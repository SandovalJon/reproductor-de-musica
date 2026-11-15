# Reproductor de Música

Reproductor web de música 100% local en el navegador, sin subir canciones a internet.

Abre `index.html` y agrega tus canciones con el botón, eligiendo una carpeta o arrastrando los archivos. Acepta MP3, WAV, FLAC, OGG, M4A, AAC y Opus.

Tu biblioteca se guarda en IndexedDB de tu dispositivo.

Versión actual de la app: 3.4.0 (se muestra también en el pie del reproductor).
v2.9.0: letras sincronizadas (LRC) y mejoras del estado vacío, filtros y móvil.
v2.9.1: corrección del botón de secciones en móvil.
v3.0.0: sincronización entre dispositivos por paquete .rpmbak (sin cuenta ni servidor), con migración de la base de datos a v3.
v3.1.0: letras incrustadas USLT/SYLT del MP3, fuentes autoalojadas (100% offline), envío a Chromecast (RemotePlayback) y carpetas persistentes con File System Access API.
v3.2.0: temas nuevos (Neón, Atardecer, Bosque) con transiciones y animaciones, visualizador con modos Combo y Anillos + fondo con el color de la portada, y atajos nuevos (J/K, 1-9, F) con doble toque central en la portada para play/pausa.
v3.3.0: accesibilidad (skip-link, foco visible, aria, objetivos táctiles de 44 px, movimiento reducido), modo karaoke a pantalla completa con la letra sincronizada, estadísticas tipo Wrapped (tops del año, minutos, racha, copiar resumen) y extracción del ecualizador y las listas inteligentes a módulos aparte.
v3.4.0: despertador con fade-in y posponer 10 min (solo con la app abierta), compartir playlist por enlace con QR y marcado tiene/falta, traducciones de letras línea por línea (también en karaoke, viajan en el .rpmbak) y mini reproductor flotante arrastrable.

## Letras sincronizadas

Con el botón ♪ Letras puedes ver la letra de la canción sincronizada con la música. Carga un archivo .lrc o pega la letra, y toca una línea para saltar a ese momento. La letra se guarda por canción en el dispositivo.
