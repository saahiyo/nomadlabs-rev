/**
 * Project Player - Nomad Labs
 *
 * Fullscreen player con <video> nativo y controles custom.
 *
 * Si el <video> tiene data-source-ssr="1" → usa el <source> ya presente.
 * Si no → pide URL vía AJAX y la inyecta.
 *
 * Ante error del <video>: retry con force=true (URL fresca), luego SD, luego is-error.
 *
 * @package NomadLabs
 */

(function () {
    'use strict';

    var player, video, poster, btnPlay, btnMute, btnFullscreen;
    var progress, progressFill, btnClose, btnInfo;
    var hideTimer = null;
    var isDragging = false;
    var wasPausedBeforeDrag = false;
    var bufferInterval = null;
    var lastBufferTime = 0;
    var playPromise = null;
    var refreshAttempts = 0;
    var triedSdFallback = false;
    var bufferingTimeout = null;
    var urlAbortController = null;
    var hasReceivedBytes = false;

    var viewportObs = null;
    var isVisible = true;
    var rafId = null;
    var progTarget = 0;
    var progDisplayed = 0;

    function getStoredMuted() {
        try { var v = sessionStorage.getItem('nomad:mute'); return v === null ? true : v === '1'; }
        catch (e) { return true; }
    }
    function setStoredMuted(m) {
        try { sessionStorage.setItem('nomad:mute', m ? '1' : '0'); } catch (e) {}
    }

    var DEBUG = (function () {
        try {
            if (location.search.indexOf('nomad_debug=1') !== -1) return true;
            if (localStorage.getItem('nomad_debug') === '1') return true;
        } catch (e) {}
        return false;
    })();
    function dlog() {
        if (!DEBUG) return;
        var args = ['%c[VIDEO]', 'color:#0073aa;font-weight:600']
            .concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }

    // ── Debug hook: eventos para video-debug.js ──
    function dbg(type, extra) {
        var detail = {
            context: 'single',
            videoEl: video || null,
            postId: video ? video.getAttribute('data-post-id') : '',
            ts: performance.now(),
        };
        if (extra) for (var k in extra) detail[k] = extra[k];
        try {
            document.dispatchEvent(new CustomEvent('nomad-debug:' + type, { detail: detail }));
        } catch (e) {}
    }

    function pickQuality() {
        var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (conn) {
            if (conn.saveData) return 'sd';
            if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g' || conn.effectiveType === '3g') return 'sd';
        }
        if (window.innerWidth < 768) return 'sd';
        return 'hd';
    }

    var boundHandlers = { keydown: null, dragMove: null, dragEnd: null };

    function startBufferCheck() {
        if (bufferInterval || !video || !player) return;
        bufferInterval = setInterval(function () {
            if (!video || !player) { stopBufferCheck(); return; }
            player.classList.toggle('is-buffering', !video.paused && video.currentTime === lastBufferTime);
            lastBufferTime = video.currentTime;
        }, 250);
    }
    function stopBufferCheck() {
        if (bufferInterval) { clearInterval(bufferInterval); bufferInterval = null; }
        if (player) player.classList.remove('is-buffering');
    }

    function safePlay() {
        if (!video) return;
        playPromise = video.play();
        if (playPromise) {
            playPromise.then(function () { playPromise = null; })
                       .catch(function () { playPromise = null; });
        }
    }
    function safePause() {
        if (!video) return;
        if (playPromise) {
            playPromise.then(function () { if (video) video.pause(); })
                       .catch(function () {});
            playPromise = null;
        } else {
            video.pause();
        }
    }

    function fetchVimeoUrl(opts, callback) {
        opts = opts || {};
        var postId = video ? video.getAttribute('data-post-id') : '';
        if (!postId || typeof nomadAjax === 'undefined') { callback(''); return; }

        if (urlAbortController) { try { urlAbortController.abort(); } catch (e) {} }
        urlAbortController = ('AbortController' in window) ? new AbortController() : null;

        var body = new URLSearchParams();
        body.set('action', 'nomad_fresh_vimeo_url');
        body.set('post_id', postId);
        body.set('nonce', nomadAjax.nonce || '');
        body.set('quality', opts.quality || pickQuality());
        if (opts.force) body.set('force', '1');

        dlog('fetchVimeoUrl →', { postId: postId, force: !!opts.force });
        var t0 = performance.now();
        dbg('resolve-start', { source: 'ajax-fresh', force: !!opts.force, quality: opts.quality || pickQuality() });

        fetch(nomadAjax.ajaxurl, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body.toString(),
            signal: urlAbortController ? urlAbortController.signal : undefined
        })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (resp) {
            var ok = !!(resp && resp.success && resp.data && resp.data.url);
            dbg('resolve-end', {
                source: 'ajax-fresh',
                ms: Math.round(performance.now() - t0),
                ok: ok,
                wpCache: resp && resp.data && resp.data.cache_status ? resp.data.cache_status : 'unknown',
                wpMs: resp && resp.data && resp.data.resolve_ms ? resp.data.resolve_ms : null,
            });
            if (ok) {
                callback(resp.data.url);
            } else {
                console.warn('[Nomad] fetchVimeoUrl empty —', resp && resp.data);
                callback('');
            }
        })
        .catch(function (err) {
            dbg('resolve-end', {
                source: 'ajax-fresh',
                ms: Math.round(performance.now() - t0),
                ok: false,
                error: (err && err.name) || 'unknown',
            });
            if (err && err.name !== 'AbortError') console.warn('[Nomad] fetchVimeoUrl error', err);
            callback('');
        });
    }

    var BUFFERING_TIMEOUT_MS = 20000;
    var triggerRetryFromTimeout = null;

    function armBufferingTimeout() {
        clearBufferingTimeout();
        bufferingTimeout = setTimeout(function () {
            if (!player || !video) return;
            if (player.classList.contains('is-playing')) return;
            if (hasReceivedBytes) {
                dlog('buffering timeout con bytes → rearmar, no retry');
                armBufferingTimeout();
                return;
            }
            dlog('buffering timeout + cero bytes → retry');
            if (triggerRetryFromTimeout) triggerRetryFromTimeout();
        }, BUFFERING_TIMEOUT_MS);
    }
    function clearBufferingTimeout() {
        if (bufferingTimeout) { clearTimeout(bufferingTimeout); bufferingTimeout = null; }
    }

    function handleSourceError(reason) {
        clearBufferingTimeout();
        dlog('handleSourceError', { reason: reason, attempt: refreshAttempts });

        var nextOpts = null;
        if (refreshAttempts === 0) {
            nextOpts = { force: true };
        } else if (refreshAttempts === 1 && !triedSdFallback) {
            nextOpts = { force: true, quality: 'sd' };
            triedSdFallback = true;
        } else {
            console.warn('[Nomad] Video failed after all retries');
            if (player) { player.classList.remove('is-buffering'); player.classList.add('is-error'); }
            return;
        }

        refreshAttempts++;
        fetchVimeoUrl(nextOpts, function (freshUrl) {
            if (freshUrl && video && player) {
                setVideoSource(freshUrl);
            } else if (player) {
                player.classList.remove('is-buffering');
                player.classList.add('is-error');
            }
        });
    }

    function attachSsrSourceHandlers() {
        if (!video || !player) return;
        dlog('attachSsrSourceHandlers — using server-rendered source');

        var errorHandled = false;
        function onError(reason) {
            if (errorHandled) return;
            errorHandled = true;
            handleSourceError(reason);
        }

        triggerRetryFromTimeout = function () { onError('buffering-timeout'); };

        var existingSource = video.querySelector('source');
        if (existingSource) {
            existingSource.addEventListener('error', function () { onError('source-error'); });
        }
        video.addEventListener('error', function () { onError('video-error'); }, { once: true });

        video.muted = true;
        player.classList.add('is-muted');
        player.classList.add('is-buffering');
        armBufferingTimeout();

        var p = video.play();
        if (p && p.then) {
            playPromise = p;
            p.then(function () {
                playPromise = null;
                errorHandled = true;
                clearBufferingTimeout();
                if (!player) return;
                player.classList.remove('is-buffering');
                player.classList.remove('is-autoplay-blocked');
                player.classList.add('is-playing');
                startHideTimer();
                startBufferCheck();
                if (poster) poster.classList.add('is-hidden');
            }).catch(function (err) {
                playPromise = null;
                if (!video || !player) return;
                var name = err && err.name;
                if (name === 'AbortError') return;
                dlog('play() rejected (SSR)', name);
                if (name === 'NotAllowedError') {
                    clearBufferingTimeout();
                    player.classList.remove('is-buffering');
                    player.classList.add('is-autoplay-blocked');
                    return;
                }
                video.addEventListener('canplay', function () {
                    if (!video || !player) return;
                    clearBufferingTimeout();
                    player.classList.remove('is-buffering');
                    safePlay();
                    player.classList.add('is-playing');
                    startHideTimer();
                    startBufferCheck();
                    if (poster) poster.classList.add('is-hidden');
                }, { once: true });
            });
        }
    }

    function setVideoSource(url) {
        if (!video || !player) return;
        dlog('setVideoSource', url.substring(0, 80), 'attempt:', refreshAttempts);
        video.__dbgSrcSetAt = performance.now();
        dbg('src-set', { url: url.substring(0, 80), attempt: refreshAttempts });

        hasReceivedBytes = false;

        var sources = video.querySelectorAll('source');
        sources.forEach(function (s) { s.remove(); });

        var source = document.createElement('source');
        source.setAttribute('src', url);
        source.setAttribute('type', 'video/mp4');

        var errorHandled = false;
        function handleError(reason) {
            if (errorHandled) return;
            errorHandled = true;
            handleSourceError(reason);
        }

        triggerRetryFromTimeout = function () { handleError('buffering-timeout'); };

        source.addEventListener('error', function () { handleError('source-error'); });
        video.addEventListener('error', function () { handleError('video-error'); }, { once: true });
        video.appendChild(source);
        video.load();

        video.muted = true;
        player.classList.add('is-muted');
        player.classList.add('is-buffering');
        armBufferingTimeout();

        playPromise = video.play();
        if (playPromise) {
            playPromise.then(function () {
                playPromise = null;
                errorHandled = true;
                clearBufferingTimeout();
                if (!player) return;
                player.classList.remove('is-buffering');
                player.classList.remove('is-autoplay-blocked');
                player.classList.add('is-playing');
                startHideTimer();
                startBufferCheck();
                if (poster) poster.classList.add('is-hidden');
            }).catch(function (err) {
                playPromise = null;
                if (!video || !player) return;
                var name = err && err.name;
                if (name === 'AbortError') return;
                dlog('play() rejected', name);
                if (name === 'NotAllowedError') {
                    clearBufferingTimeout();
                    player.classList.remove('is-buffering');
                    player.classList.add('is-autoplay-blocked');
                    return;
                }
                video.addEventListener('canplay', function () {
                    if (!video || !player) return;
                    clearBufferingTimeout();
                    player.classList.remove('is-buffering');
                    safePlay();
                    player.classList.add('is-playing');
                    startHideTimer();
                    startBufferCheck();
                    if (poster) poster.classList.add('is-hidden');
                }, { once: true });
            });
        }
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function startProgressRAF() {
        if (rafId) return;
        var tick = function () {
            if (!progressFill) { rafId = null; return; }
            var factor = isDragging ? 0.1 : 0.04;
            progDisplayed = lerp(progDisplayed, progTarget, factor);
            progressFill.style.width = (progDisplayed * 100) + '%';
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
    }
    function stopProgressRAF() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function setupViewportObserver() {
        if (!player || !video || typeof IntersectionObserver !== 'function') return;
        viewportObs = new IntersectionObserver(function (entries) {
            var wasVisible = isVisible;
            isVisible = entries[0].isIntersecting;
            if (!isVisible && !video.paused) {
                try { video.pause(); } catch (e) {}
            } else if (isVisible && !wasVisible && video.paused && video.currentTime > 0 && !video.ended) {
                safePlay();
            }
        }, { threshold: 0.5 });
        viewportObs.observe(player);
    }

    function cleanup() {
        if (boundHandlers.keydown) {
            document.removeEventListener('keydown', boundHandlers.keydown);
            boundHandlers.keydown = null;
        }
        if (boundHandlers.dragMove) {
            document.removeEventListener('mousemove', boundHandlers.dragMove);
            document.removeEventListener('touchmove', boundHandlers.dragMove);
            boundHandlers.dragMove = null;
        }
        if (boundHandlers.dragEnd) {
            document.removeEventListener('mouseup', boundHandlers.dragEnd);
            document.removeEventListener('touchend', boundHandlers.dragEnd);
            boundHandlers.dragEnd = null;
        }
        if (viewportObs) { try { viewportObs.disconnect(); } catch (e) {} viewportObs = null; }
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        stopBufferCheck();
        clearBufferingTimeout();
        if (urlAbortController) { try { urlAbortController.abort(); } catch (e) {} urlAbortController = null; }
        if (video) {
            try {
                video.pause();
                var srcs = video.querySelectorAll('source');
                srcs.forEach(function (s) { s.remove(); });
                video.removeAttribute('src');
                video.load();
            } catch (e) {}
        }
        clearTimeout(hideTimer);
        document.body.classList.remove('controls-hidden');
        isDragging = false;
        isVisible = true;
        progTarget = 0;
        progDisplayed = 0;
        playPromise = null;
        refreshAttempts = 0;
        triedSdFallback = false;
        hasReceivedBytes = false;
        player = null;
        video = null;
    }

    function init() {
        cleanup();

        player = document.getElementById('project-player');
        if (!player) return;
        dlog('init');

        video         = document.getElementById('project-video');
        poster        = document.getElementById('project-poster');
        btnPlay       = document.getElementById('project-btn-play');
        btnMute       = document.getElementById('project-btn-mute');
        btnFullscreen = document.getElementById('project-btn-fullscreen');
        progress      = document.getElementById('project-progress');
        progressFill  = document.getElementById('project-progress-fill');
        btnClose      = document.getElementById('project-btn-close');
        btnInfo       = document.getElementById('project-btn-info');

        if (!video) return;

        if (btnClose) {
            var closeFired = false;
            function stopVideo() {
                try {
                    video.pause();
                    video.removeAttribute('src');
                    video.querySelectorAll('source').forEach(function (s) { s.remove(); });
                    video.load();
                } catch (err) {}
                playPromise = null;
            }
            function pickCloseDestination() {
                try {
                    var last = sessionStorage.getItem('nomad:lastGallery');
                    if (last === '/' || last === '/list' || last === '/list/') return last;
                } catch (e) {}
                var ref = document.referrer;
                if (ref && ref.indexOf(window.location.hostname) !== -1) {
                    try {
                        var refPath = new URL(ref).pathname.replace(/\/+$/, '') || '/';
                        if (refPath === '/' || refPath === '/list') return refPath;
                    } catch (e) {}
                }
                return '/';
            }
            function handleClose(e) {
                if (closeFired) return;
                closeFired = true;
                e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
                stopVideo();
                var dest = pickCloseDestination();
                if (window.swup && typeof window.swup.navigate === 'function') {
                    try { window.swup.navigate(dest); return; } catch (err) {}
                }
                window.location.href = dest;
            }
            btnClose.addEventListener('touchend', handleClose, { passive: false });
            btnClose.addEventListener('click', handleClose);
        }

        if (btnPlay) {
            btnPlay.addEventListener('click', function (e) {
                e.stopPropagation();
                togglePlay();
            });
        }

        player.addEventListener('click', function (e) {
            if (e.target.closest('.project-controls') ||
                e.target.closest('.project-info') ||
                e.target.closest('.project-btn-close') ||
                e.target.closest('.project-nav')) return;
            togglePlay();
        });

        if (btnMute) {
            btnMute.addEventListener('click', function (e) {
                e.stopPropagation();
                if (!video || !player) return;
                video.muted = !video.muted;
                player.classList.toggle('is-muted', video.muted);
                setStoredMuted(video.muted);
            });
        }

        if (btnFullscreen) {
            btnFullscreen.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleFullscreen();
            });
        }

        var timeDisplay = document.getElementById('project-time');
        function formatTime(seconds) {
            var m = Math.floor(seconds / 60);
            var s = Math.floor(seconds % 60);
            return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
        }
        video.addEventListener('timeupdate', function () {
            if (!video || isDragging) return;
            if (video.duration) {
                progTarget = video.currentTime / video.duration;
                if (timeDisplay) {
                    timeDisplay.textContent = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
                }
            }
        });

        if (progress) {
            function getClientX(e) {
                if (e.changedTouches) return e.changedTouches[0].clientX;
                if (e.touches) return e.touches[0].clientX;
                return e.clientX;
            }
            function getPct(clientX) {
                var rect = progress.getBoundingClientRect();
                return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            }
            function seekTo(pct) {
                if (video && video.duration) {
                    video.currentTime = pct * video.duration;
                    progTarget = pct;
                    progDisplayed = pct;
                    if (progressFill) progressFill.style.width = (pct * 100) + '%';
                }
            }
            function onDragStart(e) {
                if (!video || !player) return;
                e.stopPropagation(); e.preventDefault();
                isDragging = true;
                wasPausedBeforeDrag = video.paused;
                safePause();
                player.classList.add('is-scrubbing');
                seekTo(getPct(getClientX(e)));
                showControls();
            }
            boundHandlers.dragMove = function (e) {
                if (!isDragging) return;
                e.preventDefault();
                seekTo(getPct(getClientX(e)));
            };
            boundHandlers.dragEnd = function (e) {
                if (!isDragging) return;
                isDragging = false;
                if (player) player.classList.remove('is-scrubbing');
                seekTo(getPct(getClientX(e)));
                if (!wasPausedBeforeDrag && video) {
                    safePlay();
                    if (player) player.classList.add('is-playing');
                    startHideTimer();
                }
            };
            progress.addEventListener('mousedown', onDragStart);
            progress.addEventListener('touchstart', onDragStart, { passive: false });
            document.addEventListener('mousemove', boundHandlers.dragMove);
            document.addEventListener('touchmove', boundHandlers.dragMove, { passive: false });
            document.addEventListener('mouseup', boundHandlers.dragEnd);
            document.addEventListener('touchend', boundHandlers.dragEnd);
            progress.addEventListener('click', function (e) { e.stopPropagation(); });
        }

        video.addEventListener('playing', function () {
            clearBufferingTimeout();
            var dl = video.__dbgSrcSetAt ? Math.round(performance.now() - video.__dbgSrcSetAt) : null;
            dbg('playing', { downloadMs: dl });
            if (poster) poster.classList.add('is-hidden');
            if (player) {
                player.classList.remove('is-buffering');
                player.classList.remove('is-autoplay-blocked');
                player.classList.add('is-playing');
                player.classList.toggle('is-muted', video.muted);
            }
            startBufferCheck();
            startProgressRAF();
            startHideTimer();
            setNavPreviewsPlayState(false);
        });

        video.addEventListener('waiting', function () {
            dbg('buffering', {});
            if (player && !player.classList.contains('is-playing')) {
                player.classList.add('is-buffering');
                armBufferingTimeout();
            }
        });

        video.addEventListener('error', function () {
            dbg('load-error', { error: video.error ? video.error.code : 'unknown' });
        });

        video.addEventListener('loadeddata', function () {
            var dl = video.__dbgSrcSetAt ? Math.round(performance.now() - video.__dbgSrcSetAt) : null;
            dbg('ready', { event: 'loadeddata', downloadMs: dl });
        });

        video.addEventListener('progress', function () {
            if (!video) return;
            try {
                if (video.buffered && video.buffered.length > 0 && video.buffered.end(0) > 0) {
                    if (!hasReceivedBytes) {
                        dlog('primer byte — descarga viva');
                        hasReceivedBytes = true;
                    }
                }
            } catch (e) {}
            if (player && player.classList.contains('is-buffering') && !player.classList.contains('is-playing')) {
                armBufferingTimeout();
            }
        });

        video.addEventListener('loadedmetadata', function () {
            if (!hasReceivedBytes) hasReceivedBytes = true;
        });

        video.addEventListener('pause', function () {
            if (player) player.classList.remove('is-playing');
            stopBufferCheck();
            stopProgressRAF();
            showControls();
            setNavPreviewsPlayState(true);
        });
        video.addEventListener('ended', function () {
            if (!player) return;
            player.classList.remove('is-playing');
            showControls();
            stopBufferCheck();
            stopProgressRAF();
        });

        var infoOverlay = document.getElementById('project-info-overlay');
        if (btnInfo && infoOverlay) {
            btnInfo.addEventListener('click', function (e) {
                e.stopPropagation();
                infoOverlay.classList.toggle('is-visible');
            });
        }

        player.addEventListener('mousemove', showControls);
        player.addEventListener('touchstart', showControls);

        function pauseFromGesture() { if (video && !video.paused) safePause(); }
        function playFromGesture()  { if (video && video.paused)  safePlay(); }

        player.addEventListener('wheel', function (e) {
            if (Math.abs(e.deltaY) < 5) return;
            if (e.deltaY > 0) pauseFromGesture();
            else playFromGesture();
        }, { passive: true });

        var touchStartY = null;
        player.addEventListener('touchstart', function (e) {
            if (e.touches && e.touches.length === 1) touchStartY = e.touches[0].clientY;
        }, { passive: true });
        player.addEventListener('touchmove', function (e) {
            if (touchStartY === null || !e.touches || !e.touches.length) return;
            var dy = touchStartY - e.touches[0].clientY;
            if (Math.abs(dy) < 30) return;
            if (dy > 0) pauseFromGesture();
            else playFromGesture();
        }, { passive: true });
        player.addEventListener('touchend', function () { touchStartY = null; }, { passive: true });

        document.addEventListener('fullscreenchange', updateFullscreenState);
        document.addEventListener('webkitfullscreenchange', updateFullscreenState);

        boundHandlers.keydown = function (e) {
            if (!player || !video) return;
            switch (e.key) {
                case ' ': case 'k': e.preventDefault(); togglePlay(); break;
                case 'm': video.muted = !video.muted; player.classList.toggle('is-muted', video.muted); break;
                case 'f': toggleFullscreen(); break;
                case 'Escape':
                    var overlay = document.getElementById('project-info-overlay');
                    if (overlay) overlay.classList.remove('is-visible');
                    break;
                case 'ArrowLeft': video.currentTime = Math.max(0, video.currentTime - 5); break;
                case 'ArrowRight': video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); break;
            }
        };
        document.addEventListener('keydown', boundHandlers.keydown);

        setupViewportObserver();

        var hasSsrSource = video.getAttribute('data-source-ssr') === '1'
                        && video.querySelector('source[src]');

        if (hasSsrSource) {
            attachSsrSourceHandlers();
        } else {
            if (player) player.classList.add('is-buffering');
            fetchVimeoUrl({}, function (url) {
                if (!video || !player) return;
                if (url) {
                    setVideoSource(url);
                } else {
                    player.classList.remove('is-buffering');
                    player.classList.add('is-error');
                    console.warn('[Nomad] No video source available');
                }
            });
        }

        requestAnimationFrame(function () {
            player.classList.add('is-loaded');
        });
    }

    function togglePlay() {
        if (!video || !player) return;
        if (video.paused) {
            safePlay();
            player.classList.add('is-playing');
            startHideTimer();
        } else {
            safePause();
            player.classList.remove('is-playing');
            showControls();
        }
    }

    function toggleFullscreen() {
        if (!player) return;
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        } else {
            (player.requestFullscreen || player.webkitRequestFullscreen).call(player);
        }
    }

    function updateFullscreenState() {
        if (!player) return;
        player.classList.toggle('is-fullscreen', !!(document.fullscreenElement || document.webkitFullscreenElement));
    }

    function showControls() {
        if (!player || !video) return;
        player.classList.remove('controls-hidden');
        document.body.classList.remove('controls-hidden');
        clearTimeout(hideTimer);
        if (!video.paused) startHideTimer();
    }

    function startHideTimer() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            if (!video || !player) return;
            var infoOvl = document.getElementById('project-info-overlay');
            if (!video.paused && (!infoOvl || !infoOvl.classList.contains('is-visible'))) {
                player.classList.add('controls-hidden');
                document.body.classList.add('controls-hidden');
            }
        }, 3000);
    }

    function setNavPreviewsPlayState(shouldPlay) {
        if (!player) return;
        var navVideos = player.querySelectorAll('.project-nav__video');
        navVideos.forEach(function (nv) {
            if (shouldPlay) {
                nv.play().catch(function () {});
            } else {
                nv.pause();
            }
        });
    }

    window.masterThemeInitCallbacks = window.masterThemeInitCallbacks || [];
    window.masterThemeInitCallbacks.push(function () {
        init();
    });

    if (document.readyState !== 'loading') {
        init();
    }

    window.NomadProjectPlayer = { init: init };

})();