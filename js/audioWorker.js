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
let dataChannel = null;
let workletPort = null;

let guestAccessHandle = null;
let guestFileHandle = null;

let readOffset = 0;
let extractFileSize = 0;
const CHUNK_SIZE = 16 * 1024;

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

async function decompressFile(compressedFileHandle, decompressedFileHandle) {
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
            self.postMessage({ type: 'DECOMPRESS_PROGRESS', current: readOffset, total: fileBuffer.length });
            return { readDataLength: size, buffer: chunk };
        },
        function(data, frameInfo){
            // `data` is an array of Uint8Arrays, one per channel.
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

// Creates the OPFS file for the incoming guest recording on first write.
async function ensureGuestFile() {
    if (!guestFileHandle) {
        try {
            const root = await navigator.storage.getDirectory();
            const fileName = `guest-recording-${Date.now()}.raw`;
            guestFileHandle = await root.getFileHandle(fileName, { create: true });
            guestAccessHandle = await guestFileHandle.createSyncAccessHandle();
        } catch (error) {
            self.postMessage({ type: 'ERROR', message: 'Failed to access Guest OPFS: ' + error.message });
        }
    }
}

// Creates the OPFS file for the local (host) recording.
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
    else if (msg.type === 'CLOSING' && accessHandle) {
        accessHandle.flush();
        accessHandle.close();
        accessHandle = null;
        if (guestAccessHandle) {
            guestAccessHandle.flush();
            guestAccessHandle.close();
            guestAccessHandle = null;
        }
        self.postMessage({ type: 'FILE_CLOSED' });
    } 
    else if (msg.type === 'WRITE_GUEST_CHUNK') {
        if (!guestAccessHandle) {
            await ensureGuestFile();
        }
        if (guestAccessHandle) {
            console.log(`Worker writing Guest Chunk: ${msg.data.byteLength} bytes`);
            guestAccessHandle.write(new Uint8Array(msg.data));
            // Notify the main thread so it can ACK the guest and trigger the next chunk.
            self.postMessage({ type: 'ACK_READ' });
        }
    }
    else if (msg.type === 'READ_CHUNKS') {
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
        try {
            const file = await fileHandle.getFile();
            readNextChunk(file);
        } catch (error) {
            self.postMessage({ type: 'ERROR', message: error.message });
        }
    }
    else if (msg.type === 'COMPRESS_GUEST') {
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
        try {
            const root = await navigator.storage.getDirectory();
            const decompressedName = `guest-decompressed-${Date.now()}.raw`;
            const decompressedHandle = await root.getFileHandle(decompressedName, { create: true });
            
            await decompressFile(guestFileHandle, decompressedHandle);
            
            guestFileHandle = decompressedHandle;
            self.postMessage({ type: 'DECOMPRESS_DONE' });
        } catch(e) {
            self.postMessage({ type: 'ERROR', message: 'Decompression failed: ' + e.message });
        }
    }
    else if (msg.type === 'CROP_FILES') {
        await processSyncCrops(msg.hostCropBytes, msg.guestCropBytes);
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

async function processSyncCrops(hostCropBytes, guestCropBytes) {
    try {
        const root = await navigator.storage.getDirectory();
        
        const timestamp = Date.now();
        const hostName = `final-host-${timestamp}.raw`;
        const guestName = `final-guest-${timestamp}.raw`;

        const finalHostFile = await root.getFileHandle(hostName, { create: true });
        const finalHostAccess = await finalHostFile.createSyncAccessHandle();
        
        const finalGuestFile = await root.getFileHandle(guestName, { create: true });
        const finalGuestAccess = await finalGuestFile.createSyncAccessHandle();
        
        // Close any open write handles before attempting to read.
        if (accessHandle) {
            accessHandle.flush();
            accessHandle.close();
            accessHandle = null;
        }
        if (guestAccessHandle) {
            guestAccessHandle.flush();
            guestAccessHandle.close();
            guestAccessHandle = null;
        }
        
        const hostReadFile = await fileHandle.getFile();
        const guestReadFile = await guestFileHandle.getFile();
        
        await copyWithCrop(hostReadFile, hostCropBytes, finalHostAccess);
        await copyWithCrop(guestReadFile, guestCropBytes, finalGuestAccess);
        
        finalHostAccess.close();
        finalGuestAccess.close();
        
        self.postMessage({ type: 'CROP_DONE', hostFile: hostName, guestFile: guestName });
        
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
