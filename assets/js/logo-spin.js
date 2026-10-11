/**
 * Logo Spin - Nomad Labs
 *
 * Rota la tuerca del logo (#nl-asterisk dentro del SVG inline) para
 * "apuntar" al cursor del ratón. Aguja de brújula con lerp suave.
 *
 * Comportamiento:
 *  - Mousemove → calcula ángulo desde el centro de la tuerca al cursor
 *  - RAF tick interpola `displayed` hacia `target` con factor .08
 *  - Se recalcula el centro en scroll/resize (la tuerca no se mueve en
 *    layout pero el scroll sí cambia su posición absoluta en pantalla)
 *  - En touch devices hace una rotación lenta autónoma (si no hay cursor)
 *  - Respeta prefers-reduced-motion: no rota
 *  - Self-cleanup en Swup navigation (RAF off + listeners removed)
 *
 * @package NomadLabs
 */

(function () {
    'use strict';

    // Respeta la preferencia del user
    var reducedMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return;

    var asterisk = null;
    var rafId = null;
    var target = 0;
    var displayed = 0;
    var cx = 0, cy = 0;   // centro de la tuerca en coords viewport
    var needsMeasure = true;
    var mouseHandler = null;
    var scrollHandler = null;
    var resizeHandler = null;
    // Fallback autónomo para touch devices (no hay cursor)
    var isTouchDevice = ('ontouchstart' in window) && !window.matchMedia('(pointer: fine)').matches;
    var autoAngle = 0;

    function measureCenter() {
        if (!asterisk) return;
        var svg = asterisk.closest('svg');
        if (svg) {
            var rect = svg.getBoundingClientRect();
            // SVG viewBox is 0 0 891.65 210.35. Natural center of asterisk is at (501.8, 105.17)
            cx = rect.left + rect.width * (501.8 / 891.65);
            cy = rect.top + rect.height * (105.17 / 210.35);
        } else {
            var rect = asterisk.getBoundingClientRect();
            cx = rect.left + rect.width / 2;
            cy = rect.top + rect.height / 2;
        }
        needsMeasure = false;
    }

    function onMouseMove(e) {
        if (needsMeasure) measureCenter();
        var dx = e.clientX - cx;
        var dy = e.clientY - cy;
        // atan2 devuelve en radianes; convertimos a grados.
        // +90° para que el "cero" natural de la tuerca quede hacia arriba
        // (ajusta si quieres otro offset inicial).
        target = Math.atan2(dy, dx) * (180 / Math.PI);
    }

    function tick() {
        if (!asterisk) { rafId = null; return; }

        var next = target;
        if (isTouchDevice) {
            // Sin cursor: rotación lenta continua (1 vuelta cada 60s)
            autoAngle = (autoAngle + 0.1) % 360;
            next = autoAngle;
        }

        var diff = next - displayed;
        // Tomar el camino más corto (ej: -179 → 179 = 2°, no 358°)
        while (diff > 180)  diff -= 360;
        while (diff < -180) diff += 360;
        displayed += diff * 0.08;

        asterisk.style.transform = 'rotate(' + displayed.toFixed(2) + 'deg)';
        rafId = requestAnimationFrame(tick);
    }

    function init() {
        cleanup();

        asterisk = document.getElementById('nl-asterisk');
        if (!asterisk) return;

        needsMeasure = true;

        mouseHandler = onMouseMove;
        scrollHandler = function () { needsMeasure = true; };
        resizeHandler = function () { needsMeasure = true; };

        if (!isTouchDevice) {
            document.addEventListener('mousemove', mouseHandler, { passive: true });
        }
        window.addEventListener('scroll', scrollHandler, { passive: true });
        window.addEventListener('resize', resizeHandler);

        if (!rafId) rafId = requestAnimationFrame(tick);
    }

    function cleanup() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (mouseHandler) { document.removeEventListener('mousemove', mouseHandler); mouseHandler = null; }
        if (scrollHandler) { window.removeEventListener('scroll', scrollHandler); scrollHandler = null; }
        if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
        asterisk = null;
        displayed = 0;
        target = 0;
    }

    // Registro con el callback system del tema (Swup re-init safe).
    // Se ejecuta tras DOMContentLoaded y tras cada Swup content:replace.
    window.masterThemeInitCallbacks = window.masterThemeInitCallbacks || [];
    window.masterThemeInitCallbacks.push(function () {
        init();
    });

    // Primera carga directa (sin depender del callback system)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.NomadLogoSpin = { init: init, cleanup: cleanup };
})();
