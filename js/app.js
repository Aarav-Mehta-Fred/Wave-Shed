window.app = {
    progressState: {
        compressing: -1,
        transferring: -1,
        uncompressing: -1
    },

    selectedMicId: null,

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

    startCountdown: function(seconds) {
        console.log(`[UI] Visual countdown started for ${seconds.toFixed(2)} seconds.`);
    },

    initProgressUI: function() {
        this.progressState = { compressing: -1, transferring: -1, uncompressing: -1 };
    },

    // Throttles logging to 5% increments to avoid flooding the console.
    updateProgress: function(type, current, total, extraInfo = '') {
        if (total === 0) return;
        const percentage = (current / total) * 100;
        const roundedPercentage = Math.floor(percentage / 5) * 5;
        
        if (roundedPercentage > this.progressState[type] || percentage === 100) {
            this.progressState[type] = percentage === 100 ? 100 : roundedPercentage;
            const displayPct = this.progressState[type];
            console.log(`[UI] ${type.toUpperCase()} Progress: ${displayPct}% ${extraInfo}`);
        }
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
        // Pass the chosen microphone to the audio logic
        window.AudioSync.initGuest(meetingId, window.app.selectedMicId);
    }
});
