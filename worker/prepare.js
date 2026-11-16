// Makes the lightweight preview copy and timeline thumbnails for a message, so the editor
// works smoothly from any computer. Runs on GitHub Actions: node worker/prepare.js <message id>
import fs from 'node:fs';
import path from 'node:path';
import * as G from '../lib/google.js';
import * as M from '../lib/messages.js';
import { rateExpr } from '../lib/cut.js';
import { uploadFromFile, probe, probeSources, ffmpeg, throttled, log, freeDisk, makeWaveform, WAVE_RATE, getSources, streamShape } from './common.js';

const id = process.argv[2] || process.env.MESSAGE_ID;
const work = process.env.WORK_DIR || '/tmp/md';

async function main() {
  fs.mkdirSync(work, { recursive: true });
  const m = await M.load(id);
  const e = m.edit;
  if (!M.allUploaded(m)) throw new Error('The recording has not finished uploading');
  const key = M.clipsKey(m);
  const prev = m.prepare || {};
  const state = { ...prev, status: 'running', pct: 1, startedAt: new Date().toISOString(), error: null };
  const save = throttled(async () => { m.ids.prepare = await G.writeJson(m.id, 'prepare.json', state, m.ids.prepare); });
  await save(true);

  log('free disk', Math.round(freeDisk() / 1e9), 'GB');
  let srcs = await getSources(m, work, (at, size) => { state.pct = Math.max(1, Math.floor(at / size * 40)); save(); }, { useConformed: false });
  state.conformed = null;
  if (srcs.files.length > 1) srcs = await joinClips(m, srcs, state, save, key);
  const src = srcs.input;

  const info = probeSources(srcs);
  const clipDurs = info.clipDurs || [info.duration];
  delete info.clipDurs;
  log('probe', info);
  Object.assign(state, { fps: info.fps, duration: info.duration, width: info.width, height: info.height, pct: 40 });
  await save(true);

  const proxy = path.join(work, 'preview.mp4');
  // Preview only: 540p, at most 30 fps, quickest settings. Frame timing still lines up with the original.
  const pfps = info.fps > 31 ? info.fps / 2 : info.fps;
  const pg = String(Math.max(1, Math.round(pfps)));
  const args = ['-y', '-threads', '0', ...srcs.inputArgs, '-i', src, '-map', '0:v:0', '-vf', (pfps !== info.fps ? 'fps=' + rateExpr(pfps) + ',' : '') + "scale=-2:'min(540,ih)':flags=fast_bilinear,format=yuv420p", '-c:v', 'libx264', '-preset', 'superfast', '-crf', '30', '-g', pg, '-keyint_min', pg, '-sc_threshold', '0'];
  if (info.hasAudio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '64k', '-ac', '1');
  args.push('-movflags', '+faststart', proxy);
  await ffmpeg(args, (s) => { state.pct = 40 + Math.floor(Math.min(1, s / info.duration) * 45); save(); });
  for (const f of srcs.files) if (f !== process.env.LOCAL_ORIGINAL) fs.rmSync(f, { force: true });

  // Thumbnails: one picture every ~15 seconds (48 to 400), packed into one image
  const n = Math.max(48, Math.min(400, Math.round(info.duration / 15)));
  const cols = 10, rows = Math.ceil(n / cols), w = 160, h = 90;
  const thumbs = path.join(work, 'thumbs.jpg');
  await ffmpeg(['-y', '-i', proxy, '-vf', 'fps=' + n + '/' + info.duration.toFixed(3) + ',scale=' + w + ':' + h + ':force_original_aspect_ratio=increase,crop=' + w + ':' + h + ',tile=' + cols + 'x' + rows, '-frames:v', '1', '-q:v', '5', thumbs]);
  // Sound wave for the timeline, from the preview's sound (lines up with the picture)
  const wave = path.join(work, 'wave.bin');
  const hasWave = info.hasAudio ? await makeWaveform(proxy, wave).then(() => true, (e) => { log('no sound wave'); return false; }) : false;
  state.pct = 92;
  await save(true);

  // Always new files: someone may still be watching the previous preview, and changing a file while it
  // streams breaks playback. The previous set is cleared the next time (or when the post is published).
  const p = await uploadFromFile({ path: proxy, parentId: m.id, name: 'preview.mp4', mimeType: 'video/mp4' });
  const t = await uploadFromFile({ path: thumbs, parentId: m.id, name: 'thumbs.jpg', mimeType: 'image/jpeg' });
  const wv = hasWave ? await uploadFromFile({ path: wave, parentId: m.id, name: 'wave.bin', mimeType: 'application/octet-stream' }) : null;
  const retire = [prev.proxyId, prev.thumbsId, prev.waveId].filter(Boolean);
  for (const old of prev.retired || []) await G.trashFile(old).catch(() => {});
  state.retired = retire;
  Object.assign(state, {
    status: 'done', pct: 100, proxyId: p.id, proxySize: fs.statSync(proxy).size, thumbsId: t.id,
    waveId: wv ? wv.id : null, waveRate: WAVE_RATE,
    thumbs: { n, cols, rows, w, h }, finishedAt: new Date().toISOString(), clipsKey: key, clipDurs
  });
  await save(true);
  log('preview ready');
}

// Several recordings: if they don't all share the same picture and sound format, they are re-made in
// the first one's format (high quality) so they play back to back. Those copies are kept privately in
// the post's folder for the render, and cleared when the post is published.
async function joinClips(m, srcs, state, save, key) {
  const shapes = srcs.files.map((f) => streamShape(f));
  const same = shapes.every((s) => s.v === shapes[0].v && s.a === shapes[0].a);
  log('clips', shapes.length, same ? 'match' : 'differ; making them match');
  if (same) return srcs;
  const first = shapes[0];
  const fps = first.rate && first.rate !== '0/0' ? first.rate : '30';
  const W = first.width || 1920, H = first.height || 1080;
  const out = [], ids = [];
  for (let i = 0; i < srcs.files.length; i++) {
    const f = srcs.files[i], dest = path.join(work, 'joined-' + (i + 1) + '.mp4');
    const args = ['-y', '-i', f];
    if (!shapes[i].hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-map', '0:v:0', '-map', shapes[i].hasAudio ? '0:a:0' : '1:a:0', '-shortest',
      '-vf', 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2,setsar=1,fps=' + fps + ',format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', dest);
    await ffmpeg(args, () => {});
    fs.rmSync(f, { force: true });
    const up = await uploadFromFile({ path: dest, parentId: m.id, name: 'joined-' + (i + 1) + '.mp4', mimeType: 'video/mp4', appProperties: { md: 'conformed', key: key.slice(0, 80) } });
    out.push(dest); ids.push(up.id);
    state.pct = Math.min(39, state.pct + 2); await save();
  }
  state.conformed = ids;
  const list = path.join(work, 'clips.txt');
  fs.writeFileSync(list, out.map((f) => "file '" + f + "'").join('\n'));
  return { input: list, inputArgs: ['-f', 'concat', '-safe', '0'], files: out };
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
