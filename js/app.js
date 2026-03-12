window.app = {
    progressState: {
        compressing: -1,
        transferring: -1,
        uncompressing: -1
    },

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
    setMicrophone: function(deviceId) {
        console.log(`[UI] Microphone selected: ${deviceId}`);
        this.selectedMicId = deviceId;
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
        return Promise.resolve(
            window.confirm(`"${name}" wants to join.\nHeadphones: ${headphones}\n\nAllow them in?`)
        );
    },

    /**
     * Called when the host denies our join request.
     */
    onAdmissionDenied: function() {
        console.log('[UI] We were denied entry to the meeting.');
        alert('The host denied your join request.');
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
    }
};

window.addEventListener('DOMContentLoaded', async () => {
    // Request permissions and fetch available microphones as soon as the UI loads
    const microphones = await window.app.requestMicrophoneAccess();
    
    // Default to the first available microphone if any are found
    if (microphones.length > 0) {
        window.app.setMicrophone(microphones[0].deviceId);
    }

    const params = new URLSearchParams(window.location.search);
    const meetingId = params.get('meeting');
    
    if (meetingId && window.AudioSync) {
        console.log('Auto-joining meeting as guest:', meetingId);
        // Pass the chosen microphone and participant info to the audio logic
        window.AudioSync.initGuest(meetingId, window.app.selectedMicId, window.app.getParticipantInfo());
    }
});
