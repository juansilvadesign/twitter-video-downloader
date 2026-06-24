// Content script: inject a download button into each video tweet's action bar (right of Share).
//
// Uses EVENT DELEGATION — a single capture-phase click listener on `document` — instead of
// per-button listeners. On X (a recycling React SPA) a per-button listener dies whenever React
// re-renders/replaces the action bar subtree, and X's own click handling can swallow the event.
// A delegated capture-phase listener survives re-renders and fires before X's handlers.
//
// NOTE: the DOM selectors here are heuristic and are the part most likely to drift when X changes
// its markup. Kept together for easy updating.

console.log('[TVD] content script loaded on', location.href);

const DL_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 15.5l-4.5-4.5 1.41-1.41L11 11.67V4h2v7.67l2.09-2.08L16.5 11zM5 18h14v2H5z"/></svg>';

function statusIdFromArticle(article) {
  for (const a of article.querySelectorAll('a[href*="/status/"]')) {
    const m = a.getAttribute('href')?.match(/\/status\/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

function hasVideo(article) {
  return !!article.querySelector(
    'video, [data-testid="videoComponent"], [data-testid="videoPlayer"], [data-testid="previewInterstitial"]',
  );
}

function toast(text, kind = '') {
  let el = document.getElementById('tvd-toast');
  if (!el) { el = document.createElement('div'); el.id = 'tvd-toast'; document.body.appendChild(el); }
  el.textContent = text;
  el.className = 'tvd-toast' + (kind ? ' tvd-toast-' + kind : '') + ' tvd-show';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('tvd-show'), 4500);
}

async function runDownload(btn) {
  if (btn.dataset.busy) return;
  const statusId = btn.dataset.tvdStatus;
  console.log('[TVD] button clicked — status', statusId);
  btn.dataset.busy = '1';
  btn.classList.add('tvd-loading');
  toast('Downloading video…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'tvd-download', statusId });
    console.log('[TVD] background response:', res);
    if (!res?.ok) throw new Error(res?.error || 'no response from background (is the service worker alive?)');
    btn.classList.add('tvd-done');
    toast(`Saved ${res.resolution} · ${(res.bytes / 1048576).toFixed(1)} MB`, 'ok');
    setTimeout(() => btn.classList.remove('tvd-done'), 2500);
  } catch (e) {
    console.error('[TVD] download error:', e);
    btn.classList.add('tvd-error');
    toast('Download failed: ' + (e?.message || e), 'err');
    setTimeout(() => btn.classList.remove('tvd-error'), 4500);
  } finally {
    btn.dataset.busy = '';
    btn.classList.remove('tvd-loading');
  }
}

// One delegated, capture-phase handler — robust to React re-renders and to X's own click handlers.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.tvd-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  runDownload(btn);
}, true);

function inject(actionBar) {
  if (actionBar.querySelector('.tvd-btn')) return; // self-healing: re-inject if React stripped ours
  const article = actionBar.closest('article');
  if (!article || !hasVideo(article)) return;
  const statusId = statusIdFromArticle(article);
  if (!statusId) return;

  const wrap = document.createElement('div');
  wrap.className = 'tvd-btn-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tvd-btn';
  btn.dataset.tvdStatus = statusId; // delegated handler reads the ID from here
  btn.title = 'Download video (size-capped)';
  btn.setAttribute('aria-label', 'Download video (size-capped)');
  btn.innerHTML = DL_SVG;
  wrap.appendChild(btn);
  actionBar.appendChild(wrap);
}

function scan(root = document) {
  let n = 0;
  for (const bar of root.querySelectorAll('article [role="group"]')) {
    if (bar.querySelectorAll('button, a').length >= 2) { inject(bar); n++; }
  }
  return n;
}

const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
new MutationObserver(debounce(scan, 300)).observe(document.documentElement, { childList: true, subtree: true });
scan();
console.log('[TVD] content script initialized (delegated click + observer active)');
