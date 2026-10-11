/**
 * Frontend - Nomad Labs
 *
 * Main JS: menu toggle, smooth scroll, gallery reveal.
 * Zero jQuery dependency — all vanilla JS.
 *
 * @package NomadLabs
 */

(function () {
    'use strict';

    var NomadLabs = {

        lenis: null,
        menuInitialized: false,

        init: function () {
            this.initLenis();
            this.menuToggle();
            this.galleryReveal();
        },

        reinit: function () {
            this.galleryReveal();
        },

        /**
         * Lenis smooth scroll
         */
        initLenis: function () {
            // The home grid page uses its own virtual ticker; do not attach Lenis there!
            if (document.querySelector('[data-home-grid]')) return;
            if (this.lenis || typeof Lenis === 'undefined') return;

            this.lenis = new Lenis({
                duration: 1.2,
                easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
                touchMultiplier: 2,
            });

            document.documentElement.classList.add('lenis');

            var self = this;

            // Integrate with GSAP if available (single rAF loop)
            if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
                this.lenis.on('scroll', ScrollTrigger.update);
                gsap.ticker.add(function (time) {
                    self.lenis.raf(time * 1000);
                });
                gsap.ticker.lagSmoothing(0);
            } else {
                // Fallback rAF loop
                function raf(time) {
                    self.lenis.raf(time);
                    requestAnimationFrame(raf);
                }
                requestAnimationFrame(raf);
            }
        },

        /**
         * Menu toggle (vanilla JS, no jQuery)
         */
        menuToggle: function () {
            if (this.menuInitialized) return;

            var toggle = document.getElementById('menu-toggle');
            var navHeader = document.getElementById('nav-header');
            var navDropdown = document.getElementById('nav-dropdown');
            if (!toggle || !navHeader) return;

            // Open: set the target height and let the CSS transition animate height +
            // padding together (same easing/delay as before) so the panel fits exactly up
            // to the last item — no empty space, no clipping, and fully fluid.
            //
            // We measure the items directly (sum of children) and add the final padding,
            // instead of reading offsetHeight: the active padding has a transition-delay,
            // so reading the box mid-animation undercounts it by ~24px and clips the last
            // item. The 24 below = padding-top(12) + padding-bottom(12) from header.css.
            var DROPDOWN_PADDING = 24;
            function openMenu() {
                navHeader.classList.add('is-active');
                if (!navDropdown) return;
                var inner = 0;
                var kids = navDropdown.children;
                for (var i = 0; i < kids.length; i++) {
                    inner += kids[i].offsetHeight;
                }
                navDropdown.style.height = (inner + DROPDOWN_PADDING) + 'px';
            }

            function closeMenu() {
                navHeader.classList.remove('is-active');
                if (navDropdown) {
                    navDropdown.style.height = '';
                }
            }

            toggle.addEventListener('click', function (e) {
                e.stopPropagation();
                if (navHeader.classList.contains('is-active')) {
                    closeMenu();
                } else {
                    openMenu();
                }
            });

            // Close on link click
            navHeader.addEventListener('click', function (e) {
                if (e.target.closest('.menu-link')) {
                    closeMenu();
                }
            });

            // Close on Escape
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && navHeader.classList.contains('is-active')) {
                    closeMenu();
                }
            });

            // Close on click outside
            document.addEventListener('click', function (e) {
                if (navHeader.classList.contains('is-active') && !e.target.closest('#nav-header')) {
                    closeMenu();
                }
            });

            this.menuInitialized = true;
        },

        /**
         * Gallery items scroll reveal
         */
        galleryReveal: function () {
            var items = document.querySelectorAll('.project-gallery__item');
            if (!items.length) return;

            if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
                gsap.registerPlugin(ScrollTrigger);

                items.forEach(function (item) {
                    gsap.fromTo(item,
                        { opacity: 0, y: 40 },
                        {
                            opacity: 1,
                            y: 0,
                            duration: 0.8,
                            ease: 'power3.out',
                            scrollTrigger: {
                                trigger: item,
                                start: 'top 85%',
                                once: true,
                            },
                            onComplete: function () {
                                item.classList.add('is-visible');
                            }
                        }
                    );
                });
            } else {
                var observer = new IntersectionObserver(function (entries) {
                    entries.forEach(function (entry) {
                        if (entry.isIntersecting) {
                            entry.target.classList.add('is-visible');
                            observer.unobserve(entry.target);
                        }
                    });
                }, { threshold: 0.1 });

                items.forEach(function (item) {
                    observer.observe(item);
                });
            }
        }
    };

    // Init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            NomadLabs.init();
        });
    } else {
        NomadLabs.init();
    }

    // Register with Swup callback system
    window.masterThemeInitCallbacks = window.masterThemeInitCallbacks || [];
    window.masterThemeInitCallbacks.push(function () {
        NomadLabs.reinit();
    });

    window.NomadLabs = NomadLabs;

})();
