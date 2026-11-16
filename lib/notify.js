// Phone and computer notifications ("ready to publish") using the browser's built-in push service.
// Free: no texting service. The notification itself carries no content; the device asks Message Desk
// what's new, so nothing about a post travels through Apple's or Google's push servers.
import crypto from 'node:crypto';
import * as G from './google.js';
import { workingRoot } from './messages.js';

const FILE = 'notifications.json';
const b64u = (buf) => Buffer.from(buf).toString('base64url');

async function loadStore() {
  const root = await workingRoot();
  const hits = await G.listFiles(G.q(root) + " in parents and name = 'notifications.json' and trashed = false", 'id,modifiedTime');
  hits.sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
  const id = hits[0] && hits[0].id;
  const data = (id && await G.readJson(id)) || {};
  data.subs = data.subs || [];
  return { root, id, data };
}
async function saveStore(s) { s.id = await G.writeJson(s.root, FILE, s.data, s.id); }

// The app's own signing key for the push services, made once and kept with the app's data in Drive.
async function vapid(s) {
  if (s.data.vapid) return s.data.vapid;
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  s.data.vapid = { jwk, publicKey: b64u(pub) };
  await saveStore(s);
  return s.data.vapid;
}

export async function publicKey() { return (await vapid(await loadStore())).publicKey; }

export async function subscribe(sub, email) {
  if (!sub || !/^https:\/\//.test(sub.endpoint || '')) throw new Error('Not a push subscription');
  const s = await loadStore();
  s.data.subs = s.data.subs.filter((x) => x.endpoint !== sub.endpoint);
  s.data.subs.push({ endpoint: sub.endpoint, email, addedAt: new Date().toISOString() });
  await saveStore(s);
}

export async function unsubscribe(endpoint) {
  const s = await loadStore();
  const before = s.data.subs.length;
  s.data.subs = s.data.subs.filter((x) => x.endpoint !== endpoint);
  if (s.data.subs.length !== before) await saveStore(s);
}

export async function isSubscribed(endpoint) {
  return (await loadStore()).data.subs.some((x) => x.endpoint === endpoint);
}

// What a device shows when it's woken up. Only devices that turned notifications on get an answer.
export async function latestFor(endpoint) {
  const s = await loadStore();
  if (!s.data.subs.some((x) => x.endpoint === endpoint)) return null;
  return s.data.last || null;
}

function jwt(aud, key) {
  const enc = (o) => b64u(JSON.stringify(o));
  const body = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:sentlifecenter.tech@gmail.com' });
  const sig = crypto.sign('sha256', Buffer.from(body), { key: crypto.createPrivateKey({ key: key.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return body + '.' + b64u(sig);
}

async function send(sub, key) {
  const aud = new URL(sub.endpoint).origin;
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { TTL: '86400', Urgency: 'high', Authorization: 'vapid t=' + jwt(aud, key) + ', k=' + key.publicKey, 'Content-Length': '0' }
    });
    return r.status;
  } catch (e) { return 0; }
}

// The approved team emails and the app's address, saved for the render jobs (which can't see Vercel's settings).
export async function rememberTeam(emails, appUrl) {
  const s = await loadStore();
  const team = [...new Set(emails.map((e) => e.toLowerCase()))].sort();
  if (JSON.stringify(s.data.team) === JSON.stringify(team) && s.data.appUrl === appUrl) return;
  s.data.team = team;
  s.data.appUrl = appUrl;
  await saveStore(s);
}

const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One email to the whole approved team, sent from sentlifecenter.tech@gmail.com.
export async function emailTeam(note) {
  const s = await loadStore();
  const team = s.data.team || [];
  if (!team.length || !s.data.appUrl) return 0;
  const link = s.data.appUrl + note.url;
  const subject = note.title + ': ' + (note.name || '');
  const html = '<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c1c1e">' +
    '<p>' + escHtml(note.body) + '</p>' +
    '<p><a href="' + escHtml(link) + '" style="display:inline-block;background:#2f5bea;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">' + escHtml(note.button || 'Open Message Desk') + '</a></p>' +
    '<p style="color:#6c6c72;font-size:12px">Sent by Message Desk to the SENT Life Center tech team.</p></div>';
  const enc = (t) => '=?UTF-8?B?' + Buffer.from(t).toString('base64') + '?=';
  const boundary = 'md' + crypto.randomBytes(8).toString('hex');
  const raw = [
    'From: Message Desk <sentlifecenter.tech@gmail.com>',
    'To: sentlifecenter.tech@gmail.com',
    'Bcc: ' + team.join(', '),
    'Subject: ' + enc(subject),
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    note.body + '\n\n' + (note.button || 'Open Message Desk') + ': ' + link,
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    '--' + boundary + '--'
  ].join('\r\n');
  const r = await G.gfetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') })
  });
  if (r.status === 403 || r.status === 401) throw new Error('email not allowed yet');
  if (!r.ok) throw new Error('email ' + r.status);
  return team.length;
}

// note: { title, body, url }. Optionally only to one person's devices.
export async function notify(note, onlyEmail) {
  const s = await loadStore();
  const key = await vapid(s);
  s.data.last = { ...note, at: new Date().toISOString() };
  const targets = s.data.subs.filter((x) => !onlyEmail || x.email === onlyEmail);
  const gone = [];
  let sent = 0;
  for (const sub of targets) {
    const status = await send(sub, key);
    if (status === 404 || status === 410) gone.push(sub.endpoint);
    else if (status >= 200 && status < 300) sent++;
  }
  s.data.subs = s.data.subs.filter((x) => !gone.includes(x.endpoint));
  await saveStore(s);
  return sent;
}
