// js/exportWorker.js
// Heavy-duty background orchestrator mapping the Virtual Timeline perfectly into finalized WAV envelopes without destroying RAM.

self.onmessage = async (e) => {
    if (e.data.type !== 'start_export') return;
    
    const { takeId, mix, format, tracksConf, globalMaxDuration, baseSampleRate } = e.data;
    
    // Chunking parameters! A strictly safe ceiling.
    // 10 seconds of mono 48kHz audio = 480,000 samples = ~1.9MB footprint. Perfect isolation.
    const CHUNK_LEN_SEC = 10; 
    
    const root = await navigator.storage.getDirectory();
    
    if (mix) {
        // TWO-PASS MIX EXPORT
        // Pass 1: Global Maximum Peak alignment dynamically calculated chunk by chunk
        let maxPeak = 0;
        let pass1VirtualTime = 0;
        
        while (pass1VirtualTime < globalMaxDuration) {
            const vEnd = Math.min(pass1VirtualTime + CHUNK_LEN_SEC, globalMaxDuration);
            const mixed = await buildMixChunk(pass1VirtualTime, vEnd, tracksConf, root, baseSampleRate);
            
            for (let i = 0; i < mixed.length; i++) {
                const abs = Math.abs(mixed[i]);
                if (abs > maxPeak) maxPeak = abs;
            }
            
            pass1VirtualTime = vEnd;
            const pct = (pass1VirtualTime / globalMaxDuration) * 50; 
            self.postMessage({ type: 'progress', pct: Math.floor(pct) });
        }
        
        // Pass 2: Baking, applying Normalization organically if the headroom clipped out 0.99
        let gain = 1.0;
        if (maxPeak > 0.99) {
            gain = 0.99 / maxPeak;
        }
        
        let pass2VirtualTime = 0;
        let blobParts = [];
        blobParts.push(new ArrayBuffer(44)); // Empty placeholder safely waiting for bytes
        let totalSamples = 0;
        
        while (pass2VirtualTime < globalMaxDuration) {
            const vEnd = Math.min(pass2VirtualTime + CHUNK_LEN_SEC, globalMaxDuration);
            const mixed = await buildMixChunk(pass2VirtualTime, vEnd, tracksConf, root, baseSampleRate);
            
            // Attenuate chunk securely against gain threshold safely
            if (gain !== 1.0) {
                for (let i = 0; i < mixed.length; i++) {
                    mixed[i] *= gain;
                }
            }
            
            // Cloning directly strips references against heap bounds safely
            const buffer = new Uint8Array(mixed.buffer).slice().buffer;
            blobParts.push(buffer);
            totalSamples += mixed.length;
            
            pass2VirtualTime = vEnd;
            const pct = 50 + ((pass2VirtualTime / globalMaxDuration) * 50);
            self.postMessage({ type: 'progress', pct: Math.floor(pct) });
        }
        
        // Backpatching standard WAV header payload into array natively
        blobParts[0] = buildWavHeader(totalSamples, baseSampleRate);
        
        const finalBlob = new Blob(blobParts, { type: 'audio/wav' });
        self.postMessage({ type: 'complete', blobs: { 'mix': finalBlob } });
        
    } else {
        // NON-MIX EXPORT (SEPARATED TRACKS)
        const blobs = {};
        const trackIds = Object.keys(tracksConf);
        let completedTracks = 0;
        
        for (const peerId of trackIds) {
            const track = tracksConf[peerId];
            if (track.muted) {
                // If utterly muted globally on the timeline, simply skip bypassing the loop completely
                completedTracks++;
                continue;
            }
            
            let vTime = 0;
            let blobParts = [new ArrayBuffer(44)]; // Empty placeholder
            let totalSamples = 0;
            
            while (vTime < globalMaxDuration) {
                const vEnd = Math.min(vTime + CHUNK_LEN_SEC, globalMaxDuration);
                const floatArray = await buildTrackChunk(peerId, track, vTime, vEnd, root, baseSampleRate);
                
                const buffer = new Uint8Array(floatArray.buffer).slice().buffer;
                blobParts.push(buffer);
                totalSamples += floatArray.length;
                
                vTime = vEnd;
                // Output composite progress dynamically tracking isolation
                const overallPct = ((completedTracks + (vTime / globalMaxDuration)) / trackIds.length) * 100;
                self.postMessage({ type: 'progress', pct: Math.floor(overallPct) });
            }
            
            blobParts[0] = buildWavHeader(totalSamples, track.sampleRate);
            blobs[peerId] = new Blob(blobParts, { type: 'audio/wav' });
            completedTracks++;
        }
        
        self.postMessage({ type: 'complete', blobs: blobs });
    }
};

async function buildMixChunk(vStart, vEnd, tracksConf, root, mixSampleRate) {
    const durationSec = vEnd - vStart;
    const numSamples = Math.floor(durationSec * mixSampleRate);
    const mixed = new Float32Array(numSamples);
    
    for (const [peerId, track] of Object.entries(tracksConf)) {
        if (track.muted) continue; 
        
        const trackAudio = await buildTrackChunk(peerId, track, vStart, vEnd, root, mixSampleRate);
        
        for (let i = 0; i < numSamples; i++) {
            mixed[i] += (trackAudio[i] || 0);
        }
    }
    return mixed;
}

// Strictly retrieves absolute native bytes from isolated slices
async function buildTrackChunk(peerId, track, vStart, vEnd, root, targetSampleRate) {
    const durationSec = vEnd - vStart;
    const numSamples = Math.floor(durationSec * targetSampleRate);
    const output = new Float32Array(numSamples); // Defaults structurally zero filled safely
    
    if (vStart >= track.virtualDuration) {
        return output; 
    }
    
    const segments = track.segments.filter(s => vStart < s.virtualEnd && vEnd > s.virtualStart);
    
    let handle;
    try {
        handle = await root.getFileHandle(track.fileName);
    } catch(e) { return output; }
    
    const file = await handle.getFile();
    
    for (const seg of segments) {
        if (seg.isGap || seg.isMuted) {
            continue;
        }

        const overlapStart = Math.max(vStart, seg.virtualStart);
        const overlapEnd = Math.min(vEnd, seg.virtualEnd);
        if (overlapEnd <= overlapStart) continue;
        
        const offsetSec = overlapStart - vStart;
        const outStartIndex = Math.floor(offsetSec * targetSampleRate);
        const outWriteSamples = Math.floor((overlapEnd - overlapStart) * targetSampleRate);
        
        // Find safe OPFS locations decoupled dynamically from internal pointers securely
        const srcSecStart = seg.sourceStartByte / (track.sampleRate * 4);
        const segmentTimeOffset = overlapStart - seg.virtualStart;
        
        const byteStart = Math.floor((srcSecStart + segmentTimeOffset) * track.sampleRate * 4);
        const byteEnd = Math.floor((srcSecStart + segmentTimeOffset + (overlapEnd - overlapStart)) * track.sampleRate * 4);
        
        if (byteStart >= byteEnd) continue;
        
        const blob = file.slice(byteStart, byteEnd);
        const arr = await blob.arrayBuffer();
        const f32 = new Float32Array(arr);
        
        if (track.sampleRate === targetSampleRate) {
            for (let i = 0; i < Math.min(outWriteSamples, f32.length); i++) {
                output[outStartIndex + i] = f32[i];
            }
        } else {
            // Failsafe resampler dynamically maintaining safety parameters exclusively
            const ratio = track.sampleRate / targetSampleRate;
            for (let i = 0; i < outWriteSamples; i++) {
                const srcIdx = Math.min(Math.floor(i * ratio), f32.length - 1);
                output[outStartIndex + i] = f32[srcIdx] || 0;
            }
        }
    }
    
    return output;
}

function buildWavHeader(numSamples, sampleRate) {
    const rawByteLength = numSamples * 4;
    const headerBuffer = new ArrayBuffer(44);
    const view = new DataView(headerBuffer);
    
    const writeString = (v, offset, str) => {
        for (let i = 0; i < str.length; i++) {
            v.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + rawByteLength, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); 
    view.setUint16(20, 3, true); // float32 Native encoding
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true); 
    view.setUint16(34, 32, true);
    writeString(view, 36, 'data');
    view.setUint32(40, rawByteLength, true);

    return headerBuffer;
}
