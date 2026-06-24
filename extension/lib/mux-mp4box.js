// Browser-viable JS muxer (mp4box.js): parse the separate fMP4 renditions, rebuild ONE MP4 with
// both tracks, interleaving samples by DTS. Returns the MP4 as a Uint8Array. This is the exact
// approach validated end-to-end on real Twitter HLS by the spike (no transcode, no ffmpeg.wasm).
//
// mp4box is loaded as a CLASSIC script in offscreen.html (so it attaches to the global as MP4Box
// and has access to `window`), BEFORE this module runs.

// Read mp4box lazily at call time (it's loaded as a classic <script> in offscreen.html). Doing
// this lazily — instead of at module top level — means this module always evaluates, so the
// offscreen listener registers even if mp4box somehow isn't ready, and the error is reported clearly.
// Loaded as a classic browser script, mp4box exposes `createFile` ON the MP4Box object, but
// `DataStream`, `Log`, `BoxParser`, etc. are SEPARATE globals (not under MP4Box — that's only the
// case in the Node/CommonJS build). So grab DataStream/Log from globalThis, not from MP4Box.
function getMP4Box() {
  const M = globalThis.MP4Box;
  if (!M) throw new Error('mp4box not loaded — offscreen.html must load vendor/mp4box.all.js before offscreen.js');
  globalThis.Log?.setLogLevel?.(globalThis.Log.error);
  return M;
}

function getDataStream() {
  const DS = globalThis.DataStream;
  if (!DS) throw new Error('mp4box DataStream global missing (vendor/mp4box.all.js did not load fully)');
  return DS;
}

/** Parse one single-track fMP4 (Uint8Array) -> { entry, timescale, width, height, samples[] }. */
function loadTrack(bytes, label) {
  const MP4Box = getMP4Box();
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    const res = { entry: null, timescale: 1, width: 0, height: 0, samples: [] };
    file.onError = (e) => reject(new Error(`mp4box parse (${label}): ${e}`));
    file.onReady = (info) => {
      const t = info.tracks[0];
      const trak = file.getTrackById(t.id);
      res.timescale = trak.mdia.mdhd.timescale;
      res.entry = trak.mdia.minf.stbl.stsd.entries[0];
      res.width = res.entry.width;
      res.height = res.entry.height;
      file.setExtractionOptions(t.id, null, { nbSamples: 1_000_000 });
      file.start();
    };
    file.onSamples = (_id, _user, samples) => {
      for (const s of samples) {
        res.samples.push({ data: s.data, duration: s.duration, dts: s.dts, cts: s.cts, is_sync: s.is_sync });
      }
    };
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    ab.fileStart = 0;
    file.appendBuffer(ab);
    file.flush();
    queueMicrotask(() => {
      if (!res.entry) reject(new Error(`mp4box parse (${label}): no track found`));
      else if (res.samples.length === 0) reject(new Error(`mp4box parse (${label}): no samples extracted`));
      else resolve(res);
    });
  });
}

/** Re-serialize a parsed avcC into a raw AVCDecoderConfigurationRecord ArrayBuffer (no box header). */
function avcConfigBytes(entry) {
  if (!entry.avcC) throw new Error('video sample entry has no avcC');
  const DataStream = getDataStream();
  const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  entry.avcC.write(ds);
  return ds.buffer.slice(8);
}

/** Remux separate video + audio fMP4 (Uint8Array each) into one MP4 (Uint8Array). */
export async function muxMp4box(videoBytes, audioBytes) {
  const MP4Box = getMP4Box();
  const v = await loadTrack(videoBytes, 'video');
  const a = audioBytes ? await loadTrack(audioBytes, 'audio') : null;

  const out = MP4Box.createFile();
  const vId = out.addTrack({
    type: 'avc1', hdlr: 'vide', timescale: v.timescale,
    width: v.width, height: v.height, avcDecoderConfigRecord: avcConfigBytes(v.entry),
  });

  let aId = null;
  if (a) {
    if (!a.entry.esds) throw new Error(`audio sample entry "${a.entry.type}" has no esds (not AAC/mp4a)`);
    aId = out.addTrack({
      type: 'mp4a', hdlr: 'soun', timescale: a.timescale,
      channel_count: a.entry.channel_count, samplesize: a.entry.samplesize || 16,
      samplerate: a.entry.samplerate, description: a.entry.esds,
    });
  }

  // Interleave samples across tracks by decode time so fragments are time-ordered.
  const events = [];
  for (const s of v.samples) events.push({ t: s.dts / v.timescale, id: vId, s });
  if (a) for (const s of a.samples) events.push({ t: s.dts / a.timescale, id: aId, s });
  events.sort((x, y) => x.t - y.t);
  for (const e of events) {
    out.addSample(e.id, e.s.data, { duration: e.s.duration, cts: e.s.cts, dts: e.s.dts, is_sync: e.s.is_sync });
  }

  return new Uint8Array(out.getBuffer());
}
