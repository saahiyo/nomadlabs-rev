/**
 * Swup Transitions - Nomad Labs
 *
 * Page transitions with Swup v4 + @swup/preload-plugin.
 *
 * - HTML prefetch: lo hace @swup/preload-plugin (hover) + <link rel=prefetch>
 *   inyectado desde PHP (home/list/about siempre precargadas).
 * - Warm-up Vimeo en hover/mousedown/touchstart: pre-resuelve la URL firmada del
 *   MP4 vía AJAX para que project-player.js la tenga cacheada nada más entrar.
 * - visit:start hace blur() del link clickado (evita aria-hidden on focused warning).
 * - visit:start pausa vídeos pero NO borra src (iOS perdería el gesto de autoplay).
 *
 * @package NomadLabs
 */

(function () {
    'use strict';

    var swupInstance = null;

    window.masterThemeInitCallbacks = window.masterThemeInitCallbacks || [];

    function initPage(isSwupNav) {
        window.masterThemeInitCallbacks.forEach(function (cb) {
            if (typeof cb === 'function') {
                try { cb(isSwupNav); } catch (e) {
                    console.error('Module init error:', e);
                }
            }
        });
        updateActiveNav();
        rememberGalleryPage();
    }

    function rememberGalleryPage() {
        try {
            var p = window.location.pathname.replace(/\/+$/, '') || '/';
            if (p === '/' || p === '/list' || p.indexOf('/list') === 0) {
                sessionStorage.setItem('nomad:lastGallery', p);
            }
        } catch (e) {}
    }

    function updateActiveNav() {
        var currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
        document.querySelectorAll('.nav-item').forEach(function (link) {
            var linkPath = link.pathname ? link.pathname.replace(/\/+$/, '') || '/' : '/';
            link.classList.toggle('is-current', linkPath === currentPath);
        });
    }

    // ══════════════════════════════════════════
    //  WARM-UP VIMEO en hover/mousedown/touchstart
    //  (El prefetch de HTML lo hace @swup/preload-plugin,
    //   aquí solo pre-resolvemos las URLs firmadas de Vimeo.)
    // ══════════════════════════════════════════
    function setupVimeoWarmup() {
        var warmedVimeoIds = {};

        function warmUpVimeo(vid, quality) {
            if (!vid) return;
            var k = vid + ':' + quality;
            if (warmedVimeoIds[k]) return;
            if (typeof nomadAjax === 'undefined') return;
            warmedVimeoIds[k] = true;
            var url = nomadAjax.ajaxurl + '?action=nomad_resolve_vimeo' +
                      '&vimeo_id=' + encodeURIComponent(vid) +
                      '&quality=' + encodeURIComponent(quality) +
                      '&_ajax_nonce=' + encodeURIComponent(nomadAjax.nonce || '');
            fetch(url, { credentials: 'same-origin', keepalive: true }).catch(function () {});
        }

        function handleLink(link) {
            if (!link) return;

            var href = link.getAttribute('href');
            if (!href || href.charAt(0) === '#' ||
                href.indexOf('mailto:') === 0 ||
                href.indexOf('tel:') === 0) return;

            if (link.classList.contains('no-swup')) return;

            try {
                var url = new URL(href, window.location.origin);
                if (url.origin !== window.location.origin) return;
                if (url.pathname === window.location.pathname) return;
                if (url.pathname.indexOf('wp-admin') !== -1) return;
                if (url.pathname.indexOf('wp-login') !== -1) return;
            } catch (err) { return; }

            // Warm-up preview (mini-video del grid)
            var vidEl = link.querySelector('[data-vimeo-resolve]');
            var previewVid = vidEl ? vidEl.getAttribute('data-vimeo-resolve') : '';
            if (previewVid) warmUpVimeo(previewVid, 'hd');

            // Warm-up main (vídeo del single) — para que project-player.js encuentre
            // la URL ya cacheada nada más entrar al single.
            var mainVid = link.getAttribute('data-main-vimeo-id');
            if (mainVid && mainVid !== previewVid) {
                warmUpVimeo(mainVid, 'hd');
            }
        }

        function onEvent(e) {
            if (!e.target || !e.target.closest) return;
            handleLink(e.target.closest('a[href]'));
        }

        // Hover: dispara el warm-up sin delay para ganar el máximo de tiempo.
        document.addEventListener('mouseenter', onEvent, true);
        // mousedown/touchstart: garantiza warm-up antes incluso de que termine el click.
        document.addEventListener('mousedown', onEvent, true);
        document.addEventListener('touchstart', onEvent, { capture: true, passive: true });
    }

    // ══════════════════════════════════════════
    //  SWUP INIT
    // ══════════════════════════════════════════
    function initSwup() {
        var SwupConstructor = window.Swup;
        if (SwupConstructor && SwupConstructor.default) {
            SwupConstructor = SwupConstructor.default;
        }

        if (typeof SwupConstructor !== 'function') {
            console.warn('Swup not available, running without transitions');
            initPage(false);
            return;
        }

        try {
            swupInstance = new SwupConstructor({
                containers: ['#swup'],
                animationSelector: '.transition-fade',
                cache: true,
                animateHistoryBrowsing: true,
            });
            window.swup = swupInstance;

            // Preload plugin: precarga al hover (delay 0) y también los
            // <link rel="prefetch"> que ya inyecta PHP en el <head> (home/list/about).
            // Así la navegación entre páginas principales es instantánea.
            var PreloadPluginCtor = window.SwupPreloadPlugin;
            if (PreloadPluginCtor && PreloadPluginCtor.default) {
                PreloadPluginCtor = PreloadPluginCtor.default;
            }
            if (typeof PreloadPluginCtor === 'function') {
                swupInstance.use(new PreloadPluginCtor({
                    preloadHoveredLinks: true,
                    preloadVisibleLinks: false,
                    throttle: 5,
                }));
            }
        } catch (e) {
            console.error('Swup init failed:', e);
            initPage(false);
            return;
        }

        // Antes de navegar:
        //  - Quitar focus del link clickado (evita aria-hidden focus warning).
        //  - Cerrar menú si estaba abierto.
        //  - Abortar vídeos del grid: borra src + .load() cancela descargas in-flight.
        //    CRÍTICO: si no se hace ANTES de content:replace, Swup descarta el
        //    <video> del DOM pero el navegador sigue descargando el MP4 en segundo
        //    plano, compitiendo por bandwidth con el vídeo del single destino.
        //  - El vídeo principal del single (#project-video) NO lleva data-vimeo-resolve,
        //    así que no lo tocamos — iOS conservaría el gesto de autoplay si siguiera
        //    siendo el mismo; en Swup va a ser reemplazado igualmente.
        swupInstance.hooks.on('visit:start', function () {
            try {
                if (document.activeElement &&
                    typeof document.activeElement.blur === 'function' &&
                    document.activeElement !== document.body) {
                    document.activeElement.blur();
                }
            } catch (e) {}

            var navHeader = document.getElementById('nav-header');
            if (navHeader) navHeader.classList.remove('is-active');

            // Abort de descargas activas del grid antes de que Swup reemplace el DOM.
            if (window.NomadLazyVideo && typeof window.NomadLazyVideo.cleanup === 'function') {
                try { window.NomadLazyVideo.cleanup(); } catch (e) {}
            }

            // Failsafe: pausa cualquier <video> que no haya sido limpiado por cleanup.
            document.querySelectorAll('video').forEach(function (v) {
                try {
                    if (!v.paused) v.pause();
                } catch (e) {}
            });
        });

        swupInstance.hooks.on('content:replace', function (visit) {
            try {
                var newDoc = visit && visit.to && visit.to.document;
                if (newDoc && newDoc.body) {
                    document.body.className = newDoc.body.className;
                }
            } catch (e) {}
        });

        swupInstance.hooks.on('page:view', function () {
            initPage(true);
        });

        setupVimeoWarmup();

        initPage(false);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSwup);
    } else {
        initSwup();
    }

})();