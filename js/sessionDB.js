window.SessionDB = {
    db: null,

    open: function() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                resolve();
                return;
            }
            const request = indexedDB.open('waveshed_db', 1);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('sessions')) {
                    db.createObjectStore('sessions', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('telemetry')) {
                    db.createObjectStore('telemetry', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('downloads')) {
                    db.createObjectStore('downloads', { keyPath: 'id' });
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };

            request.onerror = (e) => {
                reject(e.target.error);
            };
        });
    },

    createSession: function(record) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sessions', 'readwrite');
            const store = tx.objectStore('sessions');
            const request = store.add(record);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    },

    updateSession: function(id, partial) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sessions', 'readwrite');
            const store = tx.objectStore('sessions');
            const request = store.get(id);

            request.onsuccess = (e) => {
                const record = e.target.result;
                if (!record) {
                    reject(new Error(`Session ${id} not found`));
                    return;
                }
                const updated = { ...record, ...partial };
                const updateRequest = store.put(updated);
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = (e) => reject(e.target.error);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getSession: function(id) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sessions', 'readonly');
            const store = tx.objectStore('sessions');
            const request = store.get(id);
            request.onsuccess = (e) => resolve(e.target.result || null);
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getAllSessions: function() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sessions', 'readonly');
            const store = tx.objectStore('sessions');
            const request = store.getAll();
            request.onsuccess = (e) => {
                const sessions = e.target.result || [];
                sessions.sort((a, b) => b.createdAt - a.createdAt);
                resolve(sessions);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    },

    deleteSessions: function(id) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['sessions', 'telemetry', 'downloads'], 'readwrite');
            const sessionsStore = tx.objectStore('sessions');
            const telemetryStore = tx.objectStore('telemetry');
            const downloadsStore = tx.objectStore('downloads');

            sessionsStore.delete(id);

            // Delete associated telemetry records
            const telemetryRequest = telemetryStore.getAll();
            telemetryRequest.onsuccess = (e) => {
                const telemetry = e.target.result || [];
                telemetry.forEach(t => {
                    if (t.sessionId === id) {
                        telemetryStore.delete(t.id);
                    }
                });
            };

            // Delete associated downloads records
            const downloadsRequest = downloadsStore.getAll();
            downloadsRequest.onsuccess = (e) => {
                const downloads = e.target.result || [];
                downloads.forEach(d => {
                    if (d.sessionId === id) {
                        downloadsStore.delete(d.id);
                    }
                });
            };

            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    },

    writeTelemetry: function(record) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('telemetry', 'readwrite');
            const store = tx.objectStore('telemetry');
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getTelemetry: function(sessionId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('telemetry', 'readonly');
            const store = tx.objectStore('telemetry');
            const request = store.getAll();
            request.onsuccess = (e) => {
                const allTelemetry = e.target.result || [];
                const sessionTelemetry = allTelemetry.filter(t => t.sessionId === sessionId);
                resolve(sessionTelemetry);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    },

    logDownload: function(record) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('downloads', 'readwrite');
            const store = tx.objectStore('downloads');
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getDownloads: function(sessionId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('downloads', 'readonly');
            const store = tx.objectStore('downloads');
            const request = store.getAll();
            request.onsuccess = (e) => {
                const allDownloads = e.target.result || [];
                const sessionDownloads = allDownloads.filter(d => d.sessionId === sessionId);
                resolve(sessionDownloads);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }
};
