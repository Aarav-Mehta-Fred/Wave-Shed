# Audio Architecture

This document covers the architecture for real-time multi-participant audio communication, capture, file transfer, and sample-accurate synchronization. The system is built around four sequential phases, each with distinct responsibilities.

## Core Components

Three files work together across separate browser threads to keep the main UI responsive while recording and processing audio.

* **`audio.js`**: The orchestrator. It manages PeerJS connections for the multi-guest mesh, runs the Web Audio API pipeline, coordinates the four-phase recording lifecycle, and handles all synchronization math. Per-guest state lives in Maps keyed by peer ID.
* **`app.js`**: The UI layer. It manages microphone permissions, participant info (name, headphones, speaker), the host admission prompt, and progress bar display. It exposes hooks like `updateProgress` and `promptAdmission` that `audio.js` calls into.
* **`pcmProcessor.js`**: An `AudioWorkletProcessor` on the browser's audio render thread. It captures raw Float32 PCM samples from the microphone and transfers them to the Web Worker through a `MessageChannel`, avoiding the main thread entirely.
* **`audioWorker.js`**: A Web Worker that handles all heavy I/O. It writes PCM data to the Origin Private File System (OPFS), manages per-guest file handles via a `guestFiles` Map, and handles FLAC compression/decompression using `libflacjs`. File cropping for sync alignment also happens here.

## Dual Audio Streams

Each participant runs two independent microphone streams from the same device:

* **Recording stream (`mediaStream`)**: All browser audio processing is disabled (`echoCancellation`, `autoGainControl`, `noiseSuppression` all set to `false`). This produces a clean, unaltered signal for the raw PCM capture pipeline.
* **Comms stream (`commsStream`)**: Auto-gain and noise suppression are always enabled. Echo cancellation is toggled based on whether the participant is wearing headphones. This stream feeds the WebRTC voice calls so everyone can hear each other clearly during the session.

The recording stream routes into the `pcmProcessor` AudioWorklet. The comms stream routes into PeerJS `call()` and `answer()` methods. They never cross paths.

## Multi-Guest Connection Mesh

The system supports multiple guests joining a single host. The connection topology works like this:

1. **Guest joins**: The guest opens a PeerJS data channel to the host, attaching their participant info (name, headphones, speaker, mic) as connection metadata.
2. **Admission**: The host is prompted to accept or reject the guest. If accepted, the guest is stored in the `guests` Map and an `ADMISSION_ACCEPTED` message is sent back with a roster of all existing guest peer IDs.
3. **Voice mesh**: The new guest calls every existing guest directly for voice (peer-to-peer, no relay through the host). Existing guests accept incoming calls from the new peer ID. The host also exchanges voice calls with every guest.
4. **Data channels**: Only the host-to-guest data channels are used for telemetry, timestamps, and file transfer. Guest-to-guest connections are voice-only.

PeerJS connections include retry logic to handle Koyeb cold starts, where the signaling server may return a 503 before it wakes up.

## Phase 1: Setup and Audio Routing

This phase runs when a participant first connects, before any recording begins.

1. **Microphone access**: The user's selected mic is opened twice (once for recording, once for comms). The hardware input latency from the audio track settings and the AudioContext's base latency are summed and cached for later timestamp correction.
2. **Worker and worklet init**: The `audioWorker` Web Worker is created, and `pcmProcessor` is loaded into the AudioContext. A `MessageChannel` bridges the worklet to the worker, letting PCM data flow from the audio thread to the worker thread without touching the main thread.
3. **Pipeline wiring**: The recording `mediaStream` is connected to the `pcmProcessor` as a sink. The worklet's output is intentionally left disconnected to prevent local monitoring feedback. The worker opens an OPFS file for the local recording.
4. **Live comms**: The processed `commsStream` is sent through PeerJS voice calls. Incoming voice streams are routed to hidden `Audio` elements for playback.

## Phase 2: Network Tests and Recording

Precise synchronization depends on accurate round-trip time measurements taken with the audio hardware clock (`AudioContext.currentTime`).

1. **Sequential initial pings**: When the host starts recording, an initial ping is sent to each guest one at a time. The host waits for each response before moving to the next guest. This measures a baseline RTT and clock offset per guest.
2. **Countdown and start**: The host records its countdown start time, fires a 5-second visual countdown, and sends `START_RECORDING_CMD` to each guest offset by their individual half-RTT so all machines begin roughly simultaneously.
3. **Network flooding**: For the first 3 seconds of the countdown, the host floods all guests with ping-pong tests in round-robin order (one every 150ms). These samples are stored per-guest so the sync phase can pick the best (lowest RTT) measurement.
4. **Recording triggers**: At 4.5 seconds into the countdown, both host and guests tell their `pcmProcessor` to start recording. The worklet captures the exact `currentTime` of its first audio frame and reports it back to the main thread, where it is corrected for input latency.
5. **Stop handshake**: When the host stops recording, it sends `STOP_PING` to every guest, capturing its local audio time as `T4`. Each guest responds with `STOP_PONG` containing its own timestamps `T5` and `T6`. The host logs the final `T7` on receipt. These four timestamps per guest feed into the stop-time clock offset calculation.

## Phase 3: File Extraction

After recording stops, each guest's raw audio file needs to get to the host. All guest transfers run in parallel.

1. **File closing**: The guest's worklet stops recording. When the host sends `CMD_EXTRACT`, the guest tells its worker to flush and close the local OPFS file handle.
2. **FLAC compression**: The guest's worker reads the raw Float32 file and encodes it to 16-bit FLAC using `libflacjs`. Compression progress is shown locally and relayed to the host via the data channel.
3. **Chunked transfer**: The compressed file is read in 16KB chunks and sent over the WebRTC data channel. The host's worker writes each incoming chunk to a per-guest OPFS file (created lazily on first write via `ensureGuestFile`).
4. **Backpressure**: The host's worker sends `ACK_READ` after writing each chunk. The guest waits for this acknowledgement before sending the next chunk, preventing buffer overflow on the data channel.
5. **Telemetry delivery**: After the last chunk, the guest sends a JSON message with its recording start time, sample rate, and input latency. Once all guests have sent their telemetry, the host triggers parallel decompression.

## Phase 4: Sync and Post-Processing

This runs entirely on the host's machine after all guest files and telemetry have arrived.

1. **FLAC decompression**: Each guest's compressed file is decoded back to raw Float32 PCM in the worker. Decompression runs per-guest, and the worker tags progress messages with the guest ID for per-guest progress bars.
2. **Best RTT selection**: For each guest, the host iterates over all collected network test samples and picks the one with the lowest RTT. This minimizes the effect of network jitter on the clock offset estimate.
3. **Clock offset math**: Using the best test's timestamps (T0, T1, T2, T3):
   - `RTT = (T3 - T0) - (T2 - T1)`
   - `Start_Offset = (T0 + RTT/2) - T1`
   
   A similar calculation runs on the stop handshake timestamps to get the end-of-recording offset.
4. **Crop calculation**: The host figures out how much audio precedes the countdown origin (`hostCountdownStart + 5s`) in each file:
   - Host crop: `(hostCountdownStart + 5) - hostRecordingStart`
   - Guest crop: `(hostCountdownStart + 5) - (guestRecordingStart + startOffset)`
   
   These durations are converted to byte offsets using each track's sample rate (4 bytes per Float32 sample).
5. **File cropping**: The worker slices the calculated number of bytes off the front of each raw file, writing the remainder to final output files. This is done for the host file once and for each guest file independently.
6. **WAV export**: Each cropped raw file gets a 44-byte WAV header prepended (RIFF/WAVE format, 32-bit float, mono) and is offered as a browser download. The host file uses the host's sample rate; each guest file uses the sample rate reported in that guest's telemetry.
