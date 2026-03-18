# Audio Architecture

This document describes the architecture for real-time multi-participant audio communication, local capture, peer-to-peer file transfer, sample-accurate synchronisation, and persistent session storage. Everything runs in the browser with no server involvement beyond WebRTC signalling. The system is organised into four sequential recording phases followed by a storage and export layer.

---

## Table of Contents

1. [Core Components](#core-components)
2. [Thread Model](#thread-model)
3. [Dual Audio Streams](#dual-audio-streams)
4. [Multi-Guest Connection Mesh](#multi-guest-connection-mesh)
5. [Phase 1: Setup and Audio Routing](#phase-1-setup-and-audio-routing)
6. [Phase 2: Network Tests and Recording](#phase-2-network-tests-and-recording)
7. [Phase 3: File Extraction and Transfer](#phase-3-file-extraction-and-transfer)
8. [Phase 4: Sync and Post-Processing](#phase-4-sync-and-post-processing)
9. [Storage and Session Management](#storage-and-session-management)
10. [OPFS File Lifecycle and Cleanup](#opfs-file-lifecycle-and-cleanup)

---

## Core Components

Six files share the work across separate browser contexts so the main UI stays responsive at all times.

| File | Context | Responsibility |
|---|---|---|
| `audio.js` | Main thread | Orchestrator. Manages PeerJS connections, the Web Audio pipeline, the four-phase recording lifecycle, all synchronisation math, and the public `window.AudioSync` API. Per-guest state lives in Maps keyed by peer ID. |
| `app.js` | Main thread | Connector layer between the UI and `audio.js`. Handles microphone permissions, participant info (name, headphones, speaker), the host admission prompt, progress callbacks, and all session library operations. Exposes hooks such as `updateProgress` and `promptAdmission` that `audio.js` calls into. |
| `pcmProcessor.js` | Audio render thread | An `AudioWorkletProcessor` that captures raw Float32 PCM samples from the microphone and forwards them to the Web Worker through a `MessageChannel`, bypassing the main thread entirely. |
| `audioWorker.js` | Worker thread | Handles all heavy I/O. Writes PCM data to OPFS, manages per-guest file handles, runs FLAC compression and decompression using `libflacjs`, deletes intermediate files after cropping, and writes telemetry directly to IndexedDB. |
| `sessionDB.js` | Main thread | Manages the `waveshed_db` IndexedDB database. Exposes `window.SessionDB` with methods for creating, reading, updating, and deleting session records, telemetry, and download logs. |
| `wakeLock.js` | Main thread | Prevents the screen from sleeping during active recording sessions. Uses the Screen Wake Lock API where available, with a silent looping video element as a fallback for browsers that do not support it. Re-acquires the lock automatically when the page becomes visible again. |

---

## Thread Model

The system uses three separate browser threads to keep audio capture and file I/O from blocking the UI.

```
Main Thread (audio.js + app.js + sessionDB.js + wakeLock.js)
    |
    |-- MessageChannel port --> Audio Render Thread (pcmProcessor.js)
    |                               |
    |                               |-- MessageChannel port --> Worker Thread (audioWorker.js)
    |                                                               |
    |                                                               |-- OPFS (raw PCM files)
    |                                                               |-- OPFS (FLAC transfer files)
    |                                                               |-- OPFS (final cropped files)
    |                                                               |-- IndexedDB (telemetry writes)
    |
    |-- PeerJS data channels --> Host only (telemetry, timestamps, file transfer)
    |-- PeerJS voice calls   --> All peers (host + every other guest)
```

PCM data flows from the audio thread directly to the worker thread. The main thread never touches audio buffers, which prevents any recording glitches caused by UI work. All worker messages are processed sequentially through a promise chain to prevent OPFS race conditions.

---

## Dual Audio Streams

Each participant opens two independent microphone streams from the same physical device.

### Recording Stream (`mediaStream`)
All browser audio processing is disabled: `echoCancellation`, `autoGainControl`, and `noiseSuppression` are all set to `false`. This produces a clean, unaltered signal that feeds the raw PCM capture pipeline via the `pcmProcessor` AudioWorklet.

### Comms Stream (`commsStream`)
Auto-gain and noise suppression are always enabled. Echo cancellation is toggled based on whether the participant reports wearing headphones. This stream feeds the WebRTC voice calls so everyone can hear each other clearly during the session.

Recording quality is never compromised by the processing applied to the live monitoring signal.

---

## Multi-Guest Connection Mesh

The system supports multiple guests joining a single host. Connections are established as follows.

**Step 1: Guest joins.** The guest opens a PeerJS data channel to the host, attaching participant info (name, headphones, speaker selection, mic ID) as connection metadata.

**Step 2: Admission.** The host is prompted to accept or reject the guest. If accepted, the guest is stored in the `guests` Map and an `ADMISSION_ACCEPTED` message is returned with a roster of all existing guest peer IDs.

**Step 3: Voice mesh.** The new guest calls every existing guest directly for voice (peer-to-peer, no relay through the host). Existing guests accept incoming calls from the new peer ID. The host also exchanges voice calls with every guest.

**Step 4: Data channels.** Only host-to-guest data channels are used for telemetry, timestamps, and file transfer. Guest-to-guest connections are voice-only.

PeerJS connections include retry logic to handle signalling server cold starts, where the server may return a `503` before it finishes waking up.

---

## Phase 1: Setup and Audio Routing

This phase runs when a participant first connects, before any recording begins.

**Microphone access.** The selected mic is opened twice (once per stream). The hardware input latency from the audio track settings and the `AudioContext` base latency are summed and cached for later timestamp correction.

**Worker and worklet initialisation.** The `audioWorker` Web Worker is created and `pcmProcessor` is loaded into the `AudioContext`. A `MessageChannel` bridges the worklet to the worker, letting PCM data flow from the audio thread to the worker thread without passing through the main thread. The worker immediately opens an OPFS file for the local recording and reports the filename back to the main thread via a `STATUS` message. On the host, this filename is stored for the session record.

**Database initialisation.** On the host side only, once the peer ID is known, the worker is sent an `OPEN_DB` message to open a connection to `waveshed_db`. This connection is held for the worker's lifetime and is used later to write telemetry directly from the worker without a main-thread round-trip. The `OPEN_DB` message blocks the worker's message queue until the connection is confirmed open.

**Session record creation.** The host generates a session ID and calls `app.onSessionCreated`, which writes an initial session record to IndexedDB with status `recording`, the raw host OPFS filename, and the host's sample rate.

**Pipeline wiring.** The recording `mediaStream` is connected to `pcmProcessor` as a sink. The worklet output is intentionally left disconnected to prevent local monitoring feedback.

**Live comms.** The processed `commsStream` is sent through PeerJS voice calls. Incoming voice streams are routed to hidden `<audio>` elements for playback.

---

## Phase 2: Network Tests and Recording

Precise synchronisation depends on accurate round-trip time (RTT) measurements taken against the audio hardware clock (`AudioContext.currentTime`).

**Sequential initial pings.** When the host starts the recording flow, an initial ping is sent to each guest one at a time. The host waits for each response before moving to the next. This gives a baseline RTT and clock offset per guest.

**Countdown and start.** The host records its countdown start time, fires a 5-second visual countdown, and sends `START_RECORDING_CMD` to each guest offset by their individual half-RTT so all machines begin capturing roughly simultaneously.

**Network flooding.** During the first 4 seconds of the countdown, the host floods all guests with ping-pong tests in round-robin order (one every 80ms). These samples are stored per guest so Phase 4 can select the best measurement.

**Recording triggers.** At 4.5 seconds into the countdown, both host and guests instruct their `pcmProcessor` to start recording. The worklet captures the exact `currentTime` of its first audio frame and reports it back to the main thread, where it is corrected for input latency.

**Stop handshake.** When the host stops recording, it sends `STOP_PING` to every guest, recording its local audio time as `T4`. Each guest replies with `STOP_PONG` containing its own timestamps `T5` and `T6`. The host logs the final timestamp `T7` on receipt. These four timestamps per guest feed into the stop-time clock offset calculation.

---

## Phase 3: File Extraction and Transfer

After recording stops, each guest's raw audio file is transferred to the host. All guest transfers run in parallel.

**File closing.** The guest's worklet stops recording. When the host sends `CMD_EXTRACT`, the guest instructs its worker to flush and close the local OPFS file handle.

**FLAC compression.** The guest's worker reads the raw Float32 PCM file and encodes it to 16-bit FLAC using `libflacjs`. Compression progress is reported locally and relayed to the host via the data channel.

**Chunked transfer.** The compressed file is read in 16 KB chunks and sent over the WebRTC data channel. The host's worker writes each incoming chunk to a per-guest OPFS file, created lazily on first write via `ensureGuestFile`. When a new guest file is created, the worker posts a `GUEST_FILE_CREATED` message to the main thread, which updates the session record's `rawGuestFiles` map in IndexedDB with the filename.

**Backpressure.** The host's worker sends `ACK_READ` after writing each chunk. The guest waits for this acknowledgement before sending the next chunk, preventing data channel buffer overflow.

**Telemetry delivery.** After the last chunk, the guest sends a JSON message containing its recording start time, sample rate, and input latency. Once all guests have delivered their telemetry, the host triggers parallel decompression.

---

## Phase 4: Sync and Post-Processing

This phase runs entirely on the host machine after all guest files and telemetry have arrived.

### FLAC Decompression

Each guest's compressed file is decoded back to raw Float32 PCM in the worker. Decompression runs per guest, and progress messages are tagged with the guest ID so each guest gets its own progress bar.

### Best RTT Selection

For each guest, the host iterates over all collected network test samples and picks the one with the lowest RTT. This minimises the effect of network jitter on the clock offset estimate.

### Clock Offset Calculation

Using the best test's timestamps `T0`, `T1`, `T2`, `T3`:

```
RTT          = (T3 - T0) - (T2 - T1)
Start_Offset = (T0 + RTT / 2) - T1
```

A parallel calculation runs on the stop handshake timestamps to produce an end-of-recording offset.

### Crop Calculation

The host calculates how much audio precedes the countdown origin (`hostCountdownStart + 5s`) in each file:

```
Host crop  = (hostCountdownStart + 5) - hostRecordingStart
Guest crop = (hostCountdownStart + 5) - (guestRecordingStart + startOffset)
```

These durations are converted to byte offsets using each track's sample rate (4 bytes per Float32 sample). The crop parameters are written to the session record in IndexedDB before the worker is instructed to crop, so they can be used to re-align tracks later if needed.

### Telemetry Write

Before sending the `CROP_FILES` message, the host sends a `WRITE_TELEMETRY` message to the worker for each guest. The worker merges the mute log it holds in memory and writes the complete telemetry record directly to the `telemetry` IndexedDB store from within the worker thread. The message queue blocks on this write completing before processing `CROP_FILES`, ensuring telemetry is persisted before any files are moved.

### File Cropping

The worker slices the calculated number of bytes off the front of each raw file and writes the remainder to a new output file. This happens once for the host file and independently for each guest file.

### WAV Export and Session Finalisation

Once cropping completes, the worker posts `CROP_DONE` with the final filenames. The main thread then, in order: updates the session record to `complete` in IndexedDB (storing aligned filenames, participant list, and duration), then triggers a WAV download for each track. Each download reads the OPFS file, prepends a 44-byte WAV header (RIFF/WAVE format, 32-bit float, mono), triggers an anchor click, and logs the download to the `downloads` IndexedDB store. The host file uses the host's sample rate; each guest file uses the sample rate reported in that guest's telemetry.

---

## Storage and Session Management

### Storage Systems

Three browser storage mechanisms are used, each with a distinct role.

**OPFS** holds all raw audio files during and after a session. It is the only storage capable of handling the write throughput required during recording.

**IndexedDB** (`waveshed_db`) is the persistent store for all structured data. It contains three object stores:

- `sessions`: one record per completed recording session, including OPFS filenames, crop parameters, participant list, duration, and status (`recording`, `processing`, `complete`, `error`).
- `telemetry`: one record per guest per session, written directly from the worker thread. Contains network test samples, best RTT, clock offsets, stop handshake timestamps, and the full mute log.
- `downloads`: a log of every WAV file the host has downloaded, keyed by session ID, track type, and peer ID.

**localStorage** holds only two short-lived session flags used for reconnection: `waveshed_session` and `waveshed_admitted_guests`. Both are cleared at session end.

### Session Library

The `window.app` object exposes the following methods for the UI to interact with stored sessions:

- `getSessions()`: returns all session records sorted by creation date descending.
- `getSessionDetail(sessionId)`: returns a single session record plus all its telemetry records.
- `requestDownload(sessionId, type, peerId)`: triggers a WAV download for a specific track type (`raw_host`, `raw_guest`, `aligned_host`, `aligned_guest`) and logs it.
- `requestBulkDownload(sessionId)`: downloads all aligned tracks for a session.
- `deleteSession(sessionId)`: guards against deletion of active sessions, removes all associated OPFS files, and deletes the session, telemetry, and download records from IndexedDB.

---

## OPFS File Lifecycle and Cleanup

The table below shows every file created in OPFS during a session and when it is deleted.

| File | Created | Deleted |
|---|---|---|
| `recording-{ts}.raw` | Worker startup (host and guest) | After `CROP_DONE` on the host. On the guest, the worker is terminated after transfer and the file is left to be evicted by the browser, as the guest has no further session context. |
| `guest-{id}-{ts}.raw` | First chunk received from a guest (host worker) | After `CROP_DONE`, once the decompressed file exists. |
| `guest-decompressed-{id}-{ts}.raw` | After decompression of each guest's FLAC (host worker) | After `CROP_DONE`, once the cropped final file exists. |
| `final-host-{ts}.raw` | After crop (host worker) | When the host explicitly deletes the session via `app.deleteSession`. |
| `final-guest-{id}-{ts}.raw` | After crop (host worker) | When the host explicitly deletes the session via `app.deleteSession`. |

Deletion of intermediate files (`recording-{ts}.raw`, `guest-{id}-{ts}.raw`, `guest-decompressed-{id}-{ts}.raw`) happens automatically inside the worker immediately after `CROP_DONE` is posted. The worker tracks the original filenames in dedicated Maps (`hostRawFileName`, `guestFlacFileNames`, `guestDecompressedFileNames`) so the correct files are always deleted regardless of how `fileHandle` pointers have been re-used during processing.

Deletion of final files (`final-host` and `final-guest`) is triggered only by an explicit `app.deleteSession` call. If the live worker is running, deletion is routed through `AudioSync.deleteFiles`, which posts a `DELETE_FILES` message to the worker. If no worker is running (for example, when managing past sessions), `deleteSession` falls back to accessing OPFS directly from the main thread.