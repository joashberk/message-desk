// Copies a finished Zoom cloud recording into Drive as a new Message Desk draft.
// Runs on GitHub Actions: node worker/import-zoom.js <meeting uuid> <recording file id>
// "node worker/import-zoom.js check" lists the last week's recordings and what would happen to each.
import fs from 'node:fs';
import path from 'node:path';
import * as G from '../lib/google.js';
import * as M from '../lib/messages.js';
import { CONFIG } from '../lib/config.js';
import { ZOOM, zoom, zoomToken, collectionFor, pickFile, localDate, encodeUuid } from '../lib/zoom.js';
import { uploadFromFile, throttled, log } from './common.js';

const [uuid, fileId] = process.argv.slice(2);
const work = process.env.WORK_DIR || '/tmp/md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function output(k, v) { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, k + '=' + v + '\n'); }

async function check() {
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const j = await zoom('GET', '/users/' + encodeURIComponent(CONFIG.driveAccount) + '/recordings?page_size=50&from=' + from);
  log('Zoom connection works. Recordings in the last 7 days:', (j.meetings || []).length);
  for (const mtg of j.meetings || []) {
    const coll = collectionFor(mtg.topic), f = pickFile(mtg.recording_files);
    log('-', mtg.topic, '|', localDate(mtg.start_time, mtg.timezone), '|', coll && f ? 'would become a ' + coll + ' draft' : 'ignored (name or video not a match)');
  }
}

async function download(url, size, dest, onProgress) {
  for (let t = 0; t < 6; t++) {
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + await zoomToken() }, redirect: 'follow' });
      if (!r.ok) throw new Error('Zoom download ' + r.status);
      const out = fs.createWriteStream(dest);
      let at = 0;
      for await (const chunk of r.body) {
        if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
        at += chunk.length;
        onProgress(at, size || at);
      }
      await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
      if (size && at !== size) throw new Error('short download');
      return;
    } catch (e) { log('download retry', e.message); await sleep(3000 * 2 ** t); }
  }
  throw new Error('Could not download the recording from Zoom');
}

async function main() {
  if (uuid === 'check') return check();
  fs.mkdirSync(work, { recursive: true });
  const rec = await zoom('GET', '/meetings/' + encodeUuid(uuid) + '/recordings');
  const coll = collectionFor(rec.topic);
  const file = (rec.recording_files || []).find((f) => f.id === fileId) || pickFile(rec.recording_files);
  if (!coll || !file) { log('Not a message recording; nothing to do:', rec.topic); return; }

  const dupes = await G.listFiles("appProperties has { key='zoomFile' and value='" + file.id + "' } and trashed = false", 'id');
  if (dupes.length) { log('Already in Message Desk'); return; }

  const date = localDate(rec.start_time, rec.timezone);
  const name = String(rec.topic || 'Zoom recording').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) + ' ' + date + '.mp4';
  const m = await M.createImported({
    kind: 'zoom', name, size: file.file_size, type: 'video/mp4', date, coll,
    details: { source: { meetingId: rec.id, uuid: rec.uuid, topic: rec.topic, fileId: file.id, layout: file.recording_type } },
    appProperties: { zoomFile: String(file.id) }
  });
  log('draft created for', rec.topic, date, coll);

  const state = { status: 'copying', pct: 0 };
  let importId;
  const save = throttled(async () => { importId = await G.writeJson(m.id, 'import.json', state, importId); });
  await save(true);
  try {
    const dest = path.join(work, 'original.mp4');
    await download(file.download_url, file.file_size, dest, (at, size) => { state.pct = Math.floor(at / size * 60); save(); });
    const up = await uploadFromFile({ path: dest, parentId: m.id, name, mimeType: 'video/mp4', onProgress: (at, size) => { state.pct = 60 + Math.floor(at / size * 40); save(); } });
    const f = await G.getFile(up.id);
    if (!f || +f.size !== fs.statSync(dest).size) throw new Error('The copy in Drive does not match the Zoom recording');
    await M.markImported(m.id, up.id);
    Object.assign(state, { status: 'done', pct: 100 });
    await save(true);
    output('message_id', m.id);
    output('local', dest);
    log('copied to Drive');

    if (ZOOM.trashAfterCopy) {
      try { await zoom('DELETE', '/meetings/' + encodeUuid(rec.uuid) + '/recordings?action=trash'); log('moved to Zoom trash (recoverable for 30 days)'); }
      catch (e) { log('could not move the recording to Zoom trash:', e.message); }
    }
  } catch (err) {
    Object.assign(state, { status: 'error', error: String(err.message).slice(0, 300) });
    await save(true);
    throw err;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
