(() => {
  const MIN_CAPTURE_SECONDS = 5;
  const FLUSH_INTERVAL_SECONDS = 30;
  const SESSION_PREFIX = 'infovoreYoutubeCapture:';
  let state = null;
  let boundVideo = null;
  let lastTickAt = performance.now();
  let lastMediaTime = 0;

  function videoIdFromLocation() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const match = url.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})/);
    return match?.[1] ?? null;
  }

  function currentTitle() {
    const heading = document.querySelector(
      'ytd-watch-metadata h1 yt-formatted-string, ytd-watch-flexy h1 yt-formatted-string'
    );
    const title = heading?.textContent?.trim()
      || document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
    return title || 'YouTube video';
  }

  function currentChannel() {
    const channel = document.querySelector(
      'ytd-watch-metadata ytd-channel-name a, #owner #channel-name a, '
      + 'ytd-reel-player-header-renderer #channel-name'
    );
    return channel?.textContent?.trim() || null;
  }

  function storageKey(videoId) {
    return `${SESSION_PREFIX}${videoId}`;
  }

  function persistSession() {
    if (!state) return;
    sessionStorage.setItem(storageKey(state.videoId), JSON.stringify({
      ...state,
      updatedAt: new Date().toISOString(),
    }));
  }

  function restoredSession(videoId) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey(videoId)) ?? 'null');
      const age = Date.now() - Date.parse(saved?.updatedAt ?? '');
      if (
        saved?.videoId === videoId
        && typeof saved.sessionId === 'string'
        && age >= 0
        && age < 30 * 60_000
      ) {
        return {
          ...saved,
          actualSeconds: Number(saved.actualSeconds ?? 0),
          lastSentSeconds: Number(saved.lastSentSeconds ?? 0),
        };
      }
    } catch {
      // A corrupt per-tab cache should create a fresh session.
    }
    return null;
  }

  function ensureSession(video) {
    const videoId = videoIdFromLocation();
    if (!videoId) return null;
    if (state?.videoId === videoId) return state;
    flush(true);
    state = restoredSession(videoId) ?? {
      sessionId: crypto.randomUUID(),
      videoId,
      watchedAt: new Date().toISOString(),
      actualSeconds: 0,
      lastSentSeconds: 0,
    };
    lastTickAt = performance.now();
    lastMediaTime = video.currentTime;
    persistSession();
    return state;
  }

  function capturePayload(video) {
    if (!state) return null;
    const seconds = Math.floor(state.actualSeconds);
    if (seconds < MIN_CAPTURE_SECONDS) return null;
    return {
      sessionId: state.sessionId,
      videoId: state.videoId,
      title: currentTitle().slice(0, 500),
      url: `https://www.youtube.com/watch?v=${state.videoId}`,
      channelTitle: currentChannel(),
      watchedAt: state.watchedAt,
      actualWatchedSeconds: Math.min(86_400, seconds),
      durationSeconds: Number.isFinite(video?.duration)
        ? Math.max(1, Math.min(172_800, Math.round(video.duration)))
        : null,
    };
  }

  function flush(force = false) {
    if (!state || !boundVideo) return;
    const seconds = Math.floor(state.actualSeconds);
    if (!force && seconds - state.lastSentSeconds < FLUSH_INTERVAL_SECONDS) return;
    const payload = capturePayload(boundVideo);
    if (!payload || seconds <= state.lastSentSeconds) return;
    state.lastSentSeconds = seconds;
    persistSession();
    chrome.runtime.sendMessage({ type: 'capture', payload }).catch(() => {
      // The next periodic flush sends the latest cumulative value again.
      state.lastSentSeconds = Math.max(0, state.lastSentSeconds - FLUSH_INTERVAL_SECONDS);
      persistSession();
    });
  }

  function playingTick() {
    const now = performance.now();
    const elapsed = Math.max(0, (now - lastTickAt) / 1000);
    lastTickAt = now;
    if (
      !boundVideo
      || boundVideo.paused
      || boundVideo.ended
      || document.querySelector('.ad-showing')
    ) {
      lastMediaTime = boundVideo?.currentTime ?? 0;
      return;
    }
    ensureSession(boundVideo);
    if (!state) return;
    const mediaDelta = boundVideo.currentTime - lastMediaTime;
    lastMediaTime = boundVideo.currentTime;
    if (mediaDelta > 0) {
      const playbackRate = Math.max(0.1, boundVideo.playbackRate || 1);
      state.actualSeconds += Math.min(elapsed, mediaDelta / playbackRate);
    }
    if (Math.floor(state.actualSeconds) % 5 === 0) persistSession();
    flush(false);
  }

  function bindVideo() {
    const video = document.querySelector('video');
    if (!video || video === boundVideo) return;
    if (boundVideo) flush(true);
    boundVideo = video;
    lastTickAt = performance.now();
    lastMediaTime = video.currentTime;
    video.addEventListener('play', () => {
      ensureSession(video);
      lastTickAt = performance.now();
      lastMediaTime = video.currentTime;
    });
    video.addEventListener('pause', () => flush(true));
    video.addEventListener('ended', () => flush(true));
    if (!video.paused) ensureSession(video);
  }

  function handleNavigation() {
    const videoId = videoIdFromLocation();
    if (state && state.videoId !== videoId) {
      flush(true);
      state = null;
    }
    bindVideo();
  }

  document.addEventListener('yt-navigate-finish', handleNavigation);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
    lastTickAt = performance.now();
    lastMediaTime = boundVideo?.currentTime ?? 0;
  });
  window.addEventListener('pagehide', () => flush(true));
  new MutationObserver(bindVideo).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  setInterval(playingTick, 1000);
  bindVideo();
})();
