/**
 * About Page - Nomad Labs
 *
 * Stagger reveal animation for sections.
 * Same ease as list filters and nav menu.
 *
 * @package NomadLabs
 */

(function () {
    'use strict';

    function initAbout() {
        var sections = document.querySelectorAll('.about-section');
        if (!sections.length) return;

        // Trigger reveal with small delay to let CSS transitions kick in
        requestAnimationFrame(function () {
            sections.forEach(function (section) {
                section.classList.add('is-visible');
            });
        });
    }

    // Register with Swup callback system
    window.masterThemeInitCallbacks = window.masterThemeInitCallbacks || [];
    window.masterThemeInitCallbacks.push(function () {
        initAbout();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAbout);
    } else {
        initAbout();
    }

})();
