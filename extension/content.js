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

// Download glyph from assets/icons/download.svg. Fills are currentColor (not the asset's hardcoded
// #6D6D6D) so the existing CSS hover (grey -> brand blue) still applies — only the shape changed.
//
// Two glyph sizes: the focused/main tweet on a /status/ page renders LARGER native action icons than
// timeline tweets and replies, so the button matches each context. Tweak these two numbers to taste.
const GLYPH_MAIN = 23;     // focused post — the tweet whose id is in the URL
const GLYPH_COMPACT = 18;  // replies + timeline

const DL_PATHS =
  '<path fill="currentColor" d="M11.2419 15.1531L5.83239 9.86407L7.17053 8.54645L10.2929 11.6085V2.70996H12.1909V11.6085L15.3227 8.54645L16.6609 9.86407L11.2419 15.1531Z"/>' +
  '<path fill="currentColor" d="M19.7926 14.2249L19.7736 17.4818C19.7736 18.7623 18.7107 19.7923 17.401 19.7923H5.08255C3.76339 19.7923 2.70996 18.753 2.70996 17.4725V14.2249H4.60803V17.4725C4.60803 17.7323 4.81682 17.9365 5.08255 17.9365H17.401C17.6668 17.9365 17.8756 17.7323 17.8756 17.4725L17.8945 14.2249H19.7926Z"/>';

const dlSvg = (size) =>
  `<svg viewBox="0 0 23 23" width="${size}" height="${size}" fill="none" aria-hidden="true">${DL_PATHS}</svg>`;

// Status ID of the focused tweet on a /status/<id> detail page (the "main" post) — null elsewhere.
const focusedStatusId = () => location.pathname.match(/\/status\/(\d+)/)?.[1] || null;

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
  const isMain = statusId === focusedStatusId(); // the focused post vs a reply/timeline tweet

  const wrap = document.createElement('div');
  wrap.className = 'tvd-btn-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = isMain ? 'tvd-btn tvd-btn-main' : 'tvd-btn';
  btn.dataset.tvdStatus = statusId; // delegated handler reads the ID from here
  btn.title = 'Download video (size-capped)';
  btn.setAttribute('aria-label', 'Download video (size-capped)');
  btn.innerHTML = dlSvg(isMain ? GLYPH_MAIN : GLYPH_COMPACT);
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
