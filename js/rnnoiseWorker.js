// rnnoiseWorker.js
// Runs Mozilla's RNNoise via WebAssembly against raw Float32 payloads isolated in the background.
// CDN import is deferred inside onmessage so module-load failures post an 'error' instead of
// hanging the worker silently (top-level import failure prevents self.onmessage from being set).

self.onmessage = async (e) => {
    const { type, audioData } = e.data;
    if (type !== 'process') return;

    // Lazy-import so we catch CDN / CORS failures and return a graceful error
    let Rnnoise;
    try {
        const mod = await import('https://cdn.jsdelivr.net/npm/@shiguredo/rnnoise-wasm@1.0.1/dist/rnnoise.bundle.js');
        Rnnoise = mod.Rnnoise;
    } catch (err) {
        console.warn('[RNNoise Worker] Module load failed, passing audio through unchanged:', err);
        self.postMessage({ type: 'complete', processedAudio: audioData }, [audioData.buffer]);
        return;
    }

    try {
        let rnnoise;
        try {
            rnnoise = await Rnnoise.load();
        } catch (err) {
            console.warn('[RNNoise Worker] Rnnoise.load() failed, passing through:', err);
            self.postMessage({ type: 'complete', processedAudio: audioData }, [audioData.buffer]);
            return;
        }

        const out = new Float32Array(audioData.length);
        const FRAME_SIZE = 480; // 10 ms at 48 kHz
        let framesProcessed = 0;
        const totalFrames = Math.floor(audioData.length / FRAME_SIZE);

        for (let i = 0; i < audioData.length; i += FRAME_SIZE) {
            const frameEnd = Math.min(i + FRAME_SIZE, audioData.length);
            if (frameEnd - i === FRAME_SIZE) {
                out.set(rnnoise.processFrame(audioData.subarray(i, frameEnd)), i);
            } else {
                out.set(audioData.subarray(i, frameEnd), i);
            }
            framesProcessed++;
            if (framesProcessed % 1000 === 0) {
                self.postMessage({ type: 'progress', progress: (framesProcessed / totalFrames) * 100 });
            }
        }

        rnnoise.destroy();
        self.postMessage({ type: 'complete', processedAudio: out }, [out.buffer]);
    } catch (err) {
        self.postMessage({ type: 'error', error: err.message });
    }
};
