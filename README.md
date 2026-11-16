# Reproductor de Música

Reproductor web de música 100% local en el navegador, sin subir canciones a internet.

Abre `index.html` y agrega tus canciones con el botón, eligiendo una carpeta o arrastrando los archivos. Acepta MP3, WAV, FLAC, OGG, M4A, AAC y Opus.

Tu biblioteca se guarda en IndexedDB de tu dispositivo.

Versión actual de la app: 4.3.4 (se muestra también en el pie del reproductor).
v4.3.4: el botón «Carpeta» vuelve a abrir el selector de carpeta también en Android, como antes de la 4.3.3 (al usuario sí le funcionaba elegir carpetas); si el selector no devuelve archivos, avisa y sugiere «Añadir canciones».
v4.3.3: arreglo de la subida en Android con el botón «Carpeta»: en Android no se puede elegir una carpeta completa, así que el botón abre directamente el selector de canciones y avisa; si el selector no devuelve archivos, ya no se queda en silencio.
v4.3.2: arreglo de la subida en Android para archivos sin extensión ni tipo (WhatsApp/Drive): se detecta el audio por sus bytes iniciales (MP3, FLAC, WAV, OGG, M4A, AAC) y se avisa al momento lo que llega del selector.
v4.3.1: arreglo de la subida en Android (si una canción falla al cargar ya no se rompe el lote en silencio: las demás se añaden igual y se avisa cuáles fallaron; un archivo con metadatos raros se añade con su nombre como título).
v4.3.0: buscar por tarareo mejorado (compara también el ritmo contra la rejilla de pulsos del BPM analizado; aproximado, la melodía no se compara nota a nota).
v4.3.0: acordes en karaoke (tus acordes encima de cada línea, junto a la letra y su traducción; sin acordes guardados, el karaoke se ve como siempre).
v4.3.0: modo lectura de letras (la letra completa como un libro, con letra grande y sin distracciones; se sale con ✕ o Esc).
v4.3.0: Wrapped como video (tu año en música en WebM vertical de ~12 s, con tus tops animados, generado en local; sin datos no genera nada).
v4.2.0: portada animada con la música (la portada late con el ritmo usando el analizador que ya existe; se puede apagar y respeta el movimiento reducido).
v4.2.0: modo coche simplificado (voz manos libres al entrar, anuncio por voz de la canción que suena y botones extragrandes; al salir, todo vuelve a lo normal).
v4.2.0: compartir canción con letra (imagen PNG local con portada, letra y tu nota, o texto plano, por Web Share; nunca comparte el audio).
v4.2.0: recordatorio de respaldo (avisa cuando pasan los días de "Cada" desde la última copia JSON o .rpmbak, con posponer 7 días y opción de desactivarlo; una vez por apertura, nunca dos días seguidos).
v4.1.0: letras traducidas en karaoke (la traducción línea por línea junto a la original, usando las traducciones que ya guardas; sin traducción, el karaoke se ve como siempre).
v4.1.0: estadísticas por artista dentro de "Tu año en música" (artistas más escuchados, con horas, canciones y racha; solo con los datos de escucha que la app ya guarda).
v4.1.0: modo fiesta con votos en la escucha conjunta (los participantes proponen y votan la siguiente canción por el mismo canal WebRTC; gana la más votada).
v4.1.0: historial de versiones con "Qué hay de nuevo" al actualizar (los cambios salen del changelog del README, sin inventar ninguno).
v4.0.0: rediseño total de la interfaz (nueva paleta, tipografía y espaciado; cabecera, reproductor, tarjetas de canciones y secciones con aspecto moderno), activable y desactivable en Ajustes · Apariencia (por defecto activado; el aspecto clásico sigue disponible).
v4.0.0: sincronización automática en la nube (opcional, desactivada por defecto; usa tu Google Drive con tu propio Client ID, cada 15/30/60 min, con el mismo .rpmbak y las mismas reglas de fusión; nunca aplica un borrado sin avisar).
v4.0.0: modo DJ en vivo (cola en vivo con peticiones y reorden, sobre la mezcla automática DJ y el crossfade que ya existen).
v4.0.0: el monolito empieza a partirse en módulos: el motor de búsqueda tolerante y las utilidades puras de formato y texto (duraciones, tamaños, fechas, géneros ID3, comparación de versiones) viven ahora en `src/core/search.js` y `src/core/format.js`, con la app funcionando igual que antes.
v2.9.0: letras sincronizadas (LRC) y mejoras del estado vacío, filtros y móvil.
v2.9.1: corrección del botón de secciones en móvil.
v3.0.0: sincronización entre dispositivos por paquete .rpmbak (sin cuenta ni servidor), con migración de la base de datos a v3.
v3.1.0: letras incrustadas USLT/SYLT del MP3, fuentes autoalojadas (100% offline), envío a Chromecast (RemotePlayback) y carpetas persistentes con File System Access API.
v3.2.0: temas nuevos (Neón, Atardecer, Bosque) con transiciones y animaciones, visualizador con modos Combo y Anillos + fondo con el color de la portada, y atajos nuevos (J/K, 1-9, F) con doble toque central en la portada para play/pausa.
v3.3.0: accesibilidad (skip-link, foco visible, aria, objetivos táctiles de 44 px, movimiento reducido), modo karaoke a pantalla completa con la letra sincronizada, estadísticas tipo Wrapped (tops del año, minutos, racha, copiar resumen) y extracción del ecualizador y las listas inteligentes a módulos aparte.
v3.4.0: despertador con fade-in y posponer 10 min (solo con la app abierta), compartir playlist por enlace con QR y marcado tiene/falta, traducciones de letras línea por línea (también en karaoke, viajan en el .rpmbak) y mini reproductor flotante arrastrable.
v3.5.0: modo enfoque con Pomodoro (25/5 min, descanso largo, aviso sonoro), control por voz en español, Wrapped como imagen PNG y importar playlist desde Spotify (por texto, emparejada con la biblioteca local).
v3.6.0: mezcla automática estilo DJ (enciende juntos crossfade y modo DJ, con BPM de actual y siguiente), acordes de guitarra línea por línea sobre la letra (viajan en el .rpmbak), luces al ritmo en modo fiesta y línea de tiempo de escucha con calendario y racha.
v3.9.0: escucha conjunta sincronizada por WebRTC (código manual, sin servidor), playlist por estado de ánimo, respaldo opcional en Google Drive (con tu propio Client ID) y sonidos para dormir generados en local.
v3.8.0: controles en pantalla bloqueada (MediaSession: huecos tapados, posición en pausa, chapter info, limpieza al vaciar), buscar por fragmento de letra, exportar biblioteca y cola como .m3u, y notas personales por canción que viajan en el .rpmbak.
v3.7.0: buscar por tarareo (micrófono, contorno de notas comparado por BPM y tonalidad, aproximado), modo pantalla limpia (solo portada, título y controles), compartir la canción que suena por WhatsApp (texto y portada si el dispositivo lo permite) y sonido por salida mejorado (detección de audífonos/bocina sobre los perfiles que ya tenía la app).

## Letras sincronizadas

Con el botón ♪ Letras puedes ver la letra de la canción sincronizada con la música. Carga un archivo .lrc o pega la letra, y toca una línea para saltar a ese momento. La letra se guarda por canción en el dispositivo.
