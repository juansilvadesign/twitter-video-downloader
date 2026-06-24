// Service worker (classic). Thin router: receives a download job from the content button or the
// popup, ensures the offscreen document exists, forwards the job, then saves the returned blob via
// chrome.downloads. All heavy lifting (fetch + remux) happens in the offscreen document.

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
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function getCapMB() {
  const { capMB } = await chrome.storage.sync.get({ capMB: 10 });
  return capMB;
}

async function handleDownload(job) {
  await ensureOffscreen();
  const capMB = job.capMB ?? (await getCapMB());
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'tvd-run', ...job, capMB });
  if (!res?.ok) throw new Error(res?.error || 'remux failed');

  const filename = res.filename.replace(/[\/\\:*?"<>|]/g, '_');
  await chrome.downloads.download({ url: res.blobUrl, filename, saveAs: false });
  return { ok: true, filename, resolution: res.resolution, bytes: res.bytes };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'tvd-download') {
    handleDownload(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // async response
  }
});
