// Makes the lightweight preview copy and timeline thumbnails for a message, so the editor
// works smoothly from any computer. Runs on GitHub Actions: node worker/prepare.js <message id>
import fs from 'node:fs';
import path from 'node:path';
import * as G from '../lib/google.js';
import * as M from '../lib/messages.js';
import { rateExpr } from '../lib/cut.js';
import { downloadToFile, uploadFromFile, probe, ffmpeg, throttled, log, freeDisk } from './common.js';

const id = process.argv[2] || process.env.MESSAGE_ID;
const work = process.env.WORK_DIR || '/tmp/md';

async function main() {
  fs.mkdirSync(work, { recursive: true });
  const m = await M.load(id);
  const e = m.edit;
  if (!e.original.uploaded || !e.original.fileId) throw new Error('The recording has not finished uploading');
  const prev = m.prepare || {};
  const state = { ...prev, status: 'running', pct: 1, startedAt: new Date().toISOString(), error: null };
  const save = throttled(async () => { m.ids.prepare = await G.writeJson(m.id, 'prepare.json', state, m.ids.prepare); });
  await save(true);

  const orig = await G.getFile(e.original.fileId);
  log('original', orig.name, orig.size, 'bytes; free disk', freeDisk());
  let src = path.join(work, 'original.' + e.file.ext);
  const local = process.env.LOCAL_ORIGINAL;
  if (local && fs.existsSync(local) && fs.statSync(local).size === +orig.size) src = local; // already on this machine (Zoom import)
  else await downloadToFile(orig.id, +orig.size, src, (at, size) => { state.pct = Math.max(1, Math.floor(at / size * 40)); save(); });

  const info = probe(src);
  log('probe', info);
  Object.assign(state, { fps: info.fps, duration: info.duration, width: info.width, height: info.height, pct: 40 });
  await save(true);

  const proxy = path.join(work, 'preview.mp4');
  // Preview only: 540p, at most 30 fps, quickest settings. Frame timing still lines up with the original.
  const pfps = info.fps > 31 ? info.fps / 2 : info.fps;
  const pg = String(Math.max(1, Math.round(pfps)));
  const args = ['-y', '-threads', '0', '-i', src, '-map', '0:v:0', '-vf', (pfps !== info.fps ? 'fps=' + rateExpr(pfps) + ',' : '') + "scale=-2:'min(540,ih)':flags=fast_bilinear,format=yuv420p", '-c:v', 'libx264', '-preset', 'superfast', '-crf', '30', '-g', pg, '-keyint_min', pg, '-sc_threshold', '0'];
  if (info.hasAudio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '64k', '-ac', '1');
  args.push('-movflags', '+faststart', proxy);
  await ffmpeg(args, (s) => { state.pct = 40 + Math.floor(Math.min(1, s / info.duration) * 45); save(); });
  fs.unlinkSync(src);

  // Thumbnails: one picture every ~15 seconds (48 to 400), packed into one image
  const n = Math.max(48, Math.min(400, Math.round(info.duration / 15)));
  const cols = 10, rows = Math.ceil(n / cols), w = 160, h = 90;
  const thumbs = path.join(work, 'thumbs.jpg');
  await ffmpeg(['-y', '-i', proxy, '-vf', 'fps=' + n + '/' + info.duration.toFixed(3) + ',scale=' + w + ':' + h + ':force_original_aspect_ratio=increase,crop=' + w + ':' + h + ',tile=' + cols + 'x' + rows, '-frames:v', '1', '-q:v', '5', thumbs]);
  state.pct = 92;
  await save(true);

  const kids = await G.listChildren(m.id);
  const has = (fid) => fid && kids.some((k) => k.id === fid);
  const p = await uploadFromFile({ path: proxy, parentId: m.id, name: 'preview.mp4', mimeType: 'video/mp4', fileId: has(prev.proxyId) ? prev.proxyId : undefined });
  const t = await uploadFromFile({ path: thumbs, parentId: m.id, name: 'thumbs.jpg', mimeType: 'image/jpeg', fileId: has(prev.thumbsId) ? prev.thumbsId : undefined });
  Object.assign(state, {
    status: 'done', pct: 100, proxyId: p.id, proxySize: fs.statSync(proxy).size, thumbsId: t.id,
    thumbs: { n, cols, rows, w, h }, finishedAt: new Date().toISOString()
  });
  await save(true);
  log('preview ready');
}

main().catch(async (err) => {
  console.error(err);
  try {
    const m = await M.load(id);
    const state = { ...(m.prepare || {}), status: 'error', error: String(err.message).slice(0, 500) };
    await G.writeJson(m.id, 'prepare.json', state, m.ids.prepare);
  } catch (e) { console.error('could not record the error', e.message); }
  process.exit(1);
});
