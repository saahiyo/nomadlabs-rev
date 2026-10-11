/**
 * STANDALONE CONTROLLER FOR NOMAD LABS CLONE
 * Connects the real resolved Vimeo streaming MP4s to both the
 * kinetic infinite grid videos and the fullscreen Project Player.
 *
 * Optimizations:
 * - Dynamic Video Memory Pool (max 3 concurrent videos playing to prevent GPU lockup)
 * - Anti-ghost drag prevention (prevents cursor from getting stuck in drag state)
 * - Robust Fullscreen player show/hide with pointer-events handling
 */

(function () {
    'use strict';

    const vimeoMap = window.NOMAD_VIMEO_DATA || {};
    const projects = window.NOMAD_PROJECTS || [];

    // ── Prevent native ghost drag & drop which locks mouse cursor ──
    window.addEventListener('dragstart', (e) => {
        e.preventDefault();
        return false;
    }, { capture: true });

    // ── 1. High Performance Lazy Video Queue ──
    const MAX_CONCURRENT_VIDEOS = 3;
    let activeVideos = [];

    function setupGridVideos() {
        const gridVideos = document.querySelectorAll('.grid-item__video');
        if (!gridVideos.length) return;

        // Ensure poster exists and videos don't preload blindly
        gridVideos.forEach(video => {
            video.preload = 'none';
            video.muted = true;
            video.playsInline = true;
            video.loop = true;
        });

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const video = entry.target;
                const parent = video.closest('.grid-item--video');
                const resolveId = video.getAttribute('data-vimeo-resolve');
                const data = vimeoMap[resolveId];

                if (entry.isIntersecting && data && data.video) {
                    // Check if already playing
                    if (!video.src) {
                        // Enforce max concurrent pool
                        if (activeVideos.length >= MAX_CONCURRENT_VIDEOS) {
                            const oldest = activeVideos.shift();
                            if (oldest && oldest !== video) {
                                oldest.pause();
                                oldest.removeAttribute('src');
                                oldest.load();
                                const oldParent = oldest.closest('.grid-item--video');
                                if (oldParent) oldParent.classList.remove('is-playing');
                            }
                        }

                        video.src = data.video;
                        activeVideos.push(video);
                    }

                    const playPromise = video.play();
                    if (playPromise) {
                        playPromise.then(() => {
                            if (parent) parent.classList.add('is-playing');
                        }).catch(() => {});
                    }
                } else {
                    // Out of view: pause and unload to free GPU decoder
                    if (video.src) {
                        video.pause();
                        video.removeAttribute('src');
                        video.load();
                        activeVideos = activeVideos.filter(v => v !== video);
                    }
                    if (parent) parent.classList.remove('is-playing');
                }
            });
        }, {
            threshold: 0.25,
            rootMargin: '100px 0px'
        });

        gridVideos.forEach(video => observer.observe(video));
    }

    // ── 2. Fullscreen Single Project Player ──
    const playerEl = document.getElementById('project-player');
    const playerVideo = document.getElementById('project-video');
    const playerPoster = document.getElementById('project-poster');
    const btnClose = document.getElementById('project-btn-close');
    const btnPlay = document.getElementById('project-btn-play');
    const btnMute = document.getElementById('project-btn-mute');
    const btnFs = document.getElementById('project-btn-fullscreen');
    const progressBar = document.getElementById('project-progress');
    const progressFill = document.getElementById('project-progress-fill');
    const timeDisplay = document.getElementById('project-time');
    const btnInfo = document.getElementById('project-btn-info');
    const infoOverlay = document.getElementById('project-info-overlay');
    const btnPrev = document.getElementById('player-prev');
    const btnNext = document.getElementById('player-next');
    const srTitle = document.getElementById('player-sr-title');
    const infoTitle = document.getElementById('info-title');

    let currentProjectIndex = 0;

    function formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) return '00:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
    }

    function openProject(index) {
        if (index < 0 || index >= projects.length) return;
        currentProjectIndex = index;
        const proj = projects[index];

        const mainData = vimeoMap[proj.mainVimeoId] || vimeoMap[proj.previewVimeoId] || {};
        const videoUrl = mainData.video || '';
        const posterUrl = proj.posterUrl || mainData.thumbnail || '';

        if (srTitle) srTitle.textContent = proj.title;
        if (infoTitle) infoTitle.textContent = proj.title;

        playerPoster.src = posterUrl;
        playerPoster.style.display = 'block';

        playerVideo.src = videoUrl;
        playerVideo.load();
        playerVideo.play().then(() => {
            playerPoster.style.display = 'none';
        }).catch(() => {});

        playerEl.classList.add('is-active', 'is-loaded');
        updatePlayBtn(true);
    }

    function closeProject() {
        playerVideo.pause();
        playerVideo.removeAttribute('src');
        playerVideo.load();
        playerEl.classList.remove('is-active', 'is-loaded');
        if (infoOverlay) infoOverlay.style.display = 'none';
    }

    function updatePlayBtn(isPlaying) {
        if (!btnPlay) return;
        const lblPlay = btnPlay.querySelector('.label-play');
        const lblPause = btnPlay.querySelector('.label-pause');
        if (isPlaying) {
            if (lblPlay) lblPlay.style.display = 'none';
            if (lblPause) lblPause.style.display = 'inline';
        } else {
            if (lblPlay) lblPlay.style.display = 'inline';
            if (lblPause) lblPause.style.display = 'none';
        }
    }

    if (btnPlay) {
        btnPlay.addEventListener('click', (e) => {
            e.stopPropagation();
            if (playerVideo.paused) {
                playerVideo.play();
                updatePlayBtn(true);
            } else {
                playerVideo.pause();
                updatePlayBtn(false);
            }
        });
    }

    if (btnMute) {
        btnMute.addEventListener('click', (e) => {
            e.stopPropagation();
            playerVideo.muted = !playerVideo.muted;
            const lblUnmuted = btnMute.querySelector('.label-unmuted');
            const lblMuted = btnMute.querySelector('.label-muted');
            if (playerVideo.muted) {
                if (lblUnmuted) lblUnmuted.style.display = 'none';
                if (lblMuted) lblMuted.style.display = 'inline';
            } else {
                if (lblUnmuted) lblUnmuted.style.display = 'inline';
                if (lblMuted) lblMuted.style.display = 'none';
            }
        });
    }

    if (btnFs) {
        btnFs.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!document.fullscreenElement) {
                playerEl.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen().catch(() => {});
            }
        });
    }

    if (playerVideo) {
        playerVideo.addEventListener('timeupdate', () => {
            if (!playerVideo.duration) return;
            const pct = (playerVideo.currentTime / playerVideo.duration) * 100;
            if (progressFill) progressFill.style.width = pct + '%';
            if (timeDisplay) {
                timeDisplay.textContent = formatTime(playerVideo.currentTime) + ' / ' + formatTime(playerVideo.duration);
            }
        });
    }

    if (progressBar) {
        progressBar.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!playerVideo.duration) return;
            const rect = progressBar.getBoundingClientRect();
            const clickPos = (e.clientX - rect.left) / rect.width;
            playerVideo.currentTime = clickPos * playerVideo.duration;
        });
    }

    if (btnInfo && infoOverlay) {
        btnInfo.addEventListener('click', (e) => {
            e.stopPropagation();
            infoOverlay.style.display = infoOverlay.style.display === 'none' ? 'block' : 'none';
        });
    }

    if (btnPrev) {
        btnPrev.addEventListener('click', (e) => {
            e.stopPropagation();
            const nextIdx = (currentProjectIndex - 1 + projects.length) % projects.length;
            openProject(nextIdx);
        });
    }

    if (btnNext) {
        btnNext.addEventListener('click', (e) => {
            e.stopPropagation();
            const nextIdx = (currentProjectIndex + 1) % projects.length;
            openProject(nextIdx);
        });
    }

    if (btnClose) {
        btnClose.addEventListener('click', (e) => {
            e.stopPropagation();
            closeProject();
        });
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && playerEl.classList.contains('is-active')) {
            closeProject();
        }
    });

    // ── 3. Delegate Grid Item Clicks (Safe & Non-blocking) ──
    document.addEventListener('click', (e) => {
        const item = e.target.closest('[data-grid-item]');
        if (item) {
            e.preventDefault();
            const href = item.getAttribute('href') || '';
            const slugMatch = href.match(/\/proyecto\/([^"/]+)\//);
            const slug = slugMatch ? slugMatch[1] : '';
            const idx = projects.findIndex(p => p.slug === slug);
            if (idx !== -1) {
                openProject(idx);
            } else {
                openProject(0);
            }
        }
    });

    // ── 4. Init after Home Grid Clones ──
    document.addEventListener('homeGridReady', setupGridVideos);
    setTimeout(setupGridVideos, 500);

})();
