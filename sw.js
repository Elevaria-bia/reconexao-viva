'use strict';

const CACHE = 'reconexao-viva-v7';

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH — rede primeiro, cache como fallback ───────────────
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ── PUSH NOTIFICATIONS ───────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {
      title: 'Reconexao Viva',
      body: event.data ? event.data.text() : 'Sua pratica esta esperando.'
    };
  }

  const title = data.title || 'Reconexao Viva';
  const options = {
    body:               data.body || 'Sua pratica esta esperando.',
    icon:               '/icon-192.png',
    badge:              '/icon-96.png',
    tag:                data.tag || 'reconexao',
    renotify:           true,
    requireInteraction: false,
    data:               { url: '/' },
    vibrate:            [200, 100, 200]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── NOTIFICATION CLICK ───────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
