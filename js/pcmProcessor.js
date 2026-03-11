class PCMProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.workerPort = null;
        this.expectedBlockDuration = 128 / sampleRate;
        this.isRecording = false;
        this.firstFrameReported = false;

        this.port.onmessage = (event) => {
            if (event.data.type === 'INIT_PORT') {
                this.workerPort = event.ports[0];
            } else if (event.data.command === 'start_recording') {
                this.isRecording = true;
                this.firstFrameReported = false;
            } else if (event.data.command === 'stop_recording') {
                this.isRecording = false;
            }
        };
    }

    process(inputs, outputs, parameters) {
        if (!this.isRecording) {
            this.firstFrameReported = false;
            return true;
        }

        // Report the timestamp of the very first recorded frame for sync calculations.
        if (!this.firstFrameReported) {
            this.port.postMessage({ type: 'RECORDING_STARTED', time: currentTime });
            this.firstFrameReported = true;
        }

        const input = inputs[0];
        if (input.length > 0 && input[0].length > 0) {
            // Mono mic input — only the first channel is used.
            const channelData = input[0];
            
            // Copy before transferring so the original buffer isn't detached.
            const bufferCopy = new Float32Array(channelData);
            
            if (this.workerPort) {
                this.workerPort.postMessage({
                    type: 'pcm-data',
                    data: bufferCopy.buffer
                }, [bufferCopy.buffer]); // Transfer ownership for zero-copy performance.
            }
        }

        // Must return true to keep the AudioWorkletNode alive.
        return true;
    }
}

registerProcessor('pcm-processor', PCMProcessor);
