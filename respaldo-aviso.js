/* Recordatorio de respaldo para Reproductor de Música — v4.2.0, módulo aparte.
   No toca app/index.html ni ningún otro archivo de la app: se engancha
   solo por DOM y por el hook window.__rpmApp que la app ya expone.
   Si el módulo falla o no carga, la app sigue funcionando como sin él:
   todo el código va dentro de try/catch y nunca lanza errores globales.

   QUÉ YA EXISTE EN LA APP (verificado en app/index.html, no duplicado):
   - Barra #backupReminder con #backupReminderText, #btnBackupNow
     («Exportar copia ahora») y #btnBackupDismiss («Ahora no»),
     líneas ~1387-1391. Su lógica (checkBackupReminder, ~9971-9985)
     muestra el aviso SOLO cuando la biblioteca CRECIÓ mucho desde la
     última copia: >= 25 canciones nuevas, o >= max(5, 20 %) del tamaño
     de la última copia. NO mira el tiempo: una biblioteca que no crece
     puede pasar meses sin copia y no avisa nunca.
   - backupInfo en el almacén meta de IndexedDB (idbMetaGet/Set,
     ~9955-9999): {at, count, snooze}. Solo lo escribe exportBackup()
     (~6484-6560) al exportar el respaldo JSON. «Ahora no» pone
     snooze = nº de canciones, para no insistir hasta crecer otro tanto.
   - Respaldo automático #btnAutoBackup + #autoBackupDays (7/15/30,
     ~12595-12625): con la app abierta y vencido el plazo desde
     backupInfo.at, descarga el JSON solo, una vez por apertura.
   - Sincronizar (.rpmbak): window.__rpmSync (src/sync/sync-bridge.js)
     y syncMeta.lastSyncAt (getSyncMeta, expuesto en __rpmApp). OJO:
     markSynced() se llama al EXPORTAR el paquete (sync-bridge.js:230)
     Y al APLICAR uno importado (:308). Por eso lastSyncAt significa
     «última sincronización», no «última exportación»: tras importar y
     aplicar, este dispositivo coincide con un paquete que existe fuera
     de este navegador, así que también cuenta como copia reciente.
     La app NUNCA usa lastSyncAt para el aviso de respaldo: un usuario
     que sincroniza cada semana pero nunca exporta JSON ve «Sin copia
     todavía» y el aviso solo por crecimiento.

   QUÉ APORTA ESTE MÓDULO (solo lo que falta):
   1. Aviso POR TIEMPO: si pasan los días de #autoBackupDays (7/15/30,
      por defecto 7) desde la última copia EFECTIVA — la más reciente
      entre el respaldo JSON (backupInfo.at) y la sincronización
      .rpmbak (syncMeta.lastSyncAt) — la barra aparece aunque la
      biblioteca no haya crecido. El texto dice cuál de las dos es la
      más reciente y hace cuántos días fue.
   2. «Posponer 7 días»: botón nuevo #rpmRespaldoSnooze dentro de la
      barra, DISTINTO de «Ahora no» (que pospone hasta que la biblioteca
      crezca otro tanto). Se guarda en localStorage.
   3. Interruptor para desactivar el recordatorio del todo:
      #rpmRespaldoToggle bajo la barra. Se guarda en localStorage.
      No toca el respaldo automático (#btnAutoBackup): ese sigue
      descargando el JSON solo si está activado.
   4. Límite de molestia: como mucho UNA VEZ por apertura, y NUNCA DOS
      DÍAS SEGUIDOS (si avisó ayer, hoy no avisa aunque toque). Se
      guarda el día local del último aviso.
   5. La nota #lastBackupNote muestra la última sincronización .rpmbak
      cuando es más reciente que el último respaldo JSON (la app solo
      muestra el JSON, o «Sin copia todavía»).
   6. El crecimiento grande sigue avisando antes de plazo (misma regla
      de la app: >= 25 o >= max(5, 20 %)), pero SOLO cuando la copia
      más reciente es el JSON: el sync no guarda con cuántas canciones
      se hizo, así que el crecimiento no es medible contra él; ahí
      manda la regla de tiempo.

   CÓMO LO HACE SIN TOCAR LA LÓGICA DE LA APP:
   - No sustituye checkBackupReminder (vive dentro del IIFE cerrado y
     no es accesible): reutiliza LA MISMA barra #backupReminder y solo
     la muestra o la esconde según su propia puerta (shouldRemind), y
     actualiza su texto cuando el motivo es el tiempo o el sync.
   - Un MutationObserver vigila la clase .show de la barra: si la app
     la muestra y la puerta del módulo dice que no toca (desactivado,
     pospuesto o ya avisado), la vuelve a esconder.
   - Lee backupInfo y syncMeta con __rpmApp.idbMetaGet / getSyncMeta
     (expuestos en index.html ~12743-12751) y el plazo con el <select
     #autoBackupDays que la app ya sincroniza. Si algo no está
     disponible, usa lo que haya (o 7 días) y nunca rompe nada.
   - Sin copias previas no inventa fechas: con 0 copias solo avisa si
     ya hay >= 25 canciones (igual que la app hoy); con menos, calla.

   Persistencia: localStorage 'reproductor-respaldo-aviso:v1' (JSON):
   {version:1, disabled, snoozedUntil, lastShownDay:'YYYY-MM-DD' local,
   lastShownAt}. JSON corrupto o campos inválidos -> se ignoran (valores
   por defecto). Borrar la clave devuelve el aviso a su estado inicial.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./respaldo-aviso.css">
     <script src="./respaldo-aviso.js"></script>
   Pruebas Node: node --test respaldo-aviso.test.mjs
   Consola: window.__respaldoAviso.getState() / .checkNow() /
     .snooze(7) / .setDisabled(true|false) */
(function (g) {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var VERSION = '4.2.0';
  var STORAGE_KEY = 'reproductor-respaldo-aviso:v1';
  var DAY_MS = 86400000;
  var SNOOZE_DAYS = 7;            // «Posponer 7 días»
  var DEFAULT_INTERVAL_DAYS = 7;  // si #autoBackupDays no se puede leer
  var CHECK_MS = 60000;           // reevaluar cada 60 s (por si vence el
                                  // plazo o llega el sync con la app abierta)

  function isObject(v) { return v !== null && typeof v === 'object'; }

  /* Plazo válido: solo 7 | 15 | 30 (los del <select> de la app). */
  function sanitizeInterval(d) {
    return (d === 7 || d === 15 || d === 30) ? d : DEFAULT_INTERVAL_DAYS;
  }

  function numAt(v) {
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
  }

  /* Última copia EFECTIVA: la más reciente entre el respaldo JSON
     (backupInfo.at) y la sincronización .rpmbak (syncMeta.lastSyncAt).
     A igualdad de fecha gana el respaldo JSON. Sin ninguna, at = 0. */
  function effectiveLastCopy(backupAt, syncAt) {
    var b = numAt(backupAt);
    var s = numAt(syncAt);
    if (b === 0 && s === 0) return { at: 0, source: 'ninguna' };
    if (b >= s) return { at: b, source: 'respaldo' };
    return { at: s, source: 'sync' };
  }

  /* Días (con decimales) desde una fecha. Sin fecha -> Infinity, para
     que el llamador decida (sin copia no es lo mismo que vencido). */
  function daysSince(at, nowMs) {
    if (!numAt(at)) return Infinity;
    return (nowMs - at) / DAY_MS;
  }

  /* Cuánto creció la biblioteca desde la copia: nº de canciones nuevas.
     Misma base que la app (líneas ~9974-9975): el mayor entre el nº de
     canciones de la copia y el nº hasta el que se descartó el aviso
     («Ahora no»); sin copia, base 0. */
  function growthSince(trackCount, copyBase) {
    var n = (typeof trackCount === 'number' && isFinite(trackCount))
      ? Math.max(0, Math.floor(trackCount)) : 0;
    var base = (typeof copyBase === 'number' && isFinite(copyBase))
      ? Math.max(0, Math.floor(copyBase)) : 0;
    return n - base;
  }

  /* Regla de crecimiento de la app, literal: >= 25 nuevas, o (con copia
     previa) >= max(5, 20 % del tamaño de la copia). */
  function growthDue(trackCount, copyBase) {
    var base = (typeof copyBase === 'number' && isFinite(copyBase))
      ? Math.max(0, Math.floor(copyBase)) : 0;
    var grew = growthSince(trackCount, copyBase);
    return grew >= 25 || (base > 0 && grew >= Math.max(5, Math.ceil(base * 0.2)));
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Clave de día local 'YYYY-MM-DD' (hora local, como el usuario). */
  function dayKeyLocal(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* Días enteros entre el día de `key` y el día de nowMs (0 = hoy,
     1 = ayer, 2 = anteayer…). null si la clave no es válida. Un día
     futuro (cambio de reloj) da negativo y se trata como reciente. */
  function dayKeyDiffDays(key, nowMs) {
    if (typeof key !== 'string') return null;
    var m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), da = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    var shownDate = new Date(y, mo - 1, da);
    /* new Date hace rollover (mes 13, día 40): rechazar si no coincide. */
    if (shownDate.getFullYear() !== y || shownDate.getMonth() !== mo - 1 ||
      shownDate.getDate() !== da) return null;
    var shown = shownDate.getTime();
    var now = new Date(nowMs);
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.round((today - shown) / DAY_MS);
  }

  /* ¿Se avisó hoy o ayer? (La regla es no molestar dos días seguidos.) */
  function shownRecently(key, nowMs) {
    var diff = dayKeyDiffDays(key, nowMs);
    return diff !== null && diff <= 1;
  }

  /* Posponer: ahora + días (por defecto 7). */
  function snoozeUntilMs(nowMs, days) {
    var d = (typeof days === 'number' && isFinite(days) && days > 0) ? days : SNOOZE_DAYS;
    return nowMs + d * DAY_MS;
  }

  function defaultPrefs() {
    return { version: 1, disabled: false, snoozedUntil: null,
      lastShownDay: null, lastShownAt: null };
  }

  /* Normaliza unas preferencias leídas de cualquier parte. Siempre
     devuelve un objeto válido (nunca null): lo desconocido se descarta
     y lo que falta toma el valor por defecto. */
  function sanitizePrefs(raw) {
    var out = defaultPrefs();
    if (!isObject(raw)) return out;
    out.disabled = raw.disabled === true;
    if (typeof raw.snoozedUntil === 'number' && isFinite(raw.snoozedUntil) &&
      raw.snoozedUntil > 0) out.snoozedUntil = raw.snoozedUntil;
    if (typeof raw.lastShownDay === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(raw.lastShownDay)) out.lastShownDay = raw.lastShownDay;
    if (typeof raw.lastShownAt === 'number' && isFinite(raw.lastShownAt) &&
      raw.lastShownAt > 0) out.lastShownAt = raw.lastShownAt;
    return out;
  }

  function loadPrefs(store) {
    try {
      var raw = store.getItem(STORAGE_KEY);
      if (!raw) return defaultPrefs();
      return sanitizePrefs(JSON.parse(raw));
    } catch (e) { return defaultPrefs(); }
  }

  function savePrefs(store, prefs) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(sanitizePrefs(prefs)));
      return true;
    } catch (e) { return false; }
  }

  /* ¿Toca avisar? prefs: preferencias saneadas. ctx:
       lastCopyAt (ms, 0 = ninguna), lastCopySource ('respaldo'|'sync'|
         'ninguna'), trackCount, copyBase (nº de canciones de la copia
         o hasta el que se descartó el aviso; solo fiable con JSON),
       intervalDays (7|15|30), shownThisSession (ya avisado en esta
       apertura). Devuelve {show, reason, days?, grew?}.
     Orden: desactivado -> pospuesto -> ya en esta apertura -> avisado
     hoy o ayer -> sin copia -> vencido por tiempo -> creció mucho ->
     al día. */
  function shouldRemind(prefs, ctx, nowMs) {
    var p = sanitizePrefs(prefs);
    var c = isObject(ctx) ? ctx : {};
    var now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
    var interval = sanitizeInterval(c.intervalDays);
    var lastCopyAt = numAt(c.lastCopyAt);
    var source = (c.lastCopySource === 'sync' || c.lastCopySource === 'respaldo')
      ? c.lastCopySource : (lastCopyAt ? 'respaldo' : 'ninguna');
    var trackCount = (typeof c.trackCount === 'number' && isFinite(c.trackCount))
      ? Math.max(0, Math.floor(c.trackCount)) : 0;
    var copyBase = (typeof c.copyBase === 'number' && isFinite(c.copyBase))
      ? Math.max(0, Math.floor(c.copyBase)) : 0;

    if (p.disabled) return { show: false, reason: 'desactivado' };
    if (typeof p.snoozedUntil === 'number' && p.snoozedUntil > now) {
      return { show: false, reason: 'pospuesto', until: p.snoozedUntil };
    }
    if (c.shownThisSession) return { show: false, reason: 'ya-mostrado-esta-apertura' };
    if (p.lastShownDay) {
      var diff = dayKeyDiffDays(p.lastShownDay, now);
      if (diff !== null && diff <= 1) {
        return { show: false, reason: diff === 0 ? 'ya-mostrado-hoy' : 'mostrado-ayer' };
      }
    }
    if (!lastCopyAt) {
      /* Sin copias previas no se inventa fecha: solo avisa si la
         biblioteca ya es grande (>= 25, igual que la app hoy). Si el
         usuario descartó con «Ahora no», copyBase ya cubre el tamaño
         actual y growthDue es falso: no se insiste. */
      if (growthDue(trackCount, copyBase)) {
        return { show: true, reason: 'sin-copia', grew: growthSince(trackCount, copyBase) };
      }
      return { show: false, reason: 'pocas-canciones' };
    }
    var days = daysSince(lastCopyAt, now);
    if (days >= interval) {
      return { show: true, reason: 'vencido', days: Math.floor(days) };
    }
    /* Crecimiento grande antes de plazo, solo si la copia más reciente
       es el JSON: el sync no guarda con cuántas canciones se hizo, así
       que contra él el crecimiento no es medible. */
    if (source === 'respaldo' && growthDue(trackCount, copyBase)) {
      return { show: true, reason: 'crecio-mucho',
        grew: growthSince(trackCount, copyBase), days: Math.floor(days) };
    }
    return { show: false, reason: 'al-dia', days: Math.floor(days) };
  }

  /* Fecha como la app (fmtBackupDate, ~9960-9963): «15 nov 2026, 12:00». */
  function fmtDateEs(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) +
        ', ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      try { return new Date(ts).toISOString().slice(0, 10); } catch (e2) { return ''; }
    }
  }

  /* Texto de la barra para cada motivo de aviso. Sin copia: mismo texto
     que la app. Vencido: dice cuál fue la última copia y hace cuántos
     días; con sync, recuerda que vale un respaldo JSON o un .rpmbak. */
  function reminderText(decision, info) {
    var d = isObject(decision) ? decision : {};
    var inf = isObject(info) ? info : {};
    if (!d.show) return '';
    var n = (typeof inf.trackCount === 'number' && isFinite(inf.trackCount))
      ? Math.floor(inf.trackCount) : 0;
    if (d.reason === 'sin-copia') {
      return 'Ya tienes ' + n + ' canciones y todavía no exportaste ningún respaldo. ' +
        'Una copia guarda tus playlists, likes y ajustes por si le pasa algo a este navegador.';
    }
    if (d.reason === 'vencido') {
      var days = (typeof d.days === 'number') ? d.days : Math.floor(daysSince(inf.lastCopyAt, Date.now()));
      var when = inf.lastCopyAt ? fmtDateEs(inf.lastCopyAt) : '';
      if (inf.lastCopySource === 'sync') {
        return 'Han pasado ' + days + (days === 1 ? ' día' : ' días') +
          ' desde tu última sincronización .rpmbak' + (when ? ' (' + when + ')' : '') +
          '. Exporta un respaldo JSON o un paquete .rpmbak para guardar tus playlists, likes y ajustes.';
      }
      return 'Han pasado ' + days + (days === 1 ? ' día' : ' días') +
        ' desde tu última copia' + (when ? ' (' + when + ')' : '') +
        '. Un respaldo nuevo guarda tus playlists, likes y ajustes.';
    }
    if (d.reason === 'crecio-mucho') {
      var grew = (typeof d.grew === 'number') ? d.grew : 0;
      var when2 = inf.lastCopyAt ? fmtDateEs(inf.lastCopyAt) : '';
      return 'Tu biblioteca creció ' + grew + (grew === 1 ? ' canción' : ' canciones') +
        ' desde la última copia' + (when2 ? ' (' + when2 + ')' : '') +
        '. Un respaldo nuevo guarda tus playlists, likes y ajustes.';
    }
    return '';
  }

  /* ================= Capa navegador (solo con document) ================= */

  var state = { prefs: defaultPrefs(), shownThisSession: false,
    barVisible: false, evaluating: false, lastDecision: null, lastSources: null };
  var els = {};
  var store = null; // localStorage real, si existe

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { /* nunca romper la app */ }
    };
  }

  function toast(msg) {
    try {
      if (g.__rpmApp && typeof g.__rpmApp.toast === 'function') { g.__rpmApp.toast(msg); return; }
    } catch (e) {}
  }

  function persist() {
    try { if (store) savePrefs(store, state.prefs); } catch (e) {}
  }

  function hideBar() {
    try {
      var bar = $('backupReminder');
      if (bar) bar.classList.remove('show');
      state.barVisible = false;
    } catch (e) {}
  }

  /* La barra está visible (la haya mostrado la app o el módulo): cuenta
     como el aviso de hoy y de esta apertura. */
  function markShown(nowMs) {
    try {
      if (state.shownThisSession) return;
      state.shownThisSession = true;
      state.prefs.lastShownDay = dayKeyLocal(nowMs);
      state.prefs.lastShownAt = nowMs;
      persist();
    } catch (e) {}
  }

  /* --- Lectura de lo que ya existe en la app (sin inventar nada) --- */

  /* backupInfo (JSON), syncMeta.lastSyncAt (.rpmbak), nº de canciones y
     plazo de #autoBackupDays. Todo con plan B y timeout: si algo no
     responde, se evalúa con lo que haya (sin fecha = sin copia). */
  function readSources() {
    return new Promise(function (resolve) {
      var out = { backupAt: 0, backupCount: 0, backupSnooze: 0,
        syncAt: 0, trackCount: 0, intervalDays: DEFAULT_INTERVAL_DAYS };
      var settled = false;
      function done() { if (!settled) { settled = true; resolve(out); } }
      try {
        var sel = $('autoBackupDays');
        if (sel) out.intervalDays = sanitizeInterval(parseInt(sel.value, 10));
      } catch (e) {}
      try {
        if (g.__rpmApp && typeof g.__rpmApp.getTracks === 'function') {
          var tr = g.__rpmApp.getTracks() || [];
          out.trackCount = tr.length;
        }
      } catch (e) {}
      var pending = 0;
      function fin() { pending--; if (pending <= 0) done(); }
      /* backupInfo */
      pending++;
      try {
        if (g.__rpmApp && typeof g.__rpmApp.idbMetaGet === 'function') {
          g.__rpmApp.idbMetaGet('backupInfo').then(function (b) {
            try {
              if (b && typeof b === 'object') {
                if (typeof b.at === 'number') out.backupAt = b.at;
                if (typeof b.count === 'number') out.backupCount = b.count;
                if (typeof b.snooze === 'number') out.backupSnooze = b.snooze;
              }
            } catch (e) {}
            fin();
          }, function () { fin(); });
        } else fin();
      } catch (e) { fin(); }
      /* syncMeta.lastSyncAt (vía __rpmApp; plan B: __rpmSync, que es un
         módulo ES y puede cargar después que este script). */
      pending++;
      try {
        if (g.__rpmApp && typeof g.__rpmApp.getSyncMeta === 'function') {
          g.__rpmApp.getSyncMeta().then(function (m) {
            try { if (m && typeof m.lastSyncAt === 'number') out.syncAt = m.lastSyncAt; } catch (e) {}
            fin();
          }, function () { fin(); });
        } else if (g.__rpmSync && typeof g.__rpmSync.getLastSyncInfo === 'function') {
          g.__rpmSync.getLastSyncInfo().then(function (info) {
            try { if (info && typeof info.lastSyncAt === 'number') out.syncAt = info.lastSyncAt; } catch (e) {}
            fin();
          }, function () { fin(); });
        } else fin();
      } catch (e) { fin(); }
      /* Si IndexedDB tarda, no bloquear la evaluación más de 3 s. */
      setTimeout(done, 3000);
    });
  }

  /* La nota #lastBackupNote la escribe la app solo con el JSON. Si el
     sync es más reciente, añadirlo; si no, dejar el texto de la app. */
  function refreshNote(src, eff) {
    try {
      var elx = $('lastBackupNote');
      if (!elx || !src || !eff || eff.source !== 'sync') return;
      var syncTxt = fmtDateEs(eff.at);
      if (src.backupAt > 0) {
        elx.textContent = 'Última copia: ' + fmtDateEs(src.backupAt) +
          ' · Última sincronización .rpmbak: ' + syncTxt;
      } else {
        elx.textContent = 'Sin respaldo JSON todavía · Última sincronización .rpmbak: ' + syncTxt;
      }
    } catch (e) {}
  }

  /* Razones por las que el módulo ESCONDE la barra aunque la app la
     haya mostrado: solo las supresiones propias. Con 'al-dia' o
     'pocas-canciones' no se esconde: si la app la mostró fue por
     crecimiento contra el respaldo viejo, y eso se respeta. */
  function isSuppression(reason) {
    return reason === 'desactivado' || reason === 'pospuesto' ||
      reason === 'ya-mostrado-esta-apertura' || reason === 'ya-mostrado-hoy' ||
      reason === 'mostrado-ayer';
  }

  function evaluate() {
    try {
      if (state.evaluating) return;
      state.evaluating = true;
      readSources().then(safe(function (src) {
        state.evaluating = false;
        state.lastSources = src;
        var eff = effectiveLastCopy(src.backupAt, src.syncAt);
        var ctx = {
          lastCopyAt: eff.at, lastCopySource: eff.source,
          trackCount: src.trackCount,
          copyBase: eff.source === 'respaldo'
            ? Math.max(src.backupCount, src.backupSnooze) : 0,
          intervalDays: src.intervalDays,
          shownThisSession: state.shownThisSession
        };
        var nowMs = Date.now();
        var dec = shouldRemind(state.prefs, ctx, nowMs);
        state.lastDecision = dec;
        refreshNote(src, eff);
        var bar = $('backupReminder');
        if (!bar) { syncControls(); return; }
        if (dec.show) {
          var info = { lastCopyAt: eff.at, lastCopySource: eff.source,
            days: dec.days, grew: dec.grew, trackCount: src.trackCount };
          var txt = reminderText(dec, info);
          if (txt) {
            var tEl = $('backupReminderText');
            if (tEl) tEl.textContent = txt;
          }
          if (!bar.classList.contains('show')) bar.classList.add('show');
          state.barVisible = true;
          markShown(nowMs);
        } else {
          if (isSuppression(dec.reason)) hideBar();
          /* Si la barra quedó visible (la mostró la app por crecimiento
             y el módulo no tiene motivo para esconderla), también cuenta
             como aviso de hoy: así no vuelve mañana por tiempo. */
          if (bar.classList.contains('show')) {
            state.barVisible = true;
            markShown(nowMs);
          }
        }
        syncControls();
      }), safe(function () { state.evaluating = false; }));
    } catch (e) { state.evaluating = false; }
  }

  /* --- Controles nuevos --- */

  function syncControls() {
    try {
      var tog = els.toggle || $('rpmRespaldoToggle');
      if (!tog) return;
      var off = !!state.prefs.disabled;
      tog.classList.toggle('on', !off);
      tog.setAttribute('aria-pressed', off ? 'false' : 'true');
      var lab = els.toggleLabel || $('rpmRespaldoToggleLabel');
      if (lab) {
        lab.textContent = off
          ? 'Recordatorio de respaldo: Apagado'
          : 'Recordatorio de respaldo: Activado';
      }
    } catch (e) {}
  }

  function snooze(days) {
    try {
      var d = (typeof days === 'number' && isFinite(days) && days > 0) ? days : SNOOZE_DAYS;
      state.prefs.snoozedUntil = snoozeUntilMs(Date.now(), d);
      persist();
      hideBar();
      syncControls();
      toast('Vale: te lo recuerdo dentro de ' + d + (d === 1 ? ' día.' : ' días.'));
      return true;
    } catch (e) { return false; }
  }

  function setDisabled(off) {
    try {
      state.prefs.disabled = !!off;
      persist();
      if (off) {
        hideBar();
        toast('Recordatorio de respaldo apagado: no te volveré a avisar. El respaldo automático (si lo tienes activado) sigue igual.');
      } else {
        toast('Recordatorio de respaldo activado.');
        evaluate();
      }
      syncControls();
      return true;
    } catch (e) { return false; }
  }

  function onCopyDone() {
    /* Exportar (JSON o desde la barra) es una copia nueva: se acabó la
       posposición. La app actualiza backupInfo y esconde la barra; el
       módulo reevalúa para refrescar la nota. */
    try {
      state.prefs.snoozedUntil = null;
      persist();
      setTimeout(safe(evaluate), 1200);
    } catch (e) {}
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function buildControls() {
    try {
      var bar = $('backupReminder');
      if (!bar) return false;
      /* Botón «Posponer 7 días» dentro de la barra, junto a «Ahora no»:
         distinto de descartar: esto es por tiempo, no por crecimiento. */
      if (!$('rpmRespaldoSnooze')) {
        var snz = el('button', 'btn small', 'Posponer 7 días');
        snz.id = 'rpmRespaldoSnooze';
        snz.type = 'button';
        snz.addEventListener('click', safe(function () { snooze(SNOOZE_DAYS); }));
        bar.appendChild(snz);
      }
      /* Fila con el interruptor bajo la barra. */
      if (!$('rpmRespaldoControls')) {
        var row = el('div', 'rpm-respaldo-controls');
        row.id = 'rpmRespaldoControls';
        var tog = el('button', 'toggle-pill', null);
        tog.id = 'rpmRespaldoToggle';
        tog.type = 'button';
        tog.setAttribute('aria-pressed', 'true');
        tog.appendChild(el('span', 'dot'));
        var lab = el('span', null, 'Recordatorio de respaldo: Activado');
        lab.id = 'rpmRespaldoToggleLabel';
        tog.appendChild(lab);
        tog.addEventListener('click', safe(function () {
          setDisabled(!state.prefs.disabled);
        }));
        row.appendChild(tog);
        var note = el('span', 'backup-note rpm-respaldo-note',
          'Te avisa cuando pasan los días de «Cada» desde tu última copia — un respaldo JSON o una sincronización .rpmbak — o cuando la biblioteca crece mucho. Como mucho una vez por apertura y nunca dos días seguidos.');
        note.id = 'rpmRespaldoNote';
        row.appendChild(note);
        if (bar.parentNode) bar.parentNode.insertBefore(row, bar.nextSibling);
        else bar.appendChild(row);
      }
      els.toggle = $('rpmRespaldoToggle');
      els.toggleLabel = $('rpmRespaldoToggleLabel');
      return true;
    } catch (e) { return false; }
  }

  /* Los botones que ya existen: exportar limpia la posposición; «Ahora
     no» cuenta como aviso visto hoy (la app ya esconde la barra). */
  function wireExisting() {
    try {
      [['btnBackupNow', onCopyDone], ['btnExportBackup', onCopyDone]].forEach(function (pair) {
        var b = $(pair[0]);
        if (b && !b.__respaldoWired) {
          b.__respaldoWired = true;
          b.addEventListener('click', safe(pair[1]));
        }
      });
      var dis = $('btnBackupDismiss');
      if (dis && !dis.__respaldoWired) {
        dis.__respaldoWired = true;
        dis.addEventListener('click', safe(function () { markShown(Date.now()); }));
      }
    } catch (e) {}
  }

  /* Si la app muestra la barra por su cuenta (crecimiento), aplicar la
     puerta del módulo: desactivado / pospuesto / ya avisado -> esconder. */
  function watchBar() {
    try {
      var bar = $('backupReminder');
      if (!bar || typeof MutationObserver === 'undefined') return;
      var obs = new MutationObserver(safe(function () {
        try {
          var shown = bar.classList.contains('show');
          if (shown && !state.barVisible) {
            state.barVisible = true;
            evaluate();
          } else if (!shown) {
            state.barVisible = false;
          }
        } catch (e) {}
      }));
      obs.observe(bar, { attributes: true, attributeFilter: ['class'] });
    } catch (e) {}
  }

  function init() {
    try {
      try { store = g.localStorage || null; } catch (e) { store = null; }
      if (store) state.prefs = loadPrefs(store);
      if (!buildControls()) {
        /* La barra es HTML estático, pero si este script corrió antes
           que el DOM, reintentar una vez. */
        setTimeout(safe(function () { buildControls(); syncControls(); }), 800);
      }
      wireExisting();
      watchBar();
      syncControls();
      /* La app resuelve su idbMetaGet('backupInfo') de forma asíncrona
         al cargar: evaluar ahora, a los ~900 ms y a los 3 s cubre que
         la barra ya esté mostrada por crecimiento y que el sync-bridge
         (módulo ES, deferred) ya haya dejado su lastSyncAt. */
      evaluate();
      setTimeout(safe(evaluate), 900);
      setTimeout(safe(evaluate), 3000);
      setInterval(safe(evaluate), CHECK_MS);
      document.addEventListener('visibilitychange', safe(function () {
        if (document.visibilityState === 'visible') evaluate();
      }));
    } catch (e) { /* sin recordatorio: la app sigue igual */ }
  }

  /* Solo navegador: sin document no hay nada que montar (Node). */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else init();
    } catch (e) { /* sin UI: la app sigue igual */ }
  }

  /* ================= Exportaciones ================= */
  var api = {
    effectiveLastCopy: effectiveLastCopy,
    daysSince: daysSince,
    growthSince: growthSince,
    growthDue: growthDue,
    dayKeyLocal: dayKeyLocal,
    dayKeyDiffDays: dayKeyDiffDays,
    shownRecently: shownRecently,
    snoozeUntilMs: snoozeUntilMs,
    sanitizeInterval: sanitizeInterval,
    sanitizePrefs: sanitizePrefs,
    defaultPrefs: defaultPrefs,
    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
    shouldRemind: shouldRemind,
    reminderText: reminderText,
    fmtDateEs: fmtDateEs,
    STORAGE_KEY: STORAGE_KEY,
    SNOOZE_DAYS: SNOOZE_DAYS,
    DEFAULT_INTERVAL_DAYS: DEFAULT_INTERVAL_DAYS,
    CHECK_MS: CHECK_MS,
    DAY_MS: DAY_MS,
    VERSION: VERSION
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    try {
      window.__respaldoAviso = {
        version: VERSION,
        getState: function () {
          try {
            return {
              prefs: JSON.parse(JSON.stringify(state.prefs)),
              shownThisSession: state.shownThisSession,
              lastDecision: state.lastDecision,
              lastSources: state.lastSources
            };
          } catch (e) { return null; }
        },
        checkNow: function () { try { evaluate(); return true; } catch (e) { return false; } },
        snooze: snooze,
        setDisabled: setDisabled
      };
    } catch (e) {}
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
