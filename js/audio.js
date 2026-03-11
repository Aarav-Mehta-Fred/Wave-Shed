// audio.js - WebRTC audio capture and multi-phase sync logic

let peer = null;
let dataChannel = null;
let audioContext = null;
let audioWorker = null;
let mediaStream = null;
let pcmProcessor = null;

let isHost = false;
let peerId = null;

// Sync state and network telemetry
let networkTests = [];
let localInputLatency = 0;
let localSampleRate = 44100;
let hostCountdownStart = 0;
let hostRecordingStart = 0;
let guestRecordingStart = 0;

let currentTestId = 0;
let testTimestamps = {};
let stopHandshake = {};

let receivedFileChunks = [];
let expectedFileSize = 0;
let receivedBytes = 0;
let receivedPackets = 0;
let guestTelemetry = null;
let initialRTT = null;

// ==========================================
// Phase 1 - Setup & Audio Routing
// ==========================================

async function setupAudioPipeline(selectedMicId = null) {
    const audioConstraints = {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false
    };

    if (selectedMicId) {
        audioConstraints.deviceId = { exact: selectedMicId };
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints
    });

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
    // Output is intentionally left disconnected — we don't want local monitoring.
    // The pcmProcessor acts as a sink; it must return true in process() to stay alive.
}

function initHost(selectedMicId = null) {
    isHost = true;
    const peer = new Peer({
        host: 'podcast-peer-js.koyeb.app',
        port: 443,
        secure: true,
        path: '/'
    });

    peer.on('open', (id) => {
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
    });

    peer.on('connection', (conn) => {
        dataChannel = conn;
        setupDataChannel();
    });

    peer.on('call', async (call) => {
        if (!mediaStream) await setupAudioPipeline(selectedMicId);
        call.answer(mediaStream);
        call.on('stream', playLiveComms);
    });
}

async function initGuest(roomId, selectedMicId = null) {
    isHost = false;
    const peer = new Peer({
        host: 'podcast-peer-js.koyeb.app',
        port: 443,
        secure: true,
        path: '/'
    });

    peer.on('open', async (id) => {
        peerId = id;
        console.log('Guest Connected ID:', id);

        await setupAudioPipeline(selectedMicId);

        dataChannel = peer.connect(roomId, { reliable: true });
        setupDataChannel();

        const call = peer.call(roomId, mediaStream);
        call.on('stream', playLiveComms);
    });
}

function playLiveComms(stream) {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.play();
}

function setupDataChannel() {
    dataChannel.on('data', async (data) => {
        let currentChunkSize = 0;

        if (data instanceof Blob) {
            // PeerJS occasionally wraps binary data in a Blob — unwrap it.
            const arrayBuffer = await data.arrayBuffer();
            currentChunkSize = arrayBuffer.byteLength;
            if (isHost && audioWorker) {
                audioWorker.postMessage({ type: 'WRITE_GUEST_CHUNK', data: arrayBuffer }, [arrayBuffer]);
            }
        } else if (data instanceof ArrayBuffer) {
            currentChunkSize = data.byteLength;
            if (isHost && audioWorker) {
                audioWorker.postMessage({ type: 'WRITE_GUEST_CHUNK', data: data }, [data]);
            }
        } else if (data && data.buffer instanceof ArrayBuffer) {
            currentChunkSize = data.byteLength;
            if (isHost && audioWorker) {
                const arrayBuffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
                audioWorker.postMessage({ type: 'WRITE_GUEST_CHUNK', data: arrayBuffer }, [arrayBuffer]);
            }
        } else if (typeof data === 'string') {
            handleDataMessage(JSON.parse(data));
        } else if (typeof data === 'object') {
            // PeerJS can auto-parse JSON on reliable channels — handle that case too.
            handleDataMessage(data);
        }

        if (currentChunkSize > 0 && isHost) {
            receivedBytes += currentChunkSize;
            receivedPackets++;
            if (window.app && window.app.updateProgress && expectedFileSize > 0) {
                window.app.updateProgress('transferring', receivedBytes, expectedFileSize);
            }
        }
    });
}

function handleWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === 'STATUS') {
        console.log('Worker OPFS File:', msg.fileName);
    } else if (msg.type === 'COMPRESS_PROGRESS') {
        if (window.app && window.app.updateProgress) {
            window.app.updateProgress('compressing', msg.current, msg.total);
        }
    } else if (msg.type === 'DECOMPRESS_PROGRESS') {
        if (window.app && window.app.updateProgress) {
            window.app.updateProgress('uncompressing', msg.current, msg.total);
        }
    } else if (msg.type === 'COMPRESS_DONE') {
        audioWorker.postMessage({ type: 'READ_CHUNKS' });
    } else if (msg.type === 'DECOMPRESS_DONE') {
        runSyncAndPostProcessing();
    } else if (msg.type === 'READ_CHUNK') {
        if (dataChannel && dataChannel.open) {
            // Send the raw buffer directly — PeerJS handles binary detection automatically.
            console.log(`Guest Sending Chunk: ${msg.data.byteLength} bytes`);
            dataChannel.send(msg.data);
            
            if (!isHost && window.app && window.app.updateProgress && expectedFileSize > 0) {
                window.app.updateProgress('transferring', msg.offset, expectedFileSize);
            }
            // We wait for the host to send ACK_READ via WebRTC before proceeding to the
            // next chunk. This keeps the pipeline in lockstep and prevents data channel overflows.
        }
        if (msg.isLast) finalizeGuestExtraction();
    } else if (msg.type === 'EXTRACT_START') {
        dataChannel.send(JSON.stringify({ type: 'EXTRACT_START', fileSize: msg.fileSize }));
    } else if (msg.type === 'ACK_READ') {
        // Worker finished writing the chunk — signal the guest to send the next one.
        if (isHost && dataChannel && dataChannel.open) {
            dataChannel.send(JSON.stringify({ type: 'ACK_READ' }));
        }
    } else if (msg.type === 'CROP_DONE') {
        console.log("Processing complete. Final files are available in OPFS.");
        
        const guestSampleRate = guestTelemetry ? (guestTelemetry.guestSampleRate || localSampleRate) : localSampleRate;
        downloadAsWav(msg.hostFile, localSampleRate);
        downloadAsWav(msg.guestFile, guestSampleRate);
    } else if (msg.type === 'FILE_CLOSED') {
        if (!isHost) {
            // Guest file is finalized — safe to begin extraction.
            extractGuestData();
        }
    }
}

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

function sendMessage(msg) {
    if (dataChannel && dataChannel.open) {
        dataChannel.send(JSON.stringify(msg));
    }
}

// ==========================================
// Phase 2 - RTT Network Tests
// ==========================================

function runNetworkTest() {
    if (!isHost) return;
    currentTestId++;
    testTimestamps[currentTestId] = { T0: audioContext.currentTime };
    sendMessage({ type: 'PING', testId: currentTestId });
}

function handleDataMessage(msg) {
    const now = audioContext ? audioContext.currentTime : 0;

    switch (msg.type) {
        case 'PING':
            sendMessage({ type: 'PONG', testId: msg.testId, T1: now, T2: audioContext.currentTime });
            break;

        case 'PONG':
            if (isHost && testTimestamps[msg.testId]) {
                const test = testTimestamps[msg.testId];
                test.T1 = msg.T1;
                test.T2 = msg.T2;
                test.T3 = now;
                networkTests.push(test);
            }
            break;

        case 'ACK_READ':
            if (!isHost && audioWorker) {
                // Host acknowledged receiving the chunk — ask the worker to send the next one.
                audioWorker.postMessage({ type: 'ACK_READ' });
            }
            break;

        case 'INITIAL_PING':
            sendMessage({ type: 'INITIAL_PONG', testId: msg.testId, T1: now, T2: audioContext.currentTime });
            break;

        case 'INITIAL_PONG':
            if (isHost && testTimestamps[msg.testId]) {
                const test = testTimestamps[msg.testId];
                test.T1 = msg.T1;
                test.T2 = msg.T2;
                test.T3 = now;
                initialRTT = (test.T3 - test.T0) - (test.T2 - test.T1);
                
                const initialClockOffset = (test.T0 + (initialRTT / 2)) - test.T1;
                console.log(`[Network Test] Initial RTT: ${(initialRTT * 1000).toFixed(2)}ms | Clock Offset: ${(initialClockOffset * 1000).toFixed(2)}ms`);

                hostCountdownStart = audioContext.currentTime;

                if (window.app && window.app.startCountdown) {
                    window.app.startCountdown(5);
                }

                // Flood network tests for ~3s to collect RTT samples.
                const testInterval = setInterval(() => runNetworkTest(), 150);
                setTimeout(() => clearInterval(testInterval), 3000);

                // Trigger host recording at 4.5s into the countdown.
                setTimeout(() => {
                    pcmProcessor.port.postMessage({ command: 'start_recording' });
                    console.log('Host start recording command sent');
                }, 4500);

                sendMessage({ type: 'START_RECORDING_CMD', delay: initialRTT / 2 });
            }
            break;

        case 'START_RECORDING_CMD':
            // `delay` is approximately half the initial RTT, used to align the countdown start.
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

        case 'STOP_PING':
            const guestStopTime = now;
            audioWorker.postMessage({ type: 'CLOSING' });
            pcmProcessor.port.postMessage({ command: 'stop_recording' });
            sendMessage({ type: 'STOP_PONG', T5: guestStopTime, T6: audioContext.currentTime });
            break;

        case 'STOP_PONG':
            if (isHost) {
                stopHandshake.T5 = msg.T5;
                stopHandshake.T6 = msg.T6;
                stopHandshake.T7 = now;
                // Handshake complete — wait for guest to report its file size before proceeding.
                sendMessage({ type: 'CMD_EXTRACT' });
            }
            break;

        case 'EXTRACT_START':
            expectedFileSize = msg.fileSize;
            if (isHost && window.app && window.app.initProgressUI) window.app.initProgressUI();
            break;

        case 'TELEMETRY_DATA':
            guestTelemetry = msg.payload;
            if (isHost && audioWorker) {
                audioWorker.postMessage({ type: 'DECOMPRESS_GUEST' });
            } else {
                runSyncAndPostProcessing();
            }
            break;
    }
}

// Called from the UI to begin the recording sequence.
function startRecordingProcess() {
    if (!isHost) return;

    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }

    // Send an initial ping to measure baseline RTT before the countdown starts.
    currentTestId++;
    testTimestamps[currentTestId] = { T0: audioContext.currentTime };
    sendMessage({ type: 'INITIAL_PING', testId: currentTestId });
}

// Called from the UI to end the recording and begin extraction.
function stopRecordingProcess() {
    if (!isHost) return;
    audioWorker.postMessage({ type: 'CLOSING' });
    pcmProcessor.port.postMessage({ command: 'stop_recording' });

    stopHandshake.T4 = audioContext.currentTime;
    sendMessage({ type: 'STOP_PING' });
}

// ==========================================
// Phase 3 - Data Extraction
// ==========================================

function extractGuestData() {
    console.log("Extraction Phase Started...");
    audioWorker.postMessage({ type: 'COMPRESS_GUEST', sampleRate: localSampleRate });
}

// Wrap handleDataMessage to intercept the CMD_EXTRACT message before it hits the switch.
// This is needed because the guest must close its file before we can read its size.
const originalHandleMsg = handleDataMessage;
handleDataMessage = function (msg) {
    if (msg.type === 'CMD_EXTRACT' && !isHost) {
        if (window.app && window.app.initProgressUI) window.app.initProgressUI();
        audioWorker.postMessage({ type: 'CLOSING' });
    } else {
        originalHandleMsg(msg);
    }
    
    if (msg.type === 'EXTRACT_START' && isHost) {
        expectedFileSize = msg.fileSize;
        receivedBytes = 0;
        receivedPackets = 0;
        console.log(`Host expects to receive ${expectedFileSize} bytes from Guest.`);
    }
};

function finalizeGuestExtraction() {
    const telemetry = {
        guestRecordingStart: guestRecordingStart,
        guestSampleRate: localSampleRate,
        guestInputLatency: localInputLatency
    };
    sendMessage({ type: 'TELEMETRY_DATA', payload: telemetry });
}


// ==========================================
// Phase 4 - Sync & Post-Processing
// ==========================================

function runSyncAndPostProcessing() {
    console.log("Starting Phase 4: Sync & Post-Processing");

    // Find the network test with the lowest RTT — it best represents actual one-way delay.
    let bestTest = null;
    let minRTT = Infinity;

    networkTests.forEach(test => {
        if (!test.T3) return;
        const rtt = (test.T3 - test.T0) - (test.T2 - test.T1);
        if (rtt < minRTT) {
            minRTT = rtt;
            bestTest = test;
        }
    });

    if (!bestTest) {
        console.error("No successful network tests found!");
        return;
    }

    const { T0, T1, T3 } = bestTest;
    const startOffset = (T0 + (minRTT / 2)) - T1;

    // Calculate the clock offset at the time of the stop handshake.
    const stopRTT = (stopHandshake.T7 - stopHandshake.T4) - (stopHandshake.T6 - stopHandshake.T5);
    const stopOffset = (stopHandshake.T4 + (stopRTT / 2)) - stopHandshake.T5;

    const guestInputLatencyMs = guestTelemetry.guestInputLatency ? (guestTelemetry.guestInputLatency * 1000).toFixed(1) : 'N/A';
    console.log(`Calculated Sync - Min RTT: ${(minRTT * 1000).toFixed(2)}ms | Start Clock Offset: ${(startOffset * 1000).toFixed(2)}ms`);
    console.log(`Input Latencies - Host: ${(localInputLatency * 1000).toFixed(1)}ms | Guest: ${guestInputLatencyMs}ms`);

    // Both recordings start at the countdown origin (hostCountdownStart + 5.0s).
    // Crop length is how much audio precedes that origin in each raw file.
    const hostCropLength = (hostCountdownStart + 5.0) - hostRecordingStart;

    const mappedGuestStart = guestTelemetry.guestRecordingStart + startOffset;
    const guestCropLength = (hostCountdownStart + 5.0) - mappedGuestStart;

    console.log(`Host Crop Length: ${hostCropLength.toFixed(5)}s`);
    console.log(`Guest Crop Length: ${guestCropLength.toFixed(5)}s`);

    // Convert crop durations to byte offsets (Float32 = 4 bytes per sample).
    const hostSampleRate = localSampleRate;
    const guestSampleRate = guestTelemetry.guestSampleRate || hostSampleRate;

    const hostCropBytes = Math.floor(hostCropLength * hostSampleRate) * 4;
    const guestCropBytes = Math.floor(guestCropLength * guestSampleRate) * 4;

    console.log(`Host Crop Bytes: ${hostCropBytes} (SR: ${hostSampleRate}), Guest Crop Bytes: ${guestCropBytes} (SR: ${guestSampleRate})`);
    
    audioWorker.postMessage({
        type: 'CROP_FILES',
        hostCropBytes: Math.max(0, hostCropBytes),
        guestCropBytes: Math.max(0, guestCropBytes)
    });
    
    console.log(`Commanded worker to crop files.`);
}

// Expose public API for the UI layer.
window.AudioSync = {
    initHost,
    initGuest,
    startRecordingProcess,
    stopRecordingProcess
};
