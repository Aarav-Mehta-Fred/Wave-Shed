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
