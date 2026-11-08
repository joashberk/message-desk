// Everything a message goes through: upload, edits, render requests, Drive filing,
// the Webflow draft and publishing. State lives as small JSON files in the message's
// folder inside "Message Desk working files" on the sentlifecenter.tech Drive:
//   edit.json     written by the website (details, cut points, filing, website item)
//   prepare.json  written by the preview worker (preview copy, thumbnails, frame rate)
//   render.json   written by the website when a render is requested, then by the render worker
import { CONFIG, COLLS } from './config.js';
import * as G from './google.js';
import * as N from './naming.js';
import * as W from './webflow.js';
import { dispatch } from './github.js';
import { renameVideo } from './vimeo.js';

const MIME = { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', mkv: 'video/x-matroska', webm: 'video/webm' };

export class UserError extends Error {
  constructor(msg, status = 400) { super(msg); this.userMessage = msg; this.status = status; }
}

let rootId = null;
export async function workingRoot() {
  if (rootId) {
    // Someone may have deleted the folder in Drive; start a fresh one if so.
    const f = await G.getFile(rootId, 'id,trashed');
    if (f && !f.trashed) return rootId;
    rootId = null;
  }
  const hits = await G.listFiles("'root' in parents and trashed = false and mimeType = " + G.q(G.FOLDER) + ' and name = ' + G.q(CONFIG.workingFolderName));
  rootId = hits.length ? hits[0].id : (await G.createFolder('root', CONFIG.workingFolderName, { md: 'root' })).id;
  return rootId;
}

function cleanDetails(d, prev) {
  d = d || {};
  prev = prev || {};
  const s = (v, max = 500) => String(v == null ? '' : v).slice(0, max);
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => s(x, 120).trim()).filter(Boolean).slice(0, 30);
  const out = {
    coll: COLLS.includes(d.coll) ? d.coll : (prev.coll || 'Hebron'),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : (prev.date || new Date().toISOString().slice(0, 10)),
    part: s(d.part, 3).replace(/[^0-9]/g, ''),
    title: s(d.title, 256), titleEdited: !!d.titleEdited,
    slug: s(d.slug, 256).toLowerCase().replace(/[^a-z0-9-]/g, '-'), slugEdited: !!d.slugEdited,
    speakers: list(d.speakers), tags: list(d.tags),
    desc: s(d.desc, 200), res: s(d.res, 1000), esv: s(d.esv, 1000), esa: s(d.esa, 1000), jav: s(d.jav, 1000), jaa: s(d.jaa, 1000),
    featured: !!d.featured, hide: !!d.hide, seq: s(d.seq, 6).replace(/[^0-9]/g, ''), adv: !!d.adv
  };
  return out;
}

function cleanSegs(segs, dur) {
  if (!Array.isArray(segs) || !segs.length) return null;
  const out = segs
    .map((x) => ({ a: +x.a, b: +x.b, t: x.t === 'remove' ? 'remove' : 'keep' }))
    .filter((x) => isFinite(x.a) && isFinite(x.b) && x.b > x.a && x.a >= 0)
    .sort((x, y) => x.a - y.a);
  if (dur) out.forEach((x) => { x.b = Math.min(x.b, dur + 1); });
  return out.length ? out : null;
}

// ---------- loading and saving ----------

export async function load(id) {
  const folder = await G.getFile(id, 'id,name,appProperties,trashed');
  if (!folder || folder.trashed || !folder.appProperties || folder.appProperties.md !== 'message') throw new UserError('That post could not be found.', 404);
  const kids = await G.listChildren(id);
  // If a data file was ever written twice at once, use the newest copy and tidy up the rest.
  const byName = (n) => {
    const all = kids.filter((k) => k.name === n).sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
    for (const extra of all.slice(1)) G.trashFile(extra.id).catch(() => {});
    return all[0];
  };
  const ids = { edit: byName('edit.json')?.id, prepare: byName('prepare.json')?.id, render: byName('render.json')?.id };
  const [edit, prepare, render] = await Promise.all([
    ids.edit ? G.readJson(ids.edit) : null,
    ids.prepare ? G.readJson(ids.prepare) : null,
    ids.render ? G.readJson(ids.render) : null
  ]);
  if (!edit) throw new UserError('That post could not be opened.', 404);
  return { id, folder, kids, ids, edit, prepare, render };
}

async function saveEdit(m) {
  m.edit.updatedAt = new Date().toISOString();
  m.ids.edit = await G.writeJson(m.id, 'edit.json', m.edit, m.ids.edit);
}
async function saveRender(m) { m.ids.render = await G.writeJson(m.id, 'render.json', m.render, m.ids.render); }
async function savePrepare(m) { m.ids.prepare = await G.writeJson(m.id, 'prepare.json', m.prepare, m.ids.prepare); }

function renderDone(m) {
  return !!(m.render && m.render.status === 'done' && m.render.requestId === m.edit.renderRequestId);
}

// What the browser sees. No developer details leave the server.
export function view(m) {
  const e = m.edit, p = m.prepare || {}, r = m.render || {};
  const current = r.requestId && r.requestId === e.renderRequestId;
  return {
    id: m.id,
    file: e.file,
    duration: p.duration || e.duration || 0,
    original: { uploaded: !!e.original.uploaded, sessionUrl: e.original.uploaded ? null : e.original.sessionUrl },
    notes: e.notes.map((n) => ({ name: n.name, size: n.size, type: n.type, uploaded: !!n.uploaded, sessionUrl: n.uploaded ? null : n.sessionUrl })),
    d: e.d,
    segs: e.segs,
    fps: p.fps || e.fps || null,
    renderSegs: e.renderSegs || null,
    renderRequested: !!e.renderRequestId,
    status: e.status,
    filing: e.filing ? { path: e.filing.path, folder: e.filing.folder, isNew: !!e.filing.createdMeetingFolder, original: e.filing.original, final: e.filing.final } : null,
    webflow: e.webflow && e.webflow.itemId ? { drafted: true, published: !!e.webflow.publishedAt, liveUrl: e.webflow.publishedAt ? N.liveUrl(e.d) : null } : null,
    preview: {
      status: p.status || (e.original.uploaded ? 'queued' : 'waiting'),
      pct: p.pct || 0,
      proxyId: p.status === 'done' ? p.proxyId : null,
      proxySize: p.proxySize || null,
      proxyType: 'video/mp4',
      thumbsId: p.status === 'done' ? p.thumbsId : null,
      thumbs: p.thumbs || null
    },
    render: current ? {
      status: r.status, pct: r.pct || 0, stage: r.stage || '',
      done: r.status === 'done', failed: r.status === 'error',
      vimeo: !!r.vimeoLink, audio: !!r.mp3Id
    } : null,
    updatedAt: e.updatedAt
  };
}

// ---------- create ----------

export async function create({ file, notes, d, duration, user, origin }) {
  if (!file || !file.name || !(file.size > 0)) throw new UserError('Drop a video recording to start.');
  const root = await workingRoot();
  const det = cleanDetails(d);
  const folder = await G.createFolder(root, det.coll + ' ' + det.date + ' · ' + String(file.name).slice(0, 120), { md: 'message', open: '1' });
  const ext = N.fileExt(file.name);
  const type = file.type || MIME[ext] || 'application/octet-stream';
  const originalUrl = await G.startResumable({ parentId: folder.id, name: file.name, mimeType: type, size: file.size, origin, appProperties: { md: 'original' } });
  const noteRows = [];
  for (const n of (notes || []).slice(0, 10)) {
    noteRows.push({
      name: String(n.name).slice(0, 200), size: n.size || 0, type: n.type || 'application/octet-stream',
      uploaded: false, fileId: null,
      sessionUrl: await G.startResumable({ parentId: folder.id, name: n.name, mimeType: n.type, size: n.size, origin, appProperties: { md: 'notes' } })
    });
  }
  const m = {
    id: folder.id, folder, kids: [], ids: {}, prepare: null, render: null,
    edit: {
      v: 1, createdAt: new Date().toISOString(), createdBy: user.email, updatedAt: null,
      file: { name: file.name, size: file.size, type, lastModified: file.lastModified || null, ext },
      original: { uploaded: false, fileId: null, sessionUrl: originalUrl, sessionAt: Date.now() },
      notes: noteRows,
      d: det, segs: null, fps: null, duration: +duration || 0,
      renderSegs: null, renderRequestId: null, renderDispatched: false,
      filing: null, webflow: null, status: 'editing'
    }
  };
  await saveEdit(m);
  return m;
}

// ---------- uploads ----------

function uploadTarget(m, kind, idx) {
  if (kind === 'original') return m.edit.original;
  const n = m.edit.notes[+idx];
  if (!n) throw new UserError('That notes file is no longer attached.');
  return n;
}

// Server-side check of how far an upload got. Starts a fresh session when an old one expired.
export async function uploadOffset(m, { kind, idx }, origin) {
  const t = uploadTarget(m, kind, idx);
  if (t.uploaded) return { done: true, offset: kind === 'original' ? m.edit.file.size : t.size };
  const size = kind === 'original' ? m.edit.file.size : t.size;
  let st = await G.uploadStatus(t.sessionUrl, size);
  if (st.expired) {
    const parent = kind === 'notes' && m.edit.filing ? m.edit.filing.originalFolderId : m.id;
    t.sessionUrl = await G.startResumable({
      parentId: parent, name: kind === 'original' ? m.edit.file.name : t.name,
      mimeType: kind === 'original' ? m.edit.file.type : t.type, size, origin,
      appProperties: { md: kind === 'original' ? 'original' : 'notes' }
    });
    await saveEdit(m);
    return { done: false, offset: 0, sessionUrl: t.sessionUrl };
  }
  if (st.done && st.file) { await markUploaded(m, { kind, idx, fileId: st.file.id }); return { done: true, offset: size }; }
  return { done: false, offset: st.offset, sessionUrl: t.sessionUrl };
}

export async function markUploaded(m, { kind, idx, fileId }) {
  const t = uploadTarget(m, kind, idx);
  const f = await G.getFile(fileId);
  if (!f || f.trashed) throw new UserError('The upload did not arrive. Try again.');
  const size = kind === 'original' ? m.edit.file.size : t.size;
  if (size && f.size && +f.size !== +size) throw new UserError('The upload did not finish. Try again.');
  t.uploaded = true;
  t.fileId = f.id;
  t.sessionUrl = null;
  if (m.edit.filing) await fileToLibrary(m);
  await saveEdit(m);
  if (kind === 'original') {
    await startPrepare(m);
    if (m.edit.renderRequestId && !m.edit.renderDispatched) await startRender(m);
  }
}

export async function addNotes(m, files, origin) {
  const parent = m.edit.filing ? m.edit.filing.originalFolderId : m.id;
  const added = [];
  for (const n of (files || []).slice(0, 10)) {
    const row = {
      name: String(n.name).slice(0, 200), size: n.size || 0, type: n.type || 'application/octet-stream', uploaded: false, fileId: null,
      sessionUrl: await G.startResumable({ parentId: parent, name: n.name, mimeType: n.type, size: n.size, origin, appProperties: { md: 'notes' } })
    };
    m.edit.notes.push(row);
    added.push(m.edit.notes.length - 1);
  }
  await saveEdit(m);
  return added;
}

export async function removeNote(m, idx) {
  const n = m.edit.notes[+idx];
  if (!n) return;
  if (n.fileId) { try { await G.trashFile(n.fileId); } catch (e) { /* already gone */ } }
  m.edit.notes.splice(+idx, 1);
  if (m.edit.filing) m.edit.filing.original = filingOriginalNames(m);
  await saveEdit(m);
}

// ---------- edits and render ----------

export async function saveChanges(m, body) {
  if (body.d) m.edit.d = cleanDetails(body.d, m.edit.d);
  if ('segs' in body) m.edit.segs = cleanSegs(body.segs, m.edit.duration);
  if (body.fps && !m.prepare?.fps) m.edit.fps = Math.min(240, Math.max(1, +body.fps)) || null;
  if (body.duration && !m.edit.duration) m.edit.duration = +body.duration || 0;
  await saveEdit(m);
}

async function startPrepare(m) {
  m.prepare = { status: 'queued', pct: 0, queuedAt: new Date().toISOString() };
  await savePrepare(m);
  await dispatch('prepare.yml', { message_id: m.id });
}

async function startRender(m) {
  m.edit.renderDispatched = true;
  await saveEdit(m);
  await dispatch('render.yml', { message_id: m.id, request_id: m.edit.renderRequestId });
}

export async function requestRender(m, body) {
  if (body.d) m.edit.d = cleanDetails(body.d, m.edit.d);
  m.edit.segs = cleanSegs(body.segs, m.edit.duration);
  m.edit.renderSegs = m.edit.segs;
  m.edit.renderRequestId = Date.now().toString(36);
  m.edit.renderDispatched = false;
  m.render = { ...(m.render || {}), status: 'queued', pct: 0, stage: '', error: null, requestId: m.edit.renderRequestId, queuedAt: new Date().toISOString() };
  await saveRender(m);
  if (m.edit.original.uploaded) await startRender(m);
  else await saveEdit(m);
}

// ---------- Drive filing ----------

function filingOriginalNames(m) {
  const f = m.edit.filing;
  return [f.base + '.' + m.edit.file.ext].concat(m.edit.notes.map((n) => n.name));
}

// Idempotent: files the original, notes and final edits into
// 01_SLC Media Library > year > collection > ##_CODE_YYYY_MM_DD > Original / Final edit
export async function fileToLibrary(m) {
  const d = m.edit.d;
  const { y } = N.splitDate(d.date);
  const yearF = (await G.ensureFolder(CONFIG.libraryFolderId, y)).folder;
  const collName = N.collectionFolderName(d.coll, y);
  const collF = (await G.ensureFolder(yearF.id, collName)).folder;
  const meetings = await G.listChildren(collF.id, true);
  const prev = m.edit.filing;

  let meeting = null, created = false;
  if (prev && prev.meetingFolderId) {
    const f = meetings.find((x) => x.id === prev.meetingFolderId);
    if (f && N.findSameDateFolder([f], d.date)) meeting = f;
  }
  if (!meeting) meeting = N.findSameDateFolder(meetings, d.date);
  if (!meeting) {
    meeting = await G.createFolder(collF.id, N.meetingFolderName(N.nextNumber(meetings.map((f) => f.name)), d.coll, d.date));
    created = true;
  }
  const sub = await G.listChildren(meeting.id, true);
  const origF = (await G.ensureFolder(meeting.id, 'Original', sub)).folder;
  const finalF = (await G.ensureFolder(meeting.id, 'Final edit', sub)).folder;

  const own = new Set([m.edit.original.fileId, ...m.edit.notes.map((n) => n.fileId)].filter(Boolean));
  const origKids = await G.listChildren(origF.id);
  const part = N.choosePart(d.coll, d.date, d.part, m.edit.file.ext, origKids.filter((f) => !own.has(f.id)).map((f) => f.name));
  if (part !== d.part) d.part = part;
  const base = N.baseName(d.coll, d.date, part);

  const fileById = async (id) => m.kids.find((k) => k.id === id) || origKids.find((k) => k.id === id) || await G.getFile(id);
  if (m.edit.original.fileId) await G.placeFile(await fileById(m.edit.original.fileId), origF.id, base + '.' + m.edit.file.ext);
  for (const n of m.edit.notes) if (n.fileId) await G.placeFile(await fileById(n.fileId), origF.id, n.name);
  const r = m.render || {};
  if (r.mp4Id) { const f = await G.getFile(r.mp4Id); if (f && !f.trashed) await G.placeFile(f, finalF.id, base + '.mp4'); }
  if (r.mp3Id) { const f = await G.getFile(r.mp3Id); if (f && !f.trashed) await G.placeFile(f, finalF.id, base + '.mp3'); }

  // A folder this post created earlier, left empty after the date or collection changed
  if (prev && prev.createdMeetingFolder && prev.meetingFolderId && prev.meetingFolderId !== meeting.id) {
    try {
      const left = await G.listChildren(prev.meetingFolderId);
      const empty = await Promise.all(left.map(async (f) => f.mimeType === G.FOLDER && (await G.listChildren(f.id)).length === 0));
      if (empty.every(Boolean)) await G.trashFile(prev.meetingFolderId);
    } catch (e) { /* leave it */ }
  }

  m.edit.filing = {
    yearFolderId: yearF.id, collectionFolderId: collF.id, meetingFolderId: meeting.id,
    originalFolderId: origF.id, finalFolderId: finalF.id,
    createdMeetingFolder: created || !!(prev && prev.createdMeetingFolder && prev.meetingFolderId === meeting.id),
    base, path: ['01_SLC Media Library', y, collName], folder: meeting.name, original: [], final: [base + '.mp4', base + '.mp3']
  };
  m.edit.filing.original = filingOriginalNames(m);
}

// ---------- Webflow ----------

async function notesForSite(m, wf) {
  const out = { file: null, link: null };
  const first = m.edit.notes.find((n) => n.fileId);
  if (first) {
    if (wf.notesAsset && wf.notesAsset.fileId === first.fileId) out.file = { fileId: wf.notesAsset.assetId, url: wf.notesAsset.url };
    else {
      try {
        const buf = await G.downloadBuffer(first.fileId);
        const a = await W.uploadAsset(first.name, buf, first.type);
        wf.notesAsset = { fileId: first.fileId, assetId: a.id, url: a.url };
        out.file = { fileId: a.id, url: a.url };
      } catch (e) {
        console.error('notes asset', e.message);
        await G.shareAnyoneReader(first.fileId).catch(() => {});
        out.link = G.driveViewLink(first.fileId);
      }
    }
  }
  const second = m.edit.notes.filter((n) => n.fileId)[1];
  if (!out.link && second) {
    await G.shareAnyoneReader(second.fileId).catch(() => {});
    out.link = G.driveViewLink(second.fileId);
  }
  return out;
}

function fieldData(m, slug, notes) {
  const d = m.edit.d, r = renderDone(m) ? m.render : {};
  const f = {
    name: N.title(d),
    slug,
    'name-of-speaker-s': d.speakers.join(', ') || null,
    'topic-tags': d.tags.join(', ') || null,
    'date-of-message': d.date + 'T00:00:00.000Z',
    'video---english': r.vimeoLink || null,
    'video---spanish': d.esv || null,
    'video---japanese': d.jav || null,
    'audio---english': r.mp3Id ? G.driveViewLink(r.mp3Id) : null,
    'audio---spanish': d.esa || null,
    'audio---japanese': d.jaa || null,
    'optional-short-description': d.desc || null,
    'notes-document-from-session': notes.file,
    'optional-linked-resource': d.res || notes.link || null
  };
  if (d.coll === 'Sunday') {
    f['featured-message'] = !!d.featured;
    f['hide-from-sunday-collection'] = !!d.hide;
    f['sequence-of-appearance'] = d.seq ? parseInt(d.seq, 10) : null;
  }
  return f;
}

async function freeSlug(cid, want, ownId) {
  let s = want || 'message';
  for (let i = 2; i < 30; i++) {
    const hits = await W.findBySlug(cid, s);
    if (!hits.some((h) => h.id !== ownId)) return s;
    s = want + '-' + i;
  }
  return want + '-' + Date.now().toString(36);
}

export async function syncWebflow(m, { live = false } = {}) {
  const d = m.edit.d;
  const c = CONFIG.webflow.collections[d.coll];
  const wf = m.edit.webflow || {};
  if (wf.itemId && wf.collectionId !== c.id) {
    try { await W.deleteItem(wf.collectionId, wf.itemId); } catch (e) { console.error('old item', e.message); }
    delete wf.itemId;
    delete wf.publishedAt;
  }
  const slug = await freeSlug(c.id, N.slug(d), wf.itemId);
  if (slug !== N.slug(d)) { d.slug = slug; d.slugEdited = true; }
  const notes = await notesForSite(m, wf);
  const fd = fieldData(m, slug, notes);
  if (!wf.itemId) {
    const clean = Object.fromEntries(Object.entries(fd).filter(([, v]) => v !== null));
    const item = await W.createItem(c.id, clean, !live);
    wf.itemId = item.id;
  } else {
    await W.updateItem(c.id, wf.itemId, fd, live ? false : (wf.publishedAt ? false : true));
  }
  wf.collectionId = c.id;
  wf.syncedRender = renderDone(m) ? m.render.requestId : null;
  if (live) {
    await W.publishItems(c.id, [wf.itemId]);
    wf.publishedAt = new Date().toISOString();
  }
  m.edit.webflow = wf;
}

async function syncVimeoTitle(m) {
  if (!renderDone(m) || !m.render.vimeoId) return;
  const want = N.title(m.edit.d);
  if (m.edit.vimeoTitle === want) return;
  try { await renameVideo(m.render.vimeoId, want); m.edit.vimeoTitle = want; } catch (e) { console.error('vimeo title', e.message); }
}

// ---------- finish and publish ----------

export async function finish(m, body) {
  if (body.d) m.edit.d = cleanDetails(body.d, m.edit.d);
  if (!m.edit.d.date) throw new UserError('Add the date of the message.');
  await fileToLibrary(m);
  await syncWebflow(m);
  await syncVimeoTitle(m);
  if (m.edit.status !== 'published') m.edit.status = 'finished';
  await saveEdit(m);
  try { await G.updateFile(m.id, { name: N.title(m.edit.d) + ' · ' + m.edit.d.date }); } catch (e) { /* cosmetic */ }
}

export async function publish(m) {
  if (!renderDone(m)) throw new UserError('The video is still being prepared. Publish once it is ready.', 409);
  await fileToLibrary(m);
  await syncVimeoTitle(m);
  await syncWebflow(m, { live: true });
  m.edit.status = 'published';
  await saveEdit(m);
  try { await G.updateFile(m.id, { appProperties: { md: 'message', open: '0' } }); } catch (e) { /* listing only */ }
}

// Keeps Drive and the website draft in step after background jobs finish.
export async function heal(m) {
  let changed = false;
  const done = renderDone(m);
  if (done && m.edit.filing) {
    const inWorking = m.kids.some((k) => k.id === m.render.mp4Id || k.id === m.render.mp3Id || k.id === m.edit.original.fileId);
    if (inWorking) { await fileToLibrary(m); changed = true; }
  }
  if (done && m.edit.webflow && m.edit.webflow.itemId && m.edit.webflow.syncedRender !== m.render.requestId && !m.edit.webflow.publishedAt) {
    await syncWebflow(m);
    await syncVimeoTitle(m);
    changed = true;
  }
  // Preview went missing (cleaned up after publishing, or never started)
  if (m.edit.original.uploaded && (!m.prepare || (m.prepare.status === 'done' && m.prepare.proxyId && !m.kids.some((k) => k.id === m.prepare.proxyId)))) {
    await startPrepare(m);
  }
  if (m.edit.renderRequestId && !m.edit.renderDispatched && m.edit.original.uploaded) { await startRender(m); }
  if (changed) await saveEdit(m);
}

export async function listOpen() {
  const folders = await G.listFiles("appProperties has { key='md' and value='message' } and appProperties has { key='open' and value='1' } and trashed = false", 'id,name,modifiedTime');
  folders.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  const out = [];
  for (const f of folders.slice(0, 8)) {
    try { out.push(view(await load(f.id))); } catch (e) { /* skip broken */ }
  }
  return out;
}
