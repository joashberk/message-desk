// Shared helpers for the GitHub Actions jobs (preview + render).
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import * as G from '../lib/google.js';
import { parseRate, standardFps } from '../lib/cut.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Downloads a Drive file to disk in ranged pieces, refreshing access as needed.
export async function downloadToFile(fileId, size, dest, onProgress) {
  const PIECE = 256 * 1024 * 1024;
  const fd = fs.openSync(dest, 'w');
  try {
    let pos = 0;
    while (pos < size) {
      const end = Math.min(size, pos + PIECE) - 1;
      let ok = false;
      for (let t = 0; t < 6 && !ok; t++) {
        try {
          const r = await G.gfetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true', { headers: { Range: 'bytes=' + pos + '-' + end } });
          if (r.status !== 206 && r.status !== 200) throw new Error('download ' + r.status);
          let at = pos;
          for await (const chunk of r.body) {
            fs.writeSync(fd, chunk, 0, chunk.length, at);
            at += chunk.length;
            onProgress && onProgress(at, size);
          }
          if (at !== end + 1) throw new Error('short read');
          ok = true;
        } catch (e) {
          log('download retry', e.message);
          await sleep(2000 * 2 ** t);
        }
      }
      if (!ok) throw new Error('Could not download the recording from Drive');
      pos = end + 1;
    }
  } finally { fs.closeSync(fd); }
}

// Uploads a file from disk to Drive (new file, or new content for an existing file so its links stay the same).
export async function uploadFromFile({ path, parentId, name, mimeType, fileId, onProgress, appProperties }) {
  const size = fs.statSync(path).size;
  let session = await G.startResumable({ parentId, name, mimeType, size, fileId, appProperties });
  const CH = 64 * 1024 * 1024;
  const fd = fs.openSync(path, 'r');
  try {
    let pos = 0;
    for (let tries = 0; ;) {
      if (pos >= size) {
        const st = await G.uploadStatus(session, size);
        if (st.done) return st.file;
        pos = st.offset;
        continue;
      }
      const len = Math.min(CH, size - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      let r;
      try {
        r = await fetch(session, { method: 'PUT', headers: { 'Content-Range': 'bytes ' + pos + '-' + (pos + len - 1) + '/' + size }, body: buf });
      } catch (e) { r = { status: 0 }; }
      if (r.status === 200 || r.status === 201) { onProgress && onProgress(size, size); return await r.json(); }
      if (r.status === 308) {
        const m = /bytes=0-(\d+)/.exec(r.headers.get('range') || '');
        pos = m ? +m[1] + 1 : pos + len;
        tries = 0;
        onProgress && onProgress(pos, size);
        continue;
      }
      if (++tries > 8) throw new Error('Drive upload failed (' + r.status + ')');
      await sleep(2000 * 2 ** tries);
      const st = await G.uploadStatus(session, size);
      if (st.expired) { session = await G.startResumable({ parentId, name, mimeType, size, fileId, appProperties }); pos = 0; }
      else if (st.done) return st.file;
      else pos = st.offset;
    }
  } finally { fs.closeSync(fd); }
}

// Downloads every recording of a post and lines them up back to back for ffmpeg.
// One recording: { input: the file }. Several: a list ffmpeg reads as one continuous video
// (the clips were made to match when the preview was prepared, see worker/prepare.js).
export async function getSources(m, work, onProgress, { useConformed = true } = {}) {
  const path = (await import('node:path')).default;
  const M = await import('../lib/messages.js');
  const clips = M.clipList(m);
  const p = m.prepare || {};
  const conformed = useConformed && p.clipsKey === M.clipsKey(m) && Array.isArray(p.conformed) && p.conformed.length === clips.length ? p.conformed : null;
  const files = [];
  const metas = [];
  for (let i = 0; i < clips.length; i++) {
    const id = conformed ? conformed[i] : clips[i].fileId;
    if (!id) throw new Error('A recording has not finished uploading');
    metas.push(await G.getFile(id));
  }
  const total = metas.reduce((t, f) => t + (+f.size || 0), 0);
  let before = 0;
  for (let i = 0; i < clips.length; i++) {
    const ext = conformed ? 'mp4' : clips[i].ext || 'mov';
    const dest = path.join(work, clips.length === 1 ? 'original.' + ext : 'clip-' + (i + 1) + '.' + ext);
    const local = process.env.LOCAL_ORIGINAL;
    if (i === 0 && clips.length === 1 && local && fs.existsSync(local) && fs.statSync(local).size === +metas[0].size) files.push(local);
    else { await downloadToFile(metas[i].id, +metas[i].size, dest, (at) => onProgress && onProgress(before + at, total)); files.push(dest); }
    before += +metas[i].size;
  }
  if (files.length === 1) return { input: files[0], inputArgs: [], files };
  const list = path.join(work, 'clips.txt');
  fs.writeFileSync(list, files.map((f) => "file '" + f.replace(/'/g, "'\\''") + "'").join('\n'));
  return { input: list, inputArgs: ['-f', 'concat', '-safe', '0'], files };
}

// Length, frame rate and sound of the lined-up recordings (a joined list's total length is the clips' sum)
export function probeSources(srcs) {
  if (srcs.files.length === 1) return probe(srcs.files[0]);
  const each = srcs.files.map((f) => probe(f));
  return { ...each[0], duration: each.reduce((t, x) => t + x.duration, 0), hasAudio: each.every((x) => x.hasAudio), clipDurs: each.map((x) => x.duration) };
}

// Details that must match for clips to play back to back without re-encoding
export function streamShape(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const v = j.streams.find((s) => s.codec_type === 'video') || {};
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    v: [v.codec_name, v.profile, v.width, v.height, v.pix_fmt, v.r_frame_rate, v.time_base].join('|'),
    a: a ? [a.codec_name, a.sample_rate, a.channels].join('|') : 'none',
    width: v.width, height: v.height, rate: v.r_frame_rate, hasAudio: !!a
  };
}

export function probe(file, extra = []) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...extra, '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('The recording has no video');
  const reported = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
  return {
    duration: parseFloat(j.format.duration) || parseFloat(v.duration) || 0,
    fps: standardFps(reported),
    reportedFps: reported,
    width: v.width, height: v.height,
    hasAudio: !!a
  };
}

// Runs ffmpeg and reports progress as seconds of output written.
export function ffmpeg(args, onSeconds, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-progress', 'pipe:1', '-nostats', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'], signal });
    p.on('error', (e) => reject(e));
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && onSeconds) onSeconds(+m[1] / 1e6);
      }
    });
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.slice(-1500)))));
  });
}

// Writes progress to Drive at most every few seconds.
export function throttled(fn, ms = 8000) {
  let last = 0, pending = null, running = false;
  const run = async (force) => {
    if (running) { pending = true; return; }
    if (!force && Date.now() - last < ms) { pending = true; return; }
    running = true; last = Date.now(); pending = false;
    try { await fn(); } catch (e) { log('progress write', e.message); }
    running = false;
    if (pending && force) await run(true);
  };
  return run;
}

// The sound wave for the editor's timeline: the loudest point in every 1/50 of a second, as one byte each.
export const WAVE_RATE = 50;
export function makeWaveform(input, out) {
  return new Promise((resolve, reject) => {
    const sr = 4000, per = sr / WAVE_RATE;
    const p = spawn('ffmpeg', ['-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', String(sr), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const peaks = [];
    let carry = Buffer.alloc(0), count = 0, peak = 0;
    p.stdout.on('data', (d) => {
      const buf = carry.length ? Buffer.concat([carry, d]) : d;
      const n = buf.length >> 1;
      for (let i = 0; i < n; i++) {
        const v = Math.abs(buf.readInt16LE(i * 2));
        if (v > peak) peak = v;
        if (++count === per) { peaks.push(Math.min(255, Math.round(Math.sqrt(peak / 32768) * 255))); count = 0; peak = 0; }
      }
      carry = buf.length & 1 ? buf.subarray(buf.length - 1) : Buffer.alloc(0);
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('sound wave failed: ' + err.slice(-300)));
      if (count) peaks.push(Math.min(255, Math.round(Math.sqrt(peak / 32768) * 255)));
      fs.writeFileSync(out, Buffer.from(peaks));
      resolve(peaks.length);
    });
  });
}

export function freeDisk() {
  try { return parseInt(execFileSync('df', ['--output=avail', '-B1', '.'], { encoding: 'utf8' }).trim().split('\n').pop(), 10); } catch (e) { return 0; }
}
