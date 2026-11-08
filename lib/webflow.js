// Webflow CMS (Data API v2) using the site token from WEBFLOW_TOKEN.
import crypto from 'node:crypto';
import { CONFIG, env } from './config.js';

const API = 'https://api.webflow.com/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function wf(method, path, body, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(API + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + env('WEBFLOW_TOKEN'),
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      const wait = parseInt(r.headers.get('retry-after') || '0', 10) * 1000 || 1500 * 2 ** i;
      await sleep(wait);
      continue;
    }
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch (e) { j = { raw: text }; }
    if (!r.ok) {
      const e = new Error('Website update failed: ' + r.status + ' ' + (j && (j.message || j.msg) || '') + ' ' + JSON.stringify(j && j.details || '').slice(0, 300));
      e.status = r.status;
      e.body = j;
      throw e;
    }
    return j;
  }
}

export async function listAllItems(collectionId) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const j = await wf('GET', '/collections/' + collectionId + '/items?limit=100&offset=' + offset);
    out.push(...(j.items || []));
    if (!j.items || j.items.length < 100) break;
  }
  return out;
}

export async function findBySlug(collectionId, slug) {
  const j = await wf('GET', '/collections/' + collectionId + '/items?slug=' + encodeURIComponent(slug));
  return (j.items || []).filter((it) => it.fieldData && it.fieldData.slug === slug);
}

export const createItem = (cid, fieldData, isDraft = true) =>
  wf('POST', '/collections/' + cid + '/items', { isArchived: false, isDraft, fieldData });

export const updateItem = (cid, id, fieldData, isDraft) =>
  wf('PATCH', '/collections/' + cid + '/items/' + id, isDraft === undefined ? { fieldData } : { isDraft, fieldData });

export const getItem = (cid, id) => wf('GET', '/collections/' + cid + '/items/' + id);

export const deleteItem = (cid, id) => wf('DELETE', '/collections/' + cid + '/items/' + id);

export const publishItems = (cid, ids) => wf('POST', '/collections/' + cid + '/items/publish', { itemIds: ids });

// Uploads a file (Buffer) to the site's assets so it can be used in a File field.
export async function uploadAsset(fileName, buf, contentType) {
  const fileHash = crypto.createHash('md5').update(buf).digest('hex');
  const a = await wf('POST', '/sites/' + CONFIG.webflow.siteId + '/assets', { fileName, fileHash });
  const form = new FormData();
  for (const [k, v] of Object.entries(a.uploadDetails || {})) form.append(k, v);
  form.append('file', new Blob([buf], { type: contentType || 'application/octet-stream' }), fileName);
  const r = await fetch(a.uploadUrl, { method: 'POST', body: form });
  if (!r.ok && r.status !== 201 && r.status !== 204) throw new Error('Notes upload to the website failed: ' + r.status);
  return { id: a.id, url: a.hostedUrl || a.assetUrl };
}

// Speakers and tags already used on the site, most used first.
let optionsCache = null;
export async function siteOptions() {
  if (optionsCache && optionsCache.at > Date.now() - 10 * 60 * 1000) return optionsCache.data;
  const count = (map, raw) => {
    for (const s of String(raw || '').split(',')) {
      const v = s.trim().replace(/\s+/g, ' ');
      if (!v) continue;
      const k = v.toLowerCase();
      const cur = map.get(k);
      if (cur) cur.n++; else map.set(k, { v, n: 1 });
    }
  };
  const speakers = new Map(), tags = new Map();
  const cols = Object.values(CONFIG.webflow.collections);
  const lists = await Promise.all(cols.map((c) => listAllItems(c.id)));
  for (const items of lists) for (const it of items) {
    count(speakers, it.fieldData['name-of-speaker-s']);
    count(tags, it.fieldData['topic-tags']);
  }
  try {
    for (const it of await listAllItems(CONFIG.webflow.speakersCollectionId)) {
      const v = (it.fieldData.name || '').trim();
      if (v && !speakers.has(v.toLowerCase())) speakers.set(v.toLowerCase(), { v, n: 0 });
    }
  } catch (e) { /* the Speakers list is a bonus */ }
  const sort = (m) => [...m.values()].sort((a, b) => b.n - a.n || a.v.localeCompare(b.v)).map((x) => x.v);
  const data = { speakers: sort(speakers), tags: sort(tags) };
  optionsCache = { at: Date.now(), data };
  return data;
}
