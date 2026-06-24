const $ = (id) => document.getElementById(id);

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = 'status ' + kind;
}

async function load() {
  const { capMB } = await chrome.storage.sync.get({ capMB: 10 });
  $('cap').value = capMB;
}

$('cap').addEventListener('change', () => {
  const capMB = Math.max(1, Number($('cap').value) || 10);
  $('cap').value = capMB;
  chrome.storage.sync.set({ capMB });
});

$('go').addEventListener('click', async () => {
  const link = $('link').value.trim();
  const capMB = Math.max(1, Number($('cap').value) || 10);
  if (!link) { setStatus('Paste a tweet or video link first.', 'err'); return; }

  setStatus('Working… fetching, sizing, and remuxing.', 'busy');
  $('go').disabled = true;
  try {
    const job = /\.m3u8(\?|$)/i.test(link) ? { masterUrl: link } : { tweetUrl: link };
    const res = await chrome.runtime.sendMessage({ type: 'tvd-download', ...job, capMB });
    if (!res?.ok) throw new Error(res?.error || 'download failed');
    setStatus(`Saved ${res.filename} — ${res.resolution}, ${(res.bytes / 1048576).toFixed(1)} MB`, 'ok');
  } catch (e) {
    setStatus('Failed: ' + (e?.message || e), 'err');
  } finally {
    $('go').disabled = false;
  }
});

load();
