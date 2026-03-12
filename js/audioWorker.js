self.FLAC_SCRIPT_LOCATION = 'https://unpkg.com/libflacjs@5.4.0/dist/';
importScripts('https://unpkg.com/libflacjs@5.4.0/dist/libflac.min.js');

let flacReady = false;
if (typeof Flac !== 'undefined') {
    Flac.onready = function() {
        flacReady = true;
    };
}

let accessHandle = null;
let fileHandle = null;
let workletPort = null;

// Per-guest OPFS file state, keyed by guestId (their peerId).
let guestFiles = new Map();

let readOffset = 0;
let extractFileSize = 0;
const CHUNK_SIZE = 16 * 1024;

// Track which guest we're currently reading chunks from during extraction.
let activeReadGuestId = null;

// Polls until libFLAC is fully initialized and ready to use.
async function waitFlac() {
    while (typeof Flac === 'undefined' || !Flac.isReady()) {
        await new Promise(r => setTimeout(r, 100));
    }
}

async function compressFile(sourceFileHandle, compressedFileHandle, sampleRate) {
    const sourceFile = await sourceFileHandle.getFile();
    const sourceSize = sourceFile.size;
    const writeHandle = await compressedFileHandle.createSyncAccessHandle();
    
    await waitFlac();
    
    const encoder = Flac.create_libflac_encoder(sampleRate, 1, 16, 5, sourceSize / 4, true);
    
    Flac.init_encoder_stream(encoder, function(data, bytes, samples, current_frame){
        writeHandle.write(data);
    }, function(metadata){});
    
    let offset = 0;
    const READ_CHUNK_SIZE = 1024 * 512;
    
    while (offset < sourceSize) {
        const slice = sourceFile.slice(offset, Math.min(offset + READ_CHUNK_SIZE, sourceSize));
        const buffer = await slice.arrayBuffer();
        const float32Samples = new Float32Array(buffer);
        
        // Convert Float32 PCM to Int16 for FLAC encoding.
        const int32Samples = new Int32Array(float32Samples.length);
        for (let i = 0; i < float32Samples.length; i++) {
            const clamped = Math.max(-1, Math.min(1, float32Samples[i]));
            int32Samples[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
        }
        
        Flac.FLAC__stream_encoder_process_interleaved(encoder, int32Samples, int32Samples.length);
        offset += buffer.byteLength;
        self.postMessage({ type: 'COMPRESS_PROGRESS', current: offset, total: sourceSize });
    }
    
    Flac.FLAC__stream_encoder_finish(encoder);
    Flac.FLAC__stream_encoder_delete(encoder);
    
    writeHandle.flush();
    writeHandle.close();
}

async function decompressFile(compressedFileHandle, decompressedFileHandle, guestId) {
    const compFile = await compressedFileHandle.getFile();
    
    const writeHandle = await decompressedFileHandle.createSyncAccessHandle();
    await waitFlac();
    
    const decoder = Flac.create_libflac_decoder(true);
    let readOffset = 0;
    const fileBuffer = new Uint8Array(await compFile.arrayBuffer());
    
    Flac.init_decoder_stream(
        decoder,
        function(bufferSize){
            const size = Math.min(bufferSize, fileBuffer.length - readOffset);
            if (size === 0) return { readDataLength: 0, buffer: new Uint8Array(0) };
            const chunk = fileBuffer.slice(readOffset, readOffset + size);
            readOffset += size;
            self.postMessage({ type: 'DECOMPRESS_PROGRESS', current: readOffset, total: fileBuffer.length, guestId });
            return { readDataLength: size, buffer: chunk };
        },
        function(data, frameInfo){
            // data is an array of Uint8Arrays, one per channel.
            // The encoder used 16-bit signed PCM integers, so we convert back to Float32.
            const channelBytes = data[0]; 
            const view = new DataView(channelBytes.buffer, channelBytes.byteOffset, channelBytes.byteLength);
            
            const sampleCount = channelBytes.byteLength / 2; // 2 bytes per 16-bit sample
            const float32Samples = new Float32Array(sampleCount);
            
            for (let i = 0; i < sampleCount; i++) {
                const int16 = view.getInt16(i * 2, true); // little-endian
                float32Samples[i] = int16 / 32768.0; 
            }
            writeHandle.write(new Uint8Array(float32Samples.buffer, float32Samples.byteOffset, float32Samples.byteLength));
        },
        function(err, desc){ console.error("FLAC Decode Error:", desc); },
        function(metadata){ }
    );
    
    Flac.FLAC__stream_decoder_process_until_end_of_stream(decoder);
    Flac.FLAC__stream_decoder_finish(decoder);
    Flac.FLAC__stream_decoder_delete(decoder);
    
    writeHandle.flush();
    writeHandle.close();
}

// Creates or returns the OPFS file for a specific guest's incoming recording.
async function ensureGuestFile(guestId) {
    if (guestFiles.has(guestId) && guestFiles.get(guestId).accessHandle) {
        return guestFiles.get(guestId);
    }

    try {
        const root = await navigator.storage.getDirectory();
        const fileName = `guest-${guestId}-${Date.now()}.raw`;
        const handle = await root.getFileHandle(fileName, { create: true });
        const access = await handle.createSyncAccessHandle();
        const entry = { fileHandle: handle, accessHandle: access, fileName };
        guestFiles.set(guestId, entry);
        return entry;
    } catch (error) {
        self.postMessage({ type: 'ERROR', message: `Failed to access Guest OPFS for ${guestId}: ${error.message}` });
        return null;
    }
}

// Creates the OPFS file for the local (host or guest's own) recording.
async function initFile() {
    try {
        const root = await navigator.storage.getDirectory();
        const fileName = `recording-${Date.now()}.raw`;
        fileHandle = await root.getFileHandle(fileName, { create: true });
        accessHandle = await fileHandle.createSyncAccessHandle();
        self.postMessage({ type: 'STATUS', status: 'READY', fileName });
    } catch (error) {
        self.postMessage({ type: 'ERROR', message: 'Failed to access OPFS: ' + error.message });
    }
}

initFile();

function handleAudioMessage(msg) {
    if (msg.type === 'pcm-data' && accessHandle) {
        accessHandle.write(new Uint8Array(msg.data));
    }
}

// All messages are processed sequentially through a promise chain to prevent
// race conditions with async OPFS operations.
let messageQueue = Promise.resolve();

self.onmessage = (e) => {
    messageQueue = messageQueue.then(() => processMessage(e.data, e.ports)).catch(err => {
        self.postMessage({ type: 'ERROR', message: 'Worker Queue Error: ' + err.message });
    });
};

async function processMessage(msg, ports) {
    if (msg.type === 'INIT_PORT') {
        workletPort = ports ? ports[0] : null;
        workletPort.onmessage = (event) => handleAudioMessage(event.data);
    }
    else if (msg.type === 'CLOSING') {
        // Close the local recording file handle.
        if (accessHandle) {
            accessHandle.flush();
            accessHandle.close();
            accessHandle = null;
        }
        // Close all guest file handles.
        for (const [guestId, entry] of guestFiles) {
            if (entry.accessHandle) {
                entry.accessHandle.flush();
                entry.accessHandle.close();
                entry.accessHandle = null;
            }
        }
        self.postMessage({ type: 'FILE_CLOSED' });
    } 
    else if (msg.type === 'WRITE_GUEST_CHUNK') {
        const guestId = msg.guestId;
        const entry = await ensureGuestFile(guestId);
        if (entry && entry.accessHandle) {
            entry.accessHandle.write(new Uint8Array(msg.data));
            // Notify the main thread so it can ACK the guest and trigger the next chunk.
            self.postMessage({ type: 'ACK_READ', guestId });
        }
    }
    else if (msg.type === 'READ_CHUNKS') {
        // Guest-side: read and send the local recording file in chunks.
        try {
            if (accessHandle) {
                accessHandle.flush();
                accessHandle.close();
                accessHandle = null;
            }
            const file = await fileHandle.getFile();
            extractFileSize = file.size;
            readOffset = 0;
            self.postMessage({ type: 'EXTRACT_START', fileSize: extractFileSize });
            
            readNextChunk(file);
        } catch (error) {
            self.postMessage({ type: 'ERROR', message: error.message });
        }
    }
    else if (msg.type === 'ACK_READ') {
        // Guest-side: host acknowledged receiving the chunk, send the next one.
        try {
            const file = await fileHandle.getFile();
            readNextChunk(file);
        } catch (error) {
            self.postMessage({ type: 'ERROR', message: error.message });
        }
    }
    else if (msg.type === 'COMPRESS_GUEST') {
        // Guest-side: compress own recording before sending.
        try {
            const root = await navigator.storage.getDirectory();
            const compressedName = `guest-compressed-${Date.now()}.flac`;
            const compressedHandle = await root.getFileHandle(compressedName, { create: true });
            
            await compressFile(fileHandle, compressedHandle, msg.sampleRate);
            
            fileHandle = compressedHandle;
            self.postMessage({ type: 'COMPRESS_DONE' });
        } catch(e) {
            self.postMessage({ type: 'ERROR', message: 'Compression failed: ' + e.message });
        }
    }
    else if (msg.type === 'DECOMPRESS_GUEST') {
        // Host-side: decompress a specific guest's received file.
        const guestId = msg.guestId;
        const entry = guestFiles.get(guestId);
        if (!entry) {
            self.postMessage({ type: 'ERROR', message: `No file found for guest ${guestId}` });
            return;
        }

        try {
            const root = await navigator.storage.getDirectory();
            const decompressedName = `guest-decompressed-${guestId}-${Date.now()}.raw`;
            const decompressedHandle = await root.getFileHandle(decompressedName, { create: true });
            
            await decompressFile(entry.fileHandle, decompressedHandle, guestId);
            
            // Point the guest entry to the decompressed file for cropping later.
            entry.fileHandle = decompressedHandle;
            entry.accessHandle = null;
            self.postMessage({ type: 'DECOMPRESS_DONE', guestId });
        } catch(e) {
            self.postMessage({ type: 'ERROR', message: `Decompression failed for guest ${guestId}: ${e.message}` });
        }
    }
    else if (msg.type === 'CROP_FILES') {
        await processSyncCrops(msg.hostCropBytes, msg.guestCrops);
    }
}

async function readNextChunk(file) {
    if (readOffset >= extractFileSize) {
        return;
    }
    
    const limit = Math.min(readOffset + CHUNK_SIZE, extractFileSize);
    const chunkBlob = file.slice(readOffset, limit);
    const arrayBuffer = await chunkBlob.arrayBuffer();
    
    const isLastChunk = limit >= extractFileSize;
    
    self.postMessage({ 
        type: 'READ_CHUNK', 
        data: arrayBuffer, 
        isLast: isLastChunk,
        offset: limit
    }, [arrayBuffer]);
    
    readOffset = limit;
}

// Crop the host file and each guest file to align them after sync calculations.
// guestCrops is an array of { guestId, cropBytes }.
async function processSyncCrops(hostCropBytes, guestCrops) {
    try {
        const root = await navigator.storage.getDirectory();
        const timestamp = Date.now();

        // Crop the host file.
        const hostName = `final-host-${timestamp}.raw`;
        const finalHostFile = await root.getFileHandle(hostName, { create: true });
        const finalHostAccess = await finalHostFile.createSyncAccessHandle();

        // Close any lingering write handles before reading.
        if (accessHandle) {
            accessHandle.flush();
            accessHandle.close();
            accessHandle = null;
        }

        const hostReadFile = await fileHandle.getFile();
        await copyWithCrop(hostReadFile, hostCropBytes, finalHostAccess);
        finalHostAccess.close();

        // Crop each guest file in sequence (OPFS sync handles can't truly parallelize).
        const resultFiles = {};
        for (const cropInfo of guestCrops) {
            const entry = guestFiles.get(cropInfo.guestId);
            if (!entry) {
                console.error(`No file entry for guest ${cropInfo.guestId} during crop`);
                continue;
            }

            // Close any open access handle so we can read the file.
            if (entry.accessHandle) {
                entry.accessHandle.flush();
                entry.accessHandle.close();
                entry.accessHandle = null;
            }

            const guestName = `final-guest-${cropInfo.guestId.slice(-6)}-${timestamp}.raw`;
            const finalGuestFile = await root.getFileHandle(guestName, { create: true });
            const finalGuestAccess = await finalGuestFile.createSyncAccessHandle();

            const guestReadFile = await entry.fileHandle.getFile();
            await copyWithCrop(guestReadFile, cropInfo.cropBytes, finalGuestAccess);
            finalGuestAccess.close();

            resultFiles[cropInfo.guestId] = guestName;
        }

        self.postMessage({ type: 'CROP_DONE', hostFile: hostName, guestFiles: resultFiles });
        
    } catch (e) {
        self.postMessage({ type: 'ERROR', message: 'Failed to crop files: ' + e.message });
    }
}

async function copyWithCrop(sourceFile, cropBytes, destAccessHandle) {
    const fileSize = sourceFile.size;
    
    // Clamp the crop offset in case it exceeds the actual file size.
    let offset = Math.min(cropBytes, fileSize);
    const COPY_CHUNK_SIZE = 1024 * 1024; // 1MB per read
    
    while (offset < fileSize) {
        const limit = Math.min(offset + COPY_CHUNK_SIZE, fileSize);
        const chunkBlob = sourceFile.slice(offset, limit);
        const arrayBuffer = await chunkBlob.arrayBuffer();
        
        destAccessHandle.write(new Uint8Array(arrayBuffer));
        
        offset = limit;
    }
}
