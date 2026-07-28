async function render() {
  const stored = await chrome.storage.local.get([
    'captureSettings',
    'captureQueue',
    'captureStatus',
    'historyImportStatus',
  ]);
  const settings = stored.captureSettings ?? {};
  const status = stored.captureStatus ?? {};
  const history = stored.historyImportStatus ?? {};
  const configured = Boolean(settings.token);
  document.querySelector('#state').textContent = !settings.enabled
    ? 'Capture paused'
    : configured ? 'Capture active' : 'Setup required';
  document.querySelector('#pending').textContent = String(
    status.pending ?? stored.captureQueue?.length ?? 0
  );
  document.querySelector('#last-sync').textContent = status.lastSuccessAt
    ? new Date(status.lastSuccessAt).toLocaleString()
    : 'Never';
  document.querySelector('#error').textContent = status.lastError ?? '';
  const historyButton = document.querySelector('#history');
  const running = history.state === 'running';
  historyButton.textContent = running ? 'Cancel import' : 'Import history';
  historyButton.classList.toggle('danger', running);
  document.querySelector('#history-state').textContent = running
    ? `${history.videos ?? 0} videos`
    : history.state === 'complete'
      ? `${history.videos ?? 0} imported`
      : history.state === 'error'
        ? 'Import failed'
        : 'Not imported';
  if (history.lastError) document.querySelector('#error').textContent = history.lastError;
}

document.querySelector('#sync').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'flush' });
  await render();
});
document.querySelector('#history').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get('historyImportStatus');
  const running = stored.historyImportStatus?.state === 'running';
  await chrome.runtime.sendMessage({
    type: running ? 'history-import-cancel' : 'history-import-start',
  });
  await render();
});
document.querySelector('#options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

void render();
window.setInterval(render, 1000);
