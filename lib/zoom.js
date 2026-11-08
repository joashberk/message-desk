// Zoom cloud recordings → Message Desk drafts.
// Zoom calls /api/zoom/webhook when a recording is ready; a GitHub job then copies it to Drive.
import crypto from 'node:crypto';
import { env } from './config.js';

export const ZOOM = {
  // Which meetings become drafts, by words in the Zoom meeting name. Anything else is ignored.
  match: [
    { coll: 'Hebron', re: /\bhebron\b/i },
    { coll: 'Charis', re: /\bcharis\b|x-?elle|\bcx\b/i },
    { coll: 'Sunday', re: /\bsunday\b/i }
  ],
  minMinutes: 5,
  // Once the copy in Drive is confirmed, move the Zoom recording to Zoom's trash (recoverable for 30 days)
  trashAfterCopy: true,
  // Preferred video layouts, best first
  layouts: ['shared_screen_with_speaker_view', 'shared_screen_with_speaker_view(CC)', 'speaker_view', 'active_speaker', 'shared_screen_with_gallery_view', 'gallery_view', 'shared_screen']
};

export function collectionFor(topic) {
  const hit = ZOOM.match.find((x) => x.re.test(String(topic || '')));
  return hit ? hit.coll : null;
}

export function pickFile(files) {
  const mp4 = (files || []).filter((f) => String(f.file_type).toUpperCase() === 'MP4' && (f.status || 'completed') === 'completed');
  if (!mp4.length) return null;
  const rank = (f) => { const i = ZOOM.layouts.indexOf(f.recording_type); return i < 0 ? 99 : i; };
  return mp4.sort((a, b) => rank(a) - rank(b) || (b.file_size || 0) - (a.file_size || 0))[0];
}

// The meeting's calendar date where it happened
export function localDate(iso, tz) {
  const d = new Date(iso);
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch (e) { return d.toISOString().slice(0, 10); }
}

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Zoom signs every call with the app's secret token; anything unsigned or stale is refused.
export function verifyWebhook(raw, headers, now = Date.now()) {
  const ts = headers['x-zm-request-timestamp'], sig = headers['x-zm-signature'];
  if (!ts || !sig || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const want = 'v0=' + crypto.createHmac('sha256', env('ZOOM_WEBHOOK_SECRET')).update('v0:' + ts + ':' + raw).digest('hex');
  return safeEq(want, sig);
}

export function validationResponse(plainToken) {
  return { plainToken, encryptedToken: crypto.createHmac('sha256', env('ZOOM_WEBHOOK_SECRET')).update(String(plainToken)).digest('hex') };
}

export function encodeUuid(uuid) {
  const u = String(uuid);
  return u.startsWith('/') || u.includes('//') ? encodeURIComponent(encodeURIComponent(u)) : encodeURIComponent(u);
}

let tok = null;
export async function zoomToken() {
  if (tok && tok.exp > Date.now() + 60000) return tok.token;
  const basic = Buffer.from(env('ZOOM_CLIENT_ID') + ':' + env('ZOOM_CLIENT_SECRET')).toString('base64');
  const r = await fetch('https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' + encodeURIComponent(env('ZOOM_ACCOUNT_ID')), {
    method: 'POST', headers: { Authorization: 'Basic ' + basic }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Zoom sign-in failed (' + (j.reason || j.error || r.status) + ')');
  tok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.token;
}

export async function zoom(method, path) {
  const r = await fetch('https://api.zoom.us/v2' + path, { method, headers: { Authorization: 'Bearer ' + await zoomToken() } });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error('Zoom ' + r.status + ': ' + (j && j.message || '')); e.status = r.status; throw e; }
  return j;
}
