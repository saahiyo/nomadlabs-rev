/**
 * List View - Nomad Labs
 *
 * Stagger reveal, row hover, filter dropdowns,
 * Year column sort (ASC/DESC), category filter.
 *
 * @package NomadLabs
 */

(function () {
    'use strict';

    var activeFilters = {
        service: 'all',
        category: 'all',
    };

    var sortDirection = 'desc'; // default: newest first

    function initListView() {
        var container = document.querySelector('[data-list-view]');
        if (!container) return;

        var items = container.querySelectorAll('[data-list-item]');
        if (!items.length) return;

        initReveal(container, items);
        initFilters(container, items);
        initYearSort(container, items);
    }

    /**
     * Reveal en cascada continua, robusto a scroll rápido.
     *
     * La cascada emerge de dos factores:
     *  1) `rootMargin: 0 0 400px 0` → cada item se activa cuando aún está 400px
     *     POR DEBAJO del viewport. A velocidad normal de scroll (800-1200 px/s)
     *     eso da ~300-500ms de margen para que la animación CSS termine antes
     *     de que el item entre físicamente en viewport. Sin esta zona de
     *     "pre-entrada", scroll rápido = items apareciendo pop-in sin animar.
     *
     *  2) Mini-stagger capado (máx 120ms) cuando varios items entran en la
     *     misma tanda (scroll muy rápido o carga inicial). Evita que 50 items
     *     tengan que esperar 50·0.02=1s — como pasaba antes — y a la vez
     *     preserva la sensación de cascada en vez de "todos a la vez".
     */
    function initReveal(container, items) {
        var pending = [];
        var flushQueued = false;
        var firstFlush = true;

        // Timings:
        //  - Primer flush (apertura de página): stagger amplio, cap alto → cascada
        //    bonita sobre los ~15-20 items ya visibles.
        //  - Flushes sucesivos (durante scroll): stagger corto, cap ajustado →
        //    evita que 50 items acumulados en un scroll brusco tengan delays de 1s+.
        var INITIAL_STAGGER = 0.04;
        var INITIAL_MAX     = 0.8;
        var SCROLL_STAGGER  = 0.025;
        var SCROLL_MAX      = 0.15;

        function flush() {
            flushQueued = false;
            // Ordenar por posición en DOM → la cascada baja visualmente
            pending.sort(function (a, b) {
                return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
            });
            var n = pending.length;
            var staggerBase = firstFlush ? INITIAL_STAGGER : SCROLL_STAGGER;
            var maxTotal    = firstFlush ? INITIAL_MAX : SCROLL_MAX;
            var step = Math.min(staggerBase, maxTotal / Math.max(1, n - 1));

            pending.forEach(function (item, i) {
                item.style.transitionDelay = (i * step).toFixed(3) + 's';
                item.classList.add('is-visible');
            });

            var toClear = pending.splice(0);
            // Limpia transition-delay tras animar — para que hover/filter no
            // hereden el delay del reveal.
            setTimeout(function () {
                toClear.forEach(function (item) { item.style.transitionDelay = ''; });
            }, Math.ceil((n * step + 0.45) * 1000));

            firstFlush = false;
        }

        var observer = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
                if (!entries[i].isIntersecting) continue;
                pending.push(entries[i].target);
                observer.unobserve(entries[i].target);
            }
            if (pending.length && !flushQueued) {
                flushQueued = true;
                requestAnimationFrame(flush);
            }
        }, {
            threshold: 0,
            rootMargin: '0px 0px 400px 0px' // pre-trigger 400px por debajo del viewport
        });

        items.forEach(function (item) { observer.observe(item); });
    }

    /**
     * Filter dropdowns
     */
    function initFilters(container, items) {
        var filterGroups = container.querySelectorAll('[data-filter-group]');

        filterGroups.forEach(function (group) {
            var trigger = group.querySelector('[data-filter-trigger]');

            trigger.addEventListener('click', function (e) {
                e.stopPropagation();
                var wasOpen = group.classList.contains('is-open');

                // Close all
                filterGroups.forEach(function (g) { g.classList.remove('is-open'); });

                // Toggle clicked
                if (!wasOpen) group.classList.add('is-open');
            });

            // Option click
            var options = group.querySelectorAll('[data-filter-value]');
            options.forEach(function (opt) {
                opt.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var filterType = group.dataset.filterGroup;
                    var value = opt.dataset.filterValue;

                    activeFilters[filterType] = value;

                    // Update active state
                    options.forEach(function (o) { o.classList.remove('is-active'); });
                    opt.classList.add('is-active');

                    // Update trigger label
                    var triggerSpan = trigger.querySelector('span');
                    if (value === 'all') {
                        var labels = { category: 'Project', service: 'Services' };
                        triggerSpan.textContent = labels[filterType] || filterType;
                    } else {
                        triggerSpan.textContent = opt.textContent;
                    }

                    // Close dropdown
                    group.classList.remove('is-open');

                    // Apply filters
                    applyFilters(items);
                });
            });
        });

        // Close on click outside
        document.addEventListener('click', function () {
            filterGroups.forEach(function (g) { g.classList.remove('is-open'); });
        });
    }

    /**
     * Year column sort
     */
    function initYearSort(container, items) {
        var sortBtn = container.querySelector('[data-sort-trigger]');
        if (!sortBtn) return;

        var listBody = container.querySelector('[data-list-body]');
        if (!listBody) return;

        sortBtn.addEventListener('click', function () {
            // Toggle direction
            sortDirection = (sortDirection === 'desc') ? 'asc' : 'desc';

            // Update icon
            if (sortDirection === 'asc') {
                sortBtn.classList.add('is-asc');
            } else {
                sortBtn.classList.remove('is-asc');
            }

            // Sort items in the DOM
            var itemsArray = Array.from(listBody.querySelectorAll('[data-list-item]'));
            itemsArray.sort(function (a, b) {
                var yearA = parseInt(a.dataset.year, 10) || 0;
                var yearB = parseInt(b.dataset.year, 10) || 0;
                return sortDirection === 'asc' ? yearA - yearB : yearB - yearA;
            });

            // Re-append in new order
            itemsArray.forEach(function (item) {
                listBody.appendChild(item);
            });
        });
    }

    /**
     * Apply active filters to items
     */
    function applyFilters(items) {
        items.forEach(function (item) {
            var show = true;

            // Service filter
            if (activeFilters.service !== 'all') {
                var services = (item.dataset.service || '').split(' ');
                if (services.indexOf(activeFilters.service) === -1) show = false;
            }

            // Category filter
            if (activeFilters.category !== 'all') {
                var categories = (item.dataset.category || '').split(' ');
                if (categories.indexOf(activeFilters.category) === -1) show = false;
            }

            if (show) {
                item.classList.remove('is-hidden');
                item.classList.add('is-visible');
            } else {
                item.classList.add('is-hidden');
                item.classList.remove('is-visible');
            }
        });
    }

    // Register with callback system (Swup re-init)
    window.masterThemeInitCallbacks = window.masterThemeInitCallbacks || [];
    window.masterThemeInitCallbacks.push(function () {
        activeFilters.service = 'all';
        activeFilters.category = 'all';
        sortDirection = 'desc';
        initListView();
    });

    if (document.readyState !== 'loading') {
        initListView();
    }

    window.NomadListView = {
        init: initListView
    };

})();
