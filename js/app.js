window.app = {
    progressState: {
        compressing: -1,
        transferring: -1,
        uncompressing: -1
    },

    sessionState: 'idle', // 'idle' | 'in_meeting' | 'recording' | 'transferring'
    selectedMicId: null,

    // Local participant info
    localName: '',
    localHeadphones: false,
    localSpeaker: '',

    /**
     * Sets the local participant info before joining a session.
     * @param {string} name - Display name for this participant.
     * @param {boolean} headphones - Whether the participant is wearing headphones.
     * @param {string} speaker - The deviceId of the selected speaker output.
     */
    setParticipantInfo: function(name, headphones, speaker) {
        this.localName = name || '';
        this.localHeadphones = headphones || false;
        this.localSpeaker = speaker || '';
        console.log(`[UI] Participant info set: name="${this.localName}", headphones=${this.localHeadphones}, speaker="${this.localSpeaker}"`);
    },

    /**
     * Requests permission to access the microphone and enumerates available audio devices.
     * @returns {Promise<MediaDeviceInfo[]>} A list of available microphones.
     */
    requestMicrophoneAccess: async function() {
        try {
            console.log('[UI] Requesting microphone access...');
            // Request a temporary stream to prompt the user for permissions
            const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Now that permissions are granted, enumerate all media devices
            const allDevices = await navigator.mediaDevices.enumerateDevices();
            const microphones = allDevices.filter(device => device.kind === 'audioinput');
            
            console.log('[UI] Available microphones:', microphones);
            
            // Release the temporary stream to turn off the microphone light
            tempStream.getTracks().forEach(track => track.stop());
            
            return microphones;
        } catch (error) {
            console.error('[UI] Microphone access denied or failed:', error);
            return [];
        }
    },

    /**
     * Sets the chosen microphone to be used during the session.
     * @param {string} deviceId - The device ID of the selected microphone.
     */
    setMicrophone: async function(deviceId) {
        console.log(`[UI] Microphone selected: ${deviceId}`);
        const oldId = this.selectedMicId;
        this.selectedMicId = deviceId;

        // If we're already in a meeting, hot-swap the mic
        if (window.AudioSync && this.sessionState !== 'idle') {
            try {
                await window.AudioSync.switchMicrophone(deviceId);
            } catch (err) {
                console.error('[UI] Could not switch microphone:', err.message);
                this.selectedMicId = oldId; // Revert
            }
        }
    },

    /**
     * Prompts the host to accept or deny a guest trying to join.
     * Returns a Promise that resolves to true (admit) or false (deny).
     * @param {object} guestInfo - Contains name, headphones, speaker, micId.
     * @returns {Promise<boolean>}
     */
    promptAdmission: function(guestInfo) {
        const name = guestInfo.name || 'Unknown';
        const headphones = guestInfo.headphones ? 'Yes' : 'No';
        console.log(`[UI] Admission request from "${name}" (headphones: ${headphones}). Auto-admitting until UI is ready.`);
        return Promise.resolve(true);
    },

    /**
     * Called when the host denies our join request.
     */
    onAdmissionDenied: function() {
        console.log('[UI] We were denied entry to the meeting.');
    },

    startCountdown: function(seconds) {
        console.log(`[UI] Visual countdown started for ${seconds.toFixed(2)} seconds.`);
    },

    // Map of guestId -> display name, populated by audio.js when guests are admitted.
    guestRoster: {},

    /**
     * Registers a guest's display name so progress bars can label them.
     * Called from audio.js when a guest is admitted.
     */
    registerGuest: function(guestId, name) {
        this.guestRoster[guestId] = name;
    },

    initProgressUI: function() {
        this.progressState = { compressing: -1, transferring: -1, uncompressing: -1 };
    },

    // Throttles logging to 5% increments to avoid flooding the console.
    updateProgress: function(type, current, total, guestId = '') {
        if (total === 0) return;
        const percentage = (current / total) * 100;
        const roundedPercentage = Math.floor(percentage / 5) * 5;
        
        const key = guestId ? `${type}_${guestId}` : type;
        if (this.progressState[key] === undefined) {
            this.progressState[key] = -1;
        }

        if (roundedPercentage > this.progressState[key] || percentage === 100) {
            this.progressState[key] = percentage === 100 ? 100 : roundedPercentage;
            const displayPct = this.progressState[key];
            const guestLabel = guestId ? (this.guestRoster[guestId] || guestId.slice(-6)) : '';
            const label = guestLabel ? `${type.toUpperCase()} (${guestLabel})` : type.toUpperCase();
            console.log(`[UI] ${label} Progress: ${displayPct}%`);
        }
    },

    /**
     * Returns the participant info object to pass into initHost/initGuest.
     */
    getParticipantInfo: function() {
        return {
            name: this.localName,
            headphones: this.localHeadphones,
            speaker: this.localSpeaker
        };
    },

    setSessionState: function(state) {
        console.log(`[UI] Session state changed: ${this.sessionState} -> ${state}`);
        this.sessionState = state;
    },

    onParticipantLeft: function(name) {
        console.log(`[UI] Notification: ${name} has left the session.`);
        // In a real UI, this would show a toast/banner
    },

    onMeetingEnded: function() {
        console.log('[UI] The host has ended the session.');
        // Disable controls or redirect
        this.setSessionState('idle');
    },

    onMuteStateChanged: function(peerId, isMuted) {
        console.log(`[UI] Participant ${peerId} is now ${isMuted ? 'muted' : 'unmuted'}.`);
        // Update roster UI indicator
    },

    /**
     * Called by audio.js in initHost() once the peer ID is known.
     * Creates the initial session record in IndexedDB with status 'recording'.
     * @param {string} sessionId
     * @param {string} hostName
     */
    onSessionCreated: async function(sessionId, hostName, rawHostFileName, localSampleRate) {
        if (!window.SessionDB) return;
        try {
            await window.SessionDB.createSession({
                id: sessionId,
                createdAt: Date.now(),
                hostName: hostName,
                status: 'recording',
                rawHostFile: rawHostFileName || '',
                rawGuestFiles: {},
                alignedHostFile: '',
                alignedGuestFiles: {},
                hostCropBytes: 0,
                guestCrops: [],
                participants: [],
                durationSecs: 0,
                sampleRate: localSampleRate || 44100
            });
        } catch(e) {
            console.error('[SessionDB] onSessionCreated error:', e);
        }
    },

    /**
     * Called by audio.js from the GUEST_FILE_CREATED worker message.
     * Updates rawGuestFiles in the session record.
     * @param {string} guestId
     * @param {string} fileName
     */
    onGuestFileCreated: async function(sessionId, guestId, fileName) {
        if (!window.SessionDB) return;
        try {
            if (!sessionId) return;
            const session = await window.SessionDB.getSession(sessionId);
            if (session) {
                const updatedFiles = session.rawGuestFiles || {};
                updatedFiles[guestId] = fileName;
                await window.SessionDB.updateSession(sessionId, { rawGuestFiles: updatedFiles });
            }
        } catch(e) {
            console.error('[SessionDB] onGuestFileCreated error:', e);
        }
    },

    /**
     * Called by audio.js from the CROP_DONE handler.
     * Updates the session record: sets status to 'complete', stores alignedHostFile,
     * alignedGuestFiles, hostCropBytes, guestCrops, durationSecs, and participants.
     * @param {string} sessionId
     * @param {{ hostFile: string, guestFiles: { [peerId]: string } }} alignedFiles
     */
    onProcessingComplete: async function(sessionId, alignedFiles, guests, guestTelemetryMap, localSampleRate) {
        if (!window.SessionDB) return;
        try {
            const participants = [];
            if (guests) {
                for (const [id, g] of guests) {
                    const tel = guestTelemetryMap ? guestTelemetryMap.get(id) : null;
                    participants.push({
                        peerId: id,
                        name: g.name,
                        sampleRate: tel?.guestSampleRate || localSampleRate || 44100,
                        inputLatency: tel?.guestInputLatency || 0
                    });
                }
            }
            
            let durationSecs = 0;
            try {
                const root = await navigator.storage.getDirectory();
                const h = await root.getFileHandle(alignedFiles.hostFile);
                const f = await h.getFile();
                const sr = localSampleRate || 44100;
                durationSecs = f.size / (sr * 4);
            } catch(e) {
                console.error('[SessionDB] Could not compute duration:', e);
            }

            // hostCropBytes and guestCrops are already saved in runSyncAndPostProcessing!
            await window.SessionDB.updateSession(sessionId, {
                status: 'complete',
                alignedHostFile: alignedFiles.hostFile,
                alignedGuestFiles: alignedFiles.guestFiles,
                participants: participants,
                durationSecs: durationSecs
            });
        } catch(e) {
            console.error('[SessionDB] onProcessingComplete error:', e);
        }
    },

    /**
     * Called by audio.js or the UI on any unrecoverable worker error.
     * Sets status to 'error' in the session record.
     * @param {string} sessionId
     * @param {string} reason
     */
    onSessionError: async function(sessionId, reason) {
        if (!window.SessionDB) return;
        try {
            await window.SessionDB.updateSession(sessionId, { status: 'error' });
            console.error('[Session Error]', reason);
        } catch(e) {}
    },

    /**
     * Triggers a WAV download for a specific track and logs it to the 'downloads' store.
     * @param {string} sessionId
     * @param {'raw_host'|'raw_guest'|'aligned_host'|'aligned_guest'} type
     * @param {string|null} peerId
     */
    requestDownload: async function(sessionId, type, peerId = null) {
        if (!window.SessionDB) return;
        try {
            const session = await window.SessionDB.getSession(sessionId);
            if (!session) return;
            
            let fileName = null;
            let sampleRate = session.sampleRate || 44100;
            
            if (type === 'raw_host') fileName = session.rawHostFile;
            else if (type === 'raw_guest') {
                fileName = (session.rawGuestFiles || {})[peerId];
                if (session.participants) {
                    const p = session.participants.find(p => p.peerId === peerId);
                    if (p && p.sampleRate) sampleRate = p.sampleRate;
                }
            }
            else if (type === 'aligned_host') fileName = session.alignedHostFile;
            else if (type === 'aligned_guest') {
                fileName = (session.alignedGuestFiles || {})[peerId];
                if (session.participants) {
                    const p = session.participants.find(p => p.peerId === peerId);
                    if (p && p.sampleRate) sampleRate = p.sampleRate;
                }
            }
            
            if (fileName && window.AudioSync && window.AudioSync.downloadTrack) {
                await window.AudioSync.downloadTrack(fileName, sampleRate);
                await window.SessionDB.logDownload({
                    id: `${sessionId}_${type}_${peerId || 'host'}`,
                    sessionId: sessionId,
                    type: type,
                    peerId: peerId,
                    downloadedAt: Date.now()
                });
            } else {
                console.error('[SessionDB] Could not find track or downloadTrack not available for type:', type);
            }
        } catch(e) { console.error('[SessionDB] requestDownload error:', e); }
    },

    /**
     * Downloads all aligned tracks for a session by calling requestDownload for each.
     * @param {string} sessionId
     */
    requestBulkDownload: async function(sessionId) {
        if (!window.SessionDB) return;
        try {
            const session = await window.SessionDB.getSession(sessionId);
            if (!session) return;
            await this.requestDownload(sessionId, 'aligned_host');
            for (const peerId of Object.keys(session.alignedGuestFiles || {})) {
                await this.requestDownload(sessionId, 'aligned_guest', peerId);
            }
        } catch(e) { console.error('[SessionDB] requestBulkDownload error:', e); }
    },

    /**
     * Returns all session records sorted by createdAt descending.
     * @returns {Promise<object[]>}
     */
    getSessions: async function() {
        if (!window.SessionDB) return [];
        return await window.SessionDB.getAllSessions();
    },

    /**
     * Returns a single session record plus all telemetry records for that session.
     * @param {string} sessionId
     * @returns {Promise<{ session: object, telemetry: object[] }>}
     */
    getSessionDetail: async function(sessionId) {
        if (!window.SessionDB) return { session: null, telemetry: [] };
        const session = await window.SessionDB.getSession(sessionId);
        const telemetry = await window.SessionDB.getTelemetry(sessionId);
        return { session, telemetry };
    },

    /**
     * Deletes a session and all its associated data.
     * @param {string} sessionId
     */
    deleteSession: async function(sessionId) {
        if (!window.SessionDB) return;
        try {
            const session = await window.SessionDB.getSession(sessionId);
            if (!session) return;

            if (session.status === 'recording' || session.status === 'processing') {
                console.warn(`[SessionDB] Cannot delete session ${sessionId} while it is ${session.status}.`);
                return;
            }

            const fileNames = [session.alignedHostFile].filter(Boolean);
            if (session.alignedGuestFiles) {
                fileNames.push(...Object.values(session.alignedGuestFiles));
            }

            let dispatched = false;
            if (window.AudioSync && window.AudioSync.deleteFiles) {
                dispatched = await window.AudioSync.deleteFiles(fileNames);
            }

            if (!dispatched) {
                const root = await navigator.storage.getDirectory();
                for (const fileName of fileNames) {
                    try {
                        const h = await root.getFileHandle(fileName);
                        await h.remove();
                    } catch(e) {}
                }
            }

            await window.SessionDB.deleteSessions(sessionId);
        } catch(e) {
            console.error('[SessionDB] deleteSession error:', e);
        }
    }
};

// --- Lifecycle & Reconnection Logic ---

window.addEventListener('beforeunload', (e) => {
    const blocking = ['in_meeting', 'recording', 'transferring'];
    if (blocking.includes(window.app.sessionState)) {
        // Write dirty exit flag for host/guests who might want to reconnect
        localStorage.setItem('waveshed_dirty_exit', 'true');
        
        e.preventDefault();
        e.returnValue = ''; // Standard way to trigger "Leave site?" dialog
    }
});

window.addEventListener('DOMContentLoaded', async () => {
    // Open the DB First
    if (window.SessionDB && window.SessionDB.open) {
        await window.SessionDB.open().catch(e => console.error('Failed to open DB:', e));
    }

    // Request permissions and fetch available microphones as soon as the UI loads
    const microphones = await window.app.requestMicrophoneAccess();
    
    // Default to the first available microphone if any are found
    if (microphones.length > 0) {
        window.app.setMicrophone(microphones[0].deviceId);
    }

    const params = new URLSearchParams(window.location.search);
    const meetingIdParam = params.get('meeting');
    
    // Recovery / Reconnection Flow
    const savedSession = JSON.parse(localStorage.getItem('waveshed_session') || 'null');
    const dirtyExit = localStorage.getItem('waveshed_dirty_exit') === 'true';
    localStorage.removeItem('waveshed_dirty_exit'); // Clear flag

    if (window.AudioSync) {
        if (meetingIdParam) {
            console.log('Joining meeting via URL parameter:', meetingIdParam);
            
            // If we have a saved session for this meeting, try to use the same Peer ID
            let preferredId = null;
            let isReconnect = false;
            
            if (savedSession && savedSession.role === 'guest' && savedSession.hostId === meetingIdParam) {
                preferredId = savedSession.guestPeerId;
                isReconnect = dirtyExit;
                console.log(`[App] Attempting reconnection with preferred ID: ${preferredId}`);
            }

            window.AudioSync.initGuest(
                meetingIdParam, 
                window.app.selectedMicId, 
                window.app.getParticipantInfo(),
                isReconnect,
                preferredId
            );
        } else if (savedSession && savedSession.role === 'host' && dirtyExit) {
            console.log('[App] Host dirty exit detected, attempting to recover session:', savedSession.meetingId);
            window.AudioSync.initHost(
                window.app.selectedMicId, 
                window.app.getParticipantInfo(),
                savedSession.meetingId
            );
        }
    }
});
