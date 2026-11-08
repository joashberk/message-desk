// Signed sign-in cookie. The signing key is derived from GOOGLE_CLIENT_SECRET so there is
// one fewer secret to manage.
import crypto from 'node:crypto';
import { env } from './config.js';

const COOKIE = 'md_session';
const DAYS = 30;

function key() {
  return crypto.createHmac('sha256', env('GOOGLE_CLIENT_SECRET')).update('message-desk-session-v1').digest();
}
function b64(buf) { return Buffer.from(buf).toString('base64url'); }

export function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = b64(crypto.createHmac('sha256', key()).update(body).digest());
  return body + '.' + mac;
}

export function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const want = b64(crypto.createHmac('sha256', key()).update(body).digest());
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}

export function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getUser(req) {
  return verify(readCookies(req)[COOKIE]);
}

function secure(req) {
  return (req.headers['x-forwarded-proto'] || '').includes('https') || process.env.VERCEL ? '; Secure' : '';
}

export function setUserCookie(req, res, user) {
  const token = sign({ email: user.email, name: user.name || '', exp: Date.now() + DAYS * 864e5 });
  appendCookie(res, COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + DAYS * 86400 + secure(req));
}

export function clearUserCookie(req, res) {
  appendCookie(res, COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure(req));
}

export function appendCookie(res, c) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
