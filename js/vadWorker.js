// vadWorker.js
// Energy-based (RMS) Voice Activity Detection — no CDN dependency, works offline.
// The @ricky0123/vad-web dist/index.js is a CJS module that fails in strict ESM workers
// ("exports is not defined"), so we implement a robust built-in VAD instead.

self.onmessage = async (e) => {
    const { type, takeId, peerId, audioData, threshold } = e.data;
    if (type !== 'analyze') return;

    try {
        const speechSegments = energyVAD(audioData, threshold || 0.5);
        self.postMessage({ type: 'complete', peerId, takeId, speechSegments });
    } catch (err) {
        self.postMessage({ type: 'error', peerId, takeId, error: err.message });
    }
};

/**
 * Simple RMS energy VAD.
 *
 * @param {Float32Array} audioData   16 kHz mono
 * @param {number}       sensitivity 0–1; higher = quieter sections count as speech
 * @returns {{ start: number, end: number }[]}  Speech segments in seconds
 */
function energyVAD(audioData, sensitivity = 0.5) {
    const SR          = 16000;
    const FRAME_MS    = 30;                              // 30 ms analysis frames
    const frameSize   = Math.floor(SR * FRAME_MS / 1000); // 480 samples
    const PAD_SEC     = 0.1;                             // 100 ms pre/post padding
    const padSamples  = Math.floor(SR * PAD_SEC);

    // Derive RMS for every frame
    const frames = [];
    for (let i = 0; i < audioData.length; i += frameSize) {
        const end = Math.min(i + frameSize, audioData.length);
        let sum = 0;
        for (let j = i; j < end; j++) sum += audioData[j] * audioData[j];
        frames.push(Math.sqrt(sum / (end - i)));
    }

    // Adaptive threshold: take the 90th-percentile RMS and scale by (1 - sensitivity)
    const sorted   = [...frames].sort((a, b) => a - b);
    const p90      = sorted[Math.floor(sorted.length * 0.9)] || 0.01;
    const thresh   = p90 * (1 - Math.min(0.95, Math.max(0.05, sensitivity)));

    // State-machine to merge speech runs (debounce silence with SILENCE_FRAMES)
    const SILENCE_FRAMES = Math.ceil(300 / FRAME_MS); // 300 ms of silence ends a segment
    const speechSegments = [];
    let inSpeech = false, speechStartSample = 0, silenceCount = 0;

    frames.forEach((rms, fi) => {
        const samplePos = fi * frameSize;
        if (rms >= thresh) {
            if (!inSpeech) {
                inSpeech = true;
                speechStartSample = Math.max(0, samplePos - padSamples);
            }
            silenceCount = 0;
        } else if (inSpeech) {
            silenceCount++;
            if (silenceCount >= SILENCE_FRAMES) {
                inSpeech = false;
                const endSample = Math.min(audioData.length, samplePos + padSamples);
                speechSegments.push({ start: speechStartSample / SR, end: endSample / SR });
            }
        }
    });

    if (inSpeech) {
        speechSegments.push({ start: speechStartSample / SR, end: audioData.length / SR });
    }

    return speechSegments;
}
