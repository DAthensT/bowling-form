// 1投球 = 動画 + 解析結果 + AIフィードバック を1レコードにして IndexedDB に保存する。お手本プリセットも同じ DB に置く。
const DB_NAME = 'bowlingform';
const THROWS = 'throws';
const PRESETS = 'presets';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(THROWS)) db.createObjectStore(THROWS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PRESETS)) db.createObjectStore(PRESETS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result.result);
    t.onerror = () => reject(t.error);
  });
}

export const putThrow = (rec) => tx(THROWS, 'readwrite', s => s.put(rec));
export const removeThrow = (id) => tx(THROWS, 'readwrite', s => s.delete(id));
export const getThrow = (id) => tx(THROWS, 'readonly', s => s.get(id));
export const allThrows = async () => (await tx(THROWS, 'readonly', s => s.getAll())).sort((a, b) => b.date - a.date);

export const putPreset = (p) => tx(PRESETS, 'readwrite', s => s.put(p));
export const removePreset = (id) => tx(PRESETS, 'readwrite', s => s.delete(id));
export const getPreset = (id) => tx(PRESETS, 'readonly', s => s.get(id));
export const allPresets = async () => (await tx(PRESETS, 'readonly', s => s.getAll())).sort((a, b) => b.createdAt - a.createdAt);

export const settings = {
  get(key, def) {
    try { const v = localStorage.getItem('bf.' + key); return v === null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem('bf.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  }
};
