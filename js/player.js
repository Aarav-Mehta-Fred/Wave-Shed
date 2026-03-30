/**
 * player.js
 * 
 * Virtual Timeline and Playback Manager.
 * Uses a lookahead scheduler to schedule AudioBufferSourceNodes 
 * by slicing specific byte ranges from OPFS, honoring SessionDB.edits.
 */
window.Player = {
    audioContext: null,
    currentTakeId: null,
    isPlaying: false,
    currentTime: 0,
    tracks: {}, // Per-track virtual timeline segments
    fileMap: {},
    gainNodes: {},
    trackStates: {},
    activeNodes: [],

    // Engine constants
    chunkSize: 0.1, // 100ms chunks
    lookaheadWindow: 0.25, // 250ms lookahead
    playStartTime: 0,
    nextScheduleVirtualTime: 0,
    schedulerTimerId: null,
    timeUpdateTimerId: null,

    init: async function (audioContext) {
        console.log('[Player] Initializing playback subsystem...');
        this.audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
        return Promise.resolve();
    },

    load: async function (takeId) {
        console.log(`[Player] Loading take ${takeId} into virtual timeline...`);
        this.currentTakeId = takeId;

        this.flushNodes();
        clearTimeout(this.schedulerTimerId);
        clearInterval(this.timeUpdateTimerId);

        await this.rebuildTimeline();

        // Reset playback state
        this.currentTime = 0;
        this.isPlaying = false;
        if (window.app && window.app.onPlayerStateChange) {
            window.app.onPlayerStateChange('paused');
        }
        if (window.app && window.app.onPlayerTimeUpdate) {
            window.app.onPlayerTimeUpdate(this.currentTime);
        }
        return Promise.resolve();
    },

    /**
     * Rebuilds the Virtual Timeline based on the edits array.
     */
    rebuildTimeline: async function () {
        console.log(`[Player] Rebuilding virtual timeline for take ${this.currentTakeId}...`);

        const take = await window.SessionDB.getTake(this.currentTakeId);
        if (!take) throw new Error('Take not found');

        const edits = await window.SessionDB.getEdits(this.currentTakeId);
        const session = await window.SessionDB.getSession(take.sessionId);
        const baseSampleRate = session ? session.sampleRate : 44100;

        this.tracks = {};
        this.fileMap = {};

        const peers = ['host'];
        if (take.rawGuestFiles) {
            peers.push(...Object.keys(take.rawGuestFiles));
        }

        const root = await navigator.storage.getDirectory();

        for (const peerId of peers) {
            const fileName = peerId === 'host' ? take.rawHostFile : take.rawGuestFiles[peerId];
            if (!fileName) continue;

            let ops = [];
            if (edits && edits.tracks && edits.tracks[peerId] && edits.tracks[peerId].operations) {
                ops = edits.tracks[peerId].operations;
            }

            const isNoiseSuppressed = ops.some(op => op.type === 'noise_suppress');
            let finalFileName = fileName;
            if (isNoiseSuppressed && edits.noiseCanceledFiles && edits.noiseCanceledFiles[peerId]) {
                finalFileName = edits.noiseCanceledFiles[peerId];
            }
            this.fileMap[peerId] = finalFileName;

            // Orchestrate Mixing/GainNodes inherently.
            if (this.gainNodes[peerId]) {
                this.gainNodes[peerId].disconnect();
            }
            const gainNode = this.audioContext.createGain();
            gainNode.connect(this.audioContext.destination);
            this.gainNodes[peerId] = gainNode;

            // Track routing state defaults
            this.trackStates[peerId] = { mute: false, solo: false };

            const handle = await root.getFileHandle(fileName);
            const file = await handle.getFile();

            let sampleRate = baseSampleRate;
            if (take.participants) {
                const p = take.participants.find(pt => pt.peerId === peerId || (peerId === 'host' && pt.name === session.hostName));
                if (p && p.sampleRate) sampleRate = p.sampleRate;
            }

            const totalBytes = file.size;
            const totalSecs = totalBytes / (sampleRate * 4); // 32-bit floats

            let pois = [0, totalSecs];
            ops.forEach(op => {
                if (op.type === 'cut' || op.type === 'silence' || op.type === 'vad_silence') {
                    if (typeof op.startSec === 'number') pois.push(op.startSec);
                    if (typeof op.endSec === 'number') pois.push(op.endSec);
                } else if (op.type === 'insert_gap') {
                    if (typeof op.startSec === 'number') pois.push(op.startSec);
                }
            });

            pois = [...new Set(pois)].sort((a, b) => a - b);

            const segments = [];
            let virtualTime = 0;

            for (let i = 0; i < pois.length - 1; i++) {
                const start = pois[i];
                const end = pois[i + 1];

                const gaps = ops.filter(op => op.type === 'insert_gap' && op.startSec === start);
                for (const gap of gaps) {
                    segments.push({
                        isGap: true,
                        isMuted: true,
                        virtualStart: virtualTime,
                        virtualEnd: virtualTime + gap.durationSecs,
                        sourceStartSec: start,
                        sourceEndSec: start,
                        sourceStartByte: Math.floor(start * sampleRate) * 4,
                        sourceEndByte:   Math.floor(start * sampleRate) * 4
                    });
                    virtualTime += gap.durationSecs;
                }

                if (start >= end) continue;

                const activeOps = ops.filter(op => {
                    if (op.type === 'cut' || op.type === 'silence' || op.type === 'vad_silence') {
                        const mid = (start + end) / 2;
                        return mid > op.startSec && mid < op.endSec;
                    }
                    return false;
                });

                const isCut = activeOps.some(op => op.type === 'cut');
                const isSilence = activeOps.some(op => op.type === 'silence' || op.type === 'vad_silence');

                if (isCut) continue;

                const duration = end - start;
                segments.push({
                    isGap: false,
                    isMuted: isSilence,
                    virtualStart: virtualTime,
                    virtualEnd: virtualTime + duration,
                    sourceStartSec: start,
                    sourceEndSec: end,
                    sourceStartByte: Math.floor(start * sampleRate) * 4,
                    sourceEndByte:   Math.floor(end   * sampleRate) * 4
                });

                virtualTime += duration;
            }

            const trailingGaps = ops.filter(op => op.type === 'insert_gap' && op.startSec === totalSecs);
            for (const gap of trailingGaps) {
                segments.push({
                    isGap: true,
                    isMuted: true,
                    virtualStart: virtualTime,
                    virtualEnd: virtualTime + gap.durationSecs,
                    sourceStartSec: totalSecs,
                    sourceEndSec: totalSecs,
                    sourceStartByte: totalBytes,
                    sourceEndByte: totalBytes
                });
                virtualTime += gap.durationSecs;
            }

            // Sync global mutes/volumes from DB edits array mapping appropriately
            const globalMute = edits && edits.tracks && edits.tracks[peerId] ? edits.tracks[peerId].muted : false;
            if (globalMute) {
                this.trackStates[peerId].mute = true;
                this.gainNodes[peerId].gain.value = 0;
            }

            this.tracks[peerId] = {
                sampleRate,
                segments,
                virtualDuration: virtualTime
            };
        }

        this.updateRouting();
        console.log(`[Player] Virtual timeline rebuilt. Ready for playback limits.`);
    },

    getPeaks: async function (takeId, peerId, resolution) {
        console.log(`[Player] Extracting peaks for take ${takeId}, peer ${peerId} (resolution: ${resolution})`);
        const take = await window.SessionDB.getTake(takeId);
        if (!take) throw new Error('Take not found');

        let fileName = peerId === 'host' ? take.rawHostFile : (take.rawGuestFiles ? take.rawGuestFiles[peerId] : null);
        if (!fileName) throw new Error(`File not found for peer ${peerId}`);

        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(fileName);
        const file = await handle.getFile();

        const totalBytes = file.size;
        const totalSamples = Math.floor(totalBytes / 4);
        const numPeaks = Math.ceil(totalSamples / resolution);

        const peaks = new Float32Array(numPeaks * 2);
        const CHUNK_SIZE_BYTES = 1024 * 1024 * 4;

        let offset = 0;
        let peakIndex = 0;

        let currentMin = Infinity;
        let currentMax = -Infinity;
        let samplesInCurrentPixel = 0;

        while (offset < totalBytes) {
            const end = Math.min(offset + CHUNK_SIZE_BYTES, totalBytes);
            const blobChunk = file.slice(offset, end);
            const arrayBuffer = await blobChunk.arrayBuffer();
            const floatArray = new Float32Array(arrayBuffer);

            for (let i = 0; i < floatArray.length; i++) {
                const sample = floatArray[i];
                if (sample < currentMin) currentMin = sample;
                if (sample > currentMax) currentMax = sample;

                samplesInCurrentPixel++;

                if (samplesInCurrentPixel >= resolution) {
                    peaks[peakIndex * 2] = currentMin;
                    peaks[peakIndex * 2 + 1] = currentMax;
                    peakIndex++;
                    currentMin = Infinity;
                    currentMax = -Infinity;
                    samplesInCurrentPixel = 0;
                }
            }
            offset += CHUNK_SIZE_BYTES;
        }

        if (samplesInCurrentPixel > 0 && peakIndex < numPeaks) {
            peaks[peakIndex * 2] = currentMin === Infinity ? 0 : currentMin;
            peaks[peakIndex * 2 + 1] = currentMax === -Infinity ? 0 : currentMax;
        }

        return peaks;
    },

    // ==========================================
    // Phase 5: Lookahead Scheduler & Playback
    // ==========================================

    play: async function () {
        if (this.isPlaying) return;
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        console.log('[Player] Starting playback scheduler...');

        this.isPlaying = true;
        this.playStartTime = this.audioContext.currentTime - this.currentTime;
        this.nextScheduleVirtualTime = this.currentTime;

        this.scheduleNextChunks();

        this.timeUpdateTimerId = setInterval(() => {
            if (this.isPlaying) {
                this.currentTime = this.audioContext.currentTime - this.playStartTime;
                if (window.app && window.app.onPlayerTimeUpdate) {
                    window.app.onPlayerTimeUpdate(this.currentTime);
                }
            }
        }, 50);

        if (window.app && window.app.onPlayerStateChange) {
            window.app.onPlayerStateChange('playing');
        }
    },

    pause: function () {
        if (!this.isPlaying) return;
        console.log('[Player] Pausing playback...');

        this.isPlaying = false;
        clearTimeout(this.schedulerTimerId);
        clearInterval(this.timeUpdateTimerId);

        this.currentTime = this.audioContext.currentTime - this.playStartTime;
        this.flushNodes();

        if (window.app && window.app.onPlayerStateChange) {
            window.app.onPlayerStateChange('paused');
        }
        if (window.app && window.app.onPlayerTimeUpdate) {
            window.app.onPlayerTimeUpdate(this.currentTime);
        }
    },

    seek: function (timeInSeconds) {
        console.log(`[Player] Seeking natively to ${timeInSeconds}s`);

        // Critically flush nodes and reposition safely to allow smooth buffering on next tick
        this.flushNodes();
        this.currentTime = timeInSeconds;

        if (this.isPlaying) {
            this.playStartTime = this.audioContext.currentTime - this.currentTime;
            this.nextScheduleVirtualTime = this.currentTime;
            // The scheduler loop immediately compensates when it checks contextTime.
        }

        if (window.app && window.app.onPlayerTimeUpdate) {
            window.app.onPlayerTimeUpdate(this.currentTime);
        }
    },

    flushNodes: function () {
        this.activeNodes.forEach(source => {
            try {
                source.stop();
                source.disconnect();
            } catch (e) { }
        });
        this.activeNodes = [];
    },

    scheduleNextChunks: async function () {
        if (!this.isPlaying) return;

        const now = this.audioContext.currentTime;
        // The edge condition is `currentTime + lookahead`
        const targetVirtualTime = (now - this.playStartTime) + this.lookaheadWindow;

        while (this.nextScheduleVirtualTime < targetVirtualTime) {
            const vStart = this.nextScheduleVirtualTime;
            const vEnd = vStart + this.chunkSize;

            for (const peerId in this.tracks) {
                const track = this.tracks[peerId];
                if (vStart >= track.virtualDuration) continue;

                const segments = track.segments.filter(s => vStart < s.virtualEnd && vEnd > s.virtualStart);

                for (const seg of segments) {
                    if (seg.isGap || seg.isMuted) continue;

                    const overlapStart = Math.max(vStart, seg.virtualStart);
                    const overlapEnd = Math.min(vEnd, seg.virtualEnd);
                    if (overlapEnd <= overlapStart) continue;

                    const srcStart = seg.sourceStartSec + (overlapStart - seg.virtualStart);
                    const srcEnd = seg.sourceStartSec + (overlapEnd - seg.virtualStart);

                    const byteStart = Math.floor(srcStart * track.sampleRate) * 4;
                    const byteEnd   = Math.floor(srcEnd   * track.sampleRate) * 4;

                    this.scheduleMapSlice(peerId, byteStart, byteEnd, track.sampleRate, overlapStart);
                }
            }

            this.nextScheduleVirtualTime += this.chunkSize;
        }

        // Loop back
        this.schedulerTimerId = setTimeout(this.scheduleNextChunks.bind(this), 50);
    },

    scheduleMapSlice: async function (peerId, byteStart, byteEnd, sampleRate, virtualOffset) {
        try {
            const fileName = this.fileMap[peerId];
            if (!fileName) return;

            // Failsafe to bypass exact equality
            if (byteStart >= byteEnd) return;

            const root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle(fileName);
            const file = await handle.getFile();

            const actualEnd = Math.min(byteEnd, file.size);
            if (byteStart >= actualEnd) return;

            const blob = file.slice(byteStart, actualEnd);
            const arrayBuffer = await blob.arrayBuffer();

            // Generate compliant WAV wrapper implicitly mapping the raw floats 
            // This firmly satisfies `audioContext.decodeAudioData()` limits dynamically!
            const decodedBuffer = await this.decodeRawFloat32Chunk(arrayBuffer, sampleRate);

            const source = this.audioContext.createBufferSource();
            source.buffer = decodedBuffer;
            source.connect(this.gainNodes[peerId]);

            const scheduleTime = this.playStartTime + virtualOffset;

            // Safeguard against missing the target latency strictly
            if (scheduleTime < this.audioContext.currentTime) {
                const offsetIntoBuffer = this.audioContext.currentTime - scheduleTime;
                if (offsetIntoBuffer < decodedBuffer.duration) {
                    source.start(this.audioContext.currentTime, offsetIntoBuffer);
                }
            } else {
                source.start(scheduleTime);
            }

            this.activeNodes.push(source);

            // Garbage collection
            source.onended = () => {
                const idx = this.activeNodes.indexOf(source);
                if (idx > -1) this.activeNodes.splice(idx, 1);
            };
        } catch (e) {
            console.error('[Player] Error safely scheduling slice:', e);
        }
    },

    decodeRawFloat32Chunk: function (floatArrayBuffer, sampleRate) {
        // Float32 = 4 bytes; a file.slice() boundary is not guaranteed to be 4-byte aligned,
        // so we derive the element count explicitly and pass it as Float32Array length arg.
        const numSamples = Math.floor(floatArrayBuffer.byteLength / 4);
        if (numSamples === 0) throw new Error('[Player] Empty audio chunk');
        const audioBuffer = this.audioContext.createBuffer(1, numSamples, sampleRate);
        // Explicit (buffer, byteOffset, length) form is valid even when byteLength % 4 !== 0
        audioBuffer.copyToChannel(new Float32Array(floatArrayBuffer, 0, numSamples), 0);
        return audioBuffer;
    },

    // ==========================================
    // Phase 5: Routing & Mixing Controls (Mute/Solo)
    // ==========================================

    updateRouting: function () {
        const anySolo = Object.values(this.trackStates).some(t => t.solo);

        for (const peerId in this.gainNodes) {
            const state = this.trackStates[peerId];
            const gainNode = this.gainNodes[peerId];

            if (state.mute) {
                gainNode.gain.value = 0;
            } else if (anySolo && !state.solo) {
                gainNode.gain.value = 0;
            } else {
                gainNode.gain.value = 1;
            }
        }
    },

    setTrackMute: function (peerId, muted) {
        if (!this.trackStates[peerId]) return;
        this.trackStates[peerId].mute = muted;
        this.updateRouting();
    },

    setTrackSolo: function (peerId, soloed) {
        if (!this.trackStates[peerId]) return;
        this.trackStates[peerId].solo = soloed;
        this.updateRouting();
    },

    setPlaybackRate: function (rate) {
        console.log(`[Player] Stub: Setting playback rate to ${rate}x`);
    },

    exportMix: async function (takeId, options) {
        console.log(`[Player] Stub: Exporting mix for take ${takeId}...`);
        if (window.app && window.app.onExportProgress) {
            window.app.onExportProgress(takeId, 100);
        }
        return Promise.resolve(new Blob());
    }
};
