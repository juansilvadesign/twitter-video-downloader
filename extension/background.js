// Service worker (classic). Thin router: receives a download job from the content button or the
// popup, ensures the offscreen document exists AND its listener is live (readiness handshake),
// forwards the job, then saves the returned blob via chrome.downloads. All heavy lifting (fetch +
// remux) happens in the offscreen document.

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  const contexts = (await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] })) || [];
  return contexts.length > 0;
}

let creating = null; // de-dupe concurrent createDocument calls
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Remux HLS video+audio fMP4 into one MP4 and create a downloadable blob.',
    }).catch((e) => {
      // A concurrent create may have won the race; tolerate "single offscreen document" errors.
      if (!/single offscreen|already/i.test(String(e?.message))) throw e;
    }).finally(() => { creating = null; });
  }
  await creating;
}

// The offscreen module registers its listener asynchronously after the document loads, so the SW
// must not send the job until a ping round-trips — otherwise the first message is silently dropped.
async function waitForOffscreenReady(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'tvd-ping' });
      if (r?.ready) return;
    } catch (_) { /* no receiver yet — keep polling */ }
    await new Promise((res) => setTimeout(res, 120));
  }
  throw new Error('offscreen document did not become ready (open its console via chrome://extensions → Inspect views)');
}

async function getCapMB() {
  const { capMB } = await chrome.storage.sync.get({ capMB: 10 });
  return capMB;
}

async function handleDownload(job) {
  await ensureOffscreen();
  await waitForOffscreenReady();
  const capMB = job.capMB ?? (await getCapMB());

  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'tvd-run', ...job, capMB });
  if (res === undefined) {
    throw new Error('no response from offscreen (it may have failed to load — check the offscreen console)');
  }
  if (!res.ok) throw new Error(res.error || 'remux failed');

  const filename = res.filename.replace(/[\/\\:*?"<>|]/g, '_');
  try {
    await chrome.downloads.download({ url: res.blobUrl, filename, saveAs: false });
  } catch (e) {
    throw new Error(`chrome.downloads failed on the blob URL: ${e?.message || e}`);
  }
  return { ok: true, filename, resolution: res.resolution, bytes: res.bytes };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'tvd-download') {
    handleDownload(msg)
      .then(sendResponse)
      .catch((e) => { console.error('[TVD] download failed:', e); sendResponse({ ok: false, error: String(e?.message || e) }); });
    return true; // async response
  }
});
