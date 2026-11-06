// Phone-only storage in IndexedDB. Three stores:
//   sessions  - one record per upload: status, title, summary, per-swing analysis (small JSON)
//   videos    - the original video file (Blob), keyed by session id
//   frames    - keyframe JPEGs, keyed by `${sessionId}:${swing}:${phase}`
const DB_NAME = 'swinglab', DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos');
      if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('Storage is not available'));
    r.onblocked = () => reject(new Error('Storage is busy. Close other Swing Lab tabs and try again.'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    let out; const req = fn(s);
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error('Storage error'));
    t.onabort = () => reject(t.error || new Error('Storage full or unavailable'));
  }));
}

export const store = {
  async listSessions() { const all = await tx('sessions', 'readonly', (s) => s.getAll()); return (all || []).sort((a, b) => b.addedAt - a.addedAt); },
  getSession: (id) => tx('sessions', 'readonly', (s) => s.get(id)),
  putSession: (rec) => tx('sessions', 'readwrite', (s) => s.put(rec)),
  getVideo: (id) => tx('videos', 'readonly', (s) => s.get(id)),
  putVideo: (id, blob) => tx('videos', 'readwrite', (s) => s.put(blob, id)),
  getFrame: (key) => tx('frames', 'readonly', (s) => s.get(key)),
  putFrame: (key, blob) => tx('frames', 'readwrite', (s) => s.put(blob, key)),
  async deleteSession(id) {
    await tx('sessions', 'readwrite', (s) => s.delete(id));
    await tx('videos', 'readwrite', (s) => s.delete(id));
    await tx('frames', 'readwrite', (s) => s.delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`)));
  },
  async usage() { try { const e = await navigator.storage.estimate(); return e; } catch (e) { return null; } },
  async persist() { try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {} return false; },
};
