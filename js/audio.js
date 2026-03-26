// audio.js - WebRTC audio capture, multi-guest mesh, and sync logic

let peer = null;
let audioContext = null;
let audioWorker = null;
let mediaStream = null;
let commsStream = null; // Separate processed stream for live voice comms
let pcmProcessor = null;
let mediaStreamSource = null;

let isHost = false;
let peerId = null;
let currentSessionId = null;
let rawHostFileName = null;
let isRecording = false;
let isMuted = false;

// Local participant info (set by app.js before calling init).
let localName = '';
let localHeadphones = false;
let localSpeaker = '';

// Sync state shared across all guests
let localInputLatency = 0;
let localSampleRate = 44100;
let hostCountdownStart = 0;
let hostRecordingStart = 0;
let guestRecordingStart = 0;
let lateJoinTime = 0; // Host-clock time when a late guest joined

// Per-guest state maps (keyed by guest peerId)
let guests = new Map();             // guestId -> { name, headphones, speaker, micId, dataChannel, calls: [] }
let guestNetworkTests = new Map();  // guestId -> [{ T0, T1, T2, T3 }, ...]
let guestTestTimestamps = new Map();// guestId -> { testId -> { T0, T1, T2, T3 } }
let guestStopHandshakes = new Map();// guestId -> { T4, T5, T6, T7 }
let guestTelemetryMap = new Map();  // guestId -> telemetry object
let guestRecordingStarts = new Map();// guestId -> recording start time (guest clock)
let guestInitialRTTs = new Map();   // guestId -> initial RTT value
let guestExpectedSizes = new Map(); // guestId -> expected file size
let guestReceivedBytes = new Map(); // guestId -> bytes received so far

let currentTestId = 0;
let liveCommsPlayers = new Map(); // label -> Audio element

// Guest-side: the data channel back to the host (there's only one).
let hostDataChannel = null;
// Guest-side: calls to/from other guests for voice.
let guestVoiceCalls = [];

// Track pending decompression and transfer counts so we know when all are done.
let pendingDecompressions = 0;
let pendingTransfers = 0;
let totalGuests = 0;
let endMeetingAfterCrop = false;

// Take state
let currentTakeId = null;
let takeCounter = 0;

// ==========================================
// Phase 1 - Setup & Audio Routing
// ==========================================

async function setupAudioPipeline(selectedMicId = null) {
    // Raw recording stream - all processing disabled for clean PCM capture.
    const recordingConstraints = {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false
    };

    if (selectedMicId) {
        recordingConstraints.deviceId = { exact: selectedMicId };
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: recordingConstraints
    });

    // Live comms stream - processing enabled for a cleaner voice call experience.
    // Echo cancellation kicks in when the participant isn't wearing headphones.
    const commsConstraints = {
        echoCancellation: !localHeadphones,
        autoGainControl: true,
        noiseSuppression: true
    };

    if (selectedMicId) {
        commsConstraints.deviceId = { exact: selectedMicId };
    }

    commsStream = await navigator.mediaDevices.getUserMedia({
        audio: commsConstraints
    });

    console.log(`[Audio Pipeline] Comms stream: AGC=on, NS=on, EC=${!localHeadphones ? 'on' : 'off (headphones)'}`);

    audioContext = new AudioContext();
    
    const trackSettings = mediaStream.getAudioTracks()[0].getSettings();
    const trackLatency = trackSettings.latency || 0;
    const baseLatency = audioContext.baseLatency || 0;
    localInputLatency = trackLatency + baseLatency;
    localSampleRate = audioContext.sampleRate || 44100;
    console.log(`[Audio Pipeline] Input Latency: ${(localInputLatency * 1000).toFixed(1)}ms (track: ${(trackLatency * 1000).toFixed(1)}ms + base: ${(baseLatency * 1000).toFixed(1)}ms) | Sample Rate: ${localSampleRate}`);

    audioWorker = new Worker('js/audioWorker.js');
    audioWorker.onmessage = handleWorkerMessage;

    await audioContext.audioWorklet.addModule('js/pcmProcessor.js');

    const channel = new MessageChannel();
    pcmProcessor = new AudioWorkletNode(audioContext, 'pcm-processor');

    // Compensate for input latency to get the true hardware capture time.
    pcmProcessor.port.onmessage = (event) => {
        if (event.data.type === 'RECORDING_STARTED') {
            const trueHardwareTime = event.data.time - localInputLatency;
            if (isHost) {
                hostRecordingStart = trueHardwareTime;
                console.log(`Host Actual Recording Started at ${hostRecordingStart.toFixed(4)} (compensated for ${(localInputLatency * 1000).toFixed(1)}ms input latency)`);
            } else {
                guestRecordingStart = trueHardwareTime;
                console.log(`Guest Actual Recording Started at ${guestRecordingStart.toFixed(4)} (compensated for ${(localInputLatency * 1000).toFixed(1)}ms input latency)`);
            }
        }
    };

    pcmProcessor.port.postMessage({ type: 'INIT_PORT' }, [channel.port1]);
    audioWorker.postMessage({ type: 'INIT_PORT' }, [channel.port2]);

    if (mediaStreamSource) {
        mediaStreamSource.disconnect();
    }
    mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);
    mediaStreamSource.connect(pcmProcessor);
    // Output is intentionally left disconnected - we don't want local monitoring.
    // The pcmProcessor acts as a sink; it must return true in process() to stay alive.
}

// Wraps PeerJS creation with retry logic to handle Koyeb cold starts.
// The first request to a sleeping Koyeb instance returns 503 without CORS headers,
// so the browser blocks it. We just retry until the server wakes up.
const PEER_CONFIG = {
    host: 'podcast-peer-js.koyeb.app',
    port: 443,
    secure: true,
    path: '/'
};
const MAX_PEER_RETRIES = 5;
const PEER_RETRY_DELAY_MS = 5000;

function createPeerWithRetry(onOpen, onError, preferredId = null) {
    let attempt = 0;

    function tryConnect() {
        attempt++;
        console.log(`[PeerJS] Connection attempt ${attempt}/${MAX_PEER_RETRIES}...`);
        const p = preferredId ? new Peer(preferredId, PEER_CONFIG) : new Peer(PEER_CONFIG);

        p.on('open', (id) => {
            console.log(`[PeerJS] Connected on attempt ${attempt}`);
            onOpen(p, id);
        });

        p.on('error', (err) => {
            // 'server-error' covers the 503 cold-start case.
            // 'network' covers the CORS-blocked fetch failure.
            const isRetryable = err.type === 'server-error' || err.type === 'network';

            if (isRetryable && attempt < MAX_PEER_RETRIES) {
                console.warn(`[PeerJS] Attempt ${attempt} failed (${err.type}), retrying in ${PEER_RETRY_DELAY_MS}ms...`);
                p.destroy();
                setTimeout(tryConnect, PEER_RETRY_DELAY_MS);
            } else if (err.type === 'unavailable-id' && preferredId) {
                console.warn(`[PeerJS] Preferred ID "${preferredId}" is unavailable. Retrying with random ID...`);
                p.destroy();
                preferredId = null; // Reset and retry once
                setTimeout(tryConnect, 500); 
            } else {
                console.error(`[PeerJS] Failed after ${attempt} attempt(s):`, err);
                if (onError) onError(err);
            }
        });

        return p;
    }

    return tryConnect();
}

function initHost(selectedMicId = null, participantInfo = {}, existingMeetingId = null) {
    isHost = true;
    localName = participantInfo.name || 'Host';
    localHeadphones = participantInfo.headphones || false;
    localSpeaker = participantInfo.speaker || '';

    createPeerWithRetry(async (p, id) => {
        await setupAudioPipeline(selectedMicId);
        
        peer = p;
        peerId = id;
        console.log('Host Room ID:', id);

        if (window.WakeLock) window.WakeLock.acquire();
        if (window.app && window.app.setSessionState) window.app.setSessionState('in_meeting');
        
        currentSessionId = 'sess_' + Date.now();
        audioWorker.postMessage({ type: 'OPEN_DB' });
        if (window.app && window.app.onSessionCreated) {
            window.app.onSessionCreated(currentSessionId, localName, null, localSampleRate);
        }

        // Save session for reconnection
        localStorage.setItem('waveshed_session', JSON.stringify({
            role: 'host',
            meetingId: id
        }));

        const url = new URL(window.location.href);
        url.searchParams.set('meeting', id);
        window.history.replaceState({}, '', url);
        
        console.log('[Host] Meeting URL:', url.toString());

        // When a guest opens a data channel connection to us.
        peer.on('connection', (conn) => {
            const guestInfo = conn.metadata || {};
            const guestId = conn.peer;
            const isReconnect = guestInfo.reconnect === true;

            console.log(`[Host] Guest "${guestInfo.name || 'Unknown'}" (${guestId}) requesting to join ${isReconnect ? '(Reconnect)' : ''}`);

            // Prompt the host to accept or deny the guest.
            const admitGuest = async () => {
                let admitted = true;
                
                // Auto-admit if it's a reconnect and the guest was previously known.
                // We should also store admitted guests in localStorage to survive host reloads.
                const previouslyAdmitted = JSON.parse(localStorage.getItem('waveshed_admitted_guests') || '[]');
                
                if (isReconnect && previouslyAdmitted.includes(guestId)) {
                    console.log(`[Host] Auto-admitting reconnecting guest: ${guestId}`);
                    admitted = true;
                } else if (window.app && window.app.promptAdmission) {
                    admitted = await window.app.promptAdmission(guestInfo);
                }

                if (!admitted) {
                    conn.on('open', () => {
                        conn.send(JSON.stringify({ type: 'ADMISSION_DENIED' }));
                        setTimeout(() => conn.close(), 500);
                    });
                    console.log(`[Host] Denied guest "${guestInfo.name}"`);
                    return;
                }

                // Build the roster of already-connected guests so the new one knows who to call.
                const roster = [];
                for (const [existingId, existingGuest] of guests) {
                    roster.push({
                        peerId: existingId,
                        name: existingGuest.name,
                        headphones: existingGuest.headphones,
                        speaker: existingGuest.speaker
                    });
                }

                // Store the new guest.
                guests.set(guestId, {
                    name: guestInfo.name || 'Guest',
                    headphones: guestInfo.headphones || false,
                    speaker: guestInfo.speaker || '',
                    micId: guestInfo.micId || null,
                    dataChannel: conn
                });

                // Update admitted guests list for persistence
                if (!previouslyAdmitted.includes(guestId)) {
                    previouslyAdmitted.push(guestId);
                    localStorage.setItem('waveshed_admitted_guests', JSON.stringify(previouslyAdmitted));
                }

                // Initialize per-guest telemetry storage.
                guestNetworkTests.set(guestId, []);
                guestTestTimestamps.set(guestId, {});
                guestReceivedBytes.set(guestId, 0);

                // Register the guest name for progress bar labels.
                if (window.app && window.app.registerGuest) {
                    window.app.registerGuest(guestId, guestInfo.name || 'Guest');
                }

                conn.on('open', () => {
                    setupGuestDataChannel(guestId, conn);

                    // Tell the new guest they're in, along with the roster of existing peers.
                    conn.send(JSON.stringify({
                        type: 'ADMISSION_ACCEPTED',
                        roster: roster,
                        hostName: localName,
                        hostId: peerId
                    }));

                    if (isRecording) {
                        conn.send(JSON.stringify({ 
                            type: 'RECORDING_IN_PROGRESS',
                            hostTime: audioContext.currentTime,
                            hostCountdownStart: hostCountdownStart
                        }));
                    }

                    // Tell all existing guests about the newcomer so they can set up voice.
                    const newGuestInfo = {
                        type: 'NEW_GUEST',
                        peerId: guestId,
                        name: guestInfo.name || 'Guest',
                        headphones: guestInfo.headphones || false,
                        speaker: guestInfo.speaker || ''
                    };
                    broadcastToGuests(newGuestInfo, guestId);
                });

                console.log(`[Host] Admitted guest "${guestInfo.name}" (${guestId})`);
            };

            admitGuest();
        });

        // When a guest calls us for voice.
        peer.on('call', async (call) => {
            const callerId = call.peer;
            if (!guests.has(callerId)) {
                console.warn(`[Host] Ignoring call from unknown peer: ${callerId}`);
                return;
            }
            call.answer(commsStream);
            call.on('stream', (stream) => playLiveComms(stream, callerId));
            
            const guest = guests.get(callerId);
            if (guest) {
                if (!guest.calls) guest.calls = [];
                guest.calls.push(call);
            }
        });
    }, null, existingMeetingId);
}

async function initGuest(roomId, selectedMicId = null, participantInfo = {}, isReconnect = false, preferredGuestId = null) {
    isHost = false;
    localName = participantInfo.name || 'Guest';
    localHeadphones = participantInfo.headphones || false;
    localSpeaker = participantInfo.speaker || '';

    createPeerWithRetry(async (p, id) => {
        peer = p;
        peerId = id;
        console.log('Guest Connected ID:', id);

        await setupAudioPipeline(selectedMicId);
        
        if (window.WakeLock) window.WakeLock.acquire();
        if (window.app && window.app.setSessionState) window.app.setSessionState('in_meeting');

        // Connect to the host with our info as metadata.
        hostDataChannel = peer.connect(roomId, {
            reliable: true,
            metadata: {
                name: localName,
                headphones: localHeadphones,
                speaker: localSpeaker,
                micId: selectedMicId,
                reconnect: isReconnect
            }
        });
        setupHostDataChannel(hostDataChannel);

        // Call the host for live voice comms.
        const hostCall = peer.call(roomId, commsStream);
        hostCall.on('stream', (stream) => playLiveComms(stream, 'host'));
        guestVoiceCalls.push(hostCall);

        // Other guests might call us for voice once the host tells them about us.
        peer.on('call', async (incomingCall) => {
            incomingCall.answer(commsStream);
            incomingCall.on('stream', (stream) => playLiveComms(stream, incomingCall.peer));
            guestVoiceCalls.push(incomingCall);
        });
    }, null, preferredGuestId);
}

function playLiveComms(stream, label) {
    let audio = liveCommsPlayers.get(label);
    if (!audio) {
        audio = new Audio();
        liveCommsPlayers.set(label, audio);
        console.log(`[Voice] Created new Audio element for: ${label}`);
    }
    audio.srcObject = stream;
    audio.play().catch(e => console.warn('[Voice] Autoplay blocked:', e));
    console.log(`[Voice] Playing live comms from: ${label}`);
}

function stopLiveComms(label) {
    const audio = liveCommsPlayers.get(label);
    if (audio) {
        audio.pause();
        audio.srcObject = null;
        liveCommsPlayers.delete(label);
        console.log(`[Voice] Stopped and cleaned up live comms for: ${label}`);
    }
}

// ==========================================
// Data Channel Setup
// ==========================================

// Host-side: set up listeners on a specific guest's data channel.
function setupGuestDataChannel(guestId, conn) {
    conn.on('close', () => {
        console.log(`[Host] Data channel closed for guest: ${guestId}`);
        const guest = guests.get(guestId);
        const name = guest ? guest.name : guestId.slice(-6);
        stopLiveComms(guestId);
        guests.delete(guestId);
        broadcastToGuests({ type: 'PARTICIPANT_LEFT', name, peerId: guestId });
        if (window.app && window.app.onParticipantLeft) window.app.onParticipantLeft(name);
    });
    conn.on('data', async (data) => {
        let currentChunkSize = 0;

        if (data instanceof Blob) {
            const arrayBuffer = await data.arrayBuffer();
            currentChunkSize = arrayBuffer.byteLength;
            if (audioWorker) {
                audioWorker.postMessage({ type: 'WRITE_GUEST_CHUNK', guestId, data: arrayBuffer }, [arrayBuffer]);
            }
        } else if (data instanceof ArrayBuffer) {
            currentChunkSize = data.byteLength;
            if (audioWorker) {
                audioWorker.postMessage({ type: 'WRITE_GUEST_CHUNK', guestId, data: data }, [data]);
            }
        } else if (data && data.buffer instanceof ArrayBuffer) {
            currentChunkSize = data.byteLength;
            if (audioWorker) {
                const arrayBuffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
                audioWorker.postMessage({ type: 'WRITE_GUEST_CHUNK', guestId, data: arrayBuffer }, [arrayBuffer]);
            }
        } else if (typeof data === 'string') {
            handleHostDataMessage(guestId, JSON.parse(data));
        } else if (typeof data === 'object') {
            // PeerJS can auto-parse JSON on reliable channels.
            handleHostDataMessage(guestId, data);
        }

        if (currentChunkSize > 0) {
            const prev = guestReceivedBytes.get(guestId) || 0;
            guestReceivedBytes.set(guestId, prev + currentChunkSize);
            const expected = guestExpectedSizes.get(guestId) || 0;
            if (window.app && window.app.updateProgress && expected > 0) {
                window.app.updateProgress('transferring', prev + currentChunkSize, expected, guestId);
            }
        }
    });
}

// Guest-side: set up listeners on the single channel back to the host.
function setupHostDataChannel(conn) {
    conn.on('open', () => {
        console.log('[Guest] Data channel to host is open');
    });

    conn.on('close', () => {
        console.log('[Guest] Data channel to host closed');
        stopLiveComms('host');
    });

    conn.on('data', async (data) => {
        if (typeof data === 'string') {
            handleGuestDataMessage(JSON.parse(data));
        } else if (typeof data === 'object' && !(data instanceof ArrayBuffer) && !(data instanceof Blob)) {
            handleGuestDataMessage(data);
        }
    });
}

// ==========================================
// Message Sending Helpers
// ==========================================

// Send a message to a specific guest (host-side).
function sendToGuest(guestId, msg) {
    const guest = guests.get(guestId);
    if (guest && guest.dataChannel && guest.dataChannel.open) {
        guest.dataChannel.send(JSON.stringify(msg));
    }
}

// Send a message to all guests, optionally excluding one (host-side).
function broadcastToGuests(msg, excludeId = null) {
    for (const [guestId, guest] of guests) {
        if (guestId === excludeId) continue;
        if (guest.dataChannel && guest.dataChannel.open) {
            guest.dataChannel.send(JSON.stringify(msg));
        }
    }
}

// Send a message to the host (guest-side).
function sendToHost(msg) {
    if (hostDataChannel && hostDataChannel.open) {
        hostDataChannel.send(JSON.stringify(msg));
    }
}

// ==========================================
// Worker Message Handling
// ==========================================

function handleWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === 'STATUS') {
        if (msg.status === 'READY') {
            rawHostFileName = msg.fileName;
            console.log('Worker OPFS File:', msg.fileName);
        } else if (msg.status === 'TAKE_READY') {
            rawHostFileName = msg.fileName;
            console.log('[Take] OPFS File ready:', msg.fileName);
            if (isHost && window.app && window.app.onTakeCreated) {
                window.app.onTakeCreated(msg.takeId, msg.takeName, msg.fileName, currentSessionId);
            }
            pcmProcessor.port.postMessage({ command: 'start_recording' });
            isRecording = true;
            if (window.app && window.app.setSessionState) window.app.setSessionState('recording');
        } else if (msg.status === 'TAKE_CLOSED') {
            console.log('[Take] OPFS file closed for take:', currentTakeId);
            // Begin Phase 3 pipeline (same as stopRecordingProcess flow)
            if (guests.size === 0) {
                runSyncAndPostProcessing();
            }
            // If there are guests, the existing STOP_PONG -> CMD_EXTRACT -> transfer flow handles it
        }
    } else if (msg.type === 'GUEST_FILE_CREATED') {
        if (isHost && window.app && window.app.onGuestFileCreated) {
            window.app.onGuestFileCreated(currentSessionId, msg.guestId, msg.fileName);
        }
    } else if (msg.type === 'COMPRESS_PROGRESS') {
        if (window.app && window.app.updateProgress) {
            window.app.updateProgress('compressing', msg.current, msg.total);
        }
        // Guest-side: relay compression progress to the host so it can track all stages.
        if (!isHost) {
            sendToHost({ type: 'COMPRESS_PROGRESS', current: msg.current, total: msg.total });
        }
    } else if (msg.type === 'DECOMPRESS_PROGRESS') {
        if (window.app && window.app.updateProgress) {
            window.app.updateProgress('uncompressing', msg.current, msg.total, msg.guestId || '');
        }
    } else if (msg.type === 'COMPRESS_DONE') {
        // Guest-side: compression finished, start chunked transfer to host.
        audioWorker.postMessage({ type: 'READ_CHUNKS' });
    } else if (msg.type === 'DECOMPRESS_DONE') {
        // Host-side: one guest's file is decompressed.
        pendingDecompressions--;
        console.log(`[Host] Decompression done for guest ${msg.guestId}. ${pendingDecompressions} remaining.`);
        if (pendingDecompressions <= 0) {
            runSyncAndPostProcessing();
        }
    } else if (msg.type === 'READ_CHUNK') {
        // Guest-side: worker has a chunk ready to send to the host.
        if (hostDataChannel && hostDataChannel.open) {
            console.log(`Guest Sending Chunk: ${msg.data.byteLength} bytes`);
            hostDataChannel.send(msg.data);
            
            const expected = expectedFileSize || 0;
            if (window.app && window.app.updateProgress && expected > 0) {
                window.app.updateProgress('transferring', msg.offset, expected);
            }
            if (msg.isLast) finalizeGuestExtraction();
        }
    } else if (msg.type === 'EXTRACT_START') {
        // Guest-side: tell the host how big the file is.
        expectedFileSize = msg.fileSize;
        sendToHost({ type: 'EXTRACT_START', fileSize: msg.fileSize });
    } else if (msg.type === 'ACK_READ') {
        // Host-side: worker finished writing the chunk, signal the guest to send the next one.
        if (isHost && msg.guestId) {
            sendToGuest(msg.guestId, { type: 'ACK_READ' });
        }
    } else if (msg.type === 'CROP_DONE') {
        (async () => {
            const cropTakeId = msg.takeId || currentTakeId;
            console.log("Processing complete. Raw files preserved in OPFS. Take:", cropTakeId);
            
            if (window.app && window.app.onTakeComplete) {
                await window.app.onTakeComplete(
                    cropTakeId,
                    msg.hostFile,
                    msg.hostCropBytes,
                    msg.guestFiles,   // { [guestId]: { fileName, cropBytes } }
                    guests,
                    guestTelemetryMap,
                    localSampleRate,
                    currentSessionId
                );
            }

            if (endMeetingAfterCrop) {
                broadcastToGuests({ type: 'MEETING_ENDED' });
                if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
                if (commsStream) commsStream.getTracks().forEach(t => t.stop());
                if (audioWorker) audioWorker.terminate();
                if (peer) peer.destroy();
                localStorage.removeItem('waveshed_session');
                localStorage.removeItem('waveshed_admitted_guests');
                if (window.WakeLock) window.WakeLock.release();
                if (window.app && window.app.setSessionState) window.app.setSessionState('idle');
                if (window.app && window.app.onSessionFinalized) window.app.onSessionFinalized(currentSessionId);
                endMeetingAfterCrop = false;
            }
        })();
    } else if (msg.type === 'FILE_CLOSED') {
        if (!isHost) {
            // Guest-side only: own recording file is finalized, safe to begin extraction.
            // Host recording closure is handled via CLOSE_TAKE -> TAKE_CLOSED instead.
            extractGuestData();
        }
    } else if (msg.type === 'ERROR') {
        console.error('[Worker Error]', msg.message);
        if (isHost) {
            if (currentTakeId && window.app && window.app.onTakeError) {
                window.app.onTakeError(currentTakeId, msg.message);
            }
            if (currentSessionId && window.app && window.app.onSessionError) {
                window.app.onSessionError(currentSessionId, msg.message);
            }
        }
    }
}

let expectedFileSize = 0;

const safeName = (s) => s.replace(/[\/\\:*?"<>|]/g, '-').trim();

async function downloadAsWav(fileName, sampleRate, roomName, takeName, participantName, cropBytes = 0) {
    try {
        const root = await navigator.storage.getDirectory();
        
        const fileHandle = await root.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const croppedBlob = cropBytes > 0 ? file.slice(cropBytes) : file;
        const croppedBuffer = await croppedBlob.arrayBuffer();
        const rawByteLength = croppedBuffer.byteLength;
        
        const headerBuffer = new ArrayBuffer(44);
        const view = new DataView(headerBuffer);
        
        const numChannels = 1;
        const bitsPerSample = 32;
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);

        const writeString = (dataView, offset, string) => {
            for (let i = 0; i < string.length; i++) {
                dataView.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + rawByteLength, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); 
        view.setUint16(20, 3, true); // IEEE 754 float format (type 3)
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        writeString(view, 36, 'data');
        view.setUint32(40, rawByteLength, true);
        
        const blob = new Blob([headerBuffer, croppedBuffer], { type: 'audio/wav' });
        const objectUrl = URL.createObjectURL(blob);
        
        let downloadName;
        if (roomName && takeName && participantName) {
            downloadName = `${safeName(roomName)} \u2013 ${safeName(takeName)} \u2013 ${safeName(participantName)}.wav`;
        } else {
            downloadName = fileName.replace('.raw', '.wav');
        }
        
        console.log(`[Download] WAV ready: ${downloadName} | URL: ${objectUrl}`);
        
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    } catch (error) {
        console.error('Error creating WAV file:', fileName, error);
    }
}

// ==========================================
// Phase 2 - RTT Network Tests & Recording
// ==========================================

// Run a single network test ping aimed at a specific guest.
function runNetworkTest(guestId) {
    if (!isHost) return;
    currentTestId++;
    const timestamps = guestTestTimestamps.get(guestId) || {};
    timestamps[currentTestId] = { T0: audioContext.currentTime };
    guestTestTimestamps.set(guestId, timestamps);
    sendToGuest(guestId, { type: 'PING', testId: currentTestId });
}

// Host-side: handle data messages arriving from a specific guest.
function handleHostDataMessage(guestId, msg) {
    const now = audioContext ? audioContext.currentTime : 0;

    switch (msg.type) {
        case 'PONG': {
            const timestamps = guestTestTimestamps.get(guestId);
            if (timestamps && timestamps[msg.testId]) {
                const test = timestamps[msg.testId];
                test.T1 = msg.T1;
                test.T2 = msg.T2;
                test.T3 = now;
                const tests = guestNetworkTests.get(guestId) || [];
                tests.push(test);
                guestNetworkTests.set(guestId, tests);
            }
            break;
        }

        case 'INITIAL_PONG': {
            const timestamps = guestTestTimestamps.get(guestId);
            if (timestamps && timestamps[msg.testId]) {
                const test = timestamps[msg.testId];
                test.T1 = msg.T1;
                test.T2 = msg.T2;
                test.T3 = now;
                const rtt = (test.T3 - test.T0) - (test.T2 - test.T1);
                guestInitialRTTs.set(guestId, rtt);

                const offset = (test.T0 + (rtt / 2)) - test.T1;
                console.log(`[Network Test] Guest ${guestId.slice(-6)} Initial RTT: ${(rtt * 1000).toFixed(2)}ms | Clock Offset: ${(offset * 1000).toFixed(2)}ms`);

                // Resolve the promise so the sequential test loop can proceed.
                if (pendingInitialPongResolve) {
                    pendingInitialPongResolve(guestId);
                    pendingInitialPongResolve = null;
                }
            }
            break;
        }

        case 'STOP_PONG': {
            const handshake = guestStopHandshakes.get(guestId) || {};
            handshake.T5 = msg.T5;
            handshake.T6 = msg.T6;
            handshake.T7 = now;
            guestStopHandshakes.set(guestId, handshake);

            // Tell this guest to start extracting.
            sendToGuest(guestId, { type: 'CMD_EXTRACT' });

            pendingStopPongs--;
            console.log(`[Host] Stop Pong from ${guestId.slice(-6)}. ${pendingStopPongs} remaining.`);
            break;
        }

        case 'EXTRACT_START': {
            guestExpectedSizes.set(guestId, msg.fileSize);
            guestReceivedBytes.set(guestId, 0);
            console.log(`[Host] Expecting ${msg.fileSize} bytes from guest ${guestId.slice(-6)}`);
            if (window.app && window.app.initProgressUI) window.app.initProgressUI();
            break;
        }

        case 'TELEMETRY_DATA': {
            guestTelemetryMap.set(guestId, msg.payload);
            guestRecordingStarts.set(guestId, msg.payload.guestRecordingStart);
            pendingTransfers--;
            console.log(`[Host] Telemetry received from guest ${guestId.slice(-6)}. ${pendingTransfers} transfers remaining.`);

            if (pendingTransfers <= 0) {
                // All guests have finished transferring. Start decompression.
                pendingDecompressions = guests.size;
                for (const [gId] of guests) {
                    audioWorker.postMessage({ type: 'DECOMPRESS_GUEST', guestId: gId });
                }
            }
            break;
        }

        case 'COMPRESS_PROGRESS': {
            // Guest is forwarding its compression progress to us.
            if (window.app && window.app.updateProgress) {
                window.app.updateProgress('compressing', msg.current, msg.total, guestId);
            }
            break;
        }

        case 'GUEST_LEAVING': {
            console.log(`[Host] Guest leaving: ${msg.name} (${guestId})`);
            stopLiveComms(guestId);
            guests.delete(guestId);
            // Notify others
            broadcastToGuests({ type: 'PARTICIPANT_LEFT', name: msg.name, peerId: guestId }, guestId);
            if (window.app && window.app.onParticipantLeft) {
                window.app.onParticipantLeft(msg.name);
            }
            break;
        }

        case 'MUTE_STATE_CHANGE': {
            const guest = guests.get(guestId);
            if (guest) {
                guest.isMuted = msg.isMuted;
            }
            // Relay to others
            broadcastToGuests({ type: 'MUTE_STATE_CHANGE', peerId: guestId, isMuted: msg.isMuted }, guestId);
            if (window.app && window.app.onMuteStateChanged) {
                window.app.onMuteStateChanged(guestId, msg.isMuted);
            }
            break;
        }
    }
}

// Tracking for the sequential initial ping flow.
let pendingInitialPongResolve = null;
let pendingStopPongs = 0;

// Guest-side: handle data messages from the host.
function handleGuestDataMessage(msg) {
    const now = audioContext ? audioContext.currentTime : 0;

    switch (msg.type) {
        case 'ADMISSION_ACCEPTED': {
            console.log(`[Guest] Admitted to meeting. Host: ${msg.hostName}. Roster: ${msg.roster.length} other guest(s).`);
            
            // Save session info
            localStorage.setItem('waveshed_session', JSON.stringify({
                role: 'guest',
                hostId: msg.hostId,
                guestPeerId: peer.id,
                participantInfo: {
                    name: localName,
                    headphones: localHeadphones,
                    speaker: localSpeaker
                }
            }));

            // Call each existing guest for direct voice.
            for (const existing of msg.roster) {
                console.log(`[Guest] Calling existing guest "${existing.name}" (${existing.peerId.slice(-6)}) for voice`);
                const call = peer.call(existing.peerId, commsStream);
                call.on('stream', (stream) => playLiveComms(stream, existing.peerId));
                guestVoiceCalls.push(call);
            }
            break;
        }

        case 'ADMISSION_DENIED': {
            console.log('[Guest] Host denied our join request.');
            if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
            if (commsStream) commsStream.getTracks().forEach(t => t.stop());
            if (audioWorker) setTimeout(() => audioWorker.terminate(), 100);
            if (peer) peer.destroy();
            if (window.WakeLock) window.WakeLock.release();
            if (window.app && window.app.onAdmissionDenied) {
                window.app.onAdmissionDenied();
            }
            break;
        }

        case 'NEW_GUEST': {
            // Another guest joined. We need to accept their incoming call (handled in peer.on('call')).
            console.log(`[Guest] New guest "${msg.name}" (${msg.peerId.slice(-6)}) joined the meeting`);
            break;
        }

        case 'PING': {
            sendToHost({ type: 'PONG', testId: msg.testId, T1: now, T2: audioContext.currentTime });
            break;
        }

        case 'INITIAL_PING': {
            sendToHost({ type: 'INITIAL_PONG', testId: msg.testId, T1: now, T2: audioContext.currentTime });
            break;
        }

        case 'ACK_READ': {
            if (audioWorker) {
                // Host acknowledged receiving the chunk, ask the worker to send the next one.
                audioWorker.postMessage({ type: 'ACK_READ' });
            }
            break;
        }

        case 'START_RECORDING_CMD': {
            // delay is approximately half the initial RTT, used to align the countdown start.
            hostCountdownStart = now;
            
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }

            const remainingCountdown = 5.0 - msg.delay;
            if (window.app && window.app.startCountdown) {
                window.app.startCountdown(remainingCountdown);
            }

            setTimeout(() => {
                pcmProcessor.port.postMessage({ command: 'start_recording' });
                console.log('Guest start recording command sent');
            }, 4500 - Math.min((msg.delay * 1000), 1000));
            break;
        }

        case 'STOP_PING': {
            const guestStopTime = now;
            // Only stop the worklet here. The actual OPFS file close happens when
            // CMD_EXTRACT arrives, to avoid a double-CLOSING race.
            pcmProcessor.port.postMessage({ command: 'stop_recording' });
            sendToHost({ type: 'STOP_PONG', T5: guestStopTime, T6: audioContext.currentTime });
            break;
        }

        case 'CMD_EXTRACT': {
            if (window.app && window.app.initProgressUI) window.app.initProgressUI();
            audioWorker.postMessage({ type: 'CLOSING' });
            break;
        }

        case 'PARTICIPANT_LEFT': {
            console.log(`[Guest] Participant left: ${msg.name}`);
            stopLiveComms(msg.peerId);
            if (window.app && window.app.onParticipantLeft) {
                window.app.onParticipantLeft(msg.name);
            }
            break;
        }

        case 'MEETING_ENDED': {
            console.log('[Guest] Meeting ended by host');

            // Clear all live comms players
            for (const label of [...liveCommsPlayers.keys()]) {
                stopLiveComms(label);
            }

            if (isRecording && pcmProcessor) {
                pcmProcessor.port.postMessage({ command: 'stop_recording' });
            }
            if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
            if (commsStream) commsStream.getTracks().forEach(t => t.stop());
            if (audioWorker) audioWorker.terminate();
            localStorage.removeItem('waveshed_session');
            if (window.app && window.app.onMeetingEnded) {
                window.app.onMeetingEnded();
            }
            // Cleanup connections
            if (peer) peer.destroy();
            if (window.WakeLock) window.WakeLock.release();
            break;
        }

        case 'MUTE_STATE_CHANGE': {
            if (window.app && window.app.onMuteStateChanged) {
                window.app.onMuteStateChanged(msg.peerId, msg.isMuted);
            }
            break;
        }

        case 'RECORDING_IN_PROGRESS': {
            if (!isRecording) {
                console.log('[Guest] Late join: recording is already in progress. Starting now.');
                isRecording = true;
                hostCountdownStart = msg.hostCountdownStart; // use host's value
                lateJoinTime = audioContext.currentTime;
                if (audioContext && audioContext.state === 'suspended') {
                    audioContext.resume();
                }
                pcmProcessor.port.postMessage({ command: 'start_recording' });
                if (window.app && window.app.setSessionState) window.app.setSessionState('recording');
            }
            break;
        }
    }
}

// --- Take lifecycle functions ---

function resetTakeState() {
    hostCountdownStart = 0;
    hostRecordingStart = 0;
    guestRecordingStart = 0;
    lateJoinTime = 0;
    pendingDecompressions = 0;
    pendingTransfers = 0;
    pendingStopPongs = 0;

    guestNetworkTests.clear();
    guestTestTimestamps.clear();
    guestStopHandshakes.clear();
    guestTelemetryMap.clear();
    guestRecordingStarts.clear();
    guestInitialRTTs.clear();
    guestExpectedSizes.clear();
    guestReceivedBytes.clear();
}

function startTake(name) {
    resetTakeState();
    takeCounter++;
    currentTakeId = 'take_' + Date.now();
    const takeName = name || 'Take ' + takeCounter;

    audioWorker.postMessage({ type: 'INIT_TAKE', takeId: currentTakeId, takeName });
}

function stopTake() {
    pcmProcessor.port.postMessage({ command: 'stop_recording' });
    isRecording = false;

    // CLOSE_TAKE flushes/closes the handle; TAKE_CLOSED triggers Phase 3 for solo.
    audioWorker.postMessage({ type: 'CLOSE_TAKE' });
}

// Called from the UI to begin the recording sequence.
// Runs the initial ping sequentially for each guest, then floods network tests,
// then starts the countdown.
async function startRecordingProcess() {
    if (!isHost) return;

    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }

    totalGuests = guests.size;
    const guestIds = Array.from(guests.keys());

    // Step 1: Send initial pings one guest at a time and wait for each response.
    for (const guestId of guestIds) {
        currentTestId++;
        const timestamps = guestTestTimestamps.get(guestId) || {};
        timestamps[currentTestId] = { T0: audioContext.currentTime };
        guestTestTimestamps.set(guestId, timestamps);

        // Create a promise that resolves when the INITIAL_PONG comes back or times out.
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.warn(`[Host] No INITIAL_PONG from ${guestId.slice(-6)} after 5s, skipping.`);
                pendingInitialPongResolve = null;
                resolve();
            }, 5000);

            pendingInitialPongResolve = (id) => {
                clearTimeout(timeout);
                resolve();
            };
            sendToGuest(guestId, { type: 'INITIAL_PING', testId: currentTestId });
        });
    }

    // Step 2: Record the countdown start time and fire countdowns everywhere.
    hostCountdownStart = audioContext.currentTime;
    if (window.app && window.app.startCountdown) {
        window.app.startCountdown(5);
    }

    // Send START_RECORDING_CMD to each guest, offset by their individual half-RTT.
    for (const guestId of guestIds) {
        const rtt = guestInitialRTTs.get(guestId) || 0;
        sendToGuest(guestId, { type: 'START_RECORDING_CMD', delay: rtt / 2 });
    }

    // Step 3: Flood network tests for ~3s across all guests in round-robin order.
    let testIndex = 0;
    const testInterval = setInterval(() => {
        const targetId = guestIds[testIndex % guestIds.length];
        runNetworkTest(targetId);
        testIndex++;
    }, 80);
    setTimeout(() => clearInterval(testInterval), 4000);

    // Step 4: Start the first take at 4.5s into the countdown.
    // startTake sends INIT_TAKE to the worker; the TAKE_READY handler starts the worklet.
    setTimeout(() => {
        startTake();
        console.log('Host start recording via startTake()');
    }, 4500);
}

// Called from the UI to end the recording and begin extraction from all guests.
function stopRecordingProcess() {
    if (!isHost) return;

    const stopTime = audioContext.currentTime;
    if (window.app && window.app.setSessionState) window.app.setSessionState('transferring');
    pendingStopPongs = guests.size;
    pendingTransfers = guests.size;

    // Send STOP_PING to every guest and record our local T4 for each.
    for (const [guestId] of guests) {
        const handshake = { T4: stopTime };
        guestStopHandshakes.set(guestId, handshake);
        sendToGuest(guestId, { type: 'STOP_PING' });
    }

    // Stop the current take (stops worklet, sends CLOSE_TAKE to worker).
    stopTake();
}

// ==========================================
// Phase 3 - Data Extraction
// ==========================================

function extractGuestData() {
    console.log("Extraction Phase Started...");
    audioWorker.postMessage({ type: 'COMPRESS_GUEST', sampleRate: localSampleRate });
}

function finalizeGuestExtraction() {
    sendTelemetry({});
}

function sendTelemetry(extras) {
    const telemetry = {
        guestRecordingStart: guestRecordingStart,
        guestSampleRate: localSampleRate,
        guestInputLatency: localInputLatency,
        isLateJoin: lateJoinTime > 0,
        lateJoinTime: lateJoinTime,
        ...extras
    };
    sendToHost({ type: 'TELEMETRY_DATA', payload: telemetry });
}

// ==========================================
// Phase 4 - Sync & Post-Processing
// ==========================================

/**
 * Pure function: computes crop byte offsets for host and a single guest track.
 * Can be called standalone (by ai.js with stored telemetry) without a live session.
 */
function computeCropParams({
    networkTests,        // array of { T0, T1, T2, T3 }
    telemetry,           // { guestRecordingStart, guestSampleRate, guestInputLatency, isLateJoin, lateJoinTime }
    stopHandshake,       // { T4, T5, T6, T7 } or null
    hostCountdownStart,  // number (AudioContext time)
    hostRecordingStart,  // number (AudioContext time)
    hostSampleRate       // number
}) {
    const tests = networkTests || [];

    // Find the network test with the lowest RTT.
    let bestTest = null;
    let minRTT = Infinity;

    tests.forEach(test => {
        if (!test.T3) return;
        const rtt = (test.T3 - test.T0) - (test.T2 - test.T1);
        if (rtt < minRTT) {
            minRTT = rtt;
            bestTest = test;
        }
    });

    if (!bestTest) return null;

    const { T0, T1 } = bestTest;
    const startOffset = (T0 + (minRTT / 2)) - T1;

    // Calculate the clock offset at the time of the stop handshake.
    let stopOffset = startOffset; // fallback
    if (stopHandshake && stopHandshake.T7) {
        const stopRTT = (stopHandshake.T7 - stopHandshake.T4) - (stopHandshake.T6 - stopHandshake.T5);
        stopOffset = (stopHandshake.T4 + (stopRTT / 2)) - stopHandshake.T5;
    }

    // Both recordings start at the countdown origin (hostCountdownStart + 5.0s).
    const mappedGuestStart = telemetry.guestRecordingStart + startOffset;
    const guestCropLength = (hostCountdownStart + 5.0) - mappedGuestStart;
    const guestSampleRate = telemetry.guestSampleRate || hostSampleRate;
    const guestCropBytes = Math.floor(guestCropLength * guestSampleRate) * 4;

    const hostCropLength = (hostCountdownStart + 5.0) - hostRecordingStart;
    const hostCropBytes = Math.floor(hostCropLength * hostSampleRate) * 4;

    return {
        hostCropBytes: Math.max(0, hostCropBytes),
        guestCropBytes: Math.max(0, guestCropBytes),
        minRTT,
        startOffset,
        stopOffset
    };
}

function runSyncAndPostProcessing() {
    console.log("Starting Phase 4: Sync & Post-Processing");

    const guestCrops = [];
    let lastCropResult = null;

    for (const [guestId] of guests) {
        const tests = guestNetworkTests.get(guestId) || [];
        const telemetry = guestTelemetryMap.get(guestId);
        const stopHandshake = guestStopHandshakes.get(guestId);

        if (!telemetry) {
            console.error(`Missing telemetry for guest ${guestId.slice(-6)}, skipping.`);
            continue;
        }

        const cropResult = computeCropParams({
            networkTests: tests,
            telemetry,
            stopHandshake: stopHandshake || null,
            hostCountdownStart,
            hostRecordingStart,
            hostSampleRate: localSampleRate
        });

        if (!cropResult) {
            console.error(`No successful network tests for guest ${guestId.slice(-6)}, skipping.`);
            continue;
        }
        lastCropResult = cropResult;

        const guestInputLatencyMs = telemetry.guestInputLatency ? (telemetry.guestInputLatency * 1000).toFixed(1) : 'N/A';
        console.log(`[Sync ${guestId.slice(-6)}] Min RTT: ${(cropResult.minRTT * 1000).toFixed(2)}ms | Start Offset: ${(cropResult.startOffset * 1000).toFixed(2)}ms`);
        console.log(`[Sync ${guestId.slice(-6)}] Input Latencies - Host: ${(localInputLatency * 1000).toFixed(1)}ms | Guest: ${guestInputLatencyMs}ms`);

        const guestSampleRate = telemetry.guestSampleRate || localSampleRate;
        const guestCropLength = cropResult.guestCropBytes / 4 / guestSampleRate;
        console.log(`[Sync ${guestId.slice(-6)}] Crop Length: ${guestCropLength.toFixed(5)}s | Crop Bytes: ${cropResult.guestCropBytes} (SR: ${guestSampleRate})`);

        guestCrops.push({
            peerId: guestId, // Using peerId as standard naming in IDB/Session format
            guestId,
            cropBytes: cropResult.guestCropBytes
        });

        // Send telemetry to IDB via worker before crop
        audioWorker.postMessage({
            type: 'WRITE_TELEMETRY',
            takeId: currentTakeId,
            record: {
                id: `${currentSessionId}_${currentTakeId}_${guestId}`,
                sessionId: currentSessionId,
                takeId: currentTakeId,
                peerId: guestId,
                guestName: guests.get(guestId)?.name || 'Guest',
                guestRecordingStart: telemetry.guestRecordingStart,
                guestSampleRate: telemetry.guestSampleRate,
                guestInputLatency: telemetry.guestInputLatency,
                isLateJoin: telemetry.isLateJoin,
                lateJoinTime: telemetry.lateJoinTime,
                networkTests: guestNetworkTests.get(guestId) || [],
                bestRTT: cropResult.minRTT,
                startOffset: cropResult.startOffset,
                stopHandshake: guestStopHandshakes.get(guestId) || null
            }
        });
    }

    // Host crop is the same regardless of which guest's cropResult we use.
    // Re-use the value from computeCropParams to avoid a duplicate calculation.
    // Fall back to direct calculation for solo recordings (no guests).
    let hostCropBytes;
    if (lastCropResult) {
        hostCropBytes = lastCropResult.hostCropBytes;
    } else {
        const hostCropLength = (hostCountdownStart + 5.0) - hostRecordingStart;
        hostCropBytes = Math.max(0, Math.floor(hostCropLength * localSampleRate) * 4);
    }
    console.log(`[Sync] Host Crop Bytes: ${hostCropBytes}`);

    if (window.SessionDB && currentTakeId) {
        window.SessionDB.updateTake(currentTakeId, {
            hostCropBytes: Math.max(0, hostCropBytes),
            guestCrops: guestCrops
        }).catch(err => console.error('Failed to save crop bytes to take in DB:', err));
    }

    audioWorker.postMessage({
        type: 'CROP_FILES',
        hostCropBytes: Math.max(0, hostCropBytes),
        guestCrops,
        takeId: currentTakeId
    });

    console.log(`Commanded worker to crop files for ${guestCrops.length} guest(s).`);
}

// Expose public API for the UI layer.
window.AudioSync = {
    initHost,
    initGuest,
    startRecordingProcess,
    stopRecordingProcess,
    startTake,
    stopTake,
    switchMicrophone,
    leaveSession,
    endMeeting,
    setMuted,
    computeCropParams,
    downloadTrack: downloadAsWav,
    deleteFiles: async function(fileNames) {
        if (audioWorker) {
            audioWorker.postMessage({ type: 'DELETE_FILES', fileNames });
            return true;
        }
        return false;
    }
};

// --- New Feature Functions ---

async function switchMicrophone(newDeviceId) {
    if (isRecording) {
        throw new Error("Cannot switch microphone during recording.");
    }

    console.log(`[Audio Pipeline] Switching microphone to: ${newDeviceId}`);

    // Stop current tracks
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
    }
    if (commsStream) {
        commsStream.getTracks().forEach(t => t.stop());
    }

    // Re-open streams
    const recordingConstraints = {
        audio: {
            deviceId: { exact: newDeviceId },
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false
        }
    };
    const commsConstraints = {
        audio: {
            deviceId: { exact: newDeviceId },
            echoCancellation: !localHeadphones,
            autoGainControl: true,
            noiseSuppression: true
        }
    };

    mediaStream = await navigator.mediaDevices.getUserMedia(recordingConstraints);
    commsStream = await navigator.mediaDevices.getUserMedia(commsConstraints);

    // Update latencies
    const trackSettings = mediaStream.getAudioTracks()[0].getSettings();
    const trackLatency = trackSettings.latency || 0;
    const baseLatency = audioContext.baseLatency || 0;
    localInputLatency = trackLatency + baseLatency;

    // Update PCM processor connection
    if (pcmProcessor) {
        if (mediaStreamSource) {
            mediaStreamSource.disconnect();
        }
        mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);
        mediaStreamSource.connect(pcmProcessor);
    }

    // Replace tracks in active calls
    const newCommsTrack = commsStream.getAudioTracks()[0];
    
    if (isHost) {
        for (const guest of guests.values()) {
            if (guest.calls) {
                guest.calls.forEach(call => {
                    const sender = call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) sender.replaceTrack(newCommsTrack);
                });
            }
        }
    } else {
        // Guest calls
        guestVoiceCalls.forEach(call => {
            const sender = call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (sender) sender.replaceTrack(newCommsTrack);
        });
    }

    console.log('[Audio Pipeline] Microphone hotswapped successfully.');
}

async function leaveSession() {
    console.log('[AudioSync] Leaving session...');
    
    // Clear all live comms players
    for (const label of [...liveCommsPlayers.keys()]) {
        stopLiveComms(label);
    }

    if (hostDataChannel && hostDataChannel.open) {
        sendToHost({ type: 'GUEST_LEAVING', peerId: peerId, name: localName });
    }
    if (isRecording && pcmProcessor) {
        pcmProcessor.port.postMessage({ command: 'stop_recording' });
    }
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    if (commsStream) commsStream.getTracks().forEach(t => t.stop());
    if (audioWorker) audioWorker.terminate();
    if (peer) peer.destroy();
    localStorage.removeItem('waveshed_session');
    if (window.WakeLock) window.WakeLock.release();
    if (window.app && window.app.setSessionState) window.app.setSessionState('idle');
}

async function endMeeting() {
    if (!isHost) return;
    console.log('[AudioSync] Ending meeting for all participants...');

    if (isRecording || (window.app && window.app.sessionState === 'transferring')) {
        console.log('[AudioSync] Session active, will end after processing completion.');
        endMeetingAfterCrop = true;
        if (isRecording) {
            stopRecordingProcess();
        }
        return;
    }

    broadcastToGuests({ type: 'MEETING_ENDED' });
    
    // Clear live comms
    for (const label of [...liveCommsPlayers.keys()]) {
        stopLiveComms(label);
    }

    // Cleanup
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    if (commsStream) commsStream.getTracks().forEach(t => t.stop());
    if (audioWorker) audioWorker.terminate();
    if (peer) peer.destroy();
    localStorage.removeItem('waveshed_session');
    localStorage.removeItem('waveshed_admitted_guests');
    if (window.WakeLock) window.WakeLock.release();
    if (window.app && window.app.setSessionState) window.app.setSessionState('idle');
}

function setMuted(muted) {
    isMuted = muted;
    if (commsStream) {
        commsStream.getAudioTracks().forEach(t => t.enabled = !muted);
    }

    // Notify others
    const msg = { type: 'MUTE_STATE_CHANGE', isMuted: muted, peerId: peerId };
    if (isHost) {
        broadcastToGuests(msg);
    } else {
        sendToHost(msg);
    }

    // Log mute event in worker for sync preservation
    if (audioWorker) {
        audioWorker.postMessage({
            type: 'MUTE_EVENT',
            action: muted ? 'mute' : 'unmute',
            audioTime: audioContext.currentTime
        });
    }

    if (window.app && window.app.onMuteStateChanged) {
        window.app.onMuteStateChanged(peerId, muted);
    }
}
