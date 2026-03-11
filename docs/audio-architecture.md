# Audio Architecture

This document outlines the architecture for the real-time audio communication, capture, extraction, and accurate synchronization system. The architecture is logically grouped into a four-phase initialization and processing structure.

## Core Components

The architecture relies heavily on multithreading and browser-level abstractions to ensure high-performance, non-blocking execution throughout the recording lifecycle.

* **`audio.js`**: The main orchestrator and state manager. It handles WebRTC peer connections, manages the Web Audio API pipeline, and oversees the complete state machine of synchronization through network telemetry and worker coordination.
* **`pcmProcessor.js`**: An `AudioWorkletProcessor` running on the browser's dedicated audio render thread. It handles the low-level capture of raw PCM data streaming directly from the selected microphone, maintaining real-time capture bounds with minimal audio buffer drops. It securely transfers data out of the render thread to the Web Worker.
* **`audioWorker.js`**: A Web Worker responsible for isolating heavy I/O operations and computation away from the main thread. This worker natively interacts with the Origin Private File System (OPFS) and manages read/write streams, FLAC compression and decompression using `libflacjs`, and precise file modifications natively in byte offsets.

## Phase 1: Setup and Audio Routing

The initialization phase configures the environment based on whether the participant is the host or the incoming guest.

1. **Hardware Calibration**: The user's microphone is securely accessed. The physical hardware input latency and the core base latency of the active AudioContext are cached to calculate the actual hardware entry time.
2. **Live Routing**: A secure PeerJS connection negotiates a reliable data channel alongside a standard MediaStream connection. The WebRTC stream is routed into a hidden audio element to give participants live communication natively.
3. **Pipeline Construction**: The `pcmProcessor` is loaded into the Audio Context. The microphone output is securely routed to the `pcmProcessor` as a sink. No connection is made to the local destination output to prevent feedback loops.
4. **Zero-Copy Transfers**: A `MessageChannel` establishes a direct port-to-port bridge bypassing the main thread. Raw float32 PCM data streams directly from the `pcmProcessor` over this bridge into the `audioWorker.js` for disk writing.

## Phase 2: RTT Network Tests

Attaining sub-millisecond precision over varied network configurations requires aggressive round-trip time (RTT) modeling ahead of time.

1. **Baseline Ping**: An initial ping resolves the primary clock differences and the baseline RTT before any audio capture actually activates.
2. **Calculated Synchronization**: Rather than starting randomly, the host provides a countdown sequence combined with half of the RTT. The host delays the guest's start command algorithmically so both machines execute the command sequentially at an identical moment.
3. **Network Flooding**: A burst sequence floods the connection with ping/pong telemetry tests for three seconds prior to the start command. This generates an array of samples, allowing the host to select the minimum RTT, removing variable network spike noise.
4. **First Frame Verification**: The exact moment the very first audio frame hits the `pcmProcessor` is captured and recorded. This timestamp is corrected against the previously logged initial hardware input latency to find the true moment sound entered the physical microphone.
5. **Stop Handshake**: Once testing concludes, a mirrored stop handshake fires, determining the drift and ensuring timing validity prior to file transfer.

## Phase 3: Data Extraction

Uncompressed floating-point audio files are expensive to transmit. The third phase focuses on localized compression and reliable chunked extraction to securely move data from the guest to the host.

1. **IO Flushing**: Upon receiving the stop command, all ongoing audio connections are gracefully severed, and OPFS file handles are flushed so that no data remains trapped in memory buffers.
2. **Lossless FLAC Compression**: The guest's `audioWorker` allocates a large read buffer on the raw local recording and streams it directly into a `libflacjs` encoder instance. Floating point data is down-sampled cleanly into 16-bit PCM FLAC files.
3. **Lockstep Chunking**: The resulting zipped data streams natively from the disk in 16-kilobyte chunks back up over to the `audio.js` scope, feeding directly into the WebRTC data channel limitlessly.
4. **Data Receiving**: The host traps these incoming chunks, pushing them directly through to its own worker to be appended to a temporary guest binary OPFS file.
5. **Flow Control Registration**: The worker issues sequential `ACK_READ` acknowledgements to avoid overflowing connection buffers natively provided through the web.

## Phase 4: Sync and Post-Processing

With all binary assets housed securely on the host machine, the final phase extracts, aligns, and merges audio into its final state based entirely on recorded offsets.

1. **Information Delivery**: The guest concludes communication by sending its final synchronization properties: physical input latency, hardware entry time, and calculated sample rate.
2. **Decompression Restoring**: The host unpacks the received FLAC sequence natively within the worker. It iterates and safely decompresses back up to the original uncompressed 32-bit Float standards into its original size.
3. **Calculation Modeling**: The true delay between host countdown and guest start execution is formed utilizing the absolute lowest collected RTT time. The result produces the true local execution offset.
4. **Perfect Alignment**: The delay offset calculation mathematically matches against the 5-second start padding block. Using the unique sample rates, the required length is mapped definitively into single-byte offsets.
5. **File Extraction and Cropping**: The precise byte differences are sheared securely off the beginning of both the host's file and the decompressed guest file natively in their local OPFS handles. 
6. **WAV Compiling**: Fully aligned raw files drop into standard format algorithms, prepending WAV headers corresponding exactly to channel configurations, instantly offering them natively wrapped back to the browser user.
