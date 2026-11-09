// Push to Render: cut the full-quality original on exact frames, compress in the same pass,
// upload to Vimeo and wait for it to finish processing, make the MP3, save both to Drive and
// share the MP3 with anyone who has the link.
// Runs on GitHub Actions: node worker/render.js <message id> <request id>
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as G from '../lib/google.js';
import * as M from '../lib/messages.js';
import * as N from '../lib/naming.js';
import { vimeo, videoIdFromUri } from '../lib/vimeo.js';
import { buildRenderArgs, planChunks, keepRanges } from '../lib/cut.js';
import { downloadToFile, uploadFromFile, probe, ffmpeg, throttled, log, freeDisk } from './common.js';

const id = process.argv[2] || process.env.MESSAGE_ID;
const requestId = process.argv[3] || process.env.REQUEST_ID;
const work = process.env.WORK_DIR || '/tmp/md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let m, state, save;

// Stops quietly if someone pressed Push to Render again in the meantime.
// Practice run: does all the work but changes nothing (no Vimeo, no Drive, no progress in the app).
const dry = process.env.DRY_RUN === 'true';

async function stillCurrent() {
  if (dry) return M.load(id);
  let fresh;
  try { fresh = await M.load(id); } catch (e) {
    if (e.status === 404) { log('the post was discarded; stopping'); process.exit(0); }
    throw e;
  }
  if (fresh.edit.renderRequestId !== requestId) { log('a newer render was requested; stopping'); process.exit(0); }
  return fresh;
}

// Checks once a minute during the long compression step, so a discarded or re-pushed post stops right away.
function watchForStop(ac) {
  if (dry) return () => {};
  const t = setInterval(async () => {
    try {
      const fresh = await M.load(id);
      if (fresh.edit.renderRequestId !== requestId) { log('a newer render was requested; stopping'); ac.abort(); }
    } catch (e) { if (e.status === 404) { log('the post was discarded; stopping'); ac.abort(); } }
  }, 60000);
  return () => clearInterval(t);
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

// How a render runs on GitHub (see .github/workflows/render.yml):
//   plan    reads the recording's details and splits the kept parts into pieces
//   piece   one per piece, all at once on separate machines: cut and compress that piece of the picture
//   audio   alongside the pieces: all the sound, as AAC for the MP4 and as the MP3
//   finish  joins the pieces with the sound, uploads to Vimeo, saves the MP4 and MP3 to Drive
//   failed  records that something went wrong, so the app can say so
//   all     everything on one machine (used if the split isn't available)
const mode = process.env.RENDER_MODE || 'all';
const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, k + '=' + v + '\n'); };

async function begin(fresh) {
  m = await stillCurrent();
  if (!m.edit.original.uploaded || !m.edit.original.fileId) throw new Error('The recording has not finished uploading');
  state = fresh ? { ...(m.render || {}), requestId, status: 'running', pct: 1, stage: 'Rendering', error: null, startedAt: new Date().toISOString() } : { ...m.render };
  save = dry ? async () => {} : throttled(async () => { m.ids.render = await G.writeJson(m.id, 'render.json', state, m.ids.render); });
}

async function getOriginal(onProgress) {
  const orig = await G.getFile(m.edit.original.fileId);
  log('original', Math.round(orig.size / 1e6), 'MB; free disk', Math.round(freeDisk() / 1e9), 'GB');
  const src = path.join(work, 'original.' + m.edit.file.ext);
  await downloadToFile(orig.id, +orig.size, src, onProgress);
  return src;
}

// Probes the recording in Drive without downloading all of it.
// The short-lived access key never appears in logs: GitHub is told to blank it out, and errors are reworded.
async function probeRemote() {
  const token = await G.accessToken();
  if (process.env.GITHUB_ACTIONS) console.log('::add-mask::' + token);
  const url = 'https://www.googleapis.com/drive/v3/files/' + m.edit.original.fileId + '?alt=media&supportsAllDrives=true';
  try { return probe(url, ['-headers', 'Authorization: Bearer ' + token + '\r\n']); }
  catch (e) { throw new Error('Could not read the recording details from Drive'); }
}

async function runFfmpeg(args, onSeconds) {
  const ac = new AbortController();
  const stopWatching = watchForStop(ac);
  try { await ffmpeg(args, onSeconds, ac.signal); }
  catch (e) { if (ac.signal.aborted) process.exit(0); throw e; }
  finally { stopWatching(); }
}

async function plan() {
  await begin(true);
  await save(true);
  const info = await probeRemote();
  log('probe', info);
  if (!info.hasAudio) throw new Error('The recording has no sound, so no audio file could be made');
  const chunks = planChunks(m.edit.renderSegs, info.duration, info.fps, { target: 600, max: 10 });
  log('splitting into', chunks.length, 'pieces');
  // Clear progress markers left by earlier renders
  if (!dry) for (const k of m.kids) if (k.appProperties && k.appProperties.md === 'piece') G.trashFile(k.id).catch(() => {});
  Object.assign(state, { pct: 5, pieces: chunks.length, duration: keepRanges(m.edit.renderSegs, info.duration).reduce((t, [a, b]) => t + b - a, 0) });
  await save(true);
  out('chunks', JSON.stringify(chunks.map((segs, i) => ({ i, segs }))));
  out('info', JSON.stringify(info));
}

async function piece() {
  await begin(false);
  const { i, segs } = JSON.parse(process.env.PIECE);
  const info = JSON.parse(process.env.INFO);
  // Progress for this piece, kept in the details of a small marker file the app reads
  const marker = dry ? null : await G.writeJson(m.id, 'piece-' + i + '.json', { i });
  let pct = 0;
  const mark = dry ? async () => {} : throttled(() => G.updateFile(marker, { appProperties: { md: 'piece', req: requestId, i: String(i), pct: String(pct) } }), 10000);
  await mark(true);
  const src = await getOriginal((at, size) => { pct = Math.floor(at / size * 25); mark(); });
  const outMp4 = path.join(work, 'piece-' + String(i).padStart(3, '0') + '.mp4');
  const { args, kept } = buildRenderArgs({ input: src, outMp4, segs, dur: info.duration, fps: info.fps, hasAudio: false, parts: 'video' });
  await runFfmpeg(args, (t) => { pct = 25 + Math.floor(Math.min(1, t / kept) * 75); mark(); });
  pct = 100; await mark(true);
  log('piece', i, 'done');
}

async function audio() {
  await begin(false);
  const info = JSON.parse(process.env.INFO);
  const src = await getOriginal(() => {});
  const { args } = buildRenderArgs({ input: src, outAudio: path.join(work, 'final.m4a'), outMp3: path.join(work, 'final.mp3'), segs: m.edit.renderSegs, dur: info.duration, fps: info.fps, parts: 'audio' });
  await runFfmpeg(args);
  log('sound done');
}

async function finish() {
  await begin(false);
  const dir = process.env.PARTS_DIR || path.join(work, 'parts');
  const pieces = fs.readdirSync(dir).filter((f) => /^piece-\d+\.mp4$/.test(f)).sort();
  if (!pieces.length) throw new Error('The compressed pieces are missing');
  fs.writeFileSync(path.join(work, 'list.txt'), pieces.map((f) => "file '" + path.join(dir, f) + "'").join('\n'));
  const outMp4 = path.join(work, 'final.mp4');
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt'), '-i', path.join(dir, 'final.m4a'), '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movflags', '+faststart', outMp4]);
  log('joined', pieces.length, 'pieces');
  if (dry) {
    const d = (s) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', s, '-show_entries', 'stream=duration,nb_frames,avg_frame_rate', '-of', 'csv=p=0', outMp4], { encoding: 'utf8' }).trim();
    log('practice run finished: final video', Math.round(fs.statSync(outMp4).size / 1e6), 'MB | picture', d('v:0'), '| sound', d('a:0'));
    return;
  }
  await deliver(outMp4, path.join(dir, 'final.mp3'));
  for (const k of (await M.load(id)).kids) if (k.appProperties && k.appProperties.md === 'piece') await G.trashFile(k.id).catch(() => {});
}

async function all() {
  await begin(true);
  await save(true);
  const src = await getOriginal((at, size) => { state.pct = 1 + Math.floor(at / size * 9); save(); });
  const info = probe(src);
  log('probe', info);
  if (!info.hasAudio) throw new Error('The recording has no sound, so no audio file could be made');
  const outMp4 = path.join(work, 'final.mp4'), outMp3 = path.join(work, 'final.mp3');
  const { args, kept } = buildRenderArgs({ input: src, outMp4, outMp3, segs: m.edit.renderSegs, dur: info.duration, fps: info.fps });
  await runFfmpeg(args, (t) => { state.pct = 10 + Math.floor(Math.min(1, t / kept) * 40); save(); });
  fs.unlinkSync(src);
  state.duration = kept;
  await deliver(outMp4, outMp3);
}

// Vimeo upload and processing, with the MP4 and MP3 saved to Drive meanwhile.
async function deliver(outMp4, outMp3) {
  state.pct = 50; state.stage = 'Uploading to Vimeo';
  await save(true);
  m = await stillCurrent();
  const name = N.title(m.edit.d);

  // A re-render replaces the file on the same Vimeo video, so links keep working.
  const size = fs.statSync(outMp4).size;
  log('final video', Math.round(size / 1e6), 'MB');
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

  // MP4 and MP3 go to Drive while Vimeo works
  const finalFolder = m.edit.filing ? m.edit.filing.finalFolderId : m.id;
  const base = N.baseName(m.edit.d.coll, m.edit.d.date, m.edit.d.part);
  const existing = async (fid) => { if (!fid) return undefined; const f = await G.getFile(fid); return f && !f.trashed ? fid : undefined; };
  const drive = (async () => {
    const mp3 = await uploadFromFile({ path: outMp3, parentId: finalFolder, name: base + '.mp3', mimeType: 'audio/mpeg', fileId: await existing(state.mp3Id) });
    await G.shareAnyoneReader(mp3.id).catch((err) => log('share', err.message));
    const mp4 = await uploadFromFile({ path: outMp4, parentId: finalFolder, name: base + '.mp4', mimeType: 'video/mp4', fileId: await existing(state.mp4Id) });
    return { mp3, mp4 };
  })();

  await tusUpload(link, outMp4, (at, total) => { state.pct = 50 + Math.floor(at / total * 25); save(); });
  state.pct = 75; state.stage = 'Vimeo processing';
  await save(true);

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

  const { mp3, mp4 } = await drive;
  Object.assign(state, { mp3Id: mp3.id, mp4Id: mp4.id, mp3Link: G.driveViewLink(mp3.id) });
  await stillCurrent();
  Object.assign(state, { status: 'done', pct: 100, stage: 'Ready', finishedAt: new Date().toISOString() });
  await save(true);
  log('render done');
}

async function failed() {
  const fresh = await M.load(id).catch(() => null);
  if (!fresh || fresh.edit.renderRequestId !== requestId) return;
  const s = { ...(fresh.render || {}), requestId, status: 'error', error: 'One of the render machines stopped' };
  await G.writeJson(fresh.id, 'render.json', s, fresh.ids.render);
}

async function main() {
  fs.mkdirSync(work, { recursive: true });
  const run = { plan, piece, audio, finish, all, failed }[mode];
  if (!run) throw new Error('Unknown render step ' + mode);
  await run();
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
