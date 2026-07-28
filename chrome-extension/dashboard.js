(() => {
  const control = document.querySelector('[data-youtube-import-control]');
  if (!control) return;
  const requestEvent = 'infovore-youtube-import-request';
  const statusEvent = 'infovore-youtube-import-status';

  async function emitStatus(extra = {}) {
    const stored = await chrome.storage.local.get('historyImportStatus');
    const status = stored.historyImportStatus ?? {};
    control.dataset.extensionStatus = JSON.stringify({
      extensionReady: true,
      state: status.state ?? 'idle',
      videos: Number(status.videos ?? 0),
      pass: Number(status.pass ?? 0),
      lastError: String(status.lastError ?? ''),
      ...extra,
    });
    window.dispatchEvent(new Event(statusEvent));
  }

  window.addEventListener(requestEvent, () => {
    const action = control.dataset.importAction;
    const type = action === 'cancel'
      ? 'history-import-cancel'
      : 'history-import-start';
    chrome.runtime.sendMessage({ type })
      .then((response) => emitStatus(response?.ok
        ? {}
        : { state: 'error', lastError: response?.error || 'Import request failed' }))
      .catch((error) => emitStatus({
        state: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      }));
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.historyImportStatus) void emitStatus();
  });
  void emitStatus();
})();
