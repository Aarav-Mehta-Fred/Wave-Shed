Frontend Architecture

This document outlines the frontend presentation and state management layer of Wave Shed. The UI is built entirely in vanilla JavaScript, HTML, and CSS, featuring a terminal-inspired, Y2K/Frutiger Aero aesthetic. It operates as a lightweight Single Page Application (SPA) without heavy frameworks (like React or Vue), ensuring maximum main-thread performance alongside the intensive Web Audio and WASM workloads.

Core Components

The frontend is driven by four primary files that handle presentation, styling, and application state.

index.html: The minimal DOM shell. It loads the necessary fonts, scripts, and provides the base #terminal and #screen containers where the UI is injected.

style.css: Defines the global visual identity. It utilises CSS variables for the cyan/aqua colour palette, handles the flexbox layout, and implements the visual effects (glassmorphism blurs, CRT scanline overlays, and background bubble animations).

ui.js: The view layer and rendering engine. It handles all direct DOM manipulation, renders ASCII art, constructs interactive components (buttons, text inputs, progress bars), and manages view routing (e.g., switching between the Boot screen, Live Meeting, and Edit Dashboard).

app.js: The controller and state manager. It acts as the central bridge between the visual ui.js layer and the underlying background subsystems (AudioSync, AI, Player, and SessionDB). It also handles browser-level tasks like requesting microphone permissions and parsing URL parameters for auto-joining rooms.

Design Paradigm & Rendering

The Terminal Aesthetic

Rather than using heavy DOM elements or canvas for the main interface, Wave Shed relies on a text-based User Interface (TUI) paradigm within the browser.

Interactive elements are styled as terminal inputs or block buttons.

The interactive editing transcript renders words as simple, inline <span> elements.

Visual feedback (like waveforms and progress bars) is heavily stylised using ASCII characters (e.g., █░░░░) to maintain the retro-tech immersion while keeping DOM recalculations extremely cheap.

Event-Driven Updates

Because there is no virtual DOM, the frontend relies on strict event-driven callback hooks to stay synchronised with the background workers and audio nodes.

app.js exposes global hook functions (e.g., app.onPlayerTimeUpdate, app.onEditStateChanged, app.onTranscriptProgress).

The background engines (audio.js, ai.js, player.js) call these hooks when their internal state changes.

ui.js attaches to these hooks to trigger targeted, minimal DOM repaints (like updating a timer or striking through a deleted word) without re-rendering the entire page.

Session State Management

app.js maintains a simple, global state machine (app.sessionState) that dictates what ui.js should render. The primary states are:

idle: The user is on the boot screen or dashboard.

in_meeting: The WebRTC mesh is active, and participants are conversing.

recording: The pcmProcessor is actively capturing audio to OPFS.

transferring: The session is compressing, sending, and decoding files across the peer network.

By keeping state management in app.js and rendering in ui.js, the frontend remains decoupled from the complex WebRTC and Web Audio APIs running underneath it.