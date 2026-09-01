// =========================================================
// EquipIQ Service Worker v2.2 — Conflict Aware & Patched Sync
// =========================================================

const SW_VERSION   = 'equipiq-v2.2.0';
const STATIC_CACHE = `${SW_VERSION}-static`;
const RUNTIME_CACHE= `${SW_VERSION}-runtime`;
const API_CACHE    = `${SW_VERSION}-api`;
const DB_NAME      = 'EquipIQOfflineDB';
const DB_VERSION   = 2;

const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json'
];

const CDN_PATTERNS = [
  /cdn\.jsdelivr\.net/,
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/
];

const SUPABASE_PATTERN = /supabase\.co/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(CORE_ASSETS).catch(err => {
        console.warn('[SW] Some core assets failed to cache:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => !key.startsWith(SW_VERSION))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        return self.clients.matchAll().then(clients => {
          clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: SW_VERSION }));
        });
      })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'FLUSH_QUEUE') event.waitUntil(flushQueue());
  if (event.data === 'REFRESH_CACHE') {
    event.waitUntil(refreshAllCaches().then(() => {
      event.source && event.source.postMessage({ type: 'CACHE_REFRESHED' });
    }));
  }
});

async function refreshAllCaches() {
  const caches_to_refresh = [STATIC_CACHE, RUNTIME_CACHE];
  for (const name of caches_to_refresh) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    for (const req of keys) {
      try {
        const res = await fetch(req, { cache: 'reload' });
        if (res && (res.ok || res.type === 'opaque')) {
          await cache.put(req, res.clone());
        }
      } catch(e) { /* ignore individual failures */ }
    }
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url  = new URL(req.url);

  if (!url.protocol.startsWith('http')) return;
  if (req.headers.get('upgrade') === 'websocket') return;

  if (req.method !== 'GET') {
    if (SUPABASE_PATTERN.test(url.hostname)) {
      event.respondWith(handleMutation(req));
    }
    return;
  }

  if (SUPABASE_PATTERN.test(url.hostname) && url.pathname.includes('/auth/v1/')) return;

  if (SUPABASE_PATTERN.test(url.hostname) && url.pathname.includes('/rest/v1/')) {
    event.respondWith(handleApiGet(req));
    return;
  }

  if (SUPABASE_PATTERN.test(url.hostname) && url.pathname.includes('/functions/v1/')) {
    event.respondWith(handleEdgeFunction(req));
    return;
  }

  if (CDN_PATTERNS.some(p => p.test(url.hostname))) {
    event.respondWith(cacheFirstRevalidate(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);

  const networkPromise = fetch(req)
    .then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone()).catch(()=>{});
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    networkPromise.catch(()=>{});
    return cached;
  }

  const networkRes = await networkPromise;
  if (networkRes) return networkRes;

  return caches.match('/index.html');
}

async function cacheFirstRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);

  fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(()=>{});
    }
  }).catch(()=>{});

  if (cached) return cached;

  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(()=>{});
    }
    return res;
  } catch(e) {
    return new Response('', { status: 504 });
  }
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      cache.put(req, res.clone()).catch(()=>{});
    }
    return res;
  } catch(e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    const shell = await caches.match('/index.html');
    if (shell) return shell;
    return new Response('Offline and page not cached', { status: 404, statusText: 'Offline' });
  }
}

async function handleApiGet(req) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(req);

  try {
    const res = await fetch(req);
    if (res && res.ok) {
      cache.put(req, res.clone()).catch(()=>{});
    }
    return res;
  } catch(e) {
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-EquipIQ-Source', 'offline-cache');
      return new Response(await cached.blob(), { status: 200, headers });
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleEdgeFunction(req) {
  try {
    return await fetch(req);
  } catch(e) {
    return new Response(JSON.stringify({
      error: 'offline',
      message: 'Edge function unavailable offline'
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleMutation(req) {
  try {
    const res = await fetch(req.clone());
    return res;
  } catch(e) {
    await queueMutation(req);
    return synthesizeResponse(req);
  }
}

function synthesizeResponse(req) {
  const prefer = req.headers.get('Prefer') || '';
  const method = req.method;
  const wantsRepresentation = prefer.includes('return=representation');

  let body = '';
  if (wantsRepresentation) {
    if (method === 'POST') {
      body = JSON.stringify([{ id: 'temp-' + Date.now(), _pending_sync: true }]);
    } else if (method === 'PATCH' || method === 'PUT') {
      body = JSON.stringify([{ _pending_sync: true }]);
    } else {
      body = JSON.stringify([]);
    }
  }

  return new Response(body, {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      'X-EquipIQ-Queued': 'true'
    }
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('mutations')) {
        const store = db.createObjectStore('mutations', { autoIncrement: true, keyPath: 'qid' });
        store.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains('app_state')) {
        db.createObjectStore('app_state', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('price_cache')) {
        db.createObjectStore('price_cache', { keyPath: 'assetKey' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function getClientId() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction('app_state', 'readwrite');
    const store = tx.objectStore('app_state');
    const req = store.get('client_id');
    req.onsuccess = () => {
      if (req.result && req.result.value) {
        resolve(req.result.value);
      } else {
        const newId = 'client-' + Math.random().toString(36).substr(2, 9);
        store.put({ key: 'client_id', value: newId });
        resolve(newId);
      }
    };
    req.onerror = () => resolve('client-unknown');
  });
}

async function queueMutation(req) {
  const cloned = req.clone();
  let body = '';
  try { body = await cloned.text(); } catch(e) {}

  const clientId = await getClientId();
  
  const mutation = {
    url: req.url,
    method: req.method,
    headers: Object.fromEntries(req.headers.entries()),
    body: body,
    timestamp: Date.now(),
    client_id: clientId,
    iso_timestamp: new Date().toISOString()
  };

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mutations', 'readwrite');
    tx.objectStore('mutations').add(mutation);
    tx.oncomplete = () => {
      if ('sync' in self.registration) {
        self.registration.sync.register('sync-equipment-mutations').catch(()=>{});
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function flushQueue() {
  const db = await openDB();
  if (!db.objectStoreNames.contains('mutations')) return;

  return new Promise((resolve) => {
    const tx = db.transaction('mutations', 'readwrite');
    const store = tx.objectStore('mutations');
    const getAll = store.getAll();
    const getAllKeys = store.getAllKeys();

    getAll.onsuccess = async () => {
      const mutations = getAll.result || [];
      const keys = getAllKeys.result || [];

      let successCount = 0;
      let conflictDetected = false;

      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        try {
          const headers = {
            ...m.headers,
            'X-Client-Id': m.client_id,
            'X-Timestamp': m.iso_timestamp
          };

          const res = await fetch(m.url, {
            method: m.method,
            headers: headers,
            body: m.body
          });

          if (res.ok) {
            const delTx = db.transaction('mutations', 'readwrite');
            delTx.objectStore('mutations').delete(keys[i]);
            successCount++;
          } else if (res.status === 409) {
            // Conflict detected
            conflictDetected = true;
            const delTx = db.transaction('mutations', 'readwrite');
            delTx.objectStore('mutations').delete(keys[i]); // Drop conflicting mutation
          } else if (res.status >= 400 && res.status < 500) {
            const delTx = db.transaction('mutations', 'readwrite');
            delTx.objectStore('mutations').delete(keys[i]);
          }
        } catch(e) {
          break; // Network still down
        }
      }

      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({
          type: conflictDetected ? 'SYNC_CONFLICT' : 'SYNC_COMPLETE',
          flushed: successCount,
          remaining: mutations.length - successCount
        }));
      });
      resolve();
    };
  });
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-equipment-mutations') {
    event.waitUntil(flushQueue());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'refresh-content') {
    event.waitUntil(refreshAllCaches());
  }
});