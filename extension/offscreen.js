// Offscreen document — the download workhorse. Runs the validated spike pipeline in a context that
// has a full DOM (window, URL.createObjectURL) and host-permission fetch (no CORS).
//
// The message listener registers synchronously; the pipeline is pulled in via dynamic import()
// inside run() so a module-load problem can't silently prevent the listener from registering.
// Results are delivered back via a DECOUPLED `tvd-result` message (correlated by jobId) rather
// than the async sendResponse channel, which is unreliable for long offscreen work (it was
// resolving to undefined). All progress is also relayed to the service-worker console.

console.log('[TVD] offscreen loaded');

function relay(...args) {
  console.log('[TVD]', ...args);
  try {
    chrome.runtime.sendMessage({
      type: 'tvd-log',
      text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    });
  } catch (_) { /* SW momentarily unavailable */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'tvd-ping') { sendResponse({ ready: true }); return; }
  if (msg.type === 'tvd-run') {
    relay('received tvd-run', msg.jobId);
    sendResponse({ accepted: true }); // ack now; the real result comes via tvd-result
    run(msg)
      .then((r) => chrome.runtime.sendMessage({ type: 'tvd-result', jobId: msg.jobId, ...r }))
      .catch((e) => {
        relay('run FAILED:', String(e?.stack || e?.message || e));
        chrome.runtime.sendMessage({ type: 'tvd-result', jobId: msg.jobId, ok: false, error: String(e?.message || e) });
      });
    return; // not using the async sendResponse channel
  }
});

const getText = async (u) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`GET ${u} -> ${r.status}`);
  return r.text();
};

/** Pair the audio group the highest-bitrate AAC video variant references (Twitter -> 128k stereo;
 *  Apple-style -> AAC "aud1", skipping AC-3/EC-3). Matches the spike's validated picker. */
function pickAudio(audioGroups, videoVariants) {
  const groups = Object.values(audioGroups);
  if (!groups.length) return null;
  const aac = videoVariants
    .filter((v) => /mp4a/i.test(v.codecs || ''))
    .sort((a, b) => (b.avgBandwidth || b.bandwidth || 0) - (a.avgBandwidth || a.bandwidth || 0));
  const group = (aac[0]?.audioGroup && audioGroups[aac[0].audioGroup]) ||
    groups.find((g) => g.some((r) => r.channels === 2)) || groups[0];
  return group.find((r) => r.def) || group[0];
}

async function run(job) {
  relay('run start', JSON.stringify({ statusId: job.statusId, tweetUrl: job.tweetUrl, masterUrl: job.masterUrl, capMB: job.capMB }));
  const [{ parseMaster, parseMedia }, { renditionSize, selectVariant, MB },
    { fetchRendition }, { muxMp4box }, { resolveTweetVideo, extractStatusId }] = await Promise.all([
    import('./lib/parse-hls.js'),
    import('./lib/select-variant.js'),
    import('./lib/fetch-stream.js'),
    import('./lib/mux-mp4box.js'),
    import('./lib/tweet.js'),
  ]);
  relay('modules loaded');

  const capBytes = (job.capMB || 10) * MB;
  let master = job.masterUrl;
  let title = 'twitter-video';
  if (!master) {
    const id = job.statusId || extractStatusId(job.tweetUrl);
    if (!id) throw new Error('no tweet ID or master URL provided');
    relay('resolving tweet', id);
    ({ masterUrl: master, title } = await resolveTweetVideo(id));
  }
  relay('master', master);

  const { videoVariants, audioGroups } = parseMaster(await getText(master), master);
  if (!videoVariants.length) throw new Error('no video variants in the master playlist');
  relay('variants', videoVariants.length, 'audio groups', Object.keys(audioGroups).join(',') || '(none)');

  const audioRend = pickAudio(audioGroups, videoVariants);
  let audioMedia = null, audioBytes = 0;
  if (audioRend) {
    audioMedia = parseMedia(await getText(audioRend.uri), audioRend.uri);
    ({ bytes: audioBytes } = await renditionSize(audioMedia));
  }

  const { chosen } = await selectVariant({ videoVariants, audioBytes, capBytes });
  if (!chosen) throw new Error(`No variant fits under ${job.capMB} MB — even the lowest exceeds the cap (would need transcoding).`);
  relay('chosen', chosen.resolution, (chosen.total / MB).toFixed(2) + 'MB');

  const videoData = await fetchRendition(chosen.media);
  const audioData = audioMedia ? await fetchRendition(audioMedia) : null;
  relay('fetched, remuxing…');

  const mp4 = await muxMp4box(videoData, audioData);
  const blob = new Blob([mp4], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
  relay('done', (blob.size / MB).toFixed(2) + 'MB');

  return { ok: true, blobUrl, filename: `${title}-${chosen.height}p.mp4`, resolution: chosen.resolution, bytes: blob.size };
}
