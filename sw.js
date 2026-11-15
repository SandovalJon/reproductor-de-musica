/* Service worker del Reproductor de Música: app shell offline-first. */
/* Al publicar cambios, subir APP_VERSION en index.html y este CACHE juntos. */
/* 3.0.0: los módulos de sync entran en ASSETS para que la app
   funcione offline desde la primera carga (antes, lyrics.js y
   mejoras.js solo se cacheaban tras la primera carga). */
var CACHE = 'reproductor-musica-3.6.0';
var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './maskable-512.png',
  './apple-touch-icon.png',
  './lyrics.js',
  './lyrics.css',
  './embedded-lyrics.js',
  './mejoras.js',
  './mejoras.css',
  './cast.js',
  './cast.css',
  './temas.js',
  './temas.css',
  './visual.js',
  './visual.css',
  './atajos.js',
  './atajos.css',
  './a11y.js',
  './a11y.css',
  './karaoke.js',
  './karaoke.css',
  './wrapped.js',
  './wrapped.css',
  './wrapped-img.js',
  './wrapped-img.css',
  './alarma.js',
  './alarma.css',
  './compartir.js',
  './compartir.css',
  './traduccion.js',
  './traduccion.css',
  './mini.js',
  './mini.css',
  './pomodoro.js',
  './pomodoro.css',
  './voz.js',
  './voz.css',
  './spotify-import.js',
  './spotify-import.css',
  './dj.js',
  './dj.css',
  './acordes.js',
  './acordes.css',
  './luces.js',
  './luces.css',
  './timeline.js',
  './timeline.css',
  './fonts.css',
  './fonts/plus-jakarta-sans-latin.woff2',
  './fonts/plus-jakarta-sans-latin-ext.woff2',
  './fonts/fraunces-latin.woff2',
  './fonts/fraunces-latin-ext.woff2',
  './src/library/db.js',
  './src/library/eq.js',
  './src/library/smart-lists.js',
  './src/library/track-meta.js',
  './src/library/zip.js',
  './src/sync/sync-core.js',
  './src/sync/package-io.js',
  './src/sync/sync-ui.js',
  './src/sync/sync-ui.css',
  './src/sync/sync-bridge.js',
  './src/folders/folders.js',
  './src/folders/folders.css'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    }).then(function() {
      return self.skipWaiting();
    }).catch(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) {
        return k !== CACHE;
      }).map(function(k) {
        return caches.delete(k);
      }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  var url;
  try {
    url = new URL(event.request.url);
  } catch (e) {
    return;
  }
  // Solo cacheamos el propio sitio; Google Fonts y demás siguen a red.
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(function() {
        return caches.match('./index.html');
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function(hit) {
      if (hit) return hit;
      return fetch(event.request).then(function(res) {
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(event.request, copy);
          });
        }
        return res;
      }).catch(function() {
        return caches.match('./index.html');
      });
    })
  );
});
