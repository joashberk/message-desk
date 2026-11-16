// Who else has a post open right now. Each open browser checks in every ~20 seconds; the
// check-ins live as small tags on the post's working folder in Drive, so no extra service is needed.
import * as G from './google.js';

const FRESH = 50 * 1000; // seen within this long = still here
const STALE = 60 * 60 * 1000; // tidy away check-ins older than this
const VIEWS = { edit: 1, details: 1, review: 1 };

const key = (device) => 'pr_' + String(device || '').replace(/[^\w]/g, '').slice(0, 16);

function parse(k, v) {
  const [ts, view, email, ...rest] = String(v).split('|');
  return { device: k.slice(3), at: parseInt(ts, 36) * 1000, view, email, name: rest.join('|') };
}

// Records this browser (unless it is leaving) and returns everyone else who is here.
export async function checkIn(id, user, { device, view, leaving } = {}) {
  if (!device || !/^[\w]{6,40}$/.test(device)) return { others: [] };
  const folder = await G.getFile(id, 'id,appProperties,trashed');
  if (!folder || folder.trashed || !folder.appProperties || folder.appProperties.md !== 'message') return { others: [] };
  const now = Date.now(), mine = key(device), props = {};
  const others = [];
  for (const [k, v] of Object.entries(folder.appProperties)) {
    if (!k.startsWith('pr_') || k === mine) continue;
    const p = parse(k, v);
    if (!(now - p.at < STALE)) props[k] = null;
    else if (now - p.at < FRESH) others.push({ name: p.name, email: p.email, view: p.view, you: p.email === user.email });
  }
  if (leaving) props[mine] = null;
  else {
    // Drive allows 124 bytes for a tag's name and value together
    let v = Math.floor(now / 1000).toString(36) + '|' + (VIEWS[view] ? view : 'edit') + '|' + user.email + '|' + (user.name || '');
    while (Buffer.byteLength(mine + v) > 120) v = v.slice(0, -1);
    props[mine] = v;
  }
  await G.updateFile(id, { appProperties: props });
  return { others };
}
