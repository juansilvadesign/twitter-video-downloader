// Service worker (classic). Thin router: receives a download job from the content button or the
// popup, ensures the offscreen document is alive + ready, sends the job, and awaits the result via
// a DECOUPLED tvd-result message (the offscreen's async sendResponse channel proved unreliable —
// it resolved to undefined). Offscreen progress is relayed here via tvd-log for easy inspection.

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  const contexts = (await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] })) || [];
  return contexts.length > 0;
}

let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Remux HLS video+audio fMP4 into one MP4 and create a downloadable blob.',
    }).catch((e) => {
      if (!/single offscreen|already/i.test(String(e?.message))) throw e;
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function waitForOffscreenReady(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'tvd-ping' });
      if (r?.ready) return;
    } catch (_) { /* no receiver yet */ }
    await new Promise((res) => setTimeout(res, 120));
  }
  throw new Error('offscreen document did not become ready');
}

async function getCapMB() {
  const { capMB } = await chrome.storage.sync.get({ capMB: 10 });
  return capMB;
}

// jobId -> { resolve } for decoupled results coming back as tvd-result messages.
const pending = new Map();

function awaitResult(jobId, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    pending.set(jobId, { resolve });
    setTimeout(() => {
      if (pending.has(jobId)) { pending.delete(jobId); reject(new Error('offscreen timed out (no result in 90s)')); }
    }, timeoutMs);
  });
}

async function handleDownload(job) {
  await ensureOffscreen();
  await waitForOffscreenReady();
  const capMB = job.capMB ?? (await getCapMB());
  const jobId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());

  const resultPromise = awaitResult(jobId);
  // Forward ONLY the fields the offscreen needs. Do NOT spread `job` — it carries
  // `type: 'tvd-download'`, which would clobber `type: 'tvd-run'` and the offscreen would ignore it.
  const ack = await chrome.runtime.sendMessage({
    target: 'offscreen', type: 'tvd-run', jobId,
    statusId: job.statusId, tweetUrl: job.tweetUrl, masterUrl: job.masterUrl, capMB,
  });
  if (!ack?.accepted) console.warn('[TVD] offscreen did not ack the job (ack:', ack, ')');

  const res = await resultPromise; // delivered via tvd-result
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
  if (msg?.type === 'tvd-log') { console.log('[TVD][offscreen]', msg.text); return; }
  if (msg?.type === 'tvd-result') {
    const p = pending.get(msg.jobId);
    if (p) { pending.delete(msg.jobId); p.resolve(msg); }
    return;
  }
  if (msg?.type === 'tvd-download') {
    handleDownload(msg)
      .then(sendResponse)
      .catch((e) => { console.error('[TVD] download failed:', e); sendResponse({ ok: false, error: String(e?.message || e) }); });
    return true; // async response
  }
});
