// Pretend backend for local testing: same routes and shapes as api/index.js, kept in memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as N from '../lib/naming.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mock-'));
const msgs = new Map();
const uploads = new Map(); // token -> { size, received, file, done, msgId, kind, idx }
let seq = 1;
const SPEED = +(process.env.MOCK_SPEED || 1);

function send(res, status, data) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); }
async function body(req) { const c = []; for await (const x of req) c.push(x); const t = Buffer.concat(c).toString(); try { return t ? JSON.parse(t) : {}; } catch (e) { return {}; } }
function signedIn(req) { return /md_session=ok/.test(req.headers.cookie || ''); }

function newUpload(m, kind, idx, size) {
  const token = 'u' + (seq++);
  uploads.set(token, { size, received: 0, file: path.join(dir, token), done: false, msgId: m.id, kind, idx });
  fs.writeFileSync(path.join(dir, token), '');
  return 'http://' + host + '/fake-upload/' + token;
}
let host = 'localhost:3000';

function view(m) {
  return {
    id: m.id, file: m.file, duration: m.duration, source: m.source || null, importing: m.importing || null, original: { uploaded: m.original.uploaded, sessionUrl: m.original.uploaded ? null : m.original.sessionUrl },
    notes: m.notes.map((n) => ({ name: n.name, size: n.size, type: n.type, uploaded: n.uploaded, sessionUrl: n.uploaded ? null : n.sessionUrl })),
    d: m.d, segs: m.segs, fps: m.prepare.fps || m.fps, renderSegs: m.renderSegs, renderRequested: !!m.renderRequestId, status: m.status,
    filing: m.filing, webflow: m.webflow, preview: m.prepare, render: m.render, updatedAt: m.updatedAt
  };
}

function startPrepare(m) {
  m.prepare = { status: 'running', pct: 10 };
  setTimeout(() => {
    try {
      const src = uploads.get(m.original.token).file;
      const thumbs = path.join(dir, m.id + '-thumbs.jpg');
      const dur = m.duration || parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { encoding: 'utf8' }));
      const n = 48;
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'fps=' + n + '/' + dur + ',scale=160:90:force_original_aspect_ratio=increase,crop=160:90,tile=10x5', '-frames:v', '1', thumbs]);
      m.duration = m.duration || dur;
      m.prepare = { status: 'done', pct: 100, proxyId: 'p-' + m.id, proxySize: fs.statSync(src).size, proxyType: 'video/mp4', thumbsId: 't-' + m.id, thumbs: { n, cols: 10, rows: 5, w: 160, h: 90 }, fps: 30, duration: m.duration };
      m.files = { ['p-' + m.id]: src, ['t-' + m.id]: thumbs };
    } catch (e) { console.error(e.message); m.prepare = { status: 'error', pct: 0 }; }
  }, 1500 / SPEED);
}

function startRender(m) {
  const req = m.renderRequestId;
  m.render = { status: 'running', pct: 0, done: false, failed: false };
  const tick = setInterval(() => {
    if (m.renderRequestId !== req) return clearInterval(tick);
    m.render.pct = Math.min(100, m.render.pct + 4 * SPEED);
    if (m.render.pct >= 100) { m.render = { status: 'done', pct: 100, done: true, vimeo: true, audio: true, vimeoLink: 'https://vimeo.com/123456789', thumbApplied: !!(m.d && m.d.thumb) }; clearInterval(tick); }
  }, 500);
}

function file(m) {
  const d = m.d, { y } = N.splitDate(d.date);
  const next = { Sunday: 45, Hebron: 9, Charis: 10 }[d.coll];
  const base = N.baseName(d.coll, d.date, d.part);
  m.filing = {
    path: ['01_SLC Media Library', y, N.collectionFolderName(d.coll, y)], folder: N.meetingFolderName(next, d.coll, d.date), isNew: true,
    original: [base + '.' + N.fileExt(m.file.name)].concat(m.notes.map((n) => n.name)), final: [base + '.mp4', base + '.mp3']
  };
}

export default async function mock(req, res) {
  host = req.headers.host;
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p.startsWith('/fake-upload/')) {
    const up = uploads.get(p.split('/')[2]);
    if (!up) return send(res, 404, {});
    res.setHeader('Access-Control-Expose-Headers', 'Range');
    const cr = req.headers['content-range'] || '';
    const chunks = []; for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr);
    if (m && +m[1] === up.received) { fs.appendFileSync(up.file, buf); up.received += buf.length; }
    if (up.received >= up.size) { up.done = true; return send(res, 200, { id: 'f-' + p.split('/')[2], name: 'x', size: String(up.size) }); }
    res.statusCode = 308; if (up.received) res.setHeader('Range', 'bytes=0-' + (up.received - 1)); return res.end();
  }
  if (p.startsWith('/fake-drive/')) {
    const id = p.split('/')[2];
    const m = [...msgs.values()].find((x) => x.files && x.files[id]);
    if (!m) { res.statusCode = 404; return res.end(); }
    const f = m.files[id], size = fs.statSync(f).size;
    const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (r) {
      const s = +r[1], e = r[2] ? +r[2] : size - 1;
      res.statusCode = 206; res.setHeader('Content-Range', 'bytes ' + s + '-' + e + '/' + size); res.setHeader('Content-Length', e - s + 1);
      return fs.createReadStream(f, { start: s, end: e }).pipe(res);
    }
    res.setHeader('Content-Length', size); return fs.createReadStream(f).pipe(res);
  }

  const path2 = p.replace(/^\/api/, '');
  if (path2 === '/config') return send(res, 200, { clientId: '', user: signedIn(req) ? { email: 'tester@example.com', name: 'Tester' } : null, mock: true });
  if (path2 === '/auth/mock') { res.setHeader('Set-Cookie', 'md_session=ok; Path=/'); return send(res, 200, { ok: true }); }
  if (path2 === '/auth/signout') { res.setHeader('Set-Cookie', 'md_session=; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
  if (!signedIn(req)) return send(res, 401, { error: 'Please sign in again.', signin: true });
  // Pretend Zoom just finished a cloud recording (needs MOCK_ZOOM_FILE)
  if (path2 === '/mock/zoom') {
    const id = 'zoom' + (seq++) + 'abcdefghij';
    const size = fs.statSync(process.env.MOCK_ZOOM_FILE).size;
    const m = { id, source: 'zoom', importing: { pct: 0 }, file: { name: 'Hebron Gathering 2026-11-07.mp4', size, ext: 'mp4' }, duration: 0, d: { coll: 'Hebron', date: '2026-11-07', part: '', title: '', slug: '', slugEdited: false, speakers: [], tags: [], desc: '', res: '', esv: '', esa: '', jav: '', jaa: '', featured: false, hide: false, seq: '', adv: false }, segs: null, fps: null, notes: [], original: { uploaded: false }, prepare: { status: 'waiting', pct: 0 }, render: null, status: 'editing', webflow: null, filing: null };
    msgs.set(id, m);
    const t = setInterval(() => {
      m.importing.pct += 20 * SPEED;
      if (m.importing.pct >= 100) {
        clearInterval(t); m.importing = null;
        const token = 'z' + seq++; uploads.set(token, { file: process.env.MOCK_ZOOM_FILE, size, received: size, done: true });
        m.original = { uploaded: true, token }; startPrepare(m);
      }
    }, 1000);
    return send(res, 200, { id });
  }
  if (path2 === '/vimeo-quota') return send(res, 200, { storage: { used: 1.2e12, max: 5e12, free: 3.8e12 }, periodic: process.env.MOCK_LOW ? { used: 4.9e9, max: 5e9, free: 1e8, resets: '2026-11-15T00:00:00Z' } : null });
  if (path2 === '/drive-token') return send(res, 200, { access_token: 'mock', expires_at: Date.now() + 3600e3, mediaBase: '/fake-drive/' });
  if (path2 === '/options') return send(res, 200, { speakers: ['David Francis Copp', 'Teddy Kochukoshy', 'Abraham Garduza'], tags: ['Faith', 'Strategic Disconnection', 'Grace'] });

  const parts = path2.split('/').filter(Boolean);
  if (parts[0] === 'messages') {
    const b = req.method === 'GET' ? {} : await body(req);
    if (!parts[1] && req.method === 'GET') return send(res, 200, { messages: [...msgs.values()].filter((m) => m.status !== 'published').map(view) });
    if (!parts[1] && req.method === 'POST') {
      const id = 'msg' + (seq++) + 'abcdefghij';
      const m = { id, file: { ...b.file, ext: N.fileExt(b.file.name) }, duration: b.duration || 0, d: b.d, segs: null, fps: null, notes: [], original: {}, prepare: { status: 'waiting', pct: 0 }, render: null, status: 'editing', webflow: null, filing: null };
      m.original = { uploaded: false, sessionUrl: newUpload(m, 'original', 0, b.file.size) };
      m.original.token = m.original.sessionUrl.split('/').pop();
      for (const n of b.notes || []) m.notes.push({ ...n, uploaded: false, sessionUrl: newUpload(m, 'notes', m.notes.length, n.size) });
      msgs.set(id, m);
      return send(res, 200, view(m));
    }
    const m = msgs.get(parts[1]);
    if (!m) return send(res, 404, { error: 'That post could not be found.' });
    const a = parts[2];
    if (!a && req.method === 'GET') return send(res, 200, view(m));
    if (!a && req.method === 'DELETE') { msgs.delete(m.id); return send(res, 200, { vimeoLeft: false }); }
    if (a === 'thumb-upload') return send(res, 200, { sessionUrl: newUpload(m, 'thumb', 0, b.size) });
    if (a === 'thumb') { m.d.thumb = b.thumb; return send(res, 200, view(m)); }
    if (!a && req.method === 'PUT') { if (b.d) m.d = b.d; if ('segs' in b) m.segs = b.segs; if (b.fps) m.fps = b.fps; if (b.duration && !m.duration) m.duration = b.duration; m.updatedAt = Date.now(); return send(res, 200, { ok: true }); }
    if (a === 'upload-offset') {
      const t = b.kind === 'original' ? m.original : m.notes[b.idx];
      if (t.uploaded) return send(res, 200, { done: true });
      const up = uploads.get(t.sessionUrl.split('/').pop());
      return send(res, 200, { done: false, offset: up.received, sessionUrl: t.sessionUrl });
    }
    if (a === 'uploaded') {
      const t = b.kind === 'original' ? m.original : m.notes[b.idx];
      t.uploaded = true;
      if (b.kind === 'original') { startPrepare(m); if (m.renderRequestId && !m.render) startRender(m); }
      return send(res, 200, view(m));
    }
    if (a === 'notes' && req.method === 'POST') {
      const added = [];
      for (const n of b.files) { m.notes.push({ ...n, uploaded: false, sessionUrl: newUpload(m, 'notes', m.notes.length, n.size) }); added.push(m.notes.length - 1); }
      if (m.filing) file(m);
      return send(res, 200, { added, message: view(m) });
    }
    if (a === 'notes' && req.method === 'DELETE') { m.notes.splice(+parts[3], 1); if (m.filing) file(m); return send(res, 200, view(m)); }
    if (a === 'render') {
      m.segs = b.segs; m.renderSegs = b.segs; if (b.d) m.d = b.d; m.renderRequestId = Date.now(); m.render = null;
      if (m.original.uploaded) startRender(m);
      return send(res, 200, view(m));
    }
    if (a === 'finish') {
      if (b.d) m.d = b.d;
      if (process.env.MOCK_FAIL_FINISH) return send(res, 500, { error: 'Something went wrong. Check your connection and try again.' });
      file(m); m.webflow = { drafted: true, published: false, liveUrl: null }; m.status = 'finished';
      return send(res, 200, view(m));
    }
    if (a === 'publish') {
      if (!m.render || !m.render.done) return send(res, 409, { error: 'The video is still being prepared. Publish once it is ready.' });
      m.status = 'published'; m.webflow = { drafted: true, published: true, liveUrl: N.liveUrl(m.d) };
      return send(res, 200, view(m));
    }
  }
  return send(res, 404, { error: 'Not found' });
}
