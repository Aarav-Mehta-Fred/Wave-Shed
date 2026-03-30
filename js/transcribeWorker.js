// transcribeWorker.js
// Runs Whisper (Xenova/whisper-tiny.en) via @xenova/transformers for automatic speech recognition.
// The CDN import is done lazily inside the message handler so self.addEventListener is always
// registered regardless of whether the CDN is reachable — avoids a silent infinite hang.

let _pipeline = null;
let _env      = null;
let _moduleErr = null;

async function loadModule() {
    if (_pipeline) return _pipeline;
    if (_moduleErr) throw _moduleErr;
    try {
        const mod = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js');
        _pipeline = mod.pipeline;
        _env      = mod.env;
        _env.allowLocalModels = false;
        _env.useBrowserCache  = true;
        return _pipeline;
    } catch (err) {
        _moduleErr = err;
        throw err;
    }
}

class PipelineSingleton {
    static task     = 'automatic-speech-recognition';
    static model    = 'Xenova/whisper-tiny.en';
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            const pipeline = await loadModule();
            this.instance  = await pipeline(this.task, this.model, {
                progress_callback,
                quantized: true,
            });
        }
        return this.instance;
    }
}

self.addEventListener('message', async (event) => {
    const { type, audioData, takeId, peerId } = event.data;
    if (type !== 'transcribe') return;

    try {
        const transcriber = await PipelineSingleton.getInstance((progress) => {
            self.postMessage({ type: 'progress', takeId, peerId, progress });
        });

        const output = await transcriber(audioData, {
            chunk_length_s:    30,
            stride_length_s:   5,
            return_timestamps: 'word',
            // chunk_callback intentionally omitted: the pipeline's intermediate chunk
            // objects are Transformers.js class instances and cannot be structured-cloned
            // via postMessage. All word/timestamp data is present in the final `output`.
        });

        self.postMessage({ type: 'complete', takeId, peerId, output });
    } catch (error) {
        console.error('[Worker] Transcription failed:', error);
        self.postMessage({
            type:  'error',
            takeId,
            peerId,
            error: error.message || error.toString()
        });
    }
});
