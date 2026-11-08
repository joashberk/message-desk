// Push to Render: cut the full-quality original on exact frames, compress in the same pass,
// upload to Vimeo and wait for it to finish processing, make the MP3, save both to Drive and
// share the MP3 with anyone who has the link.
// Runs on GitHub Actions: node worker/render.js <message id> <request id>
import fs from 'node:fs';
import path from 'node:path';
import * as G from '../lib/google.js';
import * as M from '../lib/messages.js';
import * as N from '../lib/naming.js';
import { vimeo, videoIdFromUri } from '../lib/vimeo.js';
import { buildRenderArgs } from '../lib/cut.js';
import { downloadToFile, uploadFromFile, probe, ffmpeg, throttled, log, freeDisk } from './common.js';

const id = process.argv[2] || process.env.MESSAGE_ID;
const requestId = process.argv[3] || process.env.REQUEST_ID;
const work = process.env.WORK_DIR || '/tmp/md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let m, state, save;

// Stops quietly if someone pressed Push to Render again in the meantime.
async function stillCurrent() {
  const fresh = await M.load(id);
  if (fresh.edit.renderRequestId !== requestId) { log('a newer render was requested; stopping'); process.exit(0); }
  return fresh;
}

async function tusUpload(link, file, onProgress) {
  const size = fs.statSync(file).size;
  const CH = 128 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  let offset = 0;
  try {
    for (let tries = 0; offset < size;) {
      const len = Math.min(CH, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      let r;
      try {
        r = await fetch(link, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: buf });
      } catch (e) { r = { status: 0 }; }
      if (r.status === 204 || r.status === 200) {
        offset = parseInt(r.headers.get('upload-offset') || String(offset + len), 10);
        tries = 0;
        onProgress(offset, size);
        continue;
      }
      if (++tries > 8) throw new Error('Vimeo upload failed (' + r.status + ')');
      await sleep(3000 * 2 ** tries);
      const h = await fetch(link, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } }).catch(() => null);
      if (h && h.headers.get('upload-offset')) offset = parseInt(h.headers.get('upload-offset'), 10);
    }
  } finally { fs.closeSync(fd); }
}

async function main() {
  fs.mkdirSync(work, { recursive: true });
  m = await stillCurrent();
  const e = m.edit;
  if (!e.original.uploaded || !e.original.fileId) throw new Error('The recording has not finished uploading');
  state = { ...(m.render || {}), requestId, status: 'running', pct: 1, stage: 'Rendering', error: null, startedAt: new Date().toISOString() };
  save = throttled(async () => { m.ids.render = await G.writeJson(m.id, 'render.json', state, m.ids.render); });
  await save(true);

  // 1 · Download the full-quality original (0 → 10%)
  const orig = await G.getFile(e.original.fileId);
  log('original', orig.name, orig.size, 'bytes; free disk', freeDisk());
  const src = path.join(work, 'original.' + e.file.ext);
  await downloadToFile(orig.id, +orig.size, src, (at, size) => { state.pct = 1 + Math.floor(at / size * 9); save(); });
  const info = probe(src);
  log('probe', info);

  // 2 · Cut + compress + MP3 in one pass (10 → 50%)
  const outMp4 = path.join(work, 'final.mp4'), outMp3 = path.join(work, 'final.mp3');
  const { args, kept, ranges } = buildRenderArgs({ input: src, outMp4, outMp3, segs: e.renderSegs, dur: info.duration, fps: info.fps, hasAudio: info.hasAudio });
  log('keeping', ranges.length, 'sections,', kept.toFixed(2), 's');
  await ffmpeg(args, (s) => { state.pct = 10 + Math.floor(Math.min(1, s / kept) * 40); save(); });
  fs.unlinkSync(src);
  if (!info.hasAudio) throw new Error('The recording has no sound, so no audio file could be made');
  state.duration = kept;
  state.pct = 50; state.stage = 'Uploading to Vimeo';
  await save(true);

  m = await stillCurrent();
  const name = N.title(m.edit.d);

  // 3 · Vimeo upload (50 → 75%). A re-render replaces the file on the same Vimeo video, so links keep working.
  const size = fs.statSync(outMp4).size;
  let vid = state.vimeoId, link;
  if (vid) {
    try {
      const v = await vimeo('POST', '/videos/' + vid + '/versions', { file_name: N.baseName(m.edit.d.coll, m.edit.d.date, m.edit.d.part) + '.mp4', upload: { status: 'in_progress', size, approach: 'tus' } });
      link = v.upload.upload_link;
    } catch (err) { log('could not replace the earlier Vimeo video, making a new one:', err.message); vid = null; }
  }
  if (!vid) {
    const v = await vimeo('POST', '/me/videos', { upload: { approach: 'tus', size }, name });
    vid = videoIdFromUri(v.uri);
    link = v.upload.upload_link;
    state.vimeoId = vid;
    state.vimeoLink = v.link || ('https://vimeo.com/' + vid);
  } else {
    await vimeo('PATCH', '/videos/' + vid, { name }).catch(() => {});
  }
  await save(true);

  // Save the MP4 to Drive while Vimeo works
  const finalFolder = m.edit.filing ? m.edit.filing.finalFolderId : m.id;
  const base = N.baseName(m.edit.d.coll, m.edit.d.date, m.edit.d.part);
  const existing = async (fid) => { if (!fid) return undefined; const f = await G.getFile(fid); return f && !f.trashed ? fid : undefined; };
  const mp4Drive = (async () => uploadFromFile({ path: outMp4, parentId: finalFolder, name: base + '.mp4', mimeType: 'video/mp4', fileId: await existing(state.mp4Id) }))();

  await tusUpload(link, outMp4, (at, total) => { state.pct = 50 + Math.floor(at / total * 25); save(); });
  state.pct = 75; state.stage = 'Vimeo processing';
  await save(true);

  // 4 · Wait for Vimeo to finish processing (75 → 90%)
  const t0 = Date.now();
  for (;;) {
    const v = await vimeo('GET', '/videos/' + vid + '?fields=link,status,transcode.status,upload.status');
    if (v.link) state.vimeoLink = v.link;
    const ts = v.transcode && v.transcode.status;
    if (ts === 'complete' || (v.status === 'available' && ts !== 'in_progress')) break;
    if (ts === 'error' || v.status === 'transcode_starting_error' || v.status === 'uploading_error') throw new Error('Vimeo could not process the video');
    if (Date.now() - t0 > 3 * 3600 * 1000) throw new Error('Vimeo took too long to process the video');
    state.pct = Math.min(89, 75 + Math.floor((Date.now() - t0) / 60000));
    await save();
    await sleep(15000);
  }
  state.pct = 90; state.stage = 'Making audio';
  await save(true);

  // 5 · MP4 + MP3 in Drive, MP3 shared with anyone who has the link (90 → 100%)
  const mp4 = await mp4Drive;
  state.mp4Id = mp4.id;
  const mp3 = await uploadFromFile({ path: outMp3, parentId: finalFolder, name: base + '.mp3', mimeType: 'audio/mpeg', fileId: await existing(state.mp3Id) });
  state.mp3Id = mp3.id;
  await G.shareAnyoneReader(mp3.id).catch((err) => log('share', err.message));
  state.mp3Link = G.driveViewLink(mp3.id);

  await stillCurrent();
  Object.assign(state, { status: 'done', pct: 100, stage: 'Ready', finishedAt: new Date().toISOString() });
  await save(true);
  log('render done', state.vimeoLink, state.mp3Link);
}

main().catch(async (err) => {
  console.error(err);
  try {
    const fresh = await M.load(id);
    if (fresh.edit.renderRequestId === requestId) {
      const s = { ...(state || fresh.render || {}), requestId, status: 'error', error: String(err.message).slice(0, 500) };
      await G.writeJson(fresh.id, 'render.json', s, fresh.ids.render);
    }
  } catch (e) { console.error('could not record the error', e.message); }
  process.exit(1);
});
