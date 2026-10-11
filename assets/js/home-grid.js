/**
 * Home Grid - Nomad Labs
 *
 * Optimized infinite scroll grid.
 * - translate3d for GPU compositing (avoids layout/paint)
 * - Pre-computed values (no DOM reads in ticker)
 * - Cached Math operations
 * - Passive touch where possible
 * - requestAnimationFrame via GSAP ticker
 *
 * @package NomadLabs
 */

(function () {
    'use strict';

    var tickerFn = null;
    var wheelHandler = null;
    var touchStartHandler = null;
    var touchMoveHandler = null;
    var currentContainer = null;

    var targetY = 0;
    var virtualY = 0;
    var ease = 0.08;
    var lastTy = []; // Cache last transform per column to skip no-op writes

    function cleanup() {
        if (tickerFn) {
            gsap.ticker.remove(tickerFn);
            tickerFn = null;
        }
        if (wheelHandler) window.removeEventListener('wheel', wheelHandler);
        if (touchStartHandler) window.removeEventListener('touchstart', touchStartHandler);
        if (touchMoveHandler) window.removeEventListener('touchmove', touchMoveHandler);
        if (currentContainer) {
            var cols = currentContainer.querySelectorAll('[data-grid-col]');
            cols.forEach(function (col) {
                col.style.transform = '';
                col.style.visibility = '';
            });
        }
        wheelHandler = null;
        touchStartHandler = null;
        touchMoveHandler = null;
        currentContainer = null;
        targetY = 0;
        virtualY = 0;
        lastTy = [];

        document.body.style.overflow = '';
        if (window.NomadLabs && window.NomadLabs.lenis) {
            window.NomadLabs.lenis.start();
        }
    }

    // ── Mobile redistribution: move items to 2 columns based on data-col-mobile ──
    function redistributeMobile(container) {
        if (window.innerWidth > 809) return;

        var cols = container.querySelectorAll('[data-grid-col]');
        if (cols.length < 2) return;

        var tracks = [];
        cols.forEach(function (col) {
            tracks.push(col.querySelector('[data-grid-track]'));
        });

        // Collect all grid items from all columns
        var allItems = container.querySelectorAll('[data-grid-item]');

        // Remove items hidden on mobile
        allItems.forEach(function (item) {
            if (item.classList.contains('grid-item--hide-mobile')) {
                item.remove();
            }
        });

        // Move remaining items to their assigned mobile column (1 or 2)
        var mobileItems = container.querySelectorAll('[data-grid-item]');
        mobileItems.forEach(function (item) {
            var targetCol = parseInt(item.getAttribute('data-col-mobile') || '1', 10);
            if (targetCol < 1 || targetCol > 2) targetCol = 1;
            var targetTrack = tracks[targetCol - 1];
            if (targetTrack && item.parentNode !== targetTrack) {
                targetTrack.appendChild(item);
            }
        });
    }

    function initHomeGrid() {
        cleanup();

        var container = document.querySelector('[data-home-grid]');
        if (!container) return;

        // Redistribute items for mobile before grid init
        redistributeMobile(container);

        var cols = container.querySelectorAll('[data-grid-col]');
        if (!cols.length) return;

        if (typeof gsap === 'undefined') return;

        currentContainer = container;

        document.body.style.overflow = 'hidden';
        if (window.NomadLabs && window.NomadLabs.lenis) {
            window.NomadLabs.lenis.stop();
        }

        var speeds = [1, 0.8, 1.1, 0.9];
        var colsData = [];
        var vh = window.innerHeight;

        cols.forEach(function (col, i) {
            if (col.offsetParent === null && getComputedStyle(col).display === 'none') return;

            var track = col.querySelector('[data-grid-track]');
            if (!track || !track.children.length) return;

            var direction = col.dataset.direction || 'down';

            var originals = Array.from(track.children);
            var numOriginals = originals.length;

            // Measure original height once (single reflow)
            var originalHeight = track.scrollHeight;
            if (originalHeight <= 0) return;

            // Calculate how many clone sets we need (no DOM reads in loop)
            var targetHeight = vh * 3;
            var setsNeeded = Math.ceil(targetHeight / originalHeight) - 1;
            if (setsNeeded < 1) setsNeeded = 1;

            // Build all clones in a DocumentFragment (zero reflows)
            var fragment = document.createDocumentFragment();
            for (var s = 0; s < setsNeeded; s++) {
                for (var c = 0; c < numOriginals; c++) {
                    var clone = originals[c].cloneNode(true);
                    clone.setAttribute('aria-hidden', 'true');
                    // Strip video src from clones to save memory
                    var clonedVideos = clone.querySelectorAll('video');
                    clonedVideos.forEach(function (v) {
                        v.removeAttribute('src');
                        v.removeAttribute('autoplay');
                        v.setAttribute('preload', 'none');
                    });
                    fragment.appendChild(clone);
                }
            }
            // Single DOM insert (one reflow)
            track.appendChild(fragment);

            // Pre-compute distances (one-time DOM reads after insert)
            var setDistance = track.children[numOriginals].offsetTop
                           - track.children[0].offsetTop;
            var trackHeight = track.scrollHeight;

            // Initial position with translate3d (GPU layer)
            if (direction === 'down') {
                col.style.transform = 'translate3d(0,' + vh + 'px,0)';
            } else {
                col.style.transform = 'translate3d(0,' + (-trackHeight) + 'px,0)';
            }

            col.style.visibility = 'visible';

            colsData.push({
                col: col,
                direction: direction,
                setDistance: setDistance,
                trackHeight: trackHeight,
                speed: speeds[i % speeds.length],
            });

            lastTy.push(NaN); // Force first write
        });

        if (!colsData.length) return;

        // ── Wheel (attached to window for 100% reliable scrolling anywhere on screen) ──
        wheelHandler = function (e) {
            // Do not intercept if single project player is open
            if (document.querySelector('.project-player.is-active')) return;
            e.preventDefault();
            targetY += e.deltaY;
            if (targetY < 0) targetY = 0;
        };
        window.addEventListener('wheel', wheelHandler, { passive: false });

        // ── Touch (attached to window) ──
        var touchY = 0;
        touchStartHandler = function (e) {
            touchY = e.touches[0].clientY;
        };
        touchMoveHandler = function (e) {
            if (document.querySelector('.project-player.is-active')) return;
            e.preventDefault();
            var y = e.touches[0].clientY;
            targetY += (touchY - y) * 1.2;
            if (targetY < 0) targetY = 0;
            touchY = y;
        };
        window.addEventListener('touchstart', touchStartHandler, { passive: true });
        window.addEventListener('touchmove', touchMoveHandler, { passive: false });

        // ── Logo fade on scroll ──
        var logo = container.querySelector('.home-grid__logo');
        var logoLastOpacity = -1;

        // ── Ticker (runs every rAF via GSAP) ──
        var colCount = colsData.length;

        tickerFn = function () {
            // Lerp
            virtualY += (targetY - virtualY) * ease;

            // Skip if barely moving (< 0.5px total delta)
            var delta = targetY - virtualY;
            if (delta > -0.5 && delta < 0.5 && virtualY === targetY) return;

            for (var i = 0; i < colCount; i++) {
                var cd = colsData[i];
                var scroll = virtualY * cd.speed;
                var ty;

                if (cd.direction === 'down') {
                    if (scroll <= vh) {
                        ty = vh - scroll;
                    } else {
                        ty = -((scroll - vh) % cd.setDistance);
                    }
                } else {
                    var H = cd.trackHeight;
                    if (scroll <= vh) {
                        ty = -H + scroll;
                    } else {
                        ty = -(H - vh) + ((scroll - vh) % cd.setDistance);
                    }
                }

                // Round to avoid sub-pixel jitter, skip if unchanged
                ty = (ty + 0.5) | 0; // Fast Math.round
                if (ty === lastTy[i]) continue;
                lastTy[i] = ty;

                cd.col.style.transform = 'translate3d(0,' + ty + 'px,0)';
            }

            // Fade logo: fully visible at 0, gone by vh/2
            if (logo) {
                var fadeStart = 0;
                var fadeEnd = vh * 0.4;
                var opacity = 1 - Math.min(1, Math.max(0, (virtualY - fadeStart) / fadeEnd));
                opacity = (opacity * 100 + 0.5) | 0; // Round to integer %
                if (opacity !== logoLastOpacity) {
                    logoLastOpacity = opacity;
                    logo.style.opacity = opacity / 100;
                }
            }
        };

        gsap.ticker.add(tickerFn);

        document.dispatchEvent(new CustomEvent('homeGridReady'));
    }

    // Register with Swup callback system
    window.masterThemeInitCallbacks = window.masterThemeInitCallbacks || [];
    window.masterThemeInitCallbacks.push(function () {
        initHomeGrid();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initHomeGrid);
    } else {
        initHomeGrid();
    }

    // Re-measure after all images/fonts are painted
    window.addEventListener('load', function () {
        initHomeGrid();
    });

    window.NomadHomeGrid = {
        init: initHomeGrid
    };

})();
