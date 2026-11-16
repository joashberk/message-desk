// Makes the searchable transcript for a message. Runs on GitHub Actions after upload:
// node worker/transcribe.js <message id>
// Progress lives in the details of the post's transcript.json file, so the editor can show it cheaply.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as G from '../lib/google.js';
import * as M from '../lib/messages.js';
import { downloadToFile, ffmpeg, throttled, log } from './common.js';

const id = process.argv[2] || process.env.MESSAGE_ID;
const work = process.env.WORK_DIR || '/tmp/md-t';
let fileId = null;
const props = { md: 'transcript', status: 'running', pct: '0' };
const mark = throttled(() => G.updateFile(fileId, { appProperties: props }), 15000);

async function main() {
  fs.mkdirSync(work, { recursive: true });
  const m = await M.load(id);
  if (!m.edit.original.uploaded || !m.edit.original.fileId) throw new Error('The recording has not finished uploading');
  const existing = m.kids.find((k) => k.name === 'transcript.json' && k.appProperties && k.appProperties.md === 'transcript');
  if (existing && existing.appProperties.status === 'done' && existing.appProperties.orig === m.edit.original.fileId) { log('already done'); return; }
  props.orig = m.edit.original.fileId;
  fileId = await G.writeJson(m.id, 'transcript.json', { words: [] }, existing && existing.id);
  await mark(true);

  const orig = await G.getFile(m.edit.original.fileId);
  const src = path.join(work, 'original.' + m.edit.file.ext);
  await downloadToFile(orig.id, +orig.size, src, (at, size) => { props.pct = String(Math.floor(at / size * 10)); mark(); });
  // Only the sound is needed: 16 kHz mono raw samples, exactly what Whisper listens to
  const audio = path.join(work, 'sound.f32');
  await ffmpeg(['-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-acodec', 'pcm_f32le', audio]);
  fs.unlinkSync(src);
  props.pct = '12'; await mark(true);

  const out = path.join(work, 'transcript.json');
  await new Promise((resolve, reject) => {
    const p = spawn('python3', [path.join(path.dirname(new URL(import.meta.url).pathname), 'transcribe.py'), audio, out], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const mm = /^P ([\d.]+)/.exec(line);
        if (mm) { props.pct = String(12 + Math.floor(+mm[1] * 87)); mark(); }
        else if (line.startsWith('words')) log(line);
      }
    });
    p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('transcriber stopped: ' + err.slice(-500)))));
  });

  const r = await G.gfetch('https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media&supportsAllDrives=true', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: fs.readFileSync(out)
  });
  if (!r.ok) throw new Error('Could not save the transcript (' + r.status + ')');
  Object.assign(props, { status: 'done', pct: '100' });
  await mark(true);
  log('transcript ready');
}

main().catch(async (e) => {
  console.error(e.message);
  if (fileId) { props.status = 'error'; await G.updateFile(fileId, { appProperties: props }).catch(() => {}); }
  process.exit(1);
});
