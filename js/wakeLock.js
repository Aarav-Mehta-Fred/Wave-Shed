/**
 * wakeLock.js - Screen Wake Lock API utility with silent video fallback
 * 
 * Prevents the screen from dimming or sleeping during active recording sessions.
 * Modern browsers use the Screen Wake Lock API. 
 * Fallback: A tiny, silent, looping video for older iOS/desktop browsers.
 */

let wakeLockSentinel = null;
let fallbackVideo = null;
let wakeLockActive = false; // Tracks our intent to keep the screen on

/**
 * Acquires a screen wake lock if supported, otherwise uses a silent video fallback.
 */
async function acquireWakeLock() {
    wakeLockActive = true;
    
    if ('wakeLock' in navigator) {
        try {
            if (wakeLockSentinel) return; // Already held
            
            wakeLockSentinel = await navigator.wakeLock.request('screen');
            console.log('[WakeLock] Screen Wake Lock is active');
            
            wakeLockSentinel.addEventListener('release', () => {
                console.log('[WakeLock] Screen Wake Lock was released');
                wakeLockSentinel = null;
            });
        } catch (err) {
            console.error(`[WakeLock] Failed to acquire wake lock: ${err.name}, ${err.message}`);
            setupFallback();
        }
    } else {
        console.warn('[WakeLock] Screen Wake Lock API not supported, using fallback');
        setupFallback();
    }
}

/**
 * Releases the wake lock or stops the fallback mechanism.
 */
async function releaseWakeLock() {
    wakeLockActive = false;
    
    if (wakeLockSentinel) {
        try {
            await wakeLockSentinel.release();
            wakeLockSentinel = null;
        } catch (err) {
            console.error('[WakeLock] Error releasing wake lock:', err);
        }
    }
    
    if (fallbackVideo) {
        fallbackVideo.pause();
        fallbackVideo.src = "";
        fallbackVideo.load();
        if (fallbackVideo.parentNode) {
            fallbackVideo.parentNode.removeChild(fallbackVideo);
        }
        fallbackVideo = null;
        console.log('[WakeLock] Fallback video stopped and removed');
    }
}

/**
 * Creates a hidden, silent, looping video to prevent screen sleep.
 */
function setupFallback() {
    if (fallbackVideo) return;

    fallbackVideo = document.createElement('video');
    fallbackVideo.setAttribute('loop', '');
    fallbackVideo.setAttribute('playsinline', '');
    fallbackVideo.setAttribute('muted', '');
    fallbackVideo.style.display = 'none';
    
    // A slightly more robust 10-second silent H.264 MP4 stub.
    // iOS Safari requires a non-zero duration and valid stream to loop properly.
    fallbackVideo.src = 'data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tYXZjMQAAAZptb292AAAAbG12aGQAAAAA36Xq2N+l6tgAAAPoAAAAKAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABVnRyYWsAAABcdGtoZAAAAAPfperY36Xq2AAAAAEAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAWBtZGlhAAAAIG1kaGQAAAAA36Xq2N+l6tgAAQAAAAEAVf8AAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAT9taW5mAAAAFHZtYmQAAAAAAYAAAAAAEQAAABhkaW5mAAAAEERyZWYAAAAAAAAAAQAAAAp1cmwgAAAAAQAAAK9zdGJsAAAAb3N0c2QAAAAAAAAAAQAAAF9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAIAAgABIAAAASAAAAAAAAAAAOS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0AAAAVYXZjQwH0AAr/4QAYYvQACv/hAAAAD3N0dHMAAAAAAAAAAQAAAAEAAAEAAAAAFnN0c2MAAAAAAAAAAQAAAAEAAAABAAAAABRzdHN6AAAAAAAAAAYAAAABAAAAFHN0Y28AAAAAAAAAAQAAADAAAAAIdWRhdAAAAAhtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyAAAAAAAAAAAAAAAAAAAAAAhrbHR2AAAAI2lsc3QAAABXqXRvbwAAAC9kYXRhAAAAAQAAAABIYW5kYnJha2UgMS43LjMgMjAyNDAyMTAwMA==';
    
    document.body.appendChild(fallbackVideo);
    
    fallbackVideo.play().catch(err => {
        console.error('[WakeLock] Fallback video play failed:', err);
    });
}

// Re-acquire wake lock when page becomes visible again
document.addEventListener('visibilitychange', () => {
    if (wakeLockActive && document.visibilityState === 'visible') {
        acquireWakeLock();
    }
});

// Export functions to window
window.WakeLock = {
    acquire: acquireWakeLock,
    release: releaseWakeLock
};
