# Contributing to Wave Shed

First off, thank you for considering contributing to Wave Shed! This project was born for FOSS Hack 2026, and we are thrilled to welcome developers, designers, and audio enthusiasts to help us build a truly open-source, privacy-focused alternative to platforms like Riverside.

Wave Shed is a free, open-source tool that provides peer-to-peer (P2P) audio recording with local capture. By contributing, you agree to release your code under the MIT License.

## Table of Contents
1. [Architecture Documentation](#architecture-documentation)
2. [Getting Started](#getting-started)
3. [Future Plans & Roadmap](#future-plans--roadmap)
4. [How to Contribute](#how-to-contribute)
5. [Code of Conduct](./CODE_OF_CONDUCT.md)

---

## Architecture Documentation

Before diving into the codebase, please review our architectural documentation to understand how Wave Shed separates its workloads across the main thread and background workers:

* **[Audio Architecture](./docs/audio-architecture.md)**: Details WebRTC signaling, P2P mesh, and the raw PCM capture pipeline.
* **[AI & Processing Architecture](./docs/ai-processing.md)**: Covers local ONNX models, WASM implementations (Whisper/RNNoise), and the virtual timeline editing system.
* **[Frontend Architecture](./docs/frontend.md)**: Explains the text-based UI paradigm, styling, and event-driven state management.

---

## Getting Started

Because Wave Shed relies heavily on Web Workers, OPFS, and `SharedArrayBuffer` (for WASM), you cannot simply open `index.html` in your browser. 

1.  Clone the repository: `git clone https://github.com/yourusername/wave-shed.git`
2.  Navigate to the directory: `cd wave-shed`
3.  Serve the folder using a local web server that sets the correct cross-origin headers (required for precise audio timing and WASM). For example, using Python:
    ```bash
    python -m http.server 8000
    ```
4.  Open `http://localhost:8000` in your browser.

---

## Future Plans & Roadmap

We are constantly looking to improve Wave Shed. If you're looking for a feature to champion, our immediate roadmap includes:

* **Better Timestamps and Transcription:** Improving the accuracy of the local transcription to handle overlapping speech and rapid dialogue more effectively.
* **NAS and Cloud Backups:** Adding secure, opt-in hooks to automatically push exported `.wav` files and project states to personal Network Attached Storage or cloud providers.
* **Video Support:** Expanding the P2P WebRTC mesh to capture and sync local video streams alongside the raw audio tracks.
* **Fine Tune Gap Detection:** Refining the custom offline Voice Activity Detection (VAD) algorithm to give users more granular control over silence removal.
* **Improve Noise Suppression:** Upgrading or fine-tuning the noise cancellation implementation to handle complex background environments without degrading voice quality.

---

## How to Contribute

### 1. Reporting Bugs
Open an issue! Please include:
* Your browser and operating system.
* Steps to reproduce the bug.
* Any errors showing in the developer console.

### 2. Submitting Pull Requests
1.  Fork the repository and create your branch from `main`.
2.  Ensure your code matches the existing vanilla JS / minimal-dependency philosophy.
3.  Test your changes to ensure they don't block the OPFS write pipeline or the WebRTC mesh logic.
4.  Submit your pull request!