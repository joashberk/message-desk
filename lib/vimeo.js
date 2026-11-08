// Vimeo API with the token from VIMEO_TOKEN.
import { env } from './config.js';

const API = 'https://api.vimeo.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function vimeo(method, path, body, tries = 5) {
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch(path.startsWith('http') ? path : API + path, {
        method,
        headers: {
          Authorization: 'bearer ' + env('VIMEO_TOKEN'),
          'Content-Type': 'application/json',
          Accept: 'application/vnd.vimeo.*+json;version=3.4'
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(2000 * 2 ** i);
      continue;
    }
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep(3000 * 2 ** i); continue; }
    const text = await r.text();
    const j = text ? JSON.parse(text) : null;
    if (!r.ok) {
      const e = new Error('Vimeo ' + r.status + ': ' + (j && (j.developer_message || j.error) || text).toString().slice(0, 300));
      e.status = r.status;
      throw e;
    }
    return j;
  }
}

export function videoIdFromUri(uri) { return String(uri || '').split('/').pop(); }

export async function renameVideo(id, name) {
  return vimeo('PATCH', '/videos/' + id, { name });
}
