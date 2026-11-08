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
export async function uploadFromFile({ path, parentId, name, mimeType, fileId, onProgress }) {
  const size = fs.statSync(path).size;
  let session = await G.startResumable({ parentId, name, mimeType, size, fileId });
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
      if (st.expired) { session = await G.startResumable({ parentId, name, mimeType, size, fileId }); pos = 0; }
      else if (st.done) return st.file;
      else pos = st.offset;
    }
  } finally { fs.closeSync(fd); }
}

export function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
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
export function ffmpeg(args, onSeconds) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-progress', 'pipe:1', '-nostats', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

export function freeDisk() {
  try { return parseInt(execFileSync('df', ['--output=avail', '-B1', '.'], { encoding: 'utf8' }).trim().split('\n').pop(), 10); } catch (e) { return 0; }
}
