// Offscreen document — the download workhorse. Runs the validated spike pipeline in a context that
// has a full DOM (window, URL.createObjectURL) and host-permission fetch (no CORS). The service
// worker stays thin: it routes jobs here and saves the resulting blob via chrome.downloads.
//
// The message listener is registered SYNCHRONOUSLY and the pipeline is pulled in via dynamic
// import() inside run(), so a module-load problem can't silently prevent the listener from
// registering — any failure is caught and reported back with a real message.

console.log('[TVD] offscreen loaded');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'tvd-ping') { sendResponse({ ready: true }); return; }
  if (msg.type === 'tvd-run') {
    run(msg)
      .then(sendResponse)
      .catch((e) => {
        console.error('[TVD] run failed:', e);
        sendResponse({ ok: false, error: String(e?.stack || e?.message || e) });
      });
    return true; // async response
  }
});

const getText = async (u) => {
  const r = await fetch(u);
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
  console.log('[TVD] run', job);
  const [{ parseMaster, parseMedia }, { renditionSize, selectVariant, MB },
    { fetchRendition }, { muxMp4box }, { resolveTweetVideo, extractStatusId }] = await Promise.all([
    import('./lib/parse-hls.js'),
    import('./lib/select-variant.js'),
    import('./lib/fetch-stream.js'),
    import('./lib/mux-mp4box.js'),
    import('./lib/tweet.js'),
  ]);

  const capBytes = (job.capMB || 10) * MB;
  let master = job.masterUrl;
  let title = 'twitter-video';
  if (!master) {
    const id = job.statusId || extractStatusId(job.tweetUrl);
    if (!id) throw new Error('no tweet ID or master URL provided');
    ({ masterUrl: master, title } = await resolveTweetVideo(id));
  }
  console.log('[TVD] master:', master);

  const { videoVariants, audioGroups } = parseMaster(await getText(master), master);
  if (!videoVariants.length) throw new Error('no video variants in the master playlist');

  const audioRend = pickAudio(audioGroups, videoVariants);
  let audioMedia = null, audioBytes = 0;
  if (audioRend) {
    audioMedia = parseMedia(await getText(audioRend.uri), audioRend.uri);
    ({ bytes: audioBytes } = await renditionSize(audioMedia));
  }

  const { chosen } = await selectVariant({ videoVariants, audioBytes, capBytes });
  if (!chosen) throw new Error(`No variant fits under ${job.capMB} MB — even the lowest exceeds the cap (would need transcoding).`);
  console.log('[TVD] chosen', chosen.resolution, (chosen.total / MB).toFixed(2), 'MB');

  const videoData = await fetchRendition(chosen.media);
  const audioData = audioMedia ? await fetchRendition(audioMedia) : null;
  console.log('[TVD] fetched, remuxing…');

  const mp4 = await muxMp4box(videoData, audioData);
  const blob = new Blob([mp4], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
  console.log('[TVD] done', (blob.size / MB).toFixed(2), 'MB');

  return { ok: true, blobUrl, filename: `${title}-${chosen.height}p.mp4`, resolution: chosen.resolution, bytes: blob.size };
}
