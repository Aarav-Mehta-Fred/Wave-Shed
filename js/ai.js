/**
 * ai.js
 * 
 * Handles AI tasks (Transcription, VAD, Noise Suppression) via Web Workers.
 * Processes audio locally using ONNX/WASM models.
 * Zero UI Blocking: All heavy lifting happens in workers.
 */
window.AI = {
    workers: [],
    workerPoolSize: 1, // One worker: prevents N parallel model downloads (40MB each)
    queue: [],
    activeJobs: new Map(), // map of worker -> job data

    init: async function() {
        console.log(`[AI] Initializing AI subsystem with ${this.workerPoolSize} transcriber workers...`);
        for (let i = 0; i < this.workerPoolSize; i++) {
            // Whisper needs an ES module worker for transformers.js
            const worker = new Worker('js/transcribeWorker.js', { type: 'module' });
            worker.onmessage = this.handleWorkerMessage.bind(this, worker);
            this.workers.push(worker);
            this.activeJobs.set(worker, null);
        }
        return Promise.resolve();
    },

    handleWorkerMessage: async function(worker, event) {
        const { type, takeId, peerId, output, chunk, error, progress } = event.data;

        if (type === 'progress') {
            if (window.app && window.app.onAIStateChange) {
                // Notifying model loading progress
                window.app.onAIStateChange(takeId, peerId, 'transcription_loading', 'loading', progress.progress || 0);
            }
        } else if (type === 'partial') {
            if (window.app && window.app.onTranscriptProgress) {
                const words = [this.mapWordChunk(chunk)];
                window.app.onTranscriptProgress(takeId, peerId, words);
            }
        } else if (type === 'complete') {
            // Processing complete
            const job = this.activeJobs.get(worker);
            this.activeJobs.set(worker, null); // Free the worker
            
            try {
                // map output chunks to our DB format
                const rawChunks = output.chunks || [];
                const words = rawChunks.map(c => this.mapWordChunk(c));

                // Grab sessionId from the take
                const take = await window.SessionDB.getTake(takeId);
                const sessionId = take ? take.sessionId : 'unknown';

                const record = {
                    id: `${takeId}_${peerId}`,
                    takeId,
                    sessionId,
                    peerId,
                    words,
                    createdAt: Date.now()
                };

                await window.SessionDB.upsertTranscript(record);

                if (window.app && window.app.onTranscriptReady) {
                    window.app.onTranscriptReady(takeId, peerId, record.id);
                }
            } catch (err) {
                console.error('[AI] Error saving transcript:', err);
            }

            this.processQueue();
        } else if (type === 'error') {
            console.error('[AI] Transcription error from worker:', error);
            const job = this.activeJobs.get(worker);
            this.activeJobs.set(worker, null);
            if (window.app && window.app.onAIStateChange) {
                window.app.onAIStateChange(takeId, peerId, 'transcription', 'error');
            }
            this.processQueue();
        }
    },

    mapWordChunk: function(rawChunk) {
        return {
            word: rawChunk.text || '',
            startTime: rawChunk.timestamp ? rawChunk.timestamp[0] : 0,
            endTime: rawChunk.timestamp ? rawChunk.timestamp[1] : 0,
            confidence: 1.0 // Natively transformers.js does not expose individual word confidence without outputting full logits
        };
    },

    getFreeWorker: function() {
        for (const worker of this.workers) {
            if (this.activeJobs.get(worker) === null) {
                return worker;
            }
        }
        return null;
    },

    processQueue: function() {
        const worker = this.getFreeWorker();
        if (!worker || this.queue.length === 0) return;

        const job = this.queue.shift();
        this.activeJobs.set(worker, job);

        worker.postMessage({
            type: 'transcribe',
            takeId: job.takeId,
            peerId: job.peerId,
            audioData: job.audioData
        });
        
        if (window.app && window.app.onAIStateChange) {
            window.app.onAIStateChange(job.takeId, job.peerId, 'transcription', 'running');
        }
    },

    // decodeRawFloat32Chunk is kept for API compat but no longer used by resampleAudioTo16k
    decodeRawFloat32Chunk: function() {},

    resampleAudioTo16k: async function(fileHandle, originalSampleRate, cropBytes = 0) {
        console.log(`[AI] Resampling audio from OPFS to 16kHz for Whisper (crop: ${cropBytes}b)...`);
        const file = await fileHandle.getFile();
        // Slice away pre-roll bytes so we only process the actual take audio
        const blob = cropBytes > 0 ? file.slice(cropBytes) : file;
        const arrayBuffer = await blob.arrayBuffer();
        const floatArray  = new Float32Array(arrayBuffer);
        const numSamples  = floatArray.length;
        if (numSamples === 0) throw new Error('[AI] Audio file is empty after crop');

        // Build an AudioBuffer directly from raw PCM — no decodeAudioData needed
        // Reuse Player’s existing AudioContext to avoid Chrome’s per-page limit
        const audioCtx = (window.Player && window.Player.audioContext)
            ? window.Player.audioContext
            : new AudioContext();
        const originalBuffer = audioCtx.createBuffer(1, numSamples, originalSampleRate);
        originalBuffer.copyToChannel(floatArray, 0);

        // Resample to 16kHz using OfflineAudioContext
        const TARGET_SR     = 16000;
        const numOutSamples = Math.ceil(numSamples * TARGET_SR / originalSampleRate);
        const offlineCtx    = new OfflineAudioContext(1, numOutSamples, TARGET_SR);
        const source = offlineCtx.createBufferSource();
        source.buffer = originalBuffer;
        source.connect(offlineCtx.destination);
        source.start(0);
        const resampled = await offlineCtx.startRendering();
        console.log(`[AI] Resampled: ${numSamples} @ ${originalSampleRate}Hz -> ${resampled.length} @ ${TARGET_SR}Hz`);
        return resampled.getChannelData(0);
    },

    transcribeTrack: async function(takeId, peerId, fileHandle, originalSampleRate, cropBytes = 0) {
        console.log(`[AI] Queuing transcription for take ${takeId}, peer ${peerId} (crop: ${cropBytes}b)`);
        if (window.app && window.app.onAIStateChange) {
            window.app.onAIStateChange(takeId, peerId, 'transcription', 'queued');
        }

        try {
            const audioData = await this.resampleAudioTo16k(fileHandle, originalSampleRate, cropBytes);
            this.queue.push({ takeId, peerId, audioData });
            this.processQueue();
        } catch (error) {
            console.error(`[AI] Failed to queue transcription for ${peerId}:`, error);
        }
    },

    transcribeAll: async function(takeId) {
        console.log(`[AI] Transcribing all tracks for take ${takeId}`);
        const take = await window.SessionDB.getTake(takeId);
        if (!take) return;

        const session = await window.SessionDB.getSession(take.sessionId);
        const baseSampleRate = session ? session.sampleRate : 44100;

        const getSampleRate = (peerId) => {
            let rate = baseSampleRate;
            if (take.participants) {
                const p = take.participants.find(pt => pt.peerId === peerId || (peerId === 'host' && session && pt.name === session.hostName));
                if (p && p.sampleRate) rate = p.sampleRate;
            }
            return rate;
        };

        const root = await navigator.storage.getDirectory();
        
        // Host handle — pass crop offset so pre-roll silence is excluded
        const hostCrop = take.hostCropBytes || 0;
        if (take.rawHostFile) {
            try {
                const hHandle = await root.getFileHandle(take.rawHostFile);
                await this.transcribeTrack(takeId, 'host', hHandle, getSampleRate('host'), hostCrop);
            } catch(e) { console.error('[AI] Could not open host file:', e); }
        }

        // Guests
        if (take.rawGuestFiles) {
            for (const [guestId, fileName] of Object.entries(take.rawGuestFiles)) {
                try {
                    const gHandle = await root.getFileHandle(fileName);
                    const guestCropEntry = (take.guestCrops || []).find(c => c.guestId === guestId);
                    const guestCrop = guestCropEntry ? guestCropEntry.cropBytes : 0;
                    await this.transcribeTrack(takeId, guestId, gHandle, getSampleRate(guestId), guestCrop);
                } catch(e) { console.error(`[AI] Could not open guest file for ${guestId}:`, e); }
            }
        }
    },

    editWords: async function(takeId, wordIds, peerId) {
        try {
            const targetTranscript = await window.SessionDB.getTranscript(takeId, peerId);
            if (!targetTranscript || !targetTranscript.words) {
                console.error('[AI] Edit: Target transcript not found');
                return;
            }

            // Assume wordIds are array indices based on Phase 2 schema
            const selectedWords = wordIds.map(idx => targetTranscript.words[idx]).filter(Boolean);
            if (selectedWords.length === 0) return;

            const selStart = Math.min(...selectedWords.map(w => w.startTime));
            const selEnd = Math.max(...selectedWords.map(w => w.endTime));

            // Conflict Engine: Check for overlapping speech in other transcripts
            const allTranscripts = await window.SessionDB.getTakeTranscripts(takeId);
            const otherTranscripts = allTranscripts.filter(t => t.peerId !== peerId);
            
            const conflicts = [];
            for (const t of otherTranscripts) {
                const hasOverlap = t.words.some(w => w.startTime < selEnd && w.endTime > selStart);
                if (hasOverlap) {
                    conflicts.push(t.peerId);
                }
            }

            // Operation Routing: cut (all tracks) if no overlap, silence (this track only) if overlap
            const opType = conflicts.length === 0 ? 'cut' : 'silence';
            
            // Get or create edits object
            let edits = await window.SessionDB.getEdits(takeId);
            const take = await window.SessionDB.getTake(takeId);
            
            if (!edits) {
                edits = {
                    takeId,
                    sessionId: take ? take.sessionId : 'unknown',
                    tracks: {},
                    updatedAt: Date.now()
                };
            }

            // Ensure track objects exist for all peers in the take
            const allPeers = ['host'];
            if (take && take.rawGuestFiles) {
                allPeers.push(...Object.keys(take.rawGuestFiles));
            }
            allPeers.forEach(pid => {
                if (!edits.tracks[pid]) {
                    edits.tracks[pid] = { muted: false, volume: 1.0, operations: [] };
                }
            });

            // Create operation
            const opId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Math.random().toString(36).slice(2);
            const operation = {
                id: opId,
                type: opType,
                startSec: selStart,
                endSec: selEnd,
                createdAt: Date.now()
            };

            // Apply routing logic
            if (opType === 'cut') {
                Object.values(edits.tracks).forEach(track => track.operations.push({ ...operation }));
            } else {
                edits.tracks[peerId].operations.push({ ...operation });
            }

            edits.updatedAt = Date.now();
            await window.SessionDB.upsertEdits(edits);

            // Notify UI
            if (window.app && window.app.onEditDecision) {
                window.app.onEditDecision(takeId, opType, conflicts);
            }
            
            if (window.app && window.app.onEditStateChanged) {
                window.app.onEditStateChanged(takeId, edits);
            }
            
        } catch (e) {
            console.error('[AI] EditWords error:', e);
        }
    },

    restoreWords: async function(takeId, wordIds, peerId) {
        try {
            const targetTranscript = await window.SessionDB.getTranscript(takeId, peerId);
            if (!targetTranscript || !targetTranscript.words) return;

            const selectedWords = wordIds.map(idx => targetTranscript.words[idx]).filter(Boolean);
            if (selectedWords.length === 0) return;

            const selStart = Math.min(...selectedWords.map(w => w.startTime));
            const selEnd   = Math.max(...selectedWords.map(w => w.endTime));

            let edits = await window.SessionDB.getEdits(takeId);
            if (!edits) return;

            const newId = () => (window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));

            // Punch-hole: for each overlapping op, keep only the portions that lie
            // OUTSIDE the selected range. This prevents over-restoring when the existing
            // cut spans more words than the user selected.
            for (const trackId of Object.keys(edits.tracks)) {
                const newOps = [];
                for (const op of edits.tracks[trackId].operations) {
                    const isCutLike = op.type === 'cut' || op.type === 'silence' || op.type === 'vad_silence';
                    const overlaps   = op.startSec < selEnd && op.endSec > selStart;

                    if (isCutLike && overlaps) {
                        // Keep the portion before selStart (if any)
                        if (op.startSec < selStart) {
                            newOps.push({ ...op, endSec: selStart, id: newId() });
                        }
                        // Keep the portion after selEnd (if any)
                        if (op.endSec > selEnd) {
                            newOps.push({ ...op, startSec: selEnd, id: newId() });
                        }
                        // The portion within [selStart, selEnd] is intentionally dropped
                    } else {
                        newOps.push(op); // Non-overlapping ops are untouched
                    }
                }
                edits.tracks[trackId].operations = newOps;
            }

            edits.updatedAt = Date.now();
            await window.SessionDB.upsertEdits(edits);

            if (window.app && window.app.onEditStateChanged) {
                window.app.onEditStateChanged(takeId, edits);
            }
        } catch(e) {
            console.error('[AI] RestoreWords error:', e);
        }
    },

    insertGap: async function(takeId, atTime, duration) {
        try {
            let edits = await window.SessionDB.getEdits(takeId);
            const take = await window.SessionDB.getTake(takeId);
            if (!edits) {
                edits = {
                    takeId,
                    sessionId: take ? take.sessionId : 'unknown',
                    tracks: {},
                    updatedAt: Date.now()
                };
            }

            // Ensure tracks object contains all participants
            const allPeers = ['host'];
            if (take && take.rawGuestFiles) {
                allPeers.push(...Object.keys(take.rawGuestFiles));
            }
            allPeers.forEach(pid => {
                if (!edits.tracks[pid]) {
                    edits.tracks[pid] = { muted: false, volume: 1.0, operations: [] };
                }
            });

            const opId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Math.random().toString(36).slice(2);
            const operation = {
                id: opId,
                type: 'insert_gap',
                startSec: atTime,
                durationSecs: duration,
                createdAt: Date.now()
            };

            // Insert gap applies to all tracks
            Object.values(edits.tracks).forEach(track => track.operations.push({ ...operation }));

            edits.updatedAt = Date.now();
            await window.SessionDB.upsertEdits(edits);

            if (window.app && window.app.onEditStateChanged) {
                window.app.onEditStateChanged(takeId, edits);
            }
        } catch (e) {
            console.error('[AI] insertGap error:', e);
        }
    },

    runVAD: async function(takeId, threshold = 0.5) {
        console.log(`[AI] Running VAD for take ${takeId}`);
        const take = await window.SessionDB.getTake(takeId);
        if (!take) return;
        
        const session = await window.SessionDB.getSession(take.sessionId);
        const baseSampleRate = session ? session.sampleRate : 44100;

        const getSampleRate = (peerId) => {
            let rate = baseSampleRate;
            if (take.participants) {
                const p = take.participants.find(pt => pt.peerId === peerId || (peerId === 'host' && session && pt.name === session.hostName));
                if (p && p.sampleRate) rate = p.sampleRate;
            }
            return rate;
        };

        const allPeers = ['host'];
        if (take.rawGuestFiles) {
            allPeers.push(...Object.keys(take.rawGuestFiles));
        }
        
        const root = await navigator.storage.getDirectory();
        
        const vadPromises = allPeers.map(async (peerId) => {
            return new Promise(async (resolve, reject) => {
                try {
                    const fileName = peerId === 'host' ? take.rawHostFile : take.rawGuestFiles[peerId];
                    if (!fileName) return resolve({ peerId, speech: [] });
                    
                    const handle = await root.getFileHandle(fileName);
                    const audio16k = await this.resampleAudioTo16k(handle, getSampleRate(peerId));
                    
                    const worker = new Worker('js/vadWorker.js', { type: 'module' });
                    worker.onmessage = (e) => {
                        if (e.data.type === 'complete') {
                            worker.terminate();
                            resolve({ peerId, speech: e.data.speechSegments });
                        } else if (e.data.type === 'error') {
                            worker.terminate();
                            reject(e.data.error);
                        }
                    };
                    worker.postMessage({ type: 'analyze', takeId, peerId, audioData: audio16k, threshold });
                } catch(err) {
                    reject(err);
                }
            });
        });
        
        try {
            const results = await Promise.all(vadPromises);
            let allSpeech = [];
            results.forEach(r => {
                allSpeech.push(...r.speech);
            });
            
            allSpeech.sort((a, b) => a.start - b.start);
            
            const mergedSpeech = [];
            if (allSpeech.length > 0) {
                let current = { ...allSpeech[0] };
                for (let i = 1; i < allSpeech.length; i++) {
                    const next = allSpeech[i];
                    if (next.start <= current.end) {
                        current.end = Math.max(current.end, next.end);
                    } else {
                        mergedSpeech.push(current);
                        current = { ...next };
                    }
                }
                mergedSpeech.push(current);
            }
            
            const takeDuration = take.durationSecs || 0;
            const silences = [];
            let lastEnd = 0;
            
            // Only capture mutually silent intersections natively spanning > 0.8 seconds
            for (const sp of mergedSpeech) {
                if (sp.start - lastEnd >= 0.8) {
                    silences.push({ startSec: lastEnd, endSec: sp.start });
                }
                lastEnd = sp.end;
            }
            if (takeDuration > lastEnd && (takeDuration - lastEnd >= 0.8)) {
                silences.push({ startSec: lastEnd, endSec: takeDuration });
            }
            
            if (window.app && window.app.onVADPreview) {
                window.app.onVADPreview(takeId, silences);
            }
            
        } catch(e) {
            console.error('[AI] VAD Error:', e);
        }
    },

    applyVAD: async function(takeId, approvedSpans) {
        console.log(`[AI] Applying VAD silence to take ${takeId}`);
        let edits = await window.SessionDB.getEdits(takeId);
        
        if (!edits) {
            const take = await window.SessionDB.getTake(takeId);
            edits = { takeId, sessionId: take ? take.sessionId : 'unknown', tracks: {}, updatedAt: Date.now() };
        }
        
        // Ensure all target tracks are strictly validated
        const take = await window.SessionDB.getTake(takeId);
        const allPeers = ['host'];
        if (take && take.rawGuestFiles) {
            allPeers.push(...Object.keys(take.rawGuestFiles));
        }
        allPeers.forEach(pid => {
            if (!edits.tracks[pid]) {
                edits.tracks[pid] = { muted: false, volume: 1.0, operations: [] };
            }
        });
        
        for (const span of approvedSpans) {
            const opId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Math.random().toString(36).slice(2);
            // Global silence = no one talking on any track → CUT (remove time), not mute
            const operation = {
                id: opId,
                type: 'cut',
                startSec: span.startSec,
                endSec: span.endSec,
                createdAt: Date.now()
            };
            
            Object.values(edits.tracks).forEach(track => {
                track.operations.push({ ...operation });
            });
        }
        
        edits.updatedAt = Date.now();
        await window.SessionDB.upsertEdits(edits);
        
        if (window.app && window.app.onEditStateChanged) {
            window.app.onEditStateChanged(takeId, edits);
        }
    },

    toggleNoiseSuppress: async function(takeId, peerId, enabled) {
        console.log(`[AI] Toggling Noise Suppression for ${peerId} (Take: ${takeId}) -> ${enabled}`);
        
        let edits = await window.SessionDB.getEdits(takeId);
        const take = await window.SessionDB.getTake(takeId);
        if (!edits) edits = { takeId, sessionId: take ? take.sessionId : 'unknown', tracks: {} };
        if (!edits.noiseCanceledFiles) edits.noiseCanceledFiles = {};
        if (!edits.tracks[peerId]) edits.tracks[peerId] = { muted: false, volume: 1.0, operations: [] };
        
        if (!enabled) {
            if (edits.tracks[peerId].operations) {
                edits.tracks[peerId].operations = edits.tracks[peerId].operations.filter(op => op.type !== 'noise_suppress');
            }
            edits.updatedAt = Date.now();
            await window.SessionDB.upsertEdits(edits);
            if (window.app && window.app.onEditStateChanged) window.app.onEditStateChanged(takeId, edits);
            return;
        }
        
        const outputFileName = `nc-${takeId}-${peerId}.raw`;
        const root = await navigator.storage.getDirectory();
        
        let fileExists = true;
        try {
            await root.getFileHandle(outputFileName);
        } catch(e) {
            fileExists = false;
        }
        
        if (!fileExists) {
            if (window.app && window.app.onAIStateChange) {
                window.app.onAIStateChange(takeId, peerId, 'noise_suppression', 'running', 0);
            }
            
            const sourceFile = peerId === 'host' ? take.rawHostFile : take.rawGuestFiles[peerId];
            
            const handle = await root.getFileHandle(sourceFile);
            const file = await handle.getFile();
            const arrayBuffer = await file.arrayBuffer();
            const floatArray = new Float32Array(arrayBuffer);
            
            await new Promise((resolve, reject) => {
                const worker = new Worker('js/rnnoiseWorker.js', { type: 'module' });
                worker.onmessage = async (e) => {
                    if (e.data.type === 'complete') {
                        const outHandle = await root.getFileHandle(outputFileName, { create: true });
                        const writable = await outHandle.createWritable();
                        await writable.write(e.data.processedAudio);
                        await writable.close();
                        
                        worker.terminate();
                        resolve();
                    } else if (e.data.type === 'progress') {
                        if (window.app && window.app.onAIStateChange) {
                            window.app.onAIStateChange(takeId, peerId, 'noise_suppression', 'running', e.data.progress);
                        }
                    } else if (e.data.type === 'error') {
                        console.error('[AI] RNNoise failing gracefully back to raw bounds.');
                        const outHandle = await root.getFileHandle(outputFileName, { create: true });
                        const writable = await outHandle.createWritable();
                        await writable.write(floatArray);
                        await writable.close();
                        worker.terminate();
                        resolve();
                    }
                };
                worker.postMessage({ type: 'process', audioData: floatArray }, [floatArray.buffer]);
            });
            
            if (window.app && window.app.onAIStateChange) {
                window.app.onAIStateChange(takeId, peerId, 'noise_suppression', 'completed', 100);
            }
        }
        
        edits.noiseCanceledFiles[peerId] = outputFileName;
        
        const hasOp = edits.tracks[peerId].operations.some(op => op.type === 'noise_suppress');
        if (!hasOp) {
            const opId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Math.random().toString(36).slice(2);
            edits.tracks[peerId].operations.push({
                id: opId,
                type: 'noise_suppress',
                createdAt: Date.now()
            });
        }
        
        edits.updatedAt = Date.now();
        await window.SessionDB.upsertEdits(edits);
        
        if (window.app && window.app.onEditStateChanged) {
            window.app.onEditStateChanged(takeId, edits);
        }
    },

    cancelTask: function(taskId) {
        console.log(`[AI] Stub: Canceling task ${taskId}`);
        // To properly cancel, we would need to track worker jobs and terminate/re-create the worker
    },

    export: async function(takeId, format = 'wav', mix = true) {
        console.log(`[AI] Starting export for take ${takeId} (mix: ${mix}, format: ${format})`);
        
        if (window.app && window.app.onExportProgress) {
            window.app.onExportProgress(takeId, 0);
        }

        const take = await window.SessionDB.getTake(takeId);
        if (!take) throw new Error('Take not found');
        
        const edits = await window.SessionDB.getEdits(takeId);
        const session = await window.SessionDB.getSession(take.sessionId);
        const baseSampleRate = session ? session.sampleRate : 44100;
        
        const peers = ['host'];
        if (take.rawGuestFiles) {
            peers.push(...Object.keys(take.rawGuestFiles));
        }

        const tracksConf = {};
        let globalMaxDuration = 0;
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

            let sampleRate = baseSampleRate;
            if (take.participants) {
                const p = take.participants.find(pt => pt.peerId === peerId || (peerId === 'host' && session && pt.name === session.hostName));
                if (p && p.sampleRate) sampleRate = p.sampleRate;
            }

            let totalBytes = 0;
            try {
                const handle = await root.getFileHandle(fileName);
                const file = await handle.getFile();
                totalBytes = file.size;
            } catch (e) {
                console.error(`[AI] File missing for export: ${fileName}`, e);
                continue;
            }

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
                        sourceStartByte: Math.floor(start * sampleRate * 4),
                        sourceEndByte: Math.floor(start * sampleRate * 4)
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
                    sourceStartByte: Math.floor(start * sampleRate * 4),
                    sourceEndByte: Math.floor(end * sampleRate * 4)
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

            const isMutedGlobally = edits && edits.tracks && edits.tracks[peerId] ? edits.tracks[peerId].muted : false;

            tracksConf[peerId] = {
                fileName: finalFileName,
                sampleRate,
                virtualDuration: virtualTime,
                segments,
                muted: isMutedGlobally
            };

            if (virtualTime > globalMaxDuration) {
                globalMaxDuration = virtualTime;
            }
        }

        const worker = new Worker('js/exportWorker.js', { type: 'module' });
        
        worker.onmessage = async (e) => {
            if (e.data.type === 'progress') {
                if (window.app && window.app.onExportProgress) {
                    window.app.onExportProgress(takeId, e.data.pct);
                }
            } else if (e.data.type === 'complete') {
                const blobs = e.data.blobs;
                Object.keys(blobs).forEach(key => {
                    const blob = blobs[key];
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.style.display = 'none';
                    a.href = url;
                    const suffix = key === 'mix' ? 'mix' : `track-${key}`;
                    a.download = `take-${takeId}-${suffix}.${format}`;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                    }, 100);
                });

                if (window.SessionDB && window.SessionDB.logDownload) {
                    await window.SessionDB.logDownload({
                        id: `${takeId}_${format}_${Date.now()}`,
                        takeId,
                        format,
                        mix,
                        downloadedAt: Date.now()
                    });
                }
                if (window.app && window.app.onExportReady) {
                    window.app.onExportReady(takeId);
                }
                worker.terminate();
            } else if (e.data.type === 'error') {
                console.error('[AI] Export error:', e.data.error);
                worker.terminate();
            }
        };

        worker.postMessage({
            type: 'start_export',
            takeId,
            mix,
            format,
            tracksConf,
            globalMaxDuration,
            baseSampleRate
        });
    }
};
