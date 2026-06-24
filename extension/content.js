// Content script: inject a download button into each video tweet's action bar (right of Share).
// X is a recycling React SPA, so we observe DOM mutations (debounced) and re-scan, using a sentinel
// attribute to avoid duplicate injection. The tweet's status ID is read from the article permalink,
// so the button is unambiguously bound to ITS tweet even when several videos share the page.
//
// NOTE: the DOM selectors below are heuristic and are the part most likely to drift when X changes
// its markup. Keep them in one place for easy updates.

const SENTINEL = 'data-tvd-injected';

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

async function onClick(btn, statusId) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  btn.classList.add('tvd-loading');
  const reset = (cls, ms) => setTimeout(() => { btn.classList.remove(cls); btn.title = 'Download video (size-capped)'; }, ms);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'tvd-download', statusId });
    if (!res?.ok) throw new Error(res?.error || 'download failed');
    btn.classList.add('tvd-done');
    btn.title = `Saved ${res.resolution} (${(res.bytes / 1048576).toFixed(1)} MB)`;
    reset('tvd-done', 2500);
  } catch (e) {
    btn.classList.add('tvd-error');
    btn.title = 'Download failed: ' + (e?.message || e);
    reset('tvd-error', 4000);
  } finally {
    btn.dataset.busy = '';
    btn.classList.remove('tvd-loading');
  }
}

function inject(actionBar) {
  if (actionBar.hasAttribute(SENTINEL)) return;
  const article = actionBar.closest('article');
  if (!article || !hasVideo(article)) return;
  const statusId = statusIdFromArticle(article);
  if (!statusId) return;

  actionBar.setAttribute(SENTINEL, '1');
  const wrap = document.createElement('div');
  wrap.className = 'tvd-btn-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tvd-btn';
  btn.title = 'Download video (size-capped)';
  btn.setAttribute('aria-label', 'Download video (size-capped)');
  btn.innerHTML = DL_SVG;
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(btn, statusId); });
  wrap.appendChild(btn);
  actionBar.appendChild(wrap);
}

function scan(root = document) {
  // A tweet action bar is a role="group" inside an <article> holding several action buttons.
  for (const bar of root.querySelectorAll('article [role="group"]')) {
    if (bar.querySelectorAll('button, a').length >= 2) inject(bar);
  }
}

const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
const rescan = debounce(scan, 250);
new MutationObserver(rescan).observe(document.documentElement, { childList: true, subtree: true });
scan();
