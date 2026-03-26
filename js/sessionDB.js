window.SessionDB = {
    db: null,

    open: function() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                resolve();
                return;
            }
            const request = indexedDB.open('waveshed_db', 3);

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
                if (e.oldVersion < 2) {
                    const takesStore = db.createObjectStore('takes', { keyPath: 'takeId' });
                    takesStore.createIndex('sessionId', 'sessionId', { unique: false });
                }
                if (e.oldVersion < 3) {
                    const transcriptsStore = db.createObjectStore('transcripts', { keyPath: 'id' });
                    transcriptsStore.createIndex('sessionId', 'sessionId', { unique: false });
                    transcriptsStore.createIndex('takeId', 'takeId', { unique: false });

                    const editsStore = db.createObjectStore('edits', { keyPath: 'takeId' });
                    editsStore.createIndex('sessionId', 'sessionId', { unique: false });
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

    // --- Takes store methods ---

    createTake: function(record) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('takes', 'readwrite');
            const store = tx.objectStore('takes');
            const request = store.add(record);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    },

    updateTake: function(takeId, partial) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('takes', 'readwrite');
            const store = tx.objectStore('takes');
            const request = store.get(takeId);

            request.onsuccess = (e) => {
                const record = e.target.result;
                if (!record) {
                    reject(new Error(`Take ${takeId} not found`));
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

    getTake: function(takeId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('takes', 'readonly');
            const store = tx.objectStore('takes');
            const request = store.get(takeId);
            request.onsuccess = (e) => resolve(e.target.result || null);
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getSessionTakes: function(sessionId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('takes', 'readonly');
            const store = tx.objectStore('takes');
            const index = store.index('sessionId');
            const request = index.getAll(IDBKeyRange.only(sessionId));
            request.onsuccess = (e) => {
                const takes = e.target.result || [];
                takes.sort((a, b) => a.startedAt - b.startedAt);
                resolve(takes);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    },

    deleteTake: function(takeId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('takes', 'readwrite');
            const store = tx.objectStore('takes');
            const request = store.delete(takeId);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    },

    // --- Updated deleteSessions to cascade to takes ---

    deleteSessions: function(id) {
        return new Promise((resolve, reject) => {
            const storeNames = ['sessions', 'telemetry', 'downloads'];
            // Only include stores if they exist (handles v1/v2 databases gracefully)
            if (this.db.objectStoreNames.contains('takes')) {
                storeNames.push('takes');
            }
            if (this.db.objectStoreNames.contains('transcripts')) {
                storeNames.push('transcripts');
            }
            if (this.db.objectStoreNames.contains('edits')) {
                storeNames.push('edits');
            }
            const tx = this.db.transaction(storeNames, 'readwrite');
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

            // Delete associated takes using the sessionId index
            if (this.db.objectStoreNames.contains('takes')) {
                const takesStore = tx.objectStore('takes');
                const takesIndex = takesStore.index('sessionId');
                const takesRequest = takesIndex.openCursor(IDBKeyRange.only(id));
                takesRequest.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    }
                };
            }

            // Delete associated transcripts using the sessionId index
            if (this.db.objectStoreNames.contains('transcripts')) {
                const transcriptsStore = tx.objectStore('transcripts');
                const transcriptsIndex = transcriptsStore.index('sessionId');
                const transcriptsRequest = transcriptsIndex.openCursor(IDBKeyRange.only(id));
                transcriptsRequest.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    }
                };
            }

            // Delete associated edits using the sessionId index
            if (this.db.objectStoreNames.contains('edits')) {
                const editsStore = tx.objectStore('edits');
                const editsIndex = editsStore.index('sessionId');
                const editsRequest = editsIndex.openCursor(IDBKeyRange.only(id));
                editsRequest.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    }
                };
            }

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
    },

    // --- Transcript store methods ---

    createTranscript: function(record) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('transcripts', 'readwrite');
            const store = tx.objectStore('transcripts');
            const request = store.add(record);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    },

    updateTranscript: function(id, partial) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('transcripts', 'readwrite');
            const store = tx.objectStore('transcripts');
            const request = store.get(id);

            request.onsuccess = (e) => {
                const record = e.target.result;
                if (!record) {
                    reject(new Error(`Transcript ${id} not found`));
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

    upsertTranscript: function(record) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('transcripts', 'readwrite');
            const store = tx.objectStore('transcripts');
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getTranscript: function(takeId, peerId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('transcripts', 'readonly');
            const store = tx.objectStore('transcripts');
            const request = store.get(`${takeId}_${peerId}`);
            request.onsuccess = (e) => resolve(e.target.result || null);
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getSessionTranscripts: function(sessionId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('transcripts', 'readonly');
            const store = tx.objectStore('transcripts');
            const index = store.index('sessionId');
            const request = index.getAll(IDBKeyRange.only(sessionId));
            request.onsuccess = (e) => resolve(e.target.result || []);
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getTakeTranscripts: function(takeId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('transcripts', 'readonly');
            const store = tx.objectStore('transcripts');
            const index = store.index('takeId');
            const request = index.getAll(IDBKeyRange.only(takeId));
            request.onsuccess = (e) => resolve(e.target.result || []);
            request.onerror = (e) => reject(e.target.error);
        });
    },

    // --- Edits store methods ---

    createEdits: function(record) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('edits', 'readwrite');
            const store = tx.objectStore('edits');
            const request = store.add(record);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    },

    updateEdits: function(takeId, partial) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('edits', 'readwrite');
            const store = tx.objectStore('edits');
            const request = store.get(takeId);

            request.onsuccess = (e) => {
                const record = e.target.result;
                if (!record) {
                    reject(new Error(`Edits for take ${takeId} not found`));
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

    upsertEdits: function(record) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('edits', 'readwrite');
            const store = tx.objectStore('edits');
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getEdits: function(takeId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('edits', 'readonly');
            const store = tx.objectStore('edits');
            const request = store.get(takeId);
            request.onsuccess = (e) => resolve(e.target.result || null);
            request.onerror = (e) => reject(e.target.error);
        });
    }
};
