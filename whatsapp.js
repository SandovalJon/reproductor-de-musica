/* whatsapp.js — Compartir la canción que suena por WhatsApp
 * (reproductor-de-musica v3.7.0, módulo aparte)
 *
 * Qué hace: añade un botón «WhatsApp» junto a «Compartir» en la
 * tarjeta del reproductor. Al pulsarlo comparte la canción que suena
 * (título y artista leídos de #nowTitle / #nowArtist) por WhatsApp:
 *
 *   1) Si el dispositivo lo permite (Web Share API con archivos),
 *      comparte el texto + la portada como imagen.
 *   2) Si no se puede adjuntar la portada, comparte solo el texto
 *      con Web Share y lo dice claramente.
 *   3) Si no hay Web Share, abre el enlace wa.me con el texto
 *      codificado (el usuario elige el contacto en WhatsApp).
 *
 * SIN subir el audio a ningún lado: nunca se comparte ni se sube el
 * archivo de audio. Solo viajan texto y, como mucho, la portada
 * (que ya está en este dispositivo). No usa ningún servidor.
 *
 * Cómo se engancha (sin tocar el IIFE de la app): script clásico,
 * como lyrics.js / karaoke.js / compartir.js. Lee la canción actual
 * SOLO a través de window.__rpmApp.getTracks() (ya expuesto por
 * app/index.html) cruzado con el DOM (#nowTitle / #nowArtist), y la
 * portada con __rpmApp.getCoverBlob() o con fetch() de
 * track.coverUrl / #coverImg.src. Si el módulo falla al cargar, la
 * app sigue igual: todo el init va en try/catch y el botón solo se
 * añade si existe su punto de anclaje. Ver WIRING.md.
 *
 * Distinto de #btnShareCurrent («Compartir»): ese botón comparte el
 * ARCHIVO DE AUDIO con Web Share; este módulo comparte solo texto
 * (+ portada) por WhatsApp y nunca toca el audio.
 *
 * Suposiciones (confirmadas leyendo app/index.html; detalle en
 * WIRING.md):
 *   - #nowTitle muestra «Ninguna canción seleccionada» cuando no
 *     hay pista; #nowArtist, «Añade archivos de audio para empezar»
 *     o «Elige una canción de la biblioteca». Esos textos son los
 *     que detectan «sin canción sonando».
 *   - Pista en memoria: {id, name, title, artist, album, duration,
 *     size, type, addedAt, url, coverUrl, color, rating, stars}.
 *     La pista en memoria NO trae coverBlob: la portada vive en
 *     IndexedDB y se recupera con __rpmApp.getCoverBlob(pista)
 *     (idbGet(id).coverBlob) o, si eso falla, con fetch() de
 *     coverUrl (un blob: URL creado por la app).
 *   - __rpmApp NO expone getCurrentTrack(): por eso la pista actual
 *     se identifica cruzando #nowTitle/#nowArtist con getTracks()
 *     (título exacto, artista como desempate). Si __rpmApp no está
 *     disponible, se comparte con título/artista del DOM y la
 *     portada de #coverImg, si se ve.
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var NO_TRACK_TITLE = 'Ninguna canción seleccionada';
  var NO_TRACK_ARTISTS = [
    'Añade archivos de audio para empezar',
    'Elige una canción de la biblioteca',
  ];
  var MAX_FILENAME_LEN = 60;

  /* ================= Utilidades puras ================= */

  function normText(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/\s+/g, ' ').trim();
  }

  function isNoTrackTitle(title) {
    var t = String(title == null ? '' : title).trim();
    return !t || t === NO_TRACK_TITLE;
  }

  function isPlaceholderArtist(artist) {
    var a = String(artist == null ? '' : artist).trim();
    return !a || NO_TRACK_ARTISTS.indexOf(a) !== -1;
  }

  // Texto que se comparte. track: {title, artist, album}. Sin título
  // no hay nada que compartir: devuelve null.
  function buildShareText(track) {
    if (!track) return null;
    var title = String(track.title || track.name || '').trim();
    if (!title) return null;
    var lines = ['\uD83C\uDFB5 ' + title];
    var artist = String(track.artist || '').trim();
    if (artist && normText(artist) !== normText(title)) {
      lines.push('\uD83C\uDFA4 ' + artist);
    }
    var album = String(track.album || '').trim();
    if (album) lines.push('\uD83D\uDCBF ' + album);
    lines.push('Escuchando en Reproductor de Música');
    return lines.join('\n');
  }

  // Enlace wa.me sin número: WhatsApp abre su selector de contactos.
  // El texto va con encodeURIComponent (espacios %20, saltos %0A,
  // emojis y tildes codificados).
  function buildWaMeUrl(text) {
    if (typeof text !== 'string' || !text) return null;
    return 'https://wa.me/?text=' + encodeURIComponent(text);
  }

  function coverExtensionForType(type) {
    var t = String(type || '').toLowerCase().split(';')[0].trim();
    if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg';
    if (t === 'image/png') return 'png';
    if (t === 'image/webp') return 'webp';
    if (t === 'image/gif') return 'gif';
    if (t === 'image/avif') return 'avif';
    return 'jpg';
  }

  // Nombre de archivo seguro para la portada: sin tildes, sin
  // caracteres raros, a 60 caracteres. Sin título -> 'portada'.
  function coverFileName(track) {
    var base = String((track && (track.title || track.name)) || 'portada');
    try { base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
    catch (e) {}
    base = base.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, MAX_FILENAME_LEN)
      .replace(/-+$/g, '');
    if (!base) base = 'portada';
    var ext = coverExtensionForType(track && track.coverType);
    return 'portada-' + base + '.' + ext;
  }

  // Convierte el blob de la portada en File (nombre y tipo correctos
  // para que WhatsApp lo acepte como imagen). Si no hay File (navegador
  // muy viejo), devuelve el blob tal cual; canShareFiles() dirá que no.
  function coverFileFromBlob(blob, track) {
    if (!blob) return null;
    var type = blob.type || (track && track.coverType) || 'image/jpeg';
    var name = coverFileName(
      track && track.coverType ? track : Object.assign({}, track, { coverType: type }));
    if (typeof File !== 'undefined') {
      try { return new File([blob], name, { type: type }); } catch (e) {}
    }
    try { blob.name = name; } catch (e) {}
    return blob;
  }

  // ¿Puede este navegador compartir archivos con Web Share?
  // nav: navigator (inyectable en pruebas). Sin canShare o sin share,
  // devuelve false sin romper nada.
  function canShareFiles(nav, file) {
    if (!nav || !file) return false;
    if (typeof nav.canShare !== 'function' || typeof nav.share !== 'function') return false;
    try { return !!nav.canShare({ files: [file] }); }
    catch (e) { return false; }
  }

  function hasWebShare(nav) {
    return !!(nav && typeof nav.share === 'function');
  }

  // Decisión central, probada en Node:
  //   'share-files' -> Web Share con texto + portada (ideal)
  //   'share-text'  -> Web Share solo con texto (sin portada o sin
  //                    soporte de archivos; se avisa al usuario)
  //   'wa-me'       -> sin Web Share: enlace wa.me con el texto
  function decideShareMethod(caps, hasCover) {
    caps = caps || {};
    if (hasCover && caps.hasShare && caps.canShareFiles) return 'share-files';
    if (caps.hasShare) return 'share-text';
    return 'wa-me';
  }

  // Identifica la pista actual en la biblioteca por lo que muestra el
  // DOM. tracks: array de getTracks(). title/artist: textos de
  // #nowTitle / #nowArtist. Título exacto (normalizado); si hay varias
  // con el mismo título, el artista desempata; si no, la primera.
  // Devuelve la pista o null (también null si el título es el texto
  // de «sin canción» o está vacío).
  function findCurrentTrack(tracks, title, artist) {
    if (isNoTrackTitle(title)) return null;
    var wantTitle = normText(title);
    var wantArtist = isPlaceholderArtist(artist) ? '' : normText(artist);
    var firstTitleMatch = null;
    var list = Array.isArray(tracks) ? tracks : [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t) continue;
      if (normText(t.title || t.name || '') !== wantTitle) continue;
      if (!firstTitleMatch) firstTitleMatch = t;
      if (!wantArtist) continue;
      var ta = normText(t.artist || '');
      var tn = normText(t.name || '');
      if (ta === wantArtist || tn === wantArtist) return t;
    }
    return firstTitleMatch;
  }

  /* ================= Parte de navegador (DOM) =================
   * Todo aquí es defensivo: si falta un elemento o la app aún no está
   * lista, el módulo no hace nada y la app sigue igual. */
  var doc = (typeof document !== 'undefined') ? document : null;
  var win = (typeof window !== 'undefined') ? window : global;
  var nav = (typeof navigator !== 'undefined') ? navigator : null;

  function getApp() {
    try { return (typeof window !== 'undefined' && window.__rpmApp) || null; }
    catch (e) { return null; }
  }

  function getTracks() {
    var app = getApp();
    if (app && typeof app.getTracks === 'function') {
      try { return app.getTracks() || []; } catch (e) { return []; }
    }
    return [];
  }

  // Lee lo que muestra el reproductor. Devuelve
  // {title, artist, coverVisible, coverSrc} o null si no hay DOM.
  // Exportada para probarla con un DOM falso en Node.
  function readCurrentFromDom(d) {
    d = d || doc;
    if (!d || typeof d.getElementById !== 'function') return null;
    var titleEl = d.getElementById('nowTitle');
    var artistEl = d.getElementById('nowArtist');
    var coverEl = d.getElementById('coverImg');
    var title = titleEl ? String(titleEl.textContent || '').trim() : '';
    var artist = artistEl ? String(artistEl.textContent || '').trim() : '';
    var coverVisible = false, coverSrc = '';
    if (coverEl) {
      if (typeof coverEl.getAttribute === 'function') {
        coverSrc = String(coverEl.getAttribute('src') || '');
      }
      if (!coverSrc) coverSrc = String(coverEl.src || '');
      var display = coverEl.style ? String(coverEl.style.display || '') : '';
      coverVisible = !!coverSrc && display !== 'none';
    }
    return { title: title, artist: artist, coverVisible: coverVisible, coverSrc: coverSrc };
  }

  // Resuelve la canción que suena: pista de la biblioteca si se puede
  // cruzar con el DOM, o título/artista del DOM si __rpmApp no está.
  // Devuelve {track, fromDom} o {track: null, reason: 'no-track'}.
  function resolveCurrentTrack(d) {
    var shown = readCurrentFromDom(d);
    if (!shown || isNoTrackTitle(shown.title)) {
      return { track: null, reason: 'no-track' };
    }
    var track = findCurrentTrack(getTracks(), shown.title, shown.artist);
    if (track) return { track: track, fromDom: false, coverVisible: shown.coverVisible, coverSrc: shown.coverSrc };
    return {
      track: { title: shown.title, artist: isPlaceholderArtist(shown.artist) ? '' : shown.artist },
      fromDom: true, coverVisible: shown.coverVisible, coverSrc: shown.coverSrc,
    };
  }

  function appToast(msg) {
    var app = getApp();
    if (app && typeof app.toast === 'function') {
      try { app.toast(msg); return; } catch (e) {}
    }
    if (!doc) return;
    var el = doc.getElementById('toast');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(el._waT);
      el._waT = setTimeout(function () { el.classList.remove('show'); }, 3200);
      return;
    }
    var mine = doc.getElementById('waToast');
    if (!mine) {
      mine = doc.createElement('div');
      mine.id = 'waToast'; mine.className = 'wa-toast';
      mine.setAttribute('role', 'status');
      doc.body.appendChild(mine);
    }
    mine.textContent = msg;
    mine.classList.add('show');
    clearTimeout(mine._t);
    mine._t = setTimeout(function () { mine.classList.remove('show'); }, 3200);
  }

  function openWaMe(url) {
    try {
      if (win && typeof win.open === 'function') {
        var w = win.open(url, '_blank', 'noopener');
        if (w) return true;
      }
    } catch (e) {}
    try {
      if (win && win.location) { win.location.href = url; return true; }
    } catch (e) {}
    return false;
  }

  // Recupera la portada como File. Orden: __rpmApp.getCoverBlob()
  // (IndexedDB, la fuente fiable) -> fetch(track.coverUrl) -> fetch de
  // la #coverImg visible. env permite inyectar app/fetch en pruebas.
  // Nunca lanza: sin portada devuelve null (se comparte solo texto).
  function getCoverFile(track, env) {
    env = env || {};
    var app = env.app !== undefined ? env.app : getApp();
    var fetchFn = env.fetchFn !== undefined
      ? env.fetchFn
      : (typeof fetch !== 'undefined' ? fetch : null);
    var coverSrc = env.coverSrc !== undefined ? env.coverSrc : null;
    if (coverSrc === null && doc) {
      var shown = readCurrentFromDom(doc);
      if (shown && shown.coverVisible) coverSrc = shown.coverSrc;
    }
    function fromUrl(url) {
      if (!url || !fetchFn) return Promise.resolve(null);
      return Promise.resolve()
        .then(function () { return fetchFn(url); })
        .then(function (res) {
          if (!res) return null;
          if (typeof res.blob === 'function') return res.blob();
          return res;
        })
        .catch(function () { return null; });
    }
    return Promise.resolve()
      .then(function () {
        if (track && track.id && app && typeof app.getCoverBlob === 'function') {
          return Promise.resolve()
            .then(function () { return app.getCoverBlob(track); })
            .catch(function () { return null; });
        }
        return null;
      })
      .then(function (blob) {
        if (blob && blob.size !== 0) return blob;
        if (track && track.coverUrl) return fromUrl(track.coverUrl);
        return null;
      })
      .then(function (blob) {
        if (blob && blob.size !== 0) return blob;
        if (coverSrc) return fromUrl(coverSrc);
        return null;
      })
      .then(function (blob) {
        if (!blob || blob.size === 0) return null;
        return coverFileFromBlob(blob, track);
      })
      .catch(function () { return null; });
  }

  // Flujo completo al pulsar el botón. Nunca lanza: cada fallo
  // termina en un toast que dice qué pasó, y la app sigue igual.
  // env (opcional, para pruebas): {nav, app, fetchFn, coverSrc, openWaMe}.
  function shareCurrent(env) {
    env = env || {};
    var myNav = env.nav !== undefined ? env.nav : nav;
    var resolved;
    try { resolved = resolveCurrentTrack(doc); }
    catch (e) { resolved = { track: null, reason: 'no-track' }; }
    if (!resolved || !resolved.track) {
      appToast('No hay ninguna canción sonando para compartir por WhatsApp.');
      return Promise.resolve({ ok: false, reason: 'no-track' });
    }
    var track = resolved.track;
    var text = buildShareText(track);
    if (!text) {
      appToast('No hay ninguna canción sonando para compartir por WhatsApp.');
      return Promise.resolve({ ok: false, reason: 'no-track' });
    }
    var openFn = env.openWaMe || openWaMe;
    return getCoverFile(track, env).then(function (coverFile) {
      var hasCover = !!coverFile;
      var method = decideShareMethod({
        hasShare: hasWebShare(myNav),
        canShareFiles: canShareFiles(myNav, coverFile),
      }, hasCover);
      if (method === 'share-files') {
        return myNav.share({
          files: [coverFile], text: text,
          title: track.title || 'Canción',
        }).then(function () {
          appToast('Compartido por WhatsApp con portada.');
          return { ok: true, method: method, withCover: true };
        }).catch(function (err) {
          if (err && err.name === 'AbortError') {
            return { ok: false, reason: 'cancelled' };
          }
          var url = buildWaMeUrl(text);
          if (url && openFn(url)) {
            appToast('No se pudo abrir el panel de compartir: se abrió WhatsApp con el texto (sin portada).');
            return { ok: true, method: 'wa-me', withCover: false };
          }
          appToast('No se pudo compartir por WhatsApp en este dispositivo.');
          return { ok: false, reason: 'share-failed' };
        });
      }
      if (method === 'share-text') {
        return myNav.share({ text: text, title: track.title || 'Canción' })
          .then(function () {
            appToast(hasCover
              ? 'Compartido por WhatsApp (solo texto: este dispositivo no permite adjuntar la portada).'
              : 'Compartido por WhatsApp (solo texto: esta canción no tiene portada).');
            return { ok: true, method: method, withCover: false };
          }).catch(function (err) {
            if (err && err.name === 'AbortError') {
              return { ok: false, reason: 'cancelled' };
            }
            var url = buildWaMeUrl(text);
            if (url && openFn(url)) {
              appToast('No se pudo abrir el panel de compartir: se abrió WhatsApp con el texto.');
              return { ok: true, method: 'wa-me', withCover: false };
            }
            appToast('No se pudo compartir por WhatsApp en este dispositivo.');
            return { ok: false, reason: 'share-failed' };
          });
      }
      var url = buildWaMeUrl(text);
      if (url && openFn(url)) {
        appToast(hasCover
          ? 'Se abrió WhatsApp con el texto (este dispositivo no permite adjuntar la portada desde el navegador).'
          : 'Se abrió WhatsApp con el texto (esta canción no tiene portada).');
        return { ok: true, method: 'wa-me', withCover: false };
      }
      appToast('No se pudo abrir WhatsApp en este dispositivo.');
      return { ok: false, reason: 'wa-me-failed' };
    }).catch(function () {
      appToast('No se pudo compartir por WhatsApp. Inténtalo de nuevo.');
      return { ok: false, reason: 'error' };
    });
  }

  /* ---------- Botón «WhatsApp» junto a «Compartir» ---------- */
  var WA_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'style="width:15px;height:15px" aria-hidden="true">' +
    '<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l2-5.4A8.5 8.5 0 1 1 21 11.5Z"/>' +
    '<path d="M9 9.5c.5 2.5 2.5 4.5 5 5l1.5-1.5 2 1c-.5 1.5-1.5 2-2.5 1.5-3-1-5.5-3.5-6.5-6.5C8 8 8.5 7 10 6.5l1 2Z"/></svg>';

  function ensureWhatsAppButton() {
    if (!doc) return;
    if (doc.getElementById('btnWhatsApp')) return;
    var anchor = doc.getElementById('btnShareCurrent');
    var parent = anchor ? anchor.parentNode : null;
    if (!parent) {
      // Sin el botón «Compartir» no hay dónde anclarlo: no se crea
      // nada y la app sigue igual.
      return;
    }
    var btn = doc.createElement('button');
    btn.className = 'btn small wa-btn';
    btn.id = 'btnWhatsApp';
    btn.type = 'button';
    btn.title = 'Compartir la canción que suena por WhatsApp (solo texto y portada, sin subir el audio)';
    btn.setAttribute('aria-label', 'Compartir la canción que suena por WhatsApp');
    btn.innerHTML = WA_SVG + ' WhatsApp';
    btn.addEventListener('click', function () { shareCurrent(); });
    if (anchor.nextSibling) parent.insertBefore(btn, anchor.nextSibling);
    else parent.appendChild(btn);
  }

  function init() {
    if (!doc) return;
    try {
      ensureWhatsAppButton();
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[whatsapp] desactivado por error en el inicio:', e);
      }
    }
  }

  /* ================= API pública ================= */
  var api = {
    VERSION: VERSION,
    NO_TRACK_TITLE: NO_TRACK_TITLE,
    buildShareText: buildShareText,
    buildWaMeUrl: buildWaMeUrl,
    coverExtensionForType: coverExtensionForType,
    coverFileName: coverFileName,
    coverFileFromBlob: coverFileFromBlob,
    canShareFiles: canShareFiles,
    hasWebShare: hasWebShare,
    decideShareMethod: decideShareMethod,
    isNoTrackTitle: isNoTrackTitle,
    isPlaceholderArtist: isPlaceholderArtist,
    findCurrentTrack: findCurrentTrack,
    readCurrentFromDom: readCurrentFromDom,
    resolveCurrentTrack: resolveCurrentTrack,
    getCoverFile: getCoverFile,
    shareCurrent: shareCurrent,
    ensureWhatsAppButton: ensureWhatsAppButton,
    init: init,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    try { global.__rpmWhatsApp = api; } catch (e) {}
    if (doc) {
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
      else init();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
