// audio.js - WebRTC audio capture, multi-guest mesh, and sync logic

let peer = null;
let audioContext = null;
let audioWorker = null;
let mediaStream = null;
let commsStream = null; // Separate processed stream for live voice comms
let pcmProcessor = null;

let isHost = false;
let peerId = null;

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

// Guest-side: the data channel back to the host (there's only one).
let hostDataChannel = null;
// Guest-side: calls to/from other guests for voice.
let guestVoiceCalls = [];

// Track pending decompression and transfer counts so we know when all are done.
let pendingDecompressions = 0;
let pendingTransfers = 0;
let totalGuests = 0;

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

    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(pcmProcessor);
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

function createPeerWithRetry(onOpen, onError) {
    let attempt = 0;

    function tryConnect() {
        attempt++;
        console.log(`[PeerJS] Connection attempt ${attempt}/${MAX_PEER_RETRIES}...`);
        const p = new Peer(PEER_CONFIG);

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
            } else {
                console.error(`[PeerJS] Failed after ${attempt} attempt(s):`, err);
                if (onError) onError(err);
            }
        });

        return p;
    }

    return tryConnect();
}

function initHost(selectedMicId = null, participantInfo = {}) {
    isHost = true;
    localName = participantInfo.name || 'Host';
    localHeadphones = participantInfo.headphones || false;
    localSpeaker = participantInfo.speaker || '';

    createPeerWithRetry((p, id) => {
        peer = p;
        peerId = id;
        console.log('Host Room ID:', id);
        
        const url = new URL(window.location.href);
        url.searchParams.set('meeting', id);
        window.history.replaceState({}, '', url);
        
        const copyToClipboard = async (text) => {
            try {
                if (navigator.clipboard) {
                    await navigator.clipboard.writeText(text);
                    console.log('Meeting URL copied to clipboard:', text);
                    return;
                }
            } catch (err) {
                console.error('Failed native clipboard copy:', err);
            }
            
            // Fallback for when the document is not focused or writeText is blocked.
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.top = "0";
            textArea.style.left = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                const successful = document.execCommand('copy');
                console.log('Fallback clipboard copy:', successful ? 'successful' : 'unsuccessful');
            } catch (err) {
                console.error('Fallback clipboard copy failed:', err);
            }
            document.body.removeChild(textArea);
        };

        copyToClipboard(url.toString());

        // When a guest opens a data channel connection to us.
        peer.on('connection', (conn) => {
            const guestInfo = conn.metadata || {};
            const guestId = conn.peer;

            console.log(`[Host] Guest "${guestInfo.name || 'Unknown'}" (${guestId}) requesting to join`);

            // Prompt the host to accept or deny the guest.
            const admitGuest = async () => {
                let admitted = true;
                if (window.app && window.app.promptAdmission) {
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
                        hostName: localName
                    }));

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
            if (!commsStream) await setupAudioPipeline(selectedMicId);
            call.answer(commsStream);
            call.on('stream', (stream) => playLiveComms(stream, callerId));
        });
    });
}

async function initGuest(roomId, selectedMicId = null, participantInfo = {}) {
    isHost = false;
    localName = participantInfo.name || 'Guest';
    localHeadphones = participantInfo.headphones || false;
    localSpeaker = participantInfo.speaker || '';

    createPeerWithRetry(async (p, id) => {
        peer = p;
        peerId = id;
        console.log('Guest Connected ID:', id);

        await setupAudioPipeline(selectedMicId);

        // Connect to the host with our info as metadata.
        hostDataChannel = peer.connect(roomId, {
            reliable: true,
            metadata: {
                name: localName,
                headphones: localHeadphones,
                speaker: localSpeaker,
                micId: selectedMicId
            }
        });
        setupHostDataChannel(hostDataChannel);

        // Call the host for live voice comms.
        const call = peer.call(roomId, commsStream);
        call.on('stream', (stream) => playLiveComms(stream, 'host'));

        // Other guests might call us for voice once the host tells them about us.
        peer.on('call', async (incomingCall) => {
            if (!commsStream) await setupAudioPipeline(selectedMicId);
            incomingCall.answer(commsStream);
            incomingCall.on('stream', (stream) => playLiveComms(stream, incomingCall.peer));
            guestVoiceCalls.push(incomingCall);
        });
    });
}

function playLiveComms(stream, label) {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.play();
    console.log(`[Voice] Playing live comms from: ${label}`);
}

// ==========================================
// Data Channel Setup
// ==========================================

// Host-side: set up listeners on a specific guest's data channel.
function setupGuestDataChannel(guestId, conn) {
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
        console.log('Worker OPFS File:', msg.fileName);
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
            
            const expected = guestExpectedSizes.get(peerId) || expectedFileSize || 0;
            if (window.app && window.app.updateProgress && expected > 0) {
                window.app.updateProgress('transferring', msg.offset, expected);
            }
        }
        if (msg.isLast) finalizeGuestExtraction();
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
        console.log("Processing complete. Final files are available in OPFS.");
        
        // Download the host file.
        downloadAsWav(msg.hostFile, localSampleRate);
        
        // Download each guest file.
        for (const [guestId, fileName] of Object.entries(msg.guestFiles)) {
            const telemetry = guestTelemetryMap.get(guestId);
            const guestSR = telemetry ? (telemetry.guestSampleRate || localSampleRate) : localSampleRate;
            downloadAsWav(fileName, guestSR);
        }
    } else if (msg.type === 'FILE_CLOSED') {
        if (!isHost) {
            // Guest file is finalized, safe to begin extraction.
            extractGuestData();
        }
    }
}

let expectedFileSize = 0;

async function downloadAsWav(fileName, sampleRate) {
    try {
        const root = await navigator.storage.getDirectory();
        
        const fileHandle = await root.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const rawByteLength = file.size;
        
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
        
        const blob = new Blob([headerBuffer, file], { type: 'audio/wav' });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.style.display = 'none';
        anchor.href = objectUrl;
        anchor.download = fileName.replace('.raw', '.wav');
        document.body.appendChild(anchor);
        anchor.click();
        
        setTimeout(() => {
            document.body.removeChild(anchor);
            URL.revokeObjectURL(objectUrl);
        }, 100);
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
            // Call each existing guest for direct voice.
            for (const existing of msg.roster) {
                console.log(`[Guest] Calling existing guest "${existing.name}" (${existing.peerId.slice(-6)}) for voice`);
                const call = peer.call(existing.peerId, mediaStream);
                call.on('stream', (stream) => playLiveComms(stream, existing.name));
                guestVoiceCalls.push(call);
            }
            break;
        }

        case 'ADMISSION_DENIED': {
            console.log('[Guest] Host denied our join request.');
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
    }
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

        // Create a promise that resolves when the INITIAL_PONG comes back.
        await new Promise((resolve) => {
            pendingInitialPongResolve = resolve;
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
    }, 150);
    setTimeout(() => clearInterval(testInterval), 3000);

    // Step 4: Trigger host recording at 4.5s into the countdown.
    setTimeout(() => {
        pcmProcessor.port.postMessage({ command: 'start_recording' });
        console.log('Host start recording command sent');
    }, 4500);
}

// Called from the UI to end the recording and begin extraction from all guests.
function stopRecordingProcess() {
    if (!isHost) return;
    audioWorker.postMessage({ type: 'CLOSING' });
    pcmProcessor.port.postMessage({ command: 'stop_recording' });

    const stopTime = audioContext.currentTime;
    pendingStopPongs = guests.size;
    pendingTransfers = guests.size;

    // Send STOP_PING to every guest and record our local T4 for each.
    for (const [guestId] of guests) {
        const handshake = { T4: stopTime };
        guestStopHandshakes.set(guestId, handshake);
        sendToGuest(guestId, { type: 'STOP_PING' });
    }
}

// ==========================================
// Phase 3 - Data Extraction
// ==========================================

function extractGuestData() {
    console.log("Extraction Phase Started...");
    audioWorker.postMessage({ type: 'COMPRESS_GUEST', sampleRate: localSampleRate });
}

function finalizeGuestExtraction() {
    const telemetry = {
        guestRecordingStart: guestRecordingStart,
        guestSampleRate: localSampleRate,
        guestInputLatency: localInputLatency
    };
    sendToHost({ type: 'TELEMETRY_DATA', payload: telemetry });
}

// ==========================================
// Phase 4 - Sync & Post-Processing
// ==========================================

function runSyncAndPostProcessing() {
    console.log("Starting Phase 4: Sync & Post-Processing");

    const guestCrops = [];

    for (const [guestId] of guests) {
        const tests = guestNetworkTests.get(guestId) || [];
        const telemetry = guestTelemetryMap.get(guestId);
        const stopHandshake = guestStopHandshakes.get(guestId);

        if (!telemetry) {
            console.error(`Missing telemetry for guest ${guestId.slice(-6)}, skipping.`);
            continue;
        }

        // Find the network test with the lowest RTT for this guest.
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

        if (!bestTest) {
            console.error(`No successful network tests for guest ${guestId.slice(-6)}, skipping.`);
            continue;
        }

        const { T0, T1 } = bestTest;
        const startOffset = (T0 + (minRTT / 2)) - T1;

        // Calculate the clock offset at the time of the stop handshake.
        let stopOffset = startOffset; // fallback
        if (stopHandshake && stopHandshake.T7) {
            const stopRTT = (stopHandshake.T7 - stopHandshake.T4) - (stopHandshake.T6 - stopHandshake.T5);
            stopOffset = (stopHandshake.T4 + (stopRTT / 2)) - stopHandshake.T5;
        }

        const guestInputLatencyMs = telemetry.guestInputLatency ? (telemetry.guestInputLatency * 1000).toFixed(1) : 'N/A';
        console.log(`[Sync ${guestId.slice(-6)}] Min RTT: ${(minRTT * 1000).toFixed(2)}ms | Start Offset: ${(startOffset * 1000).toFixed(2)}ms`);
        console.log(`[Sync ${guestId.slice(-6)}] Input Latencies - Host: ${(localInputLatency * 1000).toFixed(1)}ms | Guest: ${guestInputLatencyMs}ms`);

        // Both recordings start at the countdown origin (hostCountdownStart + 5.0s).
        // Crop length is how much audio precedes that origin in each raw file.
        const mappedGuestStart = telemetry.guestRecordingStart + startOffset;
        const guestCropLength = (hostCountdownStart + 5.0) - mappedGuestStart;

        const guestSampleRate = telemetry.guestSampleRate || localSampleRate;
        const guestCropBytes = Math.floor(guestCropLength * guestSampleRate) * 4;

        console.log(`[Sync ${guestId.slice(-6)}] Crop Length: ${guestCropLength.toFixed(5)}s | Crop Bytes: ${guestCropBytes} (SR: ${guestSampleRate})`);

        guestCrops.push({
            guestId,
            cropBytes: Math.max(0, guestCropBytes)
        });
    }

    // Compute host crop (same for all guests since it's based on the host timeline).
    const hostCropLength = (hostCountdownStart + 5.0) - hostRecordingStart;
    const hostCropBytes = Math.floor(hostCropLength * localSampleRate) * 4;
    console.log(`[Sync] Host Crop Length: ${hostCropLength.toFixed(5)}s | Crop Bytes: ${hostCropBytes}`);

    audioWorker.postMessage({
        type: 'CROP_FILES',
        hostCropBytes: Math.max(0, hostCropBytes),
        guestCrops
    });

    console.log(`Commanded worker to crop files for ${guestCrops.length} guest(s).`);
}

// Expose public API for the UI layer.
window.AudioSync = {
    initHost,
    initGuest,
    startRecordingProcess,
    stopRecordingProcess
};
