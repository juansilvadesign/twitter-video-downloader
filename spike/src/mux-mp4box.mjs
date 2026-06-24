// Browser-viable JS muxer — the stack we actually need to validate (vs. the ~25 MB ffmpeg.wasm).
// Approach: parse each separate fMP4 rendition with mp4box.js, collect its samples + codec
// config, then rebuild ONE output file with both tracks via addTrack/addSample, interleaving
// samples by DTS. Video codec config (avcC) is re-serialized from the parsed box; audio (esds)
// is reused from the parsed entry. ffprobe + a full decode pass verify the result downstream.

import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const MP4Box = require('mp4box');

MP4Box.Log.setLogLevel?.(MP4Box.Log.error); // silence the library's debug chatter

/** Parse one single-track fMP4 buffer -> { entry, timescale, width, height, samples[] }. */
function loadTrack(buf, label) {
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
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
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

/** Re-serialize a parsed avcC box into a raw AVCDecoderConfigurationRecord ArrayBuffer
 *  (no box header). addTrack feeds this to MP4BoxStream, which requires an ArrayBuffer. */
function avcConfigBytes(entry) {
  if (!entry.avcC) throw new Error('video sample entry has no avcC');
  const ds = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
  entry.avcC.write(ds);
  return ds.buffer.slice(8); // ArrayBuffer minus the 8-byte box header
}

export async function muxMp4box(videoBuf, audioBuf, outPath) {
  const v = await loadTrack(videoBuf, 'video');
  const a = audioBuf ? await loadTrack(audioBuf, 'audio') : null;

  const out = MP4Box.createFile();

  const vId = out.addTrack({
    type: 'avc1',
    hdlr: 'vide',
    timescale: v.timescale,
    width: v.width,
    height: v.height,
    avcDecoderConfigRecord: avcConfigBytes(v.entry),
  });

  let aId = null;
  if (a) {
    if (!a.entry.esds) {
      throw new Error(`audio sample entry "${a.entry.type}" has no esds (not AAC/mp4a) — cannot build mp4a track`);
    }
    aId = out.addTrack({
      type: 'mp4a',
      hdlr: 'soun',
      timescale: a.timescale,
      channel_count: a.entry.channel_count,
      samplesize: a.entry.samplesize || 16,
      samplerate: a.entry.samplerate,
      description: a.entry.esds, // AAC decoder config (esds writer is the known risk in 0.5.4)
    });
  }

  // Interleave samples across tracks by decode time (seconds), so fragments are ordered.
  const events = [];
  for (const s of v.samples) events.push({ t: s.dts / v.timescale, id: vId, s });
  if (a) for (const s of a.samples) events.push({ t: s.dts / a.timescale, id: aId, s });
  events.sort((x, y) => x.t - y.t);
  for (const e of events) {
    out.addSample(e.id, e.s.data, { duration: e.s.duration, cts: e.s.cts, dts: e.s.dts, is_sync: e.s.is_sync });
  }

  const ab = out.getBuffer();
  await writeFile(outPath, Buffer.from(ab));
  return outPath;
}
