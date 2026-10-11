/**
 * Lazy Video Loader - Nomad Labs
 *
 * Viewport-aware video loading for the home grid.
 * Based on bswt_web reference implementation.
 *
 * - Max 3 concurrent video loads (queue system)
 * - Low-power/battery saver detection
 * - Page Visibility API (pause on hidden tab)
 * - Conservative rootMargin (200px)
 * - Poster from vumbnail.com for Vimeo videos
 * - Full cleanup on page navigation (Swup)
 *
 * CAMBIOS:
 *  - TTL del cache localStorage dinámico: parseamos `exp` del token firmado
 *    de la URL de Vimeo y cacheamos hasta 2 min antes de esa expiración.
 *    Antes estaba fijo a 2h, pero las URLs viven ~1h → servíamos URLs muertas
 *    en la segunda mitad del TTL. Fallback a 45 min si no hay exp parseable.
 *  - cleanupAllVideos usa el selector correcto `video[data-vimeo-resolve]`
 *    (antes usaba `video[data-src]` que no matchea ningún elemento del grid).
 *
 * @package NomadLabs
 */

(function () {
    'use strict';

    var observer = null;
    var unloadTimers = new WeakMap();
    var isLowPower = false;
    var lowPowerChecked = false;  // true cuando detectLowPower ha completado
    var pendingInit = false;       // initLazyVideos pidió init mientras lowPower aún no estaba listo
    var isMobile = window.innerWidth < 810;

    // Concurrencia conservadora: 2 simultáneas en desktop, 1 en móvil.
    // Menos descargas en paralelo = más ancho de banda por vídeo = cada tile
    // aparece antes. Con 3 en paralelo a 10Mb/s, cada vídeo recibía ~3Mb/s;
    // con 2 recibe 5Mb/s. El throughput total es el mismo pero la latencia
    // percibida baja mucho.
    var MAX_CONCURRENT = isMobile ? 1 : 2;
    var loadingVideos = [];
    var loadQueue = [];

    var UNLOAD_DELAY = isMobile ? 2000 : 3000;

    // ── Debug hook: emite eventos custom que consume video-debug.js.
    //    Sin listeners conectados tiene coste despreciable.
    function dbg(type, video, extra) {
        var detail = {
            context: 'grid',
            vimeoId: video ? video.getAttribute('data-vimeo-resolve') : '',
            videoEl: video || null,
            queueLen: loadQueue.length,
            loadingLen: loadingVideos.length,
            maxConcurrent: MAX_CONCURRENT,
            lowPower: isLowPower,
            ts: performance.now(),
        };
        if (extra) for (var k in extra) detail[k] = extra[k];
        try {
            document.dispatchEvent(new CustomEvent('nomad-debug:' + type, { detail: detail }));
        } catch (e) {}
    }

    // ── Quality siempre SD en el grid ──
    // Los previews del grid NO necesitan HD: se renderizan pequeños y compiten
    // con el vídeo del single por bandwidth. HD llegaba a 10-15MB por tile con
    // descargas de 10s+. SD baja eso a 1-3MB y ~1s.
    // El single-project sí usa HD vía project-player.js con su propio pickQuality.
    function pickQuality() {
        return 'sd';
    }

    // ── Connection detection ──
    function detectConnection() {
        var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!conn) return;

        function update() {
            var type = conn.effectiveType;
            var downlink = conn.downlink;
            var slow = (type === '2g' || type === 'slow-2g' || type === '3g' || downlink < 2);

            if (slow) {
                MAX_CONCURRENT = 1;
                UNLOAD_DELAY = 1000;
            } else if (isMobile) {
                MAX_CONCURRENT = 1;
                UNLOAD_DELAY = 2000;
            } else {
                MAX_CONCURRENT = 2;
                UNLOAD_DELAY = 3000;
            }
        }

        update();
        conn.addEventListener('change', update);
    }

    // ── Low-power detection ──
    // Test autoplay con un MP4 silencioso minúsculo. Si autoplay falla con
    // NotAllowedError → low-power mode → no cargamos vídeos en grid (poster only).
    // Re-ejecuta initLazyVideos si quedó pendiente (race fix).
    function detectLowPower() {
        var testVideo = document.createElement('video');
        testVideo.setAttribute('playsinline', '');
        testVideo.setAttribute('muted', '');
        testVideo.muted = true;
        testVideo.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAA' +
            'ABtZGF0AAACoAYF//+c3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNj' +
            'QvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3' +
            'gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMAAAAWYEAJ//HIAAAABUGBgJ+IAAADAAMAAAMAAAMA8' +
            'AAAABpBmiJsQ//+qQAAAAwAAAwAAOGAo4AAAAARBnkF4Q/8AAAA3QZpCeEP/AAAAE0GaY3hD/wAAAANBmoR4Q/' +
            '8AAAADQZqleEP/AAAADUGaxnhD/wAAABNBmud4Q/8AAAANQZsIeEP/AAAAR21vb3YAAABsbXZoZAAAAAAAAAAAAA' +
            'AAAAAABAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
            'AAAAAAAAAgAAABt0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAA' +
            'AAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAZ21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAKAAAAA' +
            'AAVQAAAAAAAAAALAAAAG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cm' +
            'wgAAAAAQAAAC1zdGJsAAAAJXN0c2QAAAAAAAAAAQAAABVtcDR2AAAAAAAAAAEAAAAAAAAAACBzdHRzAAAAAAAAAAEA' +
            'AAABAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAABAAAAFn' +
            'N0Y28AAAAAAAAAAQAAACA=';

        var done = function () {
            lowPowerChecked = true;
            try { testVideo.remove(); } catch (e) {}
            // Si initLazyVideos quedó esperando, dispárala ahora
            if (pendingInit) { pendingInit = false; initLazyVideos(); }
        };

        var promise = testVideo.play();
        if (promise) {
            promise.then(function () {
                try { testVideo.pause(); } catch (e) {}
                done();
            }).catch(function (err) {
                if (err && err.name === 'NotAllowedError') isLowPower = true;
                done();
            });
        } else {
            // Browser viejo sin promise → asume low-power=false
            done();
        }
    }

    // ── Vimeo resolve cache (localStorage, TTL dinámico) ──
    var FALLBACK_TTL = 45 * 60 * 1000;       // 45 min si no podemos parsear exp
    var MIN_REMAINING_MS = 2 * 60 * 1000;    // margen de seguridad antes de caducar
    var resolveInflight = {};                 // dedup in-flight requests

    // URLs legacy de Vimeo que dan ERR_CONNECTION_CLOSED en embed externo.
    // Si detectamos alguna cacheada, la descartamos para que se pida fresca.
    function isBadVimeoHost(url) {
        return !!url && url.indexOf('download-video-ak.vimeocdn.com') !== -1;
    }

    // Parsea el timestamp UNIX de expiración del token firmado de Vimeo.
    // Formatos soportados:
    //   - "...?__token__=st=...~exp=1234567890~acl=...~hmac=..."   (legacy)
    //   - "...&expires=1234567890..."                               (/config)
    // Devuelve ms desde epoch, o null.
    function parseVimeoExp(url) {
        if (!url || typeof url !== 'string') return null;
        var m = url.match(/[~&?](?:exp|expires)=(\d+)/);
        return m ? parseInt(m[1], 10) * 1000 : null;
    }

    function getCachedVimeo(vimeoId, quality) {
        try {
            var key = 'nomad_vimeo_' + vimeoId + '_' + (quality || 'sd');
            var raw = localStorage.getItem(key);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            // TTL dinámico: entry.validUntil es timestamp ms hasta el que la URL
            // es válida (exp - 2min, o ts + 45min fallback).
            if (!entry.validUntil || Date.now() > entry.validUntil) {
                localStorage.removeItem(key);
                return null;
            }
            // Self-heal: si la URL cacheada apunta al CDN legacy, invalidarla.
            if (isBadVimeoHost(entry.video)) {
                localStorage.removeItem(key);
                return null;
            }
            return entry;
        } catch (e) { return null; }
    }

    function setCachedVimeo(vimeoId, quality, data) {
        try {
            // No guardar URLs que sabemos que van a fallar en embed.
            if (isBadVimeoHost(data.video)) return;

            // TTL dinámico a partir del token firmado.
            var exp = parseVimeoExp(data.video);
            var validUntil;
            if (exp) {
                // Si ya está casi muerta (<3 min), no cacheamos — forzamos refetch
                // en próxima visita (mejor que servir URL agonizante).
                if (exp - Date.now() < 3 * 60 * 1000) return;
                validUntil = exp - MIN_REMAINING_MS;
            } else {
                validUntil = Date.now() + FALLBACK_TTL;
            }

            var key = 'nomad_vimeo_' + vimeoId + '_' + (quality || 'sd');
            localStorage.setItem(key, JSON.stringify({
                validUntil: validUntil,
                video: data.video,
                thumbnail: data.thumbnail
            }));
        } catch (e) {}
    }

    /**
     * Resolve Vimeo ID to MP4 URL via AJAX (con localStorage cache + dedup + timeout).
     *
     * Robustez:
     *  - fetch + AbortController con timeout 8s (no slot bloqueado para siempre).
     *  - Dedup de in-flight requests para el mismo vimeoId+quality.
     *  - Self-healing: descarta URLs legacy del cache (ver getCachedVimeo).
     */
    function resolveVimeo(vimeoId, quality, callback) {
        if (typeof nomadAjax === 'undefined') { callback('', ''); return; }

        var cached = getCachedVimeo(vimeoId, quality);
        if (cached && cached.video) {
            dbg('resolve-end', null, { vimeoId: vimeoId, source: 'localStorage', ms: 0, ok: true });
            callback(cached.video, cached.thumbnail);
            return;
        }

        var dedupKey = vimeoId + '_' + (quality || 'sd');
        if (resolveInflight[dedupKey]) {
            dbg('resolve-dedup', null, { vimeoId: vimeoId });
            resolveInflight[dedupKey].callbacks.push(callback);
            return;
        }

        var ctrl = ('AbortController' in window) ? new AbortController() : null;
        var t0 = performance.now();
        var timeoutId = setTimeout(function () {
            if (ctrl) try { ctrl.abort(); } catch (e) {}
        }, 8000);

        resolveInflight[dedupKey] = { callbacks: [callback], abort: ctrl };

        var url = nomadAjax.ajaxurl +
                  '?action=nomad_resolve_vimeo' +
                  '&vimeo_id=' + encodeURIComponent(vimeoId) +
                  '&quality=' + encodeURIComponent(quality || 'sd') +
                  '&_ajax_nonce=' + encodeURIComponent(nomadAjax.nonce || '');

        dbg('resolve-start', null, { vimeoId: vimeoId, source: 'ajax' });

        fetch(url, {
            credentials: 'same-origin',
            signal: ctrl ? ctrl.signal : undefined
        })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (resp) {
            clearTimeout(timeoutId);
            var entry = resolveInflight[dedupKey];
            delete resolveInflight[dedupKey];
            if (!entry) return;

            var videoUrl = '', thumbUrl = '';
            if (resp && resp.success && resp.data && resp.data.video) {
                videoUrl = resp.data.video;
                thumbUrl = resp.data.thumbnail || '';
                setCachedVimeo(vimeoId, quality, resp.data);
            }
            dbg('resolve-end', null, {
                vimeoId: vimeoId,
                source: 'ajax',
                ms: Math.round(performance.now() - t0),
                ok: !!videoUrl,
                wpCache: resp && resp.data && resp.data.cache_status ? resp.data.cache_status : 'unknown',
                wpMs: resp && resp.data && resp.data.resolve_ms ? resp.data.resolve_ms : null,
            });
            entry.callbacks.forEach(function (cb) { cb(videoUrl, thumbUrl); });
        })
        .catch(function (err) {
            clearTimeout(timeoutId);
            var entry = resolveInflight[dedupKey];
            delete resolveInflight[dedupKey];
            if (!entry) return;
            dbg('resolve-end', null, {
                vimeoId: vimeoId,
                source: 'ajax',
                ms: Math.round(performance.now() - t0),
                ok: false,
                error: (err && err.name) || 'unknown',
            });
            // Si fue abort por timeout, los callbacks reciben '' como fallo
            entry.callbacks.forEach(function (cb) { cb('', ''); });
        });
    }

    // ── Poster creation ──
    function ensurePoster(video) {
        var media = video.closest('.grid-item__media');
        if (!media) return;
        if (media.querySelector('.grid-item__poster')) return;

        var posterUrl = video.getAttribute('poster');
        if (!posterUrl) {
            var vimeoId = video.getAttribute('data-vimeo-resolve');
            if (vimeoId) {
                var cached = getCachedVimeo(vimeoId, 'sd');
                if (cached && cached.thumbnail) {
                    posterUrl = cached.thumbnail;
                    video.setAttribute('poster', posterUrl);
                }
            }
        }

        if (!posterUrl) return;
        createPosterImg(media, posterUrl);
    }

    function createPosterImg(media, url) {
        if (media.querySelector('.grid-item__poster')) return;
        var img = document.createElement('img');
        img.className = 'grid-item__poster';
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        media.appendChild(img);
    }

    // ── Queue system ──
    function enqueueVideo(video) {
        // Already loading or queued
        if (loadingVideos.indexOf(video) !== -1) return;
        if (loadQueue.indexOf(video) !== -1) return;

        if (loadingVideos.length < MAX_CONCURRENT) {
            dbg('queue-immediate', video);
            loadVideoNow(video);
        } else {
            dbg('queue-wait', video);
            loadQueue.push(video);
        }
    }

    function loadVideoNow(video) {
        var vimeoId = video.getAttribute('data-vimeo-resolve');

        if (video.getAttribute('src')) {
            dbg('src-already-set', video);
            playVideo(video);
            return;
        }

        if (!vimeoId) { return; }

        loadingVideos.push(video);

        // Tiempo total desde que salió de la cola hasta que esté listo.
        video.__dbgLoadStart = performance.now();
        dbg('load-begin', video);

        // Resolve Vimeo URL via AJAX, then load. Quality dinámica:
        // desktop con buena conexión → HD; móvil/save-data → SD.
        resolveVimeo(vimeoId, pickQuality(), function (videoUrl, thumbUrl) {
            if (!video.isConnected) {
                dbg('load-abort', video, { reason: 'disconnected' });
                releaseSlot(video);
                return;
            }
            if (!videoUrl) {
                dbg('load-abort', video, { reason: 'no-url' });
                releaseSlot(video);
                return;
            }

            // Set poster if we got a thumbnail and don't have one
            if (thumbUrl && !video.getAttribute('poster')) {
                video.setAttribute('poster', thumbUrl);
                var media = video.closest('.grid-item__media');
                if (media) createPosterImg(media, thumbUrl);
            }

            startVideoLoad(video, videoUrl);
        });
    }

    function startVideoLoad(video, src) {
        video.__dbgSrcSetAt = performance.now();
        dbg('src-set', video, { url: src.substring(0, 80) });

        video.src = src;
        video.load();

        function onReady(evtType) {
            video.removeEventListener('canplaythrough', onReadyCanPlay);
            video.removeEventListener('loadeddata', onReadyLoaded);
            var total = video.__dbgLoadStart ? Math.round(performance.now() - video.__dbgLoadStart) : null;
            var dl = video.__dbgSrcSetAt ? Math.round(performance.now() - video.__dbgSrcSetAt) : null;
            dbg('ready', video, { event: evtType, totalMs: total, downloadMs: dl });
            releaseSlot(video);

            // Prev/next del single-project: NO autoplay aquí (lo gestiona project-player.js
            // según estado del vídeo principal). Solo cargamos los bytes para que estén
            // listos cuando el usuario pause.
            if (video.classList.contains('project-nav__video')) return;

            var gridItem = video.closest('.grid-item--video');
            if (!isLowPower) {
                playVideo(video);
                if (gridItem) gridItem.classList.add('is-playing');
            }
        }
        function onReadyCanPlay() { onReady('canplaythrough'); }
        function onReadyLoaded() { onReady('loadeddata'); }

        video.addEventListener('canplaythrough', onReadyCanPlay, { once: true });
        video.addEventListener('loadeddata', onReadyLoaded, { once: true });

        function onVideoError() {
            dbg('load-error', video, { error: video.error ? video.error.code : 'unknown' });
        }
        video.addEventListener('error', onVideoError, { once: true });

        // Failsafe: si en 8s no llega ningún ready event, libera el slot igualmente
        setTimeout(function () {
            if (loadingVideos.indexOf(video) !== -1) {
                dbg('load-timeout', video);
            }
            releaseSlot(video);
        }, 8000);
    }

    function releaseSlot(video) {
        var idx = loadingVideos.indexOf(video);
        if (idx !== -1) loadingVideos.splice(idx, 1);

        // Iterativo (no recursivo) — desenfila siguientes hasta encontrar uno válido
        // o vaciar la cola. Evita stack overflow + bug previo de recursión incorrecta.
        while (loadQueue.length > 0 && loadingVideos.length < MAX_CONCURRENT) {
            var next = loadQueue.shift();
            if (next && next.isConnected &&
                next.getAttribute('data-vimeo-resolve') &&
                !next.getAttribute('src')) {
                loadVideoNow(next);
                return; // loadVideoNow añade a loadingVideos → frenamos aquí
            }
            // si no es válido, descarta y prueba el siguiente del queue
        }
    }

    function dequeueVideo(video) {
        // Remove from queue
        var qIdx = loadQueue.indexOf(video);
        if (qIdx !== -1) loadQueue.splice(qIdx, 1);

        // Remove from loading
        var lIdx = loadingVideos.indexOf(video);
        if (lIdx !== -1) loadingVideos.splice(lIdx, 1);

        // Pause and schedule unload
        video.pause();
        var gridItem = video.closest('.grid-item--video');
        if (gridItem) gridItem.classList.remove('is-playing');

        if (video.getAttribute('src')) {
            var t = setTimeout(function () {
                video.removeAttribute('src');
                video.load();
                unloadTimers.delete(video);
            }, UNLOAD_DELAY);
            unloadTimers.set(video, t);
        }
    }

    // ── Init ──
    function initLazyVideos() {
        // Clean up
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        loadingVideos = [];
        loadQueue = [];

        var videos = document.querySelectorAll('video[data-vimeo-resolve]');
        if (!videos.length) return;

        // Create posters for all videos primero (sirven aunque vídeos no carguen)
        videos.forEach(function (video) {
            ensurePoster(video);
        });

        // Race fix: si detectLowPower aún no terminó, deferir init.
        // detectLowPower llamará a initLazyVideos() al completar (vía pendingInit).
        if (!lowPowerChecked) {
            pendingInit = true;
            return;
        }

        // Low-power mode → poster only, no videos
        if (isLowPower) return;

        var root = document.querySelector('.home-grid__columns');

        observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                var video = entry.target;

                if (entry.isIntersecting) {
                    // Cancel pending unload
                    var timer = unloadTimers.get(video);
                    if (timer) {
                        clearTimeout(timer);
                        unloadTimers.delete(video);
                    }

                    dbg('viewport-enter', video);
                    enqueueVideo(video);

                } else {
                    dbg('viewport-leave', video);
                    dequeueVideo(video);
                }
            });
        }, {
            root: root || null,
            rootMargin: '200px 0px',
            threshold: 0.3
        });

        videos.forEach(function (video) {
            dbg('observe', video);
            observer.observe(video);
        });
    }

    // ── Safe play ──
    function playVideo(video) {
        if (!video.src || isLowPower) return;
        video.muted = true;
        var promise = video.play();
        if (promise) {
            promise.catch(function () {});
        }
    }

    // ── Page Visibility API ──
    // Pausa todos al ocultar tab. Al volver: solo reanuda los que NO sean prev/next
    // del project-player (esos los gestiona project-player.js según estado de main).
    document.addEventListener('visibilitychange', function () {
        var videos = document.querySelectorAll('video[data-vimeo-resolve]');
        if (document.hidden) {
            videos.forEach(function (v) { if (!v.paused) try { v.pause(); } catch (e) {} });
        } else {
            if (!observer || isLowPower) return;
            videos.forEach(function (v) {
                // Skip prev/next del single-project: project-player.js los gestiona
                if (v.classList.contains('project-nav__video')) return;
                if (v.getAttribute('src') && v.paused) playVideo(v);
            });
        }
    });

    // ── Full cleanup on navigation ──
    // Pausa y libera el src de todos los <video> con data-vimeo-resolve antes
    // de que Swup inyecte la siguiente página. Sin esto, Chrome/Safari pueden
    // mantener conexiones abiertas con los MP4 del grid anterior durante
    // varios segundos tras navegar, compitiendo por bandwidth con el vídeo
    // del single al que acabamos de entrar.
    function cleanupAllVideos() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        loadingVideos = [];
        loadQueue = [];

        document.querySelectorAll('video[data-vimeo-resolve]').forEach(function (v) {
            try {
                v.pause();
                if (v.getAttribute('src')) {
                    v.removeAttribute('src');
                    v.load();  // aborta descarga in-flight
                }
            } catch (e) {}
        });
    }

    // ── Event bindings ──
    // Run after home-grid.js clones items
    document.addEventListener('homeGridReady', function () {
        initLazyVideos();
    });

    // Fallback
    if (document.readyState !== 'loading') {
        setTimeout(function () {
            if (!observer) initLazyVideos();
        }, 500);
    }

    // Detect low-power on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            detectLowPower();
            detectConnection();
        });
    } else {
        detectLowPower();
        detectConnection();
    }

    // Register with Swup callback system
    // El cleanup ya se hace en visit:start de transitions.js (ANTES de que Swup
    // reemplace el DOM), así que aquí solo inicializamos sobre el nuevo contenido.
    // El setTimeout da un tick para que el DOM esté estable tras content:replace.
    window.masterThemeInitCallbacks = window.masterThemeInitCallbacks || [];
    window.masterThemeInitCallbacks.push(function (isSwupNav) {
        if (isSwupNav) {
            setTimeout(initLazyVideos, 100);
        }
    });

    window.NomadLazyVideo = {
        init: initLazyVideos,
        cleanup: cleanupAllVideos
    };

})();
