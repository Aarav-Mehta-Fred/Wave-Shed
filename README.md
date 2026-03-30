# Wave-Shed
## Overview  

WaveShed is a free, open-source, privacy focused tool to help you record and edit podcasts. It provides for peer-to-peer audio recording, with local capture, so that everything runs in your browser with minimal server involvement.

## Features
1. Peer-to-peer (P2P) audio recording infrastructure


2. Local AI Post-Processing
- Noise Cancellation : Reduces background noise in recordings
- Text-Based Editing : Provides users with a transcript where they can cut out any text to remove it from the audio track and shows all the gaps detected and cut out in the previous step so users can manually adjust length.
- Smart Silence Removal : Auto detects large gaps in speech and reduces them
- Umm Detector : Detects filler words (“uhms”) and stutters from the transcript or otherwise and removes them.

## Self-Hosting

Want to run Wave Shed entirely on your own infrastructure? Check out our [Self-Hosting Guide](./docs/self-hosting.md) for step-by-step instructions on deploying the static frontend and setting up your own PeerJS signaling server using free-tier platforms like Netlify and Koyeb.