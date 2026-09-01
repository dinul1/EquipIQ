export const OfflineStore = {
  DB_NAME: 'EquipIQOfflineDB',
  DB_VERSION: 2,
  _dbPromise: null,

  getDB() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('mutations')) db.createObjectStore('mutations', { autoIncrement: true, keyPath: 'qid' });
        if (!db.objectStoreNames.contains('app_state')) db.createObjectStore('app_state', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('price_cache')) db.createObjectStore('price_cache', { keyPath: 'assetKey' });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return this._dbPromise;
  },

  async saveAppState(stateData) {
    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction('app_state', 'readwrite');
        tx.objectStore('app_state').put({ key: 'globalData', value: stateData, timestamp: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch(e) {}
  },

  async loadAppState() {
    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction('app_state', 'readonly');
        const req = tx.objectStore('app_state').get('globalData');
        req.onsuccess = () => resolve(req.result?.value || null);
        req.onerror = () => resolve(null);
      });
    } catch(e) { return null; }
  },

  async cachePrice(assetKey, data) {
    try {
      const db = await this.getDB();
      const tx = db.transaction('price_cache', 'readwrite');
      tx.objectStore('price_cache').put({ assetKey, ...data, timestamp: Date.now() });
    } catch(e) {}
  },

  async getCachedPrice(assetKey) {
    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction('price_cache', 'readonly');
        const req = tx.objectStore('price_cache').get(assetKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch(e) { return null; }
  },

  async countPendingMutations() {
    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction('mutations', 'readonly');
        const req = tx.objectStore('mutations').count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => resolve(0);
      });
    } catch(e) { return 0; }
  }
};