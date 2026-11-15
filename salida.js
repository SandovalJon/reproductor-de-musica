/* Sonido por audífonos o bocina (v3.7.0) — módulo aparte.
   NO duplica nada: la app YA tiene perfiles de sonido por salida
   (Pack 12, app/index.html líneas 11422-11533): Bocina / Bluetooth /
   Cable, cada uno con su EQ de 10 bandas, balance, mono y efectos,
   guardados en settings.outProfiles (persistidos por saveState() de
   la app), con botones reales #btnOutBocina / #btnOutBluetooth /
   #btnOutCable y un cambio automático de mejor esfuerzo por
   devicechange (700 ms, etiquetas bluetooth/usb o "sin salidas
   extra" -> Bocina). Este módulo SOLO añade lo que falta:

   1) DETECCIÓN MEJORADA: un segundo listener de devicechange
      (debounce 900 ms, DESPUÉS del de la app, para no pelearse con
      él) que clasifica con más etiquetas: AirPods / Galaxy Buds /
      inalámbrico / wireless -> Bluetooth; audífonos / auriculares /
      headphones / earphones / cascos / headset / cable / aux / jack /
      3.5 mm / USB -> Cable. Solo actúa cuando la lista de salidas
      cambió de verdad (foto de deviceIds, como el vigilante de
      pausa por desconexión) y cuando el objetivo es distinto del
      perfil activo. Nunca adivina: sin etiquetas visibles (falta
      permiso de micrófono) o con salidas extra sin nombre claro, no
      cambia nada y lo dice.
   2) AVISO DISCRETO: una línea de estado (#rpmSalidaStatus) bajo
      los botones de salida con la salida detectada, el perfil
      activo y si la detección automática está disponible en este
      navegador. Se actualiza también cuando la app cambia sola de
      perfil (MutationObserver sobre aria-pressed de los 3 botones).
   3) CONTROLES: "Detectar salida ahora" (una pasada manual por
      enumerateDevices), "Cambio automático: Activado/Apagado"
      (preferencia propia en localStorage, por defecto activado) y
      "Editar EQ de este perfil" (baja al ecualizador de la app, que
      es donde se edita el perfil activo: lo ajustado queda guardado
      en ese perfil al cambiar, como ya hace la app).

   PUENTE CON LA APP (sin tocar su IIFE cerrado): switchOutProfile(),
   settings y OUT_LABELS NO son accesibles desde fuera, así que el
   módulo cambia de perfil HACIENDO CLIC en el botón real de la app
   (#btnOutBocina / #btnOutBluetooth / #btnOutCable). El clic dispara
   el handler de la app: captura el perfil que se deja, aplica el
   nuevo, guarda y muestra su toast. El perfil activo se lee de los
   mismos botones (aria-pressed, con respaldo en la clase .on).

   FAIL-SAFE (patrón luces.js / cast.js): IIFE, try/catch en el
   arranque y en cada pasada. Si no existen los botones de salida,
   si no hay navigator.mediaDevices o si algo falla, el módulo no
   hace nada: la app y sus perfiles siguen intactos. Si salida.js
   no carga, window.__rpmSalida no existe y la app es la misma.
   Los perfiles en sí NUNCA se guardan aquí: viven en la app. La
   única clave propia en localStorage es 'reproductor-salida-auto'
   ('1'/'0'; por defecto '1'). */
(function (global) {
  'use strict';

  var VERSION = '3.7.0';
  var AUTO_KEY = 'reproductor-salida-auto';
  var OUT_IDS = ['bocina', 'bluetooth', 'cable'];
  var OUT_LABELS = { bocina: 'Bocina', bluetooth: 'Bluetooth', cable: 'Cable' };
  var OUT_BUTTONS = { bocina: 'btnOutBocina', bluetooth: 'btnOutBluetooth', cable: 'btnOutCable' };

  /* ---- Partes puras (probadas en Node, sin DOM) ---- */

  function normLabel(label) {
    var s = (label || '').toString().toLowerCase();
    // Quitar acentos para que "inalámbrico" e "inalambrico" casen igual.
    s = s.replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
         .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n');
    return s;
  }

  /* Clasifica UNA etiqueta de salida. Devuelve 'bluetooth', 'cable' o
     null (sin pista: altavoz, salida genérica o etiqueta vacía).
     Bluetooth manda: unos AirPods por cable USB seguirían siendo
     Bluetooth en la práctica, y la etiqueta "Bluetooth" pesa más.
     "Realtek" a solas NO es pista de cable: "Speakers (Realtek Audio)"
     es la bocina y "Headphones (Realtek Audio)" son audífonos; lo que
     distingue es la palabra Headphones, no el chip. */
  function classifyOutputLabel(label) {
    var lbl = normLabel(label);
    if (!lbl) return null;
    if (/bluetooth|airpods|galaxy buds|inalambr|wireless/.test(lbl)) return 'bluetooth';
    if (/\busb\b|auricular|audifono|headphone|earphone|cascos|headset|wired|cable|\baux\b|jack|3\.5 ?mm/.test(lbl)) return 'cable';
    return null;
  }

  /* Clasifica un dispositivo de enumerateDevices. Solo valen las
     salidas de audio (kind 'audiooutput'); micrófonos y cámaras no. */
  function classifyOutput(device) {
    if (!device || device.kind !== 'audiooutput') return null;
    return classifyOutputLabel(device.label);
  }

  /* Decide el perfil para una lista de salidas (lo que devuelve
     enumerateDevices, ya filtrada o sin filtrar: aquí se filtra).
     Devuelve { target, reason, matchedLabel }:
     - target 'bluetooth' | 'cable' | 'bocina' | null (no se sabe).
     - reason: 'bluetooth-label' | 'cable-label' | 'only-default' |
       'unclear' (hay salidas extra pero sin nombre claro) |
       'no-labels' (etiquetas vacías: falta permiso) | 'no-outputs'.
     Reglas, en orden: Bluetooth si alguna salida lo es; si no,
     Cable si alguna lo es; si no, Bocina solo cuando NO queda
     ninguna salida extra (solo 'default'); en cualquier otro caso
     null: no se adivina. */
  function decideTarget(devices) {
    var outs = [];
    if (Array.isArray(devices)) {
      for (var i = 0; i < devices.length; i++) {
        if (devices[i] && devices[i].kind === 'audiooutput') outs.push(devices[i]);
      }
    }
    if (!outs.length) return { target: null, reason: 'no-outputs', matchedLabel: null };
    var anyLabel = false;
    var firstBt = null, firstCable = null;
    for (var j = 0; j < outs.length; j++) {
      var lbl = (outs[j].label || '').toString();
      if (lbl.trim()) anyLabel = true;
      var c = classifyOutput(outs[j]);
      // Bluetooth manda sobre Cable aunque aparezca antes en la
      // lista: se recorre todo antes de decidir.
      if (c === 'bluetooth' && !firstBt) firstBt = lbl;
      if (c === 'cable' && !firstCable) firstCable = lbl;
    }
    if (firstBt !== null) return { target: 'bluetooth', reason: 'bluetooth-label', matchedLabel: firstBt };
    if (firstCable !== null) return { target: 'cable', reason: 'cable-label', matchedLabel: firstCable };
    var extras = outs.filter(function (d) { return d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'; });
    if (!extras.length) return { target: 'bocina', reason: 'only-default', matchedLabel: null };
    if (!anyLabel) return { target: null, reason: 'no-labels', matchedLabel: null };
    return { target: null, reason: 'unclear', matchedLabel: null };
  }

  /* ¿Hay que cambiar? Solo con objetivo claro, auto activado y
     distinto del perfil activo. */
  function shouldSwitch(target, activeId, autoOn) {
    if (!autoOn) return false;
    if (!target || OUT_IDS.indexOf(target) < 0) return false;
    return target !== activeId;
  }

  /* ¿Cambió la foto de salidas? Compara deviceIds (ignora 'default':
     es un alias, no una salida real). Sin foto anterior no se sabe. */
  function snapshotChanged(prevIds, nextIds) {
    if (!Array.isArray(prevIds) || !Array.isArray(nextIds)) return true;
    var norm = function (ids) {
      return ids.filter(function (id) { return id && id !== 'default'; }).slice().sort();
    };
    var a = norm(prevIds), b = norm(nextIds);
    if (a.length !== b.length) return true;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  }

  function outputIds(devices) {
    var ids = [];
    if (Array.isArray(devices)) {
      for (var i = 0; i < devices.length; i++) {
        var d = devices[i];
        if (d && d.kind === 'audiooutput' && d.deviceId) ids.push(d.deviceId);
      }
    }
    return ids;
  }

  /* Capacidad de detección en este navegador, a partir de un objeto
     tipo navigator.mediaDevices (o null). 'auto': enumerateDevices +
     listener de devicechange; 'manual': solo enumerateDevices (hay
     que pulsar "Detectar salida ahora"); 'none': nada de nada. */
  function detectCapability(md) {
    if (!md) return 'none';
    var canEnum = typeof md.enumerateDevices === 'function';
    var canListen = typeof md.addEventListener === 'function';
    if (canEnum && canListen) return 'auto';
    if (canEnum) return 'manual';
    return 'none';
  }

  /* Preferencia propia del cambio automático: '0' apagado, cualquier
     otra cosa (incluido null = sin guardar) encendido. */
  function parseSalidaAutoPref(raw) {
    return raw !== '0';
  }

  /* Texto discreto de la línea de estado. Nunca inventa: si no hay
     objetivo claro, dice que manda el selector manual. */
  function statusText(info) {
    info = info || {};
    var active = OUT_LABELS[info.activeId] || 'Bocina';
    if (info.capability === 'none') {
      return 'Detección de salida no disponible en este navegador: elige el perfil a mano. Perfil activo: ' + active + '.';
    }
    if (!info.autoOn) {
      return 'Cambio automático apagado. Perfil activo: ' + active + ' (cámbialo arriba a mano).';
    }
    if (info.target) {
      var det = OUT_LABELS[info.target];
      if (info.matchedLabel) det += ' (' + info.matchedLabel.slice(0, 40) + ')';
      if (info.target === info.activeId) {
        return 'Salida detectada: ' + det + ' · Perfil activo: ' + active + '.';
      }
      return 'Salida detectada: ' + det + ' · Cambiando al perfil ' + OUT_LABELS[info.target] + '…';
    }
    if (info.reason === 'no-labels') {
      return 'Las etiquetas de salida están vacías (falta permiso de micrófono): la detección no distingue. Perfil activo: ' + active + ' — elige a mano.';
    }
    if (info.capability === 'manual') {
      return 'Este navegador no avisa al conectar audífonos: pulsa «Detectar salida ahora». Perfil activo: ' + active + '.';
    }
    return 'No se distingue la salida conectada: manda el selector manual. Perfil activo: ' + active + '.';
  }

  /* ---- Parte DOM (solo navegador; fail-safe) ---- */

  var autoOn = true;
  var capability = 'none';
  var lastIds = null;      // foto de deviceIds de la última pasada
  var lastDecision = null; // último decideTarget()
  var statusEl = null, btnAutoEl = null, btnDetectEl = null, btnEditEl = null;
  var debounceTimer = null;

  function readAutoPref() {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(AUTO_KEY) : null;
      return parseSalidaAutoPref(raw);
    } catch (e) { return true; }
  }

  function saveAutoPref(on) {
    try { if (global.localStorage) global.localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (e) {}
  }

  function outButton(id) {
    try { return document.getElementById(OUT_BUTTONS[id]); } catch (e) { return null; }
  }

  /* Perfil activo según los botones reales de la app. */
  function getActiveId() {
    for (var i = 0; i < OUT_IDS.length; i++) {
      var b = outButton(OUT_IDS[i]);
      if (!b) continue;
      if (b.getAttribute('aria-pressed') === 'true') return OUT_IDS[i];
      if (b.classList && b.classList.contains('on')) return OUT_IDS[i];
    }
    return null;
  }

  /* Cambiar de perfil = clic en el botón real de la app. Su handler
     hace todo: captura el perfil que se deja, aplica el nuevo, guarda
     y muestra el toast. Si el botón no existe, no se hace nada. */
  function switchTo(id) {
    var b = outButton(id);
    if (!b) return false;
    try { b.click(); return true; } catch (e) { return false; }
  }

  function renderStatus() {
    if (!statusEl) return;
    var info = {
      capability: capability,
      autoOn: autoOn,
      activeId: getActiveId() || 'bocina',
      target: lastDecision ? lastDecision.target : null,
      reason: lastDecision ? lastDecision.reason : null,
      matchedLabel: lastDecision ? lastDecision.matchedLabel : null
    };
    try { statusEl.textContent = statusText(info); } catch (e) {}
  }

  function renderAutoButton() {
    if (!btnAutoEl) return;
    try {
      btnAutoEl.textContent = 'Cambio automático: ' + (autoOn ? 'Activado' : 'Apagado');
      btnAutoEl.setAttribute('aria-pressed', autoOn ? 'true' : 'false');
      btnAutoEl.classList.toggle('on', !!autoOn);
      btnAutoEl.title = autoOn
        ? 'Al conectar o desconectar audífonos, la app cambia sola al perfil de esa salida'
        : 'La app no cambiará sola de perfil: elige arriba a mano';
    } catch (e) {}
  }

  function enumerateOutputs() {
    var md = (typeof navigator !== 'undefined') ? navigator.mediaDevices : null;
    if (!md || typeof md.enumerateDevices !== 'function') return Promise.resolve(null);
    try {
      return md.enumerateDevices().then(function (devs) { return devs || []; })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  /* Una pasada de detección. manual=true: la pidió el usuario con el
     botón (entonces sí se informa aunque no haya cambio). Devuelve
     una promesa que se resuelve en el target decidido o null. */
  function refresh(manual) {
    return enumerateOutputs().then(function (devs) {
      if (!devs) { renderStatus(); return null; }
      var ids = outputIds(devs);
      var decision = decideTarget(devs);
      var changed = snapshotChanged(lastIds, ids);
      lastIds = ids;
      lastDecision = decision;
      var active = getActiveId();
      if (decision.target && shouldSwitch(decision.target, active, autoOn)) {
        if (switchTo(decision.target)) {
          // El toast de la app ya avisa del cambio; la línea de
          // estado se actualiza al observar el cambio de botones.
          lastDecision = { target: decision.target, reason: decision.reason, matchedLabel: decision.matchedLabel };
        }
      } else if (manual || changed) {
        renderStatus();
      }
      return decision.target;
    }).catch(function () { renderStatus(); return null; });
  }

  function scheduleRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer);
    // 900 ms: DESPUÉS del listener propio de la app (700 ms), así
    // la app actúa primero y este módulo solo remata lo que aquella
    // no distinguió (p. ej. "Headphones (Realtek Audio)").
    debounceTimer = setTimeout(function () { debounceTimer = null; refresh(false); }, 900);
  }

  function observeAppSwitches() {
    try {
      var btns = [];
      OUT_IDS.forEach(function (id) { var b = outButton(id); if (b) btns.push(b); });
      if (!btns.length || typeof MutationObserver === 'undefined') return;
      var obs = new MutationObserver(function () { renderStatus(); });
      btns.forEach(function (b) {
        obs.observe(b, { attributes: true, attributeFilter: ['aria-pressed', 'class'] });
      });
    } catch (e) {}
  }

  function buildUI(group) {
    try {
      var btnsRow = group.querySelector('.out-btns');
      if (!btnsRow) return false;
      // Línea de estado discreta, justo debajo de los botones.
      statusEl = document.createElement('p');
      statusEl.id = 'rpmSalidaStatus';
      statusEl.className = 'rpm-salida-status';
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
      btnsRow.parentNode.insertBefore(statusEl, btnsRow.nextSibling);
      // Fila de controles del módulo.
      var row = document.createElement('div');
      row.className = 'rpm-salida-row';
      btnAutoEl = document.createElement('button');
      btnAutoEl.id = 'btnSalidaAuto';
      btnAutoEl.type = 'button';
      btnAutoEl.className = 'toggle-pill rpm-salida-btn';
      btnAutoEl.addEventListener('click', function () {
        autoOn = !autoOn;
        saveAutoPref(autoOn);
        renderAutoButton();
        if (autoOn) refresh(true); else renderStatus();
      });
      btnDetectEl = document.createElement('button');
      btnDetectEl.id = 'btnSalidaDetectar';
      btnDetectEl.type = 'button';
      btnDetectEl.className = 'toggle-pill rpm-salida-btn';
      btnDetectEl.textContent = 'Detectar salida ahora';
      btnDetectEl.title = 'Lee las salidas de audio del navegador y aplica el perfil que toca';
      btnDetectEl.addEventListener('click', function () { refresh(true); });
      btnEditEl = document.createElement('button');
      btnEditEl.id = 'btnSalidaEditar';
      btnEditEl.type = 'button';
      btnEditEl.className = 'toggle-pill rpm-salida-btn';
      btnEditEl.textContent = 'Editar EQ de este perfil';
      btnEditEl.title = 'Baja al ecualizador: lo que ajustes queda guardado en el perfil activo';
      btnEditEl.addEventListener('click', function () {
        try {
          var eq = document.getElementById('eqPreset');
          if (eq) { eq.scrollIntoView({ block: 'center', behavior: 'smooth' }); eq.focus({ preventScroll: true }); }
        } catch (e) {}
      });
      row.appendChild(btnAutoEl);
      row.appendChild(btnDetectEl);
      row.appendChild(btnEditEl);
      statusEl.parentNode.insertBefore(row, statusEl.nextSibling);
      return true;
    } catch (e) { return false; }
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href$="salida.css"]')) return;
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './salida.css';
      document.head.appendChild(link);
    } catch (e) {}
  }

  function init() {
    try {
      // Sin los botones reales de la app no hay nada que enganchar:
      // salir en silencio, la app sigue igual.
      var bocinaBtn = outButton('bocina');
      if (!bocinaBtn) return;
      var group = bocinaBtn.closest ? bocinaBtn.closest('.sound-group') : bocinaBtn.parentNode;
      if (!group) return;
      ensureCss();
      autoOn = readAutoPref();
      var md = (typeof navigator !== 'undefined') ? navigator.mediaDevices : null;
      capability = detectCapability(md);
      if (!buildUI(group)) return;
      renderAutoButton();
      observeAppSwitches();
      // Primera foto silenciosa (sin cambiar nada todavía: si el
      // perfil activo ya es el que toca, no hay que tocar nada).
      refresh(false);
      if (capability === 'auto' && md && md.addEventListener) {
        md.addEventListener('devicechange', function () { scheduleRefresh(); });
      } else if (capability === 'manual') {
        renderStatus();
      } else {
        renderStatus();
      }
      if (btnDetectEl) btnDetectEl.disabled = (capability === 'none');
    } catch (e) { /* El módulo nunca rompe la app. */ }
  }

  var api = {
    classifyOutputLabel: classifyOutputLabel,
    classifyOutput: classifyOutput,
    decideTarget: decideTarget,
    shouldSwitch: shouldSwitch,
    snapshotChanged: snapshotChanged,
    outputIds: outputIds,
    detectCapability: detectCapability,
    parseSalidaAutoPref: parseSalidaAutoPref,
    statusText: statusText,
    OUT_IDS: OUT_IDS,
    OUT_LABELS: OUT_LABELS,
    AUTO_KEY: AUTO_KEY,
    VERSION: VERSION
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__rpmSalidaHelpers = api; } catch (e) {}
  try {
    global.__rpmSalida = {
      version: VERSION,
      getActive: function () { try { return getActiveId(); } catch (e) { return null; } },
      detectNow: function () { return refresh(true); },
      isAuto: function () { return autoOn; },
      setAuto: function (on) {
        autoOn = !!on;
        saveAutoPref(autoOn);
        renderAutoButton();
        renderStatus();
        return autoOn;
      },
      classifyOutput: classifyOutput,
      decideTarget: decideTarget
    };
  } catch (e) {}

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
