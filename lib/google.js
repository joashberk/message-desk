// Google Drive access as sentlifecenter.tech@gmail.com, using that account's long-lived
// refresh token from the environment. Used by the website server and the render workers.
import { env } from './config.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';

let cached = null;

export async function accessToken(force = false) {
  if (!force && cached && cached.exp > Date.now() + 120000) return cached.token;
  const body = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    client_secret: env('GOOGLE_CLIENT_SECRET'),
    refresh_token: env('GOOGLE_REFRESH_TOKEN'),
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const e = new Error('Google sign-in for Drive failed (' + (j.error || r.status) + ')');
    e.code = 'DRIVE_AUTH';
    throw e;
  }
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

export function tokenInfo() { return cached ? { access_token: cached.token, expires_at: cached.exp } : null; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Generic Google API call with retries on rate limits and server errors.
export async function gfetch(url, opts = {}, tries = 5) {
  for (let i = 0; ; i++) {
    const token = await accessToken(i > 0 && opts._authRetry);
    const headers = { Authorization: 'Bearer ' + token, ...(opts.headers || {}) };
    let r;
    try {
      r = await fetch(url, { ...opts, headers });
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(1000 * 2 ** i);
      continue;
    }
    if (r.status === 401 && i < tries - 1) { opts._authRetry = true; continue; }
    if ((r.status === 429 || r.status >= 500 || r.status === 403 && /rateLimit/i.test(await peek(r))) && i < tries - 1) {
      await sleep(1000 * 2 ** i + Math.random() * 500);
      continue;
    }
    return r;
  }
}
async function peek(r) { try { return await r.clone().text(); } catch (e) { return ''; } }

async function ok(r, what) {
  if (r.ok) return r;
  const t = await r.text().catch(() => '');
  const e = new Error((what || 'Drive request') + ' failed: ' + r.status + ' ' + t.slice(0, 300));
  e.status = r.status;
  throw e;
}

function qs(o) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p.toString();
}

const ALL = { supportsAllDrives: true };
export const FILE_FIELDS = 'id,name,mimeType,size,parents,appProperties,md5Checksum,webViewLink,trashed,modifiedTime,createdTime';

export function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

export async function listFiles(query, fields = FILE_FIELDS) {
  const out = [];
  let pageToken;
  do {
    const r = await ok(await gfetch(DRIVE + '/files?' + qs({
      q: query, fields: 'nextPageToken,files(' + fields + ')', pageSize: 1000, pageToken,
      includeItemsFromAllDrives: true, supportsAllDrives: true, spaces: 'drive'
    })), 'List files');
    const j = await r.json();
    out.push(...j.files);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

export function listChildren(parentId, onlyFolders = false) {
  return listFiles(q(parentId) + ' in parents and trashed = false' + (onlyFolders ? ' and mimeType = ' + q(FOLDER) : ''));
}

export async function getFile(id, fields = FILE_FIELDS) {
  const r = await gfetch(DRIVE + '/files/' + id + '?' + qs({ fields, ...ALL }));
  if (r.status === 404) return null;
  await ok(r, 'Get file');
  return r.json();
}

export async function createFolder(parentId, name, appProperties) {
  const r = await ok(await gfetch(DRIVE + '/files?' + qs({ fields: FILE_FIELDS, ...ALL }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId], appProperties })
  }), 'Create folder');
  return r.json();
}

// Returns { folder, created }
export async function ensureFolder(parentId, name, existingChildren) {
  const kids = existingChildren || await listFiles(q(parentId) + ' in parents and trashed = false and mimeType = ' + q(FOLDER) + ' and name = ' + q(name));
  const hit = kids.find((f) => f.name === name && f.mimeType === FOLDER);
  if (hit) return { folder: hit, created: false };
  return { folder: await createFolder(parentId, name), created: true };
}

export async function updateFile(id, { name, addParents, removeParents, appProperties, description } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (appProperties) body.appProperties = appProperties;
  if (description !== undefined) body.description = description;
  const r = await ok(await gfetch(DRIVE + '/files/' + id + '?' + qs({ fields: FILE_FIELDS, addParents, removeParents, ...ALL }), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), 'Update file');
  return r.json();
}

// Moves a file into a folder (and renames it) only when something differs.
export async function placeFile(file, folderId, name) {
  const inPlace = (file.parents || []).length === 1 && file.parents[0] === folderId;
  if (inPlace && (!name || file.name === name)) return file;
  return updateFile(file.id, {
    name: name || undefined,
    addParents: inPlace ? undefined : folderId,
    removeParents: inPlace ? undefined : (file.parents || []).join(',') || undefined
  });
}

export async function trashFile(id) {
  await ok(await gfetch(DRIVE + '/files/' + id + '?' + qs(ALL), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
  }), 'Trash file');
}

export async function readJson(id) {
  const r = await gfetch(DRIVE + '/files/' + id + '?' + qs({ alt: 'media', ...ALL }));
  if (r.status === 404) return null;
  await ok(r, 'Read data');
  return r.json();
}

export async function downloadBuffer(id) {
  const r = await ok(await gfetch(DRIVE + '/files/' + id + '?' + qs({ alt: 'media', ...ALL })), 'Download');
  return Buffer.from(await r.arrayBuffer());
}

// Creates or overwrites a small JSON file. Returns the file id.
export async function writeJson(parentId, name, data, existingId) {
  const body = JSON.stringify(data, null, 1);
  if (existingId) {
    const r = await gfetch(UPLOAD + '/files/' + existingId + '?' + qs({ uploadType: 'media', fields: 'id', ...ALL }), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
    });
    if (r.ok) return (await r.json()).id;
    if (r.status !== 404) await ok(r, 'Save data');
  }
  const boundary = 'mdb' + Math.random().toString(36).slice(2);
  const multipart =
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({ name, parents: [parentId], mimeType: 'application/json' }) + '\r\n' +
    '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + body + '\r\n--' + boundary + '--';
  const r = await ok(await gfetch(UPLOAD + '/files?' + qs({ uploadType: 'multipart', fields: 'id', ...ALL }), {
    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart
  }), 'Save data');
  return (await r.json()).id;
}

// Starts a resumable upload session. The returned URL is used directly by the browser
// (or a worker) to send the bytes; it needs no other credentials. Pass `origin` when a
// browser will upload so Google answers its cross-site requests.
export async function startResumable({ parentId, name, mimeType, size, origin, fileId, appProperties }) {
  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType || 'application/octet-stream'
  };
  if (size != null) headers['X-Upload-Content-Length'] = String(size);
  if (origin) headers.Origin = origin;
  const url = fileId
    ? UPLOAD + '/files/' + fileId + '?' + qs({ uploadType: 'resumable', fields: 'id,name,size', ...ALL })
    : UPLOAD + '/files?' + qs({ uploadType: 'resumable', fields: 'id,name,size', ...ALL });
  const meta = fileId ? (name ? { name } : {}) : { name, parents: [parentId], appProperties };
  const r = await ok(await gfetch(url, { method: fileId ? 'PATCH' : 'POST', headers, body: JSON.stringify(meta) }), 'Start upload');
  const loc = r.headers.get('location');
  if (!loc) throw new Error('Upload session missing');
  return loc;
}

// Asks Google how much of a resumable upload has arrived.
// Returns { offset, done, file, expired }
export async function uploadStatus(sessionUrl, size) {
  const r = await fetch(sessionUrl, { method: 'PUT', headers: { 'Content-Range': 'bytes */' + size, 'Content-Length': '0' } });
  if (r.status === 200 || r.status === 201) return { offset: size, done: true, file: await r.json().catch(() => null) };
  if (r.status === 308) {
    const range = r.headers.get('range');
    const m = range && /bytes=0-(\d+)/.exec(range);
    return { offset: m ? parseInt(m[1], 10) + 1 : 0, done: false };
  }
  if (r.status === 404 || r.status === 410) return { offset: 0, done: false, expired: true };
  throw new Error('Upload status ' + r.status);
}

export async function shareAnyoneReader(id) {
  const r = await gfetch(DRIVE + '/files/' + id + '/permissions?' + qs({ ...ALL, fields: 'id' }), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false })
  });
  await ok(r, 'Share file');
}

export function driveViewLink(id) { return 'https://drive.google.com/file/d/' + id + '/view?usp=drive_link'; }
