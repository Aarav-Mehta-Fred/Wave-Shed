// ═══════════════════════════════════════════════════════════
// ui.js — Console TUI: full-screen ASCII terminal interface
// Renders all views as ASCII art with clickable elements
// ═══════════════════════════════════════════════════════════

(function () {
    'use strict';

    const screen = document.getElementById('screen');

    // ──────────────────────────────
    //  ASCII ART ASSETS
    // ──────────────────────────────

    const ASCII_LETTERS = {
        'W': ['╦ ╦', '║║║', '╚╩╝'],
        'A': ['┌─┐', '├─┤', '┴ ┴'],
        'V': ['┬  ┬', '└┐┌┘', ' └┘ '],
        'E': ['┌─┐', '├┤ ', '└─┘'],
        'S': ['╔═╗', '╚═╗', '╚═╝'],
        'H': ['┬ ┬', '├─┤', '┴ ┴'],
        'D': ['┌┬┐', ' ││', '─┴┘'],
        ' ': [' ', ' ', ' ']
    };

    function createLogoDOM() {
        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.gap = '8px';
        container.style.marginBottom = '20px';

        for (const char of 'WAVE SHED') {
            const lines = ASCII_LETTERS[char];
            if (!lines) continue;
            
            const col = document.createElement('div');
            col.className = 'ascii ascii-title';
            col.style.display = 'flex';
            col.style.flexDirection = 'column';
            col.style.marginBottom = '0';
            
            lines.forEach(lineText => {
                const lineSpan = document.createElement('span');
                lineSpan.innerHTML = lineText.replace(/ /g, '&nbsp;'); 
                col.appendChild(lineSpan);
            });
            
            container.appendChild(col);
        }
        return container;
    }

    const DIVIDER_CHAR = '─';

    function divider(width) {
        return DIVIDER_CHAR.repeat(width || 50);
    }

    function boxTop(label, width) {
        const w = width || 50;
        if (label) {
            const l = `─ ${label} `;
            return '┌' + l + DIVIDER_CHAR.repeat(Math.max(0, w - l.length - 1)) + '┐';
        }
        return '┌' + DIVIDER_CHAR.repeat(w) + '┐';
    }

    function boxMid(label, width) {
        const w = width || 50;
        if (label) {
            const l = `─ ${label} `;
            return '├' + l + DIVIDER_CHAR.repeat(Math.max(0, w - l.length - 1)) + '┤';
        }
        return '├' + DIVIDER_CHAR.repeat(w) + '┤';
    }

    function boxBot(width) {
        const w = width || 50;
        return '└' + DIVIDER_CHAR.repeat(w) + '┘';
    }

    function boxRow(content, width) {
        const w = width || 50;
        // content is plain text, pad it
        const stripped = stripAnsi(content);
        const pad = Math.max(0, w - stripped.length);
        return '│ ' + content + ' '.repeat(pad > 1 ? pad - 1 : 0) + '│';
    }

    function stripAnsi(s) {
        // Our "content" is plain text length for padding
        return s;
    }

    function progressBar(pct, width) {
        const w = width || 28;
        const filled = Math.round((pct / 100) * w);
        const empty = w - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }

    // ──────────────────────────────
    //  UTILITIES
    // ──────────────────────────────

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ──────────────────────────────
    //  STATE
    // ──────────────────────────────

    let currentView = 'boot';
    let isRecordingUI = false;
    let isMutedUI = false;
    let isHostUI = false;
    let activeRosterUI = {}; // Used to track who is currently active
    let mutedPeersUI = new Set(); // Tracks muted peers

    // Floating system messages
    let systemMessages = [];
    
    function addSystemMessage(text) {
        const msg = { text, id: Date.now() + Math.random() };
        systemMessages.push(msg);
        if (systemMessages.length > 5) systemMessages.shift();
        if (currentView === 'meeting') renderMeeting();
        
        setTimeout(() => {
            const idx = systemMessages.findIndex(m => m.id === msg.id);
            if (idx !== -1) {
                systemMessages.splice(idx, 1);
                if (currentView === 'meeting') renderMeeting();
            }
        }, 5000);
    }

    let currentSessionIdUI = null;
    let pendingRoomNameUI = null;
    let recStartTime = 0;
    let recTimerInterval = null;
    let countdownInterval = null;
    let dashboardDetail = null; // null = list, sessionId = detail
    let editTakeDetail = null; // object { sessionId, takeId } if in edit view
    let waveformAnimFrame = null;

    // ── EDIT TAKE STATE ──────────────────────────────────────────────────────
    let editPlayerState  = 'paused'; // 'playing' | 'paused'
    let editCurrentTime  = 0;
    let editTotalDuration = 0;
    let editSelectedWordIds = []; // [{ peerId, wordIdx }]
    let editLastClickedWord  = null; // { peerId, wordIdx } — for shift+click range select
    let editNoiseStates  = {};   // { [peerId]: boolean }
    let editExportProgress = null; // null | 0-100
    let editCurrentEdits = null;  // Latest edits object

    // Sync Cut/Restore button state — auto-detects if all selected words are already cut
    function _syncWsCutBtn() {
        const cb = document.getElementById('edit-cut-btn');
        if (!cb) return;
        cb.disabled = editSelectedWordIds.length === 0;
        if (editSelectedWordIds.length === 0) {
            cb.dataset.mode = 'cut';
            cb.textContent = '[ ✂  CUT SELECTED ]';
            cb.className = 'tui-btn btn-red';
            return;
        }
        const allCut = editSelectedWordIds.every(({ peerId, wordIdx }) => {
            const s = document.querySelector(
                `#edit-transcript-area .tui-word[data-peer-id="${peerId}"][data-word-id="${wordIdx}"]`
            );
            return s && s.style.textDecoration === 'line-through';
        });
        cb.dataset.mode = allCut ? 'restore' : 'cut';
        cb.textContent  = allCut ? '[ ↩  RESTORE SELECTED ]' : '[ ✂  CUT SELECTED ]';
        cb.className    = 'tui-btn ' + (allCut ? 'btn-green' : 'btn-red');
    }

    // Microphone list cached for the select
    let micList = [];

    // ──────────────────────────────
    //  RENDERING HELPERS
    // ──────────────────────────────

    // Create a text node / span
    function txt(content, cls) {
        const span = document.createElement('span');
        if (cls) span.className = cls;
        span.textContent = content;
        return span;
    }

    // Create a clickable ASCII button like [ Text ]
    function btn(label, onClick, cls) {
        const b = document.createElement('button');
        b.className = 'tui-btn' + (cls ? ' ' + cls : '');
        b.textContent = label;
        if (onClick) b.addEventListener('click', onClick);
        return b;
    }

    // Create an inline text input
    function input(placeholder, id, opts = {}) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'tui-input';
        inp.placeholder = placeholder || '';
        if (id) inp.id = id;
        if (opts.value) inp.value = opts.value;
        if (opts.maxlength) inp.maxLength = opts.maxlength;
        if (opts.onEnter) {
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') opts.onEnter(inp.value);
            });
        }
        return inp;
    }

    // Create a select dropdown
    function select(options, id, selectedValue) {
        const sel = document.createElement('select');
        sel.className = 'tui-select';
        if (id) sel.id = id;
        options.forEach(o => {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            if (o.value === selectedValue) opt.selected = true;
            sel.appendChild(opt);
        });
        return sel;
    }

    // Prompt line: label + element
    function promptLine(label, element) {
        const div = document.createElement('div');
        div.className = 'prompt-line';
        const lbl = document.createElement('span');
        lbl.className = 'prompt-label';
        lbl.textContent = label;
        div.appendChild(lbl);
        if (element) div.appendChild(element);
        return div;
    }

    // Action bar with multiple buttons
    function actionBar(...buttons) {
        const div = document.createElement('div');
        div.className = 'action-bar';
        buttons.forEach(b => div.appendChild(b));
        return div;
    }

    // A divider element
    function dividerEl(width) {
        const d = document.createElement('div');
        d.className = 'divider';
        d.textContent = divider(width);
        return d;
    }

    // Newline spacer
    function spacer() {
        const div = document.createElement('div');
        div.innerHTML = '&nbsp;';
        return div;
    }

    // Apply/remove strikethrough styling on a word <span> based on current edits.
    function applyWordEditStyle(spanEl, word, edits, peerId) {
        if (!edits || !edits.tracks) return;
        const track = edits.tracks[peerId];
        if (!track || !track.operations) { spanEl.style.textDecoration = ''; spanEl.style.opacity = ''; return; }
        const affected = track.operations.some(op => {
            if (op.type === 'cut' || op.type === 'silence' || op.type === 'vad_silence') {
                return word.startTime < op.endSec && word.endTime > op.startSec;
            }
            return false;
        });
        if (affected) {
            spanEl.style.textDecoration = 'line-through';
            spanEl.style.opacity = '0.38';
            spanEl.title = 'Cut / Silenced';
        } else {
            spanEl.style.textDecoration = '';
            spanEl.style.opacity = '';
            spanEl.title = '';
        }
    }

    // Clear and redraw the screen
    function render(buildFn) {
        screen.innerHTML = '';
        screen.onkeydown = null; // reset listeners
        buildFn(screen);
        screen.scrollTop = 0;
    }

    // ──────────────────────────────
    //  VIEW: BOOT
    // ──────────────────────────────

    function renderBoot() {
        render((s) => {
            // Logo
            s.appendChild(createLogoDOM());

            const sub = txt('  P2P Multi-Track Audio Recording\n', 'dim');
            s.appendChild(sub);

            s.appendChild(dividerEl());
            s.appendChild(spacer());

            const urlParams = new URLSearchParams(window.location.search);
            const isGuestURL = !!urlParams.get('meeting');

            // Name input
            const nameInput = input('enter your name', 'tui-name', {
                value: window.app.localName || '',
                maxlength: 32
            });
            s.appendChild(promptLine('> name:', nameInput));

            if (!isGuestURL) {
                // Session name input (optional)
                const sessionNameInput = input('session name (optional)', 'tui-session-name', {
                    maxlength: 64
                });
                s.appendChild(promptLine('> room name:', sessionNameInput));
            }

            // Mic select
            const micOptions = micList.length > 0
                ? micList.map((m, i) => ({ value: m.deviceId, label: m.label || `Microphone ${i + 1}` }))
                : [{ value: '', label: 'loading…' }];
            const micSel = select(micOptions, 'tui-mic', window.app.selectedMicId || '');
            micSel.addEventListener('change', () => {
                if (micSel.value) window.app.setMicrophone(micSel.value);
            });
            s.appendChild(promptLine('> mic:', micSel));

            // Headphones toggle
            const hpToggle = document.createElement('span');
            hpToggle.className = 'tui-toggle' + (window.app.localHeadphones ? ' on' : '');
            hpToggle.textContent = window.app.localHeadphones ? '[ON]  🎧' : '[OFF] 🔊';
            hpToggle.tabIndex = 0;
            hpToggle.addEventListener('click', () => {
                window.app.localHeadphones = !window.app.localHeadphones;
                renderBoot(); // re-render to update toggle
            });
            hpToggle.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hpToggle.click(); }
            });
            s.appendChild(promptLine('> headphones:', hpToggle));

            s.appendChild(spacer());
            s.appendChild(dividerEl());
            s.appendChild(spacer());

            if (!isGuestURL) {
                // Create Room button
                const createBtn = btn('CREATE ROOM', () => {
                    const nameInputEl = document.getElementById('tui-name');
                    const name = nameInputEl?.value?.trim();
                    if (!name) {
                        nameInputEl.classList.add('shake');
                        setTimeout(() => nameInputEl.classList.remove('shake'), 400);
                        return;
                    }

                    if (!window.AudioSync) { console.warn('Audio system not ready.'); return; }
                    const mic = document.getElementById('tui-mic')?.value || null;
                    const sessionName = document.getElementById('tui-session-name')?.value?.trim();
                    
                    createBtn.textContent = 'CONNECTING...';
                    createBtn.classList.add('disabled');
                    
                    isHostUI = true;
                    pendingRoomNameUI = sessionName || null;
                    window.app.setParticipantInfo(name, window.app.localHeadphones, '');
                    window.app.selectedMicId = mic;
                    window.AudioSync.initHost(mic, window.app.getParticipantInfo());
                }, 'btn-green');
                s.appendChild(createBtn);
            }

            s.appendChild(spacer());

            // Join Room
            const joinRow = document.createElement('div');
            joinRow.className = 'prompt-line';
            const joinLabel = txt('> room id: ', 'prompt-label');
            joinRow.appendChild(joinLabel);

            const joinInput = input('paste room id', 'tui-join-id', {
                value: new URLSearchParams(window.location.search).get('meeting') || '',
                onEnter: (val) => doJoin(val)
            });
            joinRow.appendChild(joinInput);
            s.appendChild(joinRow);

            const joinBtn = btn('JOIN ROOM', () => {
                const val = document.getElementById('tui-join-id')?.value?.trim();
                if (!val) return;
                
                const nameInputEl = document.getElementById('tui-name');
                const name = nameInputEl?.value?.trim();
                if (!name) {
                    nameInputEl.classList.add('shake');
                    setTimeout(() => nameInputEl.classList.remove('shake'), 400);
                    return;
                }

                joinBtn.textContent = 'CONNECTING...';
                joinBtn.classList.add('disabled');
                
                doJoin(val);
            });
            s.appendChild(joinBtn);
            
            // Setup global arrow-key nav map after render completes; also auto-focus
            // the first element so arrow keys work without needing to Tab first
            setTimeout(() => {
                const els = Array.from(screen.querySelectorAll('input, select, .tui-btn, .tui-toggle'));
                if (els.length > 0 && !document.activeElement?.closest('#tui-screen')) {
                    els[0].focus();
                }
                screen.onkeydown = (e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const idx = els.indexOf(document.activeElement);
                        if (idx !== -1) {
                            let next = idx + (e.key === 'ArrowDown' ? 1 : -1);
                            if (next >= els.length) next = 0;
                            if (next < 0) next = els.length - 1;
                            els[next].focus();
                        } else if (els.length > 0) {
                            els[0].focus();
                        }
                    }
                };
            }, 50);

            s.appendChild(spacer());
            s.appendChild(dividerEl());

            // Sessions
            const sessBtn = btn('VIEW PAST SESSIONS', () => {
                currentView = 'dashboard';
                dashboardDetail = null;
                renderDashboard();
            }, 'btn-amber');
            s.appendChild(sessBtn);

            s.appendChild(spacer());
            s.appendChild(txt('  ↑↓ Tab to navigate  ·  Enter to select  ·  Type to input\n', 'dim'));
        });
    }

    function doJoin(roomId) {
        if (!roomId) { console.warn('Room ID is required.'); return; }
        const nameInputEl = document.getElementById('tui-name');
        const name = nameInputEl?.value?.trim();
        if (!name) {
            nameInputEl.classList.add('shake');
            setTimeout(() => nameInputEl.classList.remove('shake'), 400);
            return;
        }

        if (!window.AudioSync) { console.warn('Audio system not ready.'); return; }
        const mic = document.getElementById('tui-mic')?.value || null;
        isHostUI = false;
        window.app.setParticipantInfo(name, window.app.localHeadphones, '');
        window.app.selectedMicId = mic;
        window.AudioSync.initGuest(roomId, mic, window.app.getParticipantInfo());
    }

    // ──────────────────────────────
    //  VIEW: MEETING
    // ──────────────────────────────

    function renderMeeting() {
        render((s) => {
            const params = new URLSearchParams(window.location.search);
            const roomId = params.get('meeting') || currentSessionIdUI || '—';

            // Header box
            s.appendChild(txt(boxTop('ROOM') + '\n', 'box-line'));

            // Room ID (clickable to copy)
            const idRow = document.createElement('div');
            const idLabel = txt('│ ID: ', 'box-line');
            const idValue = document.createElement('button');
            idValue.className = 'tui-btn';
            idValue.textContent = roomId;
            idValue.title = 'Click to copy invite link';
            idValue.addEventListener('click', () => {
                navigator.clipboard.writeText(window.location.href).then(() => {
                    console.log('[UI] Invite link copied to clipboard.');
                }).catch(() => {
                    navigator.clipboard.writeText(roomId).catch(() => {});
                    console.log('[UI] Room ID copied.');
                });
            });
            idRow.appendChild(idLabel);
            idRow.appendChild(idValue);
            s.appendChild(idRow);

            // Room name
            const nameRow = document.createElement('div');
            nameRow.className = 'prompt-line';
            nameRow.appendChild(txt('│ Name: ', 'box-line'));
            
            if (isHostUI) {
                const nameInp = input('session name', 'tui-room-name', { maxlength: 64, value: pendingRoomNameUI || '' });
                let roomNameTimer;
                nameInp.addEventListener('input', () => {
                    clearTimeout(roomNameTimer);
                    roomNameTimer = setTimeout(() => {
                        if (currentSessionIdUI && window.app.renameRoom) {
                            window.app.renameRoom(currentSessionIdUI, nameInp.value);
                        }
                    }, 800);
                });
                nameRow.appendChild(nameInp);
            } else {
                nameRow.appendChild(txt(pendingRoomNameUI || 'guest session', 'white'));
            }
            s.appendChild(nameRow);

            // Participants
            s.appendChild(txt(boxMid('PARTICIPANTS') + '\n', 'box-line'));

            const roster = window.app.guestRoster || {};
            // Show host
            if (isHostUI) {
                const hLine = document.createElement('div');
                hLine.className = 'roster-entry';
                hLine.dataset.peerId = 'local';
                const dotColor = isMutedUI ? 'red rec-blink' : 'green';
                hLine.innerHTML = `<span class="box-line">│</span> <span class="${dotColor}">●</span> <span class="white">${escapeHtml(window.app.localName || 'Host')}</span> <span class="dim">(you · host)</span><span class="ascii-waveform"></span>`;
                s.appendChild(hLine);
            } else {
                if (window.app.hostInfo) {
                    const hLine = document.createElement('div');
                    hLine.className = 'roster-entry';
                    hLine.dataset.peerId = 'host';
                    const dotColor = mutedPeersUI.has(window.app.hostInfo.peerId) ? 'red rec-blink' : 'cyan';
                    hLine.innerHTML = `<span class="box-line">│</span> <span class="${dotColor}">●</span> <span class="white">${escapeHtml(window.app.hostInfo.name || 'Host')}</span> <span class="dim">(host)</span><span class="ascii-waveform"></span>`;
                    s.appendChild(hLine);
                }

                const sLine = document.createElement('div');
                sLine.className = 'roster-entry';
                sLine.dataset.peerId = 'local';
                const dotColor = isMutedUI ? 'red rec-blink' : 'green';
                sLine.innerHTML = `<span class="box-line">│</span> <span class="${dotColor}">●</span> <span class="white">${escapeHtml(window.app.localName || 'Guest')}</span> <span class="dim">(you)</span><span class="ascii-waveform"></span>`;
                s.appendChild(sLine);
            }

            // If we are guest, we need to show the host too! (Wait, normally roster only shows guests, let's just append waveform container to all roster entries).
            // Roster entries that are guests.
            Object.entries(roster).forEach(([id, name]) => {
                const gLine = document.createElement('div');
                gLine.className = 'roster-entry';
                gLine.dataset.peerId = id;
                const dotColor = mutedPeersUI.has(id) ? 'red rec-blink' : 'cyan';
                gLine.innerHTML = `<span class="box-line">│</span> <span class="${dotColor}">●</span> <span class="white">${escapeHtml(name)}</span><span class="ascii-waveform"></span>`;
                s.appendChild(gLine);
            });

            // System Messages (rendered inline at bottom of roster)
            if (systemMessages.length > 0) {
                s.appendChild(txt('│\n', 'box-line'));
                systemMessages.forEach((m) => {
                    const msgRow = document.createElement('div');
                    msgRow.appendChild(txt('│  * ', 'dim'));
                    msgRow.appendChild(txt(m.text, 'cyan'));
                    s.appendChild(msgRow);
                });
            }

            // Controls section
            s.appendChild(txt(boxMid('CONTROLS') + '\n', 'box-line'));

            // Countdown overlay area
            const cdArea = document.createElement('div');
            cdArea.id = 'tui-countdown';
            cdArea.style.display = 'none';
            s.appendChild(cdArea);

            // Record button
            if (isHostUI) {
                const recRow = document.createElement('div');
                recRow.style.margin = '6px 0';

                if (isRecordingUI) {
                    const recDot = document.createElement('span');
                    recDot.className = 'red rec-blink';
                    recDot.textContent = '● REC ';

                    const timerSpan = document.createElement('span');
                    timerSpan.id = 'tui-rec-timer';
                    timerSpan.className = 'red';
                    timerSpan.textContent = '00:00';

                    recRow.appendChild(txt('│ ', 'box-line'));
                    recRow.appendChild(recDot);
                    recRow.appendChild(timerSpan);
                    recRow.appendChild(txt('  '));
                    recRow.appendChild(btn('STOP TAKE', () => {
                        if (window.AudioSync) window.AudioSync.stopRecordingProcess();
                    }, 'btn-red'));
                    s.appendChild(recRow);
                } else {
                    recRow.appendChild(txt('│ ', 'box-line'));
                    recRow.appendChild(btn('START TAKE', () => {
                        if (window.AudioSync) window.AudioSync.startRecordingProcess();
                    }, 'btn-green'));
                    s.appendChild(recRow);

                    // Take name
                    const tkRow = document.createElement('div');
                    tkRow.className = 'prompt-line';
                    tkRow.appendChild(txt('│ take: ', 'box-line'));
                    const tkInp = input('name (optional)', 'tui-take-name', { maxlength: 48 });
                    let tkTimer;
                    tkInp.addEventListener('input', () => {
                        clearTimeout(tkTimer);
                        tkTimer = setTimeout(() => {
                            if (window.app.lastCompletedTakeId) {
                                window.app.renameTake(window.app.lastCompletedTakeId, tkInp.value);
                            }
                        }, 800);
                    });
                    tkRow.appendChild(tkInp);
                    s.appendChild(tkRow);
                }
            } else {
                // Guest: show recording status
                if (isRecordingUI) {
                    const recRow = document.createElement('div');
                    const recDot = document.createElement('span');
                    recDot.className = 'red rec-blink';
                    recDot.textContent = '● REC ';
                    const timerSpan = document.createElement('span');
                    timerSpan.id = 'tui-rec-timer';
                    timerSpan.className = 'red';
                    timerSpan.textContent = '00:00';
                    recRow.appendChild(txt('│ ', 'box-line'));
                    recRow.appendChild(recDot);
                    recRow.appendChild(timerSpan);
                    recRow.appendChild(txt('  ', 'dim'));
                    recRow.appendChild(txt('host controls recording', 'dim'));
                    s.appendChild(recRow);
                } else {
                    const waitRow = document.createElement('div');
                    waitRow.appendChild(txt('│ ', 'box-line'));
                    waitRow.appendChild(txt('waiting for host to start recording…', 'dim'));
                    s.appendChild(waitRow);
                }
            }

            s.appendChild(txt(boxMid() + '\n', 'box-line'));

            // Action buttons
            const actRow = document.createElement('div');
            actRow.className = 'action-bar';
            actRow.appendChild(txt('│ ', 'box-line'));

            // Mute
            const muteBtn = btn(isMutedUI ? 'UNMUTE' : 'MUTE', () => {
                if (!window.AudioSync) return;
                isMutedUI = !isMutedUI;
                window.AudioSync.setMuted(isMutedUI);
                renderMeeting();
            }, isMutedUI ? 'btn-red' : '');
            actRow.appendChild(muteBtn);

            if (isHostUI) {
                actRow.appendChild(btn('END MEETING', () => {
                    if (window.AudioSync) window.AudioSync.endMeeting();
                    clearUrlParams();
                }, 'btn-amber'));
            } else {
                actRow.appendChild(btn('LEAVE', () => {
                    if (window.AudioSync) window.AudioSync.leaveSession();
                    clearUrlParams();
                }, 'btn-amber'));
            }
            s.appendChild(actRow);

            s.appendChild(txt(boxBot() + '\n', 'box-line'));
            s.appendChild(spacer());
            s.appendChild(txt('  M mute · R record · L leave · E end meeting\n', 'dim'));
        });
    }

    // ──────────────────────────────
    //  VIEW: PROCESSING
    // ──────────────────────────────

    const progressState = {};

    function renderProcessing() {
        render((s) => {
            s.appendChild(txt(boxTop('PROCESSING') + '\n', 'box-line'));

            const sub = document.createElement('div');
            sub.appendChild(txt('│ ', 'box-line'));
            sub.appendChild(txt('Syncing and aligning audio tracks…', 'dim'));
            s.appendChild(sub);

            s.appendChild(txt('│\n', 'box-line'));

            // Progress bars container
            const pbContainer = document.createElement('div');
            pbContainer.id = 'tui-progress-container';
            s.appendChild(pbContainer);

            updateProgressBarsDOM();

            s.appendChild(txt('│\n', 'box-line'));
            s.appendChild(txt(boxBot() + '\n', 'box-line'));
        });
    }

    function updateProgressBarsDOM() {
        const container = document.getElementById('tui-progress-container');
        if (!container) return;
        container.innerHTML = '';

        Object.entries(progressState).forEach(([key, data]) => {
            const row = document.createElement('div');
            row.className = 'progress-row';

            const pct = Math.round(data.pct);
            const label = data.label.padEnd(18, ' ');
            const bar = progressBar(pct, 24);
            const pctStr = String(pct).padStart(3, ' ') + '%';

            row.appendChild(txt('│  ', 'box-line'));
            row.appendChild(txt(label, 'cyan'));
            row.appendChild(txt('[', 'dim'));
            row.appendChild(txt(bar, pct >= 100 ? 'green' : 'cyan'));
            row.appendChild(txt(']', 'dim'));
            row.appendChild(txt(' ' + pctStr, pct >= 100 ? 'green' : 'white'));
            container.appendChild(row);
        });

        if (Object.keys(progressState).length === 0) {
            const row = document.createElement('div');
            row.appendChild(txt('│  ', 'box-line'));
            row.appendChild(txt('waiting for data…', 'dim'));
            container.appendChild(row);
        }
    }

    // ──────────────────────────────
    //  VIEW: DASHBOARD
    // ──────────────────────────────

    async function renderDashboard() {
        if (dashboardDetail) {
            await renderSessionDetail(dashboardDetail);
            return;
        }

        render((s) => {
            s.appendChild(txt(boxTop('SESSIONS') + '\n', 'box-line'));
            s.appendChild(txt('│\n', 'box-line'));

            const listEl = document.createElement('div');
            listEl.id = 'tui-session-list';
            listEl.appendChild(txt('│  loading…', 'dim'));
            s.appendChild(listEl);

            s.appendChild(txt('│\n', 'box-line'));
            s.appendChild(txt(boxBot() + '\n', 'box-line'));
            s.appendChild(spacer());
            s.appendChild(btn('← BACK TO HOME', () => {
                currentView = 'boot';
                renderBoot();
            }));
        });

        // Load sessions asynchronously
        const sessions = await window.app.getSessions();
        const listEl = document.getElementById('tui-session-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        if (!sessions || sessions.length === 0) {
            listEl.appendChild(txt('│  no sessions recorded yet.\n', 'dim'));
            return;
        }

        sessions.forEach((s, i) => {
            const row = document.createElement('div');
            row.style.margin = '2px 0';
            const date = new Date(s.createdAt).toLocaleDateString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric'
            });
            const name = s.roomName || 'Untitled';
            const status = s.status || '?';

            row.appendChild(txt('│  ', 'box-line'));
            row.appendChild(btn(name, () => {
                dashboardDetail = s.id;
                renderDashboard();
            }));
            row.appendChild(txt(`  ${date}  `, 'dim'));
            row.appendChild(txt(status, status === 'complete' ? 'green' : status === 'error' ? 'red' : 'amber'));
            row.appendChild(txt('  '));
            row.appendChild(btn('✕', async () => {
                if (confirm(`Delete "${name}"?`)) {
                    await window.app.deleteSession(s.id);
                    console.log('[UI] Session deleted.');
                    dashboardDetail = null;
                    renderDashboard();
                }
            }, 'btn-red'));
            listEl.appendChild(row);
        });
    }

    async function renderSessionDetail(sessionId) {
        const detail = await window.app.getSessionDetail(sessionId);
        if (!detail || !detail.session) return;

        render((s) => {
            const sesh = detail.session;
            s.appendChild(txt(boxTop(sesh.roomName || 'SESSION') + '\n', 'box-line'));

            const takes = detail.takes || [];
            if (takes.length === 0) {
                s.appendChild(txt('│  no takes in this session.\n', 'dim'));
            } else {
                // Table header
                const hdr = document.createElement('div');
                hdr.appendChild(txt('│  ', 'box-line'));
                hdr.appendChild(txt('#  NAME                 DURATION  STATUS\n', 'dim'));
                s.appendChild(hdr);

                s.appendChild(txt(boxMid() + '\n', 'box-line'));

                takes.forEach((t, i) => {
                    const name = (t.name || 'Untitled').padEnd(20, ' ').slice(0, 20);
                    let dur = '   —   ';
                    if (t.durationSecs) {
                        const m = Math.floor(t.durationSecs / 60);
                        const sec = Math.floor(t.durationSecs % 60);
                        dur = `${m}:${String(sec).padStart(2, '0')}`.padEnd(7, ' ');
                    }
                    const status = t.status || '?';
                    const statusCls = status === 'complete' ? 'green' : status === 'error' ? 'red' : 'amber';

                    const row = document.createElement('div');
                    row.appendChild(txt('│  ', 'box-line'));
                    row.appendChild(txt(`${String(i + 1).padStart(2, ' ')} `, 'dim'));
                    row.appendChild(txt(name + ' ', 'white'));
                    row.appendChild(txt(dur + ' ', 'dim'));
                    row.appendChild(txt(status.padEnd(10, ' '), statusCls));

                    if (status === 'complete') {
                        const guestPeerIds = Object.keys(t.rawGuestFiles || {});

                        // RAW — downloads every raw (uncropped) track
                        row.appendChild(btn('RAW', async () => {
                            await window.app.requestDownload(sessionId, 'raw_host', null, t.takeId);
                            for (const pid of guestPeerIds) {
                                await window.app.requestDownload(sessionId, 'raw_guest', pid, t.takeId);
                            }
                        }));
                        row.appendChild(txt(' '));

                        // ALIGNED — downloads all cropped / synced tracks
                        row.appendChild(btn('ALIGNED', async () => {
                            await window.app.requestDownload(sessionId, 'aligned_host', null, t.takeId);
                            for (const pid of guestPeerIds) {
                                await window.app.requestDownload(sessionId, 'aligned_guest', pid, t.takeId);
                            }
                        }, 'btn-green'));
                        row.appendChild(txt(' '));

                        row.appendChild(btn('EDIT', () => {
                            editTakeDetail = { sessionId, takeId: t.takeId };
                            currentView = 'edit_take';
                            showView('edit_take');
                        }, 'btn-amber'));

                        // Participant badges — visual only, show who was in the take
                        (t.participants || []).forEach(p => {
                            const badge = document.createElement('span');
                            badge.style.cssText = 'display:inline-block;margin-left:6px;padding:1px 7px;'
                                + 'border-radius:10px;border:1px solid #2a4a4a;font-size:0.82em;color:#5effb8;';
                            badge.textContent = p.name || p.peerId.slice(-6);
                            row.appendChild(badge);
                        });
                        // Fallback if participants not populated yet (old take format)
                        if (!(t.participants || []).length && guestPeerIds.length) {
                            guestPeerIds.forEach(pid => {
                                const badge = document.createElement('span');
                                badge.style.cssText = 'display:inline-block;margin-left:6px;padding:1px 7px;'
                                    + 'border-radius:10px;border:1px solid #2a4a4a;font-size:0.82em;color:#5effb8;';
                                badge.textContent = pid.slice(-6).toUpperCase();
                                row.appendChild(badge);
                            });
                        }
                    }
                    s.appendChild(row);
                });
            }

            s.appendChild(txt('│\n', 'box-line'));
            s.appendChild(txt(boxBot() + '\n', 'box-line'));
            s.appendChild(spacer());

            const navRow = actionBar(
                btn('DOWNLOAD ALL', () => {
                    window.app.requestBulkDownload(sessionId);
                    console.log('[UI] Downloading all aligned tracks…');
                }, 'btn-green'),
                btn('← BACK', () => {
                    dashboardDetail = null;
                    renderDashboard();
                })
            );
            s.appendChild(navRow);
        });
    }

    // ──────────────────────────────
    //  VIEW: EDIT TAKE
    // ──────────────────────────────

    async function renderEditTake() {
        if (!editTakeDetail) return;
        const { sessionId, takeId } = editTakeDetail;

        // Reset transient state
        editSelectedWordIds = [];
        editExportProgress  = null;
        editCurrentEdits    = null;

        const fmtTime = (secs) => {
            const t = Math.max(0, secs || 0);
            return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
        };

        // Loading skeleton
        render((s) => {
            s.appendChild(txt(boxTop('EDIT TAKE') + '\n', 'box-line'));
            s.appendChild(txt('│\n', 'box-line'));
            const r = document.createElement('div');
            r.appendChild(txt('│  ', 'box-line'));
            r.appendChild(txt('Loading take data…', 'dim'));
            s.appendChild(r);
            s.appendChild(txt('│\n', 'box-line'));
            s.appendChild(txt(boxBot() + '\n', 'box-line'));
            s.appendChild(spacer());
            s.appendChild(btn('← BACK', () => { editTakeDetail = null; currentView = 'dashboard'; renderDashboard(); }));
        });

        // Fetch data
        let take, transcripts, existingEdits;
        try {
            [take, transcripts, existingEdits] = await Promise.all([
                window.SessionDB.getTake(takeId),
                window.SessionDB.getTakeTranscripts(takeId).catch(() => []),
                window.SessionDB.getEdits(takeId).catch(() => null)
            ]);
        } catch (e) {
            console.error('[EditTake] Load error:', e);
            return;
        }
        editCurrentEdits  = existingEdits;
        editTotalDuration = take?.durationSecs || 0;

        // Init AI worker pool (idempotent — skips if already initialized)
        if (window.AI && window.AI.workers.length === 0) {
            try { await window.AI.init(); } catch (e) { console.warn('[EditTake] AI.init failed:', e); }
        }

        // Init player — AudioContext must be created before load()
        if (window.Player) {
            try {
                if (!window.Player.audioContext) {
                    await window.Player.init();
                }
                await window.Player.load(takeId);
                const maxDur = Object.values(window.Player.tracks || {}).reduce((m, t) => Math.max(m, t.virtualDuration || 0), 0);
                if (maxDur > 0) editTotalDuration = maxDur;
                editCurrentTime  = 0;
                editPlayerState  = 'paused';
            } catch (e) { console.error('[EditTake] Player.load failed:', e); }
        }

        // Collect peers
        const peers = ['host'];
        if (take?.rawGuestFiles) peers.push(...Object.keys(take.rawGuestFiles));

        // Sync noise states from existing edits
        peers.forEach(pid => {
            if (editNoiseStates[pid] === undefined) editNoiseStates[pid] = false;
            if (existingEdits?.tracks?.[pid]?.operations) {
                editNoiseStates[pid] = existingEdits.tracks[pid].operations.some(op => op.type === 'noise_suppress');
            }
        });

        const getPeerName = (pid) => {
            if (pid === 'host') return 'Host';
            const p = take?.participants?.find(pt => pt.peerId === pid);
            return p?.name || pid.slice(-6).toUpperCase();
        };

        // ── Build full UI ────────────────────────────────────────────────────
        render((s) => {
            const takeName = take?.name || `Take ${takeId.slice(-6)}`;

            // ── HEADER ──
            s.appendChild(txt(boxTop(`EDIT ─ ${takeName}`) + '\n', 'box-line'));

            const tRow = document.createElement('div');
            tRow.style.cssText = 'display:flex;align-items:center;padding:4px 0;gap:8px;';
            tRow.appendChild(txt('│  ', 'box-line'));

            const playBtn = btn(
                editPlayerState === 'playing' ? '[ ⏸ PAUSE ]' : '[ ▶ PLAY  ]',
                () => { if (window.Player) { window.Player.isPlaying ? window.Player.pause() : window.Player.play(); } },
                editPlayerState === 'playing' ? 'btn-amber' : 'btn-green'
            );
            playBtn.id = 'edit-play-btn';
            tRow.appendChild(playBtn);

            const timeTxt = document.createElement('span');
            timeTxt.id = 'edit-time-display';
            timeTxt.className = 'white';
            timeTxt.style.fontVariantNumeric = 'tabular-nums';
            timeTxt.textContent = `  ${fmtTime(editCurrentTime)}  /  ${fmtTime(editTotalDuration)}`;
            tRow.appendChild(timeTxt);
            s.appendChild(tRow);

            // Seek bar row
            const pbRow = document.createElement('div');
            pbRow.style.cssText = 'display:flex;align-items:center;padding:2px 0;';
            pbRow.appendChild(txt('│  [', 'box-line'));
            const PBAR_W = 36;
            const pct0 = editTotalDuration > 0 ? editCurrentTime / editTotalDuration : 0;
            const filled0 = Math.round(pct0 * PBAR_W);
            const barEl = document.createElement('span');
            barEl.id = 'edit-progress-bar';
            barEl.style.cursor = 'pointer';
            barEl.title = 'Click to seek';
            const fillEl = document.createElement('span'); fillEl.id = 'edit-pb-fill'; fillEl.className = 'cyan'; fillEl.textContent = '█'.repeat(filled0);
            const emptyEl = document.createElement('span'); emptyEl.id = 'edit-pb-empty'; emptyEl.className = 'dim';  emptyEl.textContent = '░'.repeat(PBAR_W - filled0);
            barEl.appendChild(fillEl); barEl.appendChild(emptyEl);
            barEl.addEventListener('click', (e) => {
                if (!window.Player || editTotalDuration <= 0) return;
                const r = barEl.getBoundingClientRect();
                window.Player.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * editTotalDuration);
            });
            pbRow.appendChild(barEl);
            pbRow.appendChild(txt(']', 'dim'));
            s.appendChild(pbRow);

            // ── TRANSCRIPT ──
            s.appendChild(txt(boxMid('TRANSCRIPT') + '\n', 'box-line'));

            const txArea = document.createElement('div');
            txArea.id = 'edit-transcript-area';

            if (!transcripts || transcripts.length === 0) {
                const nr = document.createElement('div'); nr.className = 'tx-placeholder'; nr.style.padding = '4px 0';
                nr.appendChild(txt('│  ', 'box-line'));
                nr.appendChild(txt('No transcript available. Transcribe via AI Tools first.', 'dim'));
                txArea.appendChild(nr);
            } else {
                transcripts.forEach(transcript => {
                    // Wrap in data-tx-peer so onTranscriptReady can replace on re-transcription
                    const peerBlock = document.createElement('div');
                    peerBlock.dataset.txPeer = transcript.peerId;

                    const labelRow = document.createElement('div'); labelRow.style.margin = '6px 0 2px 0';
                    labelRow.appendChild(txt('│  ', 'box-line'));
                    labelRow.appendChild(txt(`┤ ${getPeerName(transcript.peerId)} ├ `, 'amber'));
                    peerBlock.appendChild(labelRow);

                    const wordsRow = document.createElement('div'); wordsRow.style.padding = '2px 0';
                    wordsRow.appendChild(txt('│    ', 'box-line'));
                    const wrap = document.createElement('span'); wrap.style.lineHeight = '2';

                    (transcript.words || []).forEach((word, wordIdx) => {
                        const sp = document.createElement('span');
                        sp.className = 'tui-word';
                        sp.dataset.wordId    = String(wordIdx);
                        sp.dataset.peerId    = transcript.peerId;
                        sp.dataset.startTime = String(word.startTime ?? 0);
                        sp.dataset.endTime   = String(word.endTime   ?? 0);
                        sp.textContent = (word.word || '') + ' ';
                        if (existingEdits) applyWordEditStyle(sp, word, existingEdits, transcript.peerId);
                        if (editSelectedWordIds.some(sel => sel.peerId === transcript.peerId && sel.wordIdx === wordIdx)) sp.classList.add('selected');
                        sp.addEventListener('click', (ev) => {
                            if (ev.shiftKey && editLastClickedWord && editLastClickedWord.peerId === transcript.peerId) {
                                const fromIdx = Math.min(editLastClickedWord.wordIdx, wordIdx);
                                const toIdx   = Math.max(editLastClickedWord.wordIdx, wordIdx);
                                const allSpans = document.querySelectorAll(
                                    `#edit-transcript-area .tui-word[data-peer-id="${transcript.peerId}"]`
                                );
                                allSpans.forEach(s => {
                                    const si = parseInt(s.dataset.wordId, 10);
                                    if (si >= fromIdx && si <= toIdx) {
                                        if (!editSelectedWordIds.find(x => x.peerId === transcript.peerId && x.wordIdx === si)) {
                                            editSelectedWordIds.push({ peerId: transcript.peerId, wordIdx: si });
                                            s.classList.add('selected');
                                        }
                                    }
                                });
                            } else {
                                const idx = editSelectedWordIds.findIndex(sel => sel.peerId === transcript.peerId && sel.wordIdx === wordIdx);
                                if (idx === -1) { editSelectedWordIds.push({ peerId: transcript.peerId, wordIdx }); sp.classList.add('selected'); }
                                else           { editSelectedWordIds.splice(idx, 1); sp.classList.remove('selected'); }
                                editLastClickedWord = { peerId: transcript.peerId, wordIdx };
                            }
                            _syncWsCutBtn();
                        });
                        wrap.appendChild(sp);
                    });
                    wordsRow.appendChild(wrap);
                    peerBlock.appendChild(wordsRow);
                    txArea.appendChild(peerBlock);
                });
            }
            s.appendChild(txArea);

            // Cut / Clear row
            const cutRow = document.createElement('div'); cutRow.style.padding = '4px 0';
            cutRow.appendChild(txt('│  ', 'box-line'));
            const cutBtn = btn('[ ✂  CUT SELECTED ]', async () => {
                if (!editSelectedWordIds.length) return;
                const mode = cutBtn.dataset.mode || 'cut';
                const byPeer = {};
                editSelectedWordIds.forEach(({ peerId, wordIdx }) => { if (!byPeer[peerId]) byPeer[peerId] = []; byPeer[peerId].push(wordIdx); });
                cutBtn.textContent = mode === 'restore' ? '[ … RESTORING… ]' : '[ … CUTTING… ]';
                cutBtn.disabled = true;
                for (const [pid, wids] of Object.entries(byPeer)) {
                    if (mode === 'restore') {
                        if (window.AI?.restoreWords) await window.AI.restoreWords(takeId, wids, pid);
                    } else {
                        if (window.AI?.editWords) await window.AI.editWords(takeId, wids, pid);
                    }
                }
                editSelectedWordIds = [];
                editLastClickedWord = null;
                document.querySelectorAll('#edit-transcript-area .tui-word.selected').forEach(el => el.classList.remove('selected'));
                cutBtn.dataset.mode = 'cut';
                cutBtn.textContent  = '[ ✂  CUT SELECTED ]';
                cutBtn.className    = 'tui-btn btn-red';
                cutBtn.disabled = true;
                _syncWsCutBtn();
            }, 'btn-red');
            cutBtn.id = 'edit-cut-btn'; cutBtn.disabled = true;
            cutRow.appendChild(cutBtn);
            cutRow.appendChild(txt('  '));
            const clrBtn = btn('[ × CLEAR ]', () => {
                editSelectedWordIds = [];
                editLastClickedWord = null;
                document.querySelectorAll('#edit-transcript-area .tui-word.selected').forEach(el => el.classList.remove('selected'));
                _syncWsCutBtn();
            });
            cutRow.appendChild(clrBtn);
            s.appendChild(cutRow);

            // ── AI TOOLS ──
            s.appendChild(txt(boxMid('AI TOOLS') + '\n', 'box-line'));

            // Transcribe
            const txRow = document.createElement('div'); txRow.style.padding = '4px 0';
            txRow.appendChild(txt('│  ', 'box-line'));
            txRow.appendChild(txt('Transcription:  ', 'dim'));
            const txBtn = btn('[ 🎤 TRANSCRIBE ALL ]', async () => {
                txBtn.textContent = '[ ⟳  RESAMPLING… ]'; txBtn.disabled = true;
                const statusEl2 = document.getElementById('edit-tx-status');
                if (statusEl2) { statusEl2.textContent = '  ⟳ queued…'; statusEl2.className = 'dim'; }
                // transcribeAll awaits resampling then queues to worker;
                // onTranscriptReady fires when each peer's transcript is ready
                if (window.AI?.transcribeAll) await window.AI.transcribeAll(takeId);
                txBtn.textContent = '[ ⟳  TRANSCRIBING… ]';
                // Button is re-enabled by onTranscriptReady once each peer finishes
            });
            txBtn.id = 'edit-transcribe-btn';
            txRow.appendChild(txBtn);
            // Status span — updated by onAIStateChange and onTranscriptReady
            const txStatus = document.createElement('span');
            txStatus.id = 'edit-tx-status';
            txStatus.className = 'dim';
            txRow.appendChild(txStatus);
            s.appendChild(txRow);

            // VAD
            const vadRow = document.createElement('div'); vadRow.style.padding = '4px 0';
            vadRow.appendChild(txt('│  ', 'box-line'));
            vadRow.appendChild(txt('Gap Reduction:  ', 'dim'));
            const vadBtn = btn('[ ✨ REMOVE SILENCES ]', async () => {
                vadBtn.textContent = '[ ⟳  ANALYZING… ]'; vadBtn.disabled = true;
                const vadStatus = document.getElementById('edit-vad-status');
                if (vadStatus) { vadStatus.textContent = '  ⟳ running…'; vadStatus.className = 'dim'; }
                if (window.AI?.runVAD) await window.AI.runVAD(takeId, 0.5);
                // Button re-enabled by onVADPreview (which fires when worker returns)
            }, 'btn-amber');
            vadBtn.id = 'edit-vad-btn';
            vadRow.appendChild(vadBtn);
            const vadStatus = document.createElement('span');
            vadStatus.id = 'edit-vad-status';
            vadStatus.className = 'dim';
            vadRow.appendChild(vadStatus);
            s.appendChild(vadRow);

            // Noise cancel per peer
            const ncRow = document.createElement('div'); ncRow.style.padding = '4px 0';
            ncRow.appendChild(txt('│  ', 'box-line'));
            ncRow.appendChild(txt('RNNoise:  ', 'dim'));
            peers.forEach(pid => {
                const isOn = editNoiseStates[pid] || false;
                const ncBtn = btn(
                    `[ ${getPeerName(pid)}: ${isOn ? 'ON ✓' : 'OFF'} ]`,
                    async function () {
                        const newState = !editNoiseStates[pid];
                        editNoiseStates[pid] = newState;
                        this.textContent = `[ ${getPeerName(pid)}: ${newState ? 'ON ✓' : 'OFF'} ]`;
                        this.className    = 'tui-btn' + (newState ? ' btn-green' : '');
                        this.disabled = true;
                        if (window.AI?.toggleNoiseSuppress) await window.AI.toggleNoiseSuppress(takeId, pid, newState);
                        this.disabled = false;
                    },
                    isOn ? 'btn-green' : ''
                );
                ncBtn.id = `edit-nc-${pid}`;
                ncRow.appendChild(ncBtn); ncRow.appendChild(txt(' '));
            });
            s.appendChild(ncRow);

            // ── EXPORT ──
            s.appendChild(txt(boxMid('EXPORT') + '\n', 'box-line'));

            const expRow = document.createElement('div'); expRow.style.padding = '4px 0';
            expRow.appendChild(txt('│  ', 'box-line'));

            const exportMixBtn = btn('[ ⬇ EXPORT MIX ]', async () => {
                exportMixBtn.textContent = '[ ⟳  EXPORTING… ]'; exportMixBtn.disabled = true; exportTracksBtn.disabled = true;
                if (window.AI?.export) await window.AI.export(takeId, 'wav', true);
            }, 'btn-green');
            exportMixBtn.id = 'edit-export-mix-btn';
            expRow.appendChild(exportMixBtn); expRow.appendChild(txt('  '));

            const exportTracksBtn = btn('[ ⬇ EXPORT TRACKS ]', async () => {
                exportTracksBtn.textContent = '[ ⟳  EXPORTING… ]'; exportTracksBtn.disabled = true; exportMixBtn.disabled = true;
                if (window.AI?.export) await window.AI.export(takeId, 'wav', false);
            });
            exportTracksBtn.id = 'edit-export-tracks-btn';
            expRow.appendChild(exportTracksBtn);
            s.appendChild(expRow);

            // Export progress bar (hidden until export starts)
            const epRow = document.createElement('div');
            epRow.id = 'edit-export-pb-row';
            epRow.style.cssText = 'display:none;align-items:center;padding:2px 0;';
            s.appendChild(epRow);

            // ── FOOTER ──
            s.appendChild(txt(boxBot() + '\n', 'box-line'));
            s.appendChild(spacer());
            s.appendChild(actionBar(btn('← BACK TO SESSION', () => {
                if (window.Player?.isPlaying) window.Player.pause();
                editTakeDetail = null; editSelectedWordIds = []; editNoiseStates = {};
                editExportProgress = null; editCurrentEdits = null;
                currentView = 'dashboard'; renderDashboard();
            })));
        }); // end render()

        function _syncCutBtn() { _syncWsCutBtn(); }
    }

    function clearUrlParams() {
        if (window.history.replaceState) {
            const url = new URL(window.location.href);
            url.searchParams.delete('meeting');
            window.history.replaceState({ path: url.href }, '', url.href);
        }
    }

    // ──────────────────────────────
    //  VIEW: WAITING
    // ──────────────────────────────

    function renderWaiting() {
        render((s) => {
            const params = new URLSearchParams(window.location.search);
            const roomId = params.get('meeting') || currentSessionIdUI || '—';

            s.appendChild(txt(boxTop('ROOM') + '\n', 'box-line'));
            
            s.appendChild(txt('│ ID: ', 'box-line'));
            s.appendChild(txt(roomId + '\n', 'dim'));
            s.appendChild(txt('│\n', 'box-line'));
            
            const msgRow = document.createElement('div');
            msgRow.appendChild(txt('│  ', 'box-line'));
            msgRow.appendChild(txt('Waiting for host to admit you...', 'cyan blink'));
            s.appendChild(msgRow);

            s.appendChild(txt('│\n', 'box-line'));
            s.appendChild(txt(boxBot() + '\n', 'box-line'));
            
            // Action buttons
            const actRow = document.createElement('div');
            actRow.className = 'action-bar';
            actRow.appendChild(txt('│ ', 'box-line'));
            actRow.appendChild(btn('LEAVE [L]', () => {
                if (window.AudioSync) window.AudioSync.leaveSession();
                clearUrlParams();
            }, 'btn-amber'));
            s.appendChild(actRow);
        });
    }

    // ──────────────────────────────
    //  VIEW SWITCHER
    // ──────────────────────────────

    function showView(name) {
        currentView = name;
        if (waveformAnimFrame) {
            cancelAnimationFrame(waveformAnimFrame);
            waveformAnimFrame = null;
        }

        switch (name) {
            case 'boot':       renderBoot(); break;
            case 'waiting':    renderWaiting(); break;
            case 'meeting':    renderMeeting(); startWaveformLoop(); break;
            case 'processing': renderProcessing(); break;
            case 'dashboard':  renderDashboard(); break;
            case 'edit_take':  renderEditTake(); break;
        }
    }

    function getWaveformHTML(level) {
        // Boost level slightly so it's more visible
        const boosted = Math.min(1.0, level * 2.5);
        const maxBars = 10;
        let html = '<span style="display:inline-flex; align-items:flex-end; gap:2px; height:0.8em; margin-left:8px; vertical-align:middle;">';

        for (let i = 0; i < maxBars; i++) {
            let h = 15; // Minimum 15% height as a stable baseline
            
            // Leave the left and right bar empty (frozen at baseline)
            if (boosted >= 0.05 && i !== 0 && i !== maxBars - 1) {
                // Give each bar a slightly different pseudo-random weight so they bounce independently
                const weight = 0.5 + Math.sin(Date.now() / (80 + i * 45)) * 0.5;
                const val = boosted * weight;
                h = Math.min(100, Math.max(15, Math.floor(val * 100)));
            }
            html += `<span style="display:inline-block; width:4px; height:${h}%; background-color:#5effff; border-radius:1px; box-shadow: 0 0 4px #5effff, inset 0 0 2px #fff; transition: height 0.05s ease-out;"></span>`;
        }
        html += '</span>';
        return html;
    }

    function startWaveformLoop() {
        if (!window.AudioSync || !window.AudioSync.getAudioLevels) return;
        
        function loop() {
            if (currentView !== 'meeting') return;
            const levels = window.AudioSync.getAudioLevels();
            
            const elements = document.querySelectorAll('.roster-entry');
            elements.forEach(el => {
                const id = el.dataset.peerId;
                const waveSpan = el.querySelector('.ascii-waveform');
                if (waveSpan) {
                    const l = levels[id] || 0;
                    waveSpan.innerHTML = getWaveformHTML(l);
                }
            });

            waveformAnimFrame = requestAnimationFrame(loop);
        }
        loop();
    }

    // Patch setSessionState
    const _origSetSessionState = window.app.setSessionState.bind(window.app);
    window.app.setSessionState = function (state) {
        _origSetSessionState(state);
        switch (state) {
            case 'idle':
                isRecordingUI = false;
                stopRecTimer();
                if (currentView === 'meeting' || currentView === 'processing') {
                    clearUrlParams(); // Remove ?meeting= so CREATE ROOM reappears
                    showView('boot');
                }
                break;
            case 'waiting':
                isRecordingUI = false;
                stopRecTimer();
                showView('waiting');
                break;
            case 'in_meeting':
                isRecordingUI = false;
                stopRecTimer();
                showView('meeting');
                break;
            case 'recording':
                isRecordingUI = true;
                showView('meeting');
                startRecTimer();
                break;
            case 'transferring':
            case 'compressing':
            case 'processing':
                isRecordingUI = false;
                stopRecTimer();
                showView('processing');
                break;
        }
    };

    // ──────────────────────────────
    //  TIMER
    // ──────────────────────────────

    function startRecTimer() {
        recStartTime = Date.now();
        recTimerInterval = setInterval(() => {
            const el = document.getElementById('tui-rec-timer');
            if (!el) return;
            const elapsed = Math.floor((Date.now() - recStartTime) / 1000);
            const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const ss = String(elapsed % 60).padStart(2, '0');
            el.textContent = `${mm}:${ss}`;
        }, 500);
    }

    function stopRecTimer() {
        if (recTimerInterval) { clearInterval(recTimerInterval); recTimerInterval = null; }
    }

    // ──────────────────────────────
    //  APP.JS HOOKS (patching)
    // ──────────────────────────────

    // Session created
    const _origOnSessionCreated = window.app.onSessionCreated.bind(window.app);
    window.app.onSessionCreated = async function (sessionId, hostName, rawHostFileName, localSampleRate) {
        await _origOnSessionCreated(sessionId, hostName, rawHostFileName, localSampleRate);
        currentSessionIdUI = sessionId;
        isHostUI = true;
        
        if (pendingRoomNameUI && window.app.renameRoom) {
            await window.app.renameRoom(sessionId, pendingRoomNameUI);
            // Keep pendingRoomNameUI so renderMeeting can display the room name
        }

        if (currentView === 'meeting') renderMeeting();
    };

    // Register guest → re-render roster
    const _origRegisterGuest = window.app.registerGuest.bind(window.app);
    window.app.registerGuest = function (guestId, name) {
        _origRegisterGuest(guestId, name);
        addSystemMessage(`${name} joined the room.`);
        if (currentView === 'meeting') renderMeeting();
    };

    // Participant left
    const _origOnParticipantLeft = window.app.onParticipantLeft.bind(window.app);
    window.app.onParticipantLeft = function (peerId, name) {
        _origOnParticipantLeft(peerId, name);
        addSystemMessage(`${name} left the room.`);
        if (currentView === 'meeting') renderMeeting();
    };

    // Mute state changed
    const _origOnMuteStateChanged = window.app.onMuteStateChanged.bind(window.app);
    window.app.onMuteStateChanged = function (peerId, isMuted) {
        _origOnMuteStateChanged(peerId, isMuted);
        if (isMuted) mutedPeersUI.add(peerId);
        else mutedPeersUI.delete(peerId);
        if (currentView === 'meeting') renderMeeting();
    };

    // Meeting ended
    const _origOnMeetingEnded = window.app.onMeetingEnded.bind(window.app);
    window.app.onMeetingEnded = function () {
        _origOnMeetingEnded();
        clearUrlParams(); // Remove ?meeting= param so the boot screen shows CREATE ROOM
        console.log('[UI] ← The host has ended the session.');
    };

    // Admission denied
    const _origOnAdmissionDenied = window.app.onAdmissionDenied.bind(window.app);
    window.app.onAdmissionDenied = function () {
        _origOnAdmissionDenied();
        console.warn('[UI] Host denied your join request.');
        showView('boot');
    };

    // Admission prompt (host-side)
    window.app.promptAdmission = function (guestInfo) {
        return new Promise((resolve) => {
            const name = guestInfo.name || 'Unknown';
            const hp = guestInfo.headphones ? 'headphones' : 'speaker';
            console.log(`[UI] ⚡ "${name}" (${hp}) wants to join.`);

            // Insert inline admission buttons in screen
            const admitRow = document.createElement('div');
            admitRow.style.margin = '6px 0';
            admitRow.style.padding = '4px 0';
            admitRow.style.borderTop = '1px solid var(--border)';
            admitRow.style.borderBottom = '1px solid var(--border)';

            admitRow.appendChild(txt(`  ⚡ "${name}" (${hp}) requests to join  `, 'amber'));
            admitRow.appendChild(btn('ADMIT', () => {
                admitRow.remove();
                resolve(true);
            }, 'btn-green'));
            admitRow.appendChild(txt(' '));
            admitRow.appendChild(btn('DENY', () => {
                admitRow.remove();
                resolve(false);
            }, 'btn-red'));

            screen.appendChild(admitRow);
            screen.scrollTop = screen.scrollHeight;
        });
    };

    // Countdown
    const _origStartCountdown = window.app.startCountdown.bind(window.app);
    window.app.startCountdown = function (seconds) {
        _origStartCountdown(seconds);
        let remaining = Math.ceil(seconds);
        if (countdownInterval) clearInterval(countdownInterval);

        function tick() {
            const cdEl = document.getElementById('tui-countdown');
            if (!cdEl) return;

            if (remaining <= 0) {
                cdEl.style.display = 'none';
                cdEl.textContent = '';
                clearInterval(countdownInterval);
                countdownInterval = null;
                return;
            }

            cdEl.style.display = 'block';
            cdEl.innerHTML = '';
            cdEl.appendChild(txt('│   ', 'box-line'));
            cdEl.appendChild(txt(`▶ Recording starts in ${remaining}…`, 'amber bold'));
            remaining--;
        }

        tick();
        countdownInterval = setInterval(tick, 1000);
    };

    // Progress updates
    const _origUpdateProgress = window.app.updateProgress.bind(window.app);
    window.app.updateProgress = function (type, current, total, guestId) {
        _origUpdateProgress(type, current, total, guestId);
        if (total === 0) return;
        const pct = Math.min(100, (current / total) * 100);
        const key = guestId ? `${type}_${guestId}` : type;
        const guestLabel = guestId ? (window.app.guestRoster[guestId] || guestId.slice(-6)) : '';
        const label = guestLabel ? `${type} (${guestLabel})` : type;
        progressState[key] = { pct, label };

        // Update DOM in place
        updateProgressBarsDOM();
    };

    const _origInitProgressUI = window.app.initProgressUI.bind(window.app);
    window.app.initProgressUI = function () {
        _origInitProgressUI();
        Object.keys(progressState).forEach(k => delete progressState[k]);
        if (currentView === 'processing') updateProgressBarsDOM();
    };

    // ─── Edit Take — Player & AI Callbacks ───────────────────────────────────
    const _et_fmtTime = (secs) => {
        const t = Math.max(0, secs || 0);
        return `${String(Math.floor(t / 60)).padStart(2,'0')}:${String(Math.floor(t % 60)).padStart(2,'0')}`;
    };

    const _origOnPlayerTimeUpdate = window.app.onPlayerTimeUpdate.bind(window.app);
    window.app.onPlayerTimeUpdate = function (time) {
        _origOnPlayerTimeUpdate(time);
        if (currentView !== 'edit_take') return;
        editCurrentTime = time;
        const td = document.getElementById('edit-time-display');
        if (td) td.textContent = `  ${_et_fmtTime(time)}  /  ${_et_fmtTime(editTotalDuration)}`;
        if (editTotalDuration > 0) {
            const PBAR_W = 44;
            const filled = Math.round(Math.min(1, time / editTotalDuration) * PBAR_W);
            const fillEl  = document.getElementById('edit-pb-fill');
            const emptyEl = document.getElementById('edit-pb-empty');
            if (fillEl)  fillEl.textContent  = '█'.repeat(filled);
            if (emptyEl) emptyEl.textContent = '░'.repeat(PBAR_W - filled);
        }
    };

    const _origOnPlayerStateChange = window.app.onPlayerStateChange.bind(window.app);
    window.app.onPlayerStateChange = function (state) {
        _origOnPlayerStateChange(state);
        if (currentView !== 'edit_take') return;
        editPlayerState = state === 'playing' ? 'playing' : 'paused';
        const pb = document.getElementById('edit-play-btn');
        if (pb) {
            pb.textContent = editPlayerState === 'playing' ? '[ ⏸ PAUSE ]' : '[ ▶ PLAY  ]';
            pb.className   = 'tui-btn ' + (editPlayerState === 'playing' ? 'btn-amber' : 'btn-green');
        }
    };

    const _origOnEditStateChanged = window.app.onEditStateChanged.bind(window.app);
    window.app.onEditStateChanged = function (takeId, editsObject) {
        _origOnEditStateChanged(takeId, editsObject);
        if (currentView !== 'edit_take' || !editTakeDetail || editTakeDetail.takeId !== takeId) return;
        editCurrentEdits = editsObject;
        // Re-apply strikethroughs
        document.querySelectorAll('#edit-transcript-area .tui-word').forEach(span => {
            applyWordEditStyle(span, {
                startTime: parseFloat(span.dataset.startTime) || 0,
                endTime:   parseFloat(span.dataset.endTime)   || 0
            }, editsObject, span.dataset.peerId);
        });
        // Rebuild player timeline then sync the displayed total duration
        if (window.Player && window.Player.currentTakeId === takeId) {
            window.Player.rebuildTimeline()
                .then(() => {
                    const newDur = Object.values(window.Player.tracks || {})
                        .reduce((m, t) => Math.max(m, t.virtualDuration || 0), 0);
                    if (newDur > 0) {
                        editTotalDuration = newDur;
                        const td = document.getElementById('edit-time-display');
                        if (td) td.textContent = `  ${_et_fmtTime(editCurrentTime)}  /  ${_et_fmtTime(newDur)}`;
                    }
                })
                .catch(e => console.error('[EditTake] rebuildTimeline error:', e));
        }
    };

    const _origOnVADPreview = window.app.onVADPreview.bind(window.app);
    window.app.onVADPreview = async function (takeId, silenceSpans) {
        _origOnVADPreview(takeId, silenceSpans);
        if (currentView !== 'edit_take' || !editTakeDetail || editTakeDetail.takeId !== takeId) return;

        const vb  = document.getElementById('edit-vad-btn');
        const vs  = document.getElementById('edit-vad-status');

        if (!silenceSpans || silenceSpans.length === 0) {
            if (vb) { vb.textContent = '[ ✨ REMOVE SILENCES ]'; vb.disabled = false; }
            if (vs) { vs.textContent = '  ✓ no silences found'; vs.className = 'dim'; }
            return;
        }

        if (vs) { vs.textContent = `  ⟳ applying ${silenceSpans.length} cut${silenceSpans.length !== 1 ? 's' : ''}…`; vs.className = 'amber'; }

        try {
            if (window.AI?.applyVAD) await window.AI.applyVAD(takeId, silenceSpans);
            const totalSec = silenceSpans.reduce((s, sp) => s + (sp.endSec - sp.startSec), 0);
            const mm = Math.floor(totalSec / 60);
            const ss = (totalSec % 60).toFixed(1);
            if (vs) { vs.textContent = `  ✓ ${silenceSpans.length} cut${silenceSpans.length !== 1 ? 's' : ''} (${mm > 0 ? mm + 'm ' : ''}${ss}s removed)`; vs.className = 'green'; }
        } catch (e) {
            console.error('[EditTake] applyVAD error:', e);
            if (vs) { vs.textContent = '  ✕ error applying cuts'; vs.className = 'red'; }
        }

        if (vb) { vb.textContent = '[ ✨ REMOVE SILENCES ]'; vb.disabled = false; }
    };

    const _origOnExportProgress = window.app.onExportProgress.bind(window.app);
    window.app.onExportProgress = function (takeId, percentage) {
        _origOnExportProgress(takeId, percentage);
        if (currentView !== 'edit_take') return;
        editExportProgress = percentage;
        const epRow = document.getElementById('edit-export-pb-row');
        if (epRow) {
            const EPB_W  = 32;
            const pct    = Math.min(100, Math.round(percentage));
            const filled = Math.round((pct / 100) * EPB_W);
            epRow.style.display = 'flex';
            epRow.innerHTML = '';
            epRow.appendChild(txt('│  ', 'box-line'));
            epRow.appendChild(txt('[', 'dim'));
            epRow.appendChild(txt('█'.repeat(filled),       pct >= 100 ? 'green' : 'cyan'));
            epRow.appendChild(txt('░'.repeat(EPB_W - filled), 'dim'));
            epRow.appendChild(txt(']', 'dim'));
            epRow.appendChild(txt(` ${pct}%`, pct >= 100 ? 'green' : 'white'));
        }
        if (percentage >= 100) {
            const mb = document.getElementById('edit-export-mix-btn');
            const tb = document.getElementById('edit-export-tracks-btn');
            if (mb) { mb.textContent = '[ ⬇ EXPORT MIX ]';    mb.disabled = false; }
            if (tb) { tb.textContent = '[ ⬇ EXPORT TRACKS ]'; tb.disabled = false; }
            editExportProgress = null;
            setTimeout(() => { const r = document.getElementById('edit-export-pb-row'); if (r) r.style.display = 'none'; }, 2500);
        }
    };

    // Inject styles for tui-word selection
    (function injectEditStyles() {
        if (document.getElementById('ws-edit-styles')) return;
        const style = document.createElement('style');
        style.id = 'ws-edit-styles';
        style.textContent = [
            '.tui-word { cursor: pointer; border-radius: 2px; padding: 0 1px; transition: background 0.1s, color 0.1s; }',
            '.tui-word:hover { background: rgba(94,255,255,0.12); }',
            '.tui-word.selected { background: rgba(94,255,255,0.28); color: #5effff; outline: 1px solid rgba(94,255,255,0.5); }',
            '.edit-transport-row { display: flex; align-items: center; padding: 3px 0; gap: 6px; }'
        ].join('\n');
        document.head.appendChild(style);
    })();

    // Helper: build word spans into a container element for a given transcript record
    function _buildTranscriptWords(container, transcript, getPeerNameFn) {
        const labelRow = document.createElement('div'); labelRow.style.margin = '6px 0 2px 0';
        labelRow.appendChild(txt('│  ', 'box-line'));
        labelRow.appendChild(txt(`┤ ${getPeerNameFn(transcript.peerId)} ├ `, 'amber'));
        container.appendChild(labelRow);
        const wordsRow = document.createElement('div'); wordsRow.style.padding = '2px 0';
        wordsRow.appendChild(txt('│    ', 'box-line'));
        const wrap = document.createElement('span'); wrap.style.lineHeight = '2';
        (transcript.words || []).forEach((word, wordIdx) => {
            const sp = document.createElement('span');
            sp.className = 'tui-word';
            sp.dataset.wordId    = String(wordIdx);
            sp.dataset.peerId    = transcript.peerId;
            sp.dataset.startTime = String(word.startTime ?? 0);
            sp.dataset.endTime   = String(word.endTime   ?? 0);
            sp.textContent = (word.word || '') + ' ';
            if (editCurrentEdits) applyWordEditStyle(sp, word, editCurrentEdits, transcript.peerId);
            sp.addEventListener('click', (ev) => {
                if (ev.shiftKey && editLastClickedWord && editLastClickedWord.peerId === transcript.peerId) {
                    const fromIdx = Math.min(editLastClickedWord.wordIdx, wordIdx);
                    const toIdx   = Math.max(editLastClickedWord.wordIdx, wordIdx);
                    const allSpans = document.querySelectorAll(
                        `#edit-transcript-area .tui-word[data-peer-id="${transcript.peerId}"]`
                    );
                    allSpans.forEach(s => {
                        const si = parseInt(s.dataset.wordId, 10);
                        if (si >= fromIdx && si <= toIdx) {
                            if (!editSelectedWordIds.find(x => x.peerId === transcript.peerId && x.wordIdx === si)) {
                                editSelectedWordIds.push({ peerId: transcript.peerId, wordIdx: si });
                                s.classList.add('selected');
                            }
                        }
                    });
                } else {
                    const idx = editSelectedWordIds.findIndex(s => s.peerId === transcript.peerId && s.wordIdx === wordIdx);
                    if (idx === -1) { editSelectedWordIds.push({ peerId: transcript.peerId, wordIdx }); sp.classList.add('selected'); }
                    else            { editSelectedWordIds.splice(idx, 1); sp.classList.remove('selected'); }
                    editLastClickedWord = { peerId: transcript.peerId, wordIdx };
                }
                const cb = document.getElementById('edit-cut-btn');
                if (cb) _syncWsCutBtn();
            });
            wrap.appendChild(sp);
        });
        wordsRow.appendChild(wrap);
        container.appendChild(wordsRow);
    }

    // onAIStateChange: show live progress in the Edit view status line
    const _origOnAIStateChange = window.app.onAIStateChange.bind(window.app);
    window.app.onAIStateChange = function (takeId, peerId, taskType, state, progress) {
        _origOnAIStateChange(takeId, peerId, taskType, state, progress);
        if (currentView !== 'edit_take' || !editTakeDetail || editTakeDetail.takeId !== takeId) return;
        const statusEl = document.getElementById('edit-tx-status');
        if (!statusEl) return;
        if (state === 'queued') {
            statusEl.textContent = `  ⟳ queued…`;
            statusEl.className = 'dim';
        } else if (state === 'running') {
            statusEl.textContent = `  ⟳ transcribing…`;
            statusEl.className = 'cyan';
        } else if (taskType === 'transcription_loading') {
            const pct = Math.round(progress || 0);
            statusEl.textContent = `  ⬇ loading model ${pct}%`;
            statusEl.className = 'amber';
        } else if (state === 'error') {
            statusEl.textContent = `  ✕ error`;
            statusEl.className = 'red';
        }
    };

    // onTranscriptReady: auto-populate the transcript area as each peer finishes
    const _origOnTranscriptReady = window.app.onTranscriptReady.bind(window.app);
    window.app.onTranscriptReady = async function (takeId, peerId, transcriptId) {
        _origOnTranscriptReady(takeId, peerId, transcriptId);
        if (currentView !== 'edit_take' || !editTakeDetail || editTakeDetail.takeId !== takeId) return;

        const txArea = document.getElementById('edit-transcript-area');
        if (!txArea) return;

        // Remove any "no transcript" placeholder
        txArea.querySelectorAll('.tx-placeholder').forEach(el => el.remove());

        // Fetch the new transcript record
        const transcript = await window.SessionDB.getTakeTranscripts(takeId)
            .then(all => all.find(t => t.peerId === peerId))
            .catch(() => null);
        if (!transcript) return;

        // Remove stale entry for this peer if it already exists
        const existing = txArea.querySelector(`[data-tx-peer="${peerId}"]`);
        if (existing) existing.remove();

        // Build and append peer name resolver (best-effort from Player tracks)
        const take = await window.SessionDB.getTake(takeId).catch(() => null);
        const getPeerName = (pid) => {
            if (pid === 'host') return 'Host';
            const p = take?.participants?.find(pt => pt.peerId === pid);
            return p?.name || pid.slice(-6).toUpperCase();
        };

        const peerBlock = document.createElement('div');
        peerBlock.dataset.txPeer = peerId;
        _buildTranscriptWords(peerBlock, transcript, getPeerName);
        txArea.appendChild(peerBlock);

        // Clear status line
        const statusEl = document.getElementById('edit-tx-status');
        if (statusEl) { statusEl.textContent = '  ✓ done'; statusEl.className = 'green'; }
        // Re-enable transcribe button
        const txBtn = document.getElementById('edit-transcribe-btn');
        if (txBtn) { txBtn.textContent = '[ 🎤 TRANSCRIBE ALL ]'; txBtn.disabled = false; }
    };

    // ──────────────────────────────
    //  KEYBOARD SHORTCUTS
    // ──────────────────────────────

    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

        if (currentView === 'meeting') {
            if (e.key === 'm' || e.key === 'M') {
                if (!window.AudioSync) return;
                isMutedUI = !isMutedUI;
                window.AudioSync.setMuted(isMutedUI);
                renderMeeting();
            }
            if ((e.key === 'r' || e.key === 'R') && isHostUI) {
                if (!window.AudioSync) return;
                if (!isRecordingUI) {
                    window.AudioSync.startRecordingProcess();
                } else {
                    window.AudioSync.stopRecordingProcess();
                }
            }
            if ((e.key === 'l' || e.key === 'L') && !isHostUI) {
                if (window.AudioSync) window.AudioSync.leaveSession();
            }
            if ((e.key === 'e' || e.key === 'E') && isHostUI) {
                if (window.AudioSync) window.AudioSync.endMeeting();
            }
        }
    });

    // ──────────────────────────────
    //  MICROPHONE POPULATION
    // ──────────────────────────────

    async function populateMicrophones() {
        micList = await window.app.requestMicrophoneAccess();
        if (micList.length > 0 && !window.app.selectedMicId) {
            window.app.setMicrophone(micList[0].deviceId);
        }
        // Re-render boot if we're on it
        if (currentView === 'boot') renderBoot();
    }

    // ──────────────────────────────
    //  INIT
    // ──────────────────────────────

    console.log('╔══════════════════════════════════════╗');
    console.log('║  Wave Shed — Terminal Interface v1   ║');
    console.log('╚══════════════════════════════════════╝');

    // Initial render
    renderBoot();

    // Populate mics after a beat (app.js DOMContentLoaded may race)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(populateMicrophones, 150));
    } else {
        setTimeout(populateMicrophones, 150);
    }

    // URL auto-join handling: if ?meeting= is set, the join field is pre-filled
    // app.js DOMContentLoaded handles the actual auto-join logic

})();
