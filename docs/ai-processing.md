# AI & Processing Architecture

This document describes the architecture for the in-browser AI processing, non-destructive editing, playback scheduling, and audio export pipeline. The system runs entirely locally leveraging WebAssembly (WASM), ONNX models, and Web Workers to ensure complete data privacy and zero UI blocking. 

---

## Table of Contents

1. [Core Components](#core-components)
2. [Thread and Memory Model](#thread-and-memory-model)
3. [The Virtual Timeline (Non-Destructive Editing)](#the-virtual-timeline-non-destructive-editing)
4. [AI Processing Subsystems](#ai-processing-subsystems)
5. [The Playback Engine](#the-playback-engine)
6. [The Export Engine](#the-export-engine)

---

## Core Components

Six primary files manage the asynchronous AI operations, playback scheduling, and file generation.

| File | Context | Responsibility |
|---|---|---|
| `ai.js` | Main thread | Orchestrator. Manages worker pools, queues jobs, resamples audio via `OfflineAudioContext`, computes overlap logic for edits, and updates `SessionDB`. |
| `player.js` | Main thread | Playback Manager. Translates database operations into a Virtual Timeline, dynamically extracts chunked peaks for the UI, and runs a Lookahead Scheduler to stream audio directly from OPFS without loading full files into RAM. |
| `transcribeWorker.js` | Worker thread | Uses `@xenova/transformers` (Whisper ONNX) to transcribe 16kHz audio arrays into timestamped word arrays. |
| `vadWorker.js` | Worker thread | Runs a custom offline RMS energy-based Voice Activity Detection (VAD) algorithm to find silent segments without relying on heavy external modules. |
| `rnnoiseWorker.js` | Worker thread | Utilises Mozilla's RNNoise via WebAssembly (`@shiguredo/rnnoise-wasm`) to process raw Float32 payloads in 480-sample frames, outputting noise-cancelled OPFS files. |
| `exportWorker.js` | Worker thread | Heavy-duty chunked exporter. Replays the virtual timeline in 10-second memory-safe blocks. Handles two-pass mixing (peak detection followed by normalisation) and writes final `.wav` blobs. |

---

## Thread and Memory Model

To process multi-gigabyte raw Float32 files without crashing the browser tab (OOM errors) or dropping animation frames, the system enforces a strict isolation policy. The main thread never holds full audio buffers.

```text
Main Thread (ai.js, player.js, SessionDB)
    |
    |-- OPFS slice() & decodeAudioData() --> Scheduled AudioContext Playback
    |-- OfflineAudioContext (16kHz Downsampling)
    |
    |-- Message (Float32Array Transfer) --> Transcribe Worker (Whisper ONNX)
    |-- Message (Float32Array Transfer) --> VAD Worker (RMS Energy Engine)
    |-- Message (Float32Array Transfer) --> RNNoise Worker (WASM)
    |-- Message (Virtual Timeline Map)  --> Export Worker
                                                |
                                                |-- OPFS (Reads raw chunks)
                                                |-- OPFS (Reads nc-*.raw chunks)
                                                |-- Generates final WAV Blob