// One serverless function handles every /api route (Vercel's free plan limits the number of functions).
import { CONFIG, allowedEmails, env } from '../lib/config.js';
import { getUser, setUserCookie, clearUserCookie, sign, verify } from '../lib/session.js';
import * as G from '../lib/google.js';
import * as M from '../lib/messages.js';
import { siteOptions } from '../lib/webflow.js';
import * as Z from '../lib/zoom.js';
import { dispatch } from '../lib/github.js';
import { quota as vimeoQuota } from '../lib/vimeo.js';

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}
function html(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}
function redirect(res, url) { res.statusCode = 302; res.setHeader('Location', url); res.end(); }

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return req.body ? JSON.stringify(req.body) : '';
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString();
  try { return t ? JSON.parse(t) : {}; } catch (e) { return {}; }
}

function origin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || (host && host.startsWith('localhost') ? 'http' : 'https')).split(',')[0];
  return proto + '://' + host;
}

// Friendly wording for anything that goes wrong. Details stay in the server log.
function friendly(e) {
  if (e.userMessage) return e.userMessage;
  if (e.code === 'MISSING_ENV') return 'Message Desk is not fully set up yet. Ask the tech lead to finish setup.';
  if (e.code === 'DRIVE_AUTH') return 'Message Desk lost its connection to Google Drive. Ask the tech lead to reconnect it.';
  return 'Something went wrong. Check your connection and try again.';
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  try {
    // ----- public routes -----
    if (path === '/config' && req.method === 'GET') {
      const u = getUser(req);
      const ok = u && allowedEmails().includes(u.email.toLowerCase());
      return send(res, 200, { clientId: process.env.GOOGLE_CLIENT_ID || '', user: ok ? { email: u.email, name: u.name } : null });
    }
    if (path === '/auth/google' && req.method === 'POST') {
      const { credential } = await readBody(req);
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential || ''));
      const t = await r.json().catch(() => ({}));
      const good = r.ok && t.aud === env('GOOGLE_CLIENT_ID') && /accounts\.google\.com$/.test(t.iss || '') && String(t.email_verified) === 'true';
      if (!good) return send(res, 401, { error: 'Google sign-in did not work. Try again.' });
      if (!allowedEmails().includes(String(t.email).toLowerCase())) {
        return send(res, 403, { error: t.email + " isn't on the Message Desk team list. Ask the tech lead to add you." });
      }
      setUserCookie(req, res, { email: t.email, name: t.name || t.given_name || '' });
      return send(res, 200, { user: { email: t.email, name: t.name || '' } });
    }
    if (path === '/auth/signout' && req.method === 'POST') { clearUserCookie(req, res); return send(res, 200, { ok: true }); }
    // Zoom says a cloud recording is ready. Must answer within 3 seconds, so the copying happens on GitHub.
    if (path === '/zoom/webhook' && req.method === 'POST') {
      const raw = await readRaw(req);
      let b;
      try { b = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'bad request' }); }
      if (!Z.verifyWebhook(raw, req.headers)) return send(res, 401, { error: 'not signed' });
      if (b.event === 'endpoint.url_validation') return send(res, 200, Z.validationResponse(b.payload && b.payload.plainToken));
      if (b.event === 'recording.completed') {
        const o = (b.payload && b.payload.object) || {};
        const f = Z.pickFile(o.recording_files);
        if (Z.collectionFor(o.topic) && f && (o.duration || 0) >= Z.ZOOM.minMinutes) {
          await dispatch('import-zoom.yml', { meeting_uuid: String(o.uuid), file_id: String(f.id) });
        }
      }
      return send(res, 200, { ok: true });
    }
    // Setup check: says only whether each connection works, never any details.
    if (path === '/status' && req.method === 'GET') return send(res, 200, await status());

    // ----- everything below needs a team member -----
    const user = getUser(req);
    if (!user || !allowedEmails().includes(user.email.toLowerCase())) {
      if (path.startsWith('/google/')) return redirect(res, '/');
      return send(res, 401, { error: 'Please sign in again.', signin: true });
    }

    // One-time Drive connection for sentlifecenter.tech@gmail.com
    if (path === '/google/connect') {
      const state = sign({ email: user.email, purpose: 'drive', exp: Date.now() + 15 * 60 * 1000 });
      const p = new URLSearchParams({
        client_id: env('GOOGLE_CLIENT_ID'),
        redirect_uri: origin(req) + '/api/google/callback',
        response_type: 'code',
        scope: 'openid email https://www.googleapis.com/auth/drive',
        access_type: 'offline',
        prompt: 'consent select_account',
        login_hint: CONFIG.driveAccount,
        state
      });
      return redirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?' + p);
    }
    if (path === '/google/callback') {
      const st = verify(url.searchParams.get('state'));
      if (!st || st.purpose !== 'drive' || st.email !== user.email) return html(res, 400, page('That link expired', '<p>Go back and start the Drive connection again.</p>'));
      if (url.searchParams.get('error')) return html(res, 400, page('Drive was not connected', '<p>Google said no. You can start again any time.</p>'));
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          code: url.searchParams.get('code') || '', client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'),
          redirect_uri: origin(req) + '/api/google/callback', grant_type: 'authorization_code'
        })
      });
      const t = await r.json().catch(() => ({}));
      if (!r.ok) return html(res, 400, page('Drive was not connected', '<p>Google did not accept the sign-in. Start again.</p>'));
      let email = '';
      try { email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email || ''; } catch (e) { /* none */ }
      if (email.toLowerCase() !== CONFIG.driveAccount) {
        return html(res, 400, page('Wrong Google account', '<p>You signed in as <b>' + esc(email || 'another account') + '</b>. Message Desk must use <b>' + CONFIG.driveAccount + '</b>, so nothing was saved.</p><p><a href="/api/google/connect">Try again with ' + CONFIG.driveAccount + '</a></p>'));
      }
      if (!t.refresh_token) return html(res, 400, page('Almost', '<p>Google did not send a long-term key. Remove Message Desk at myaccount.google.com/permissions for ' + CONFIG.driveAccount + ', then <a href="/api/google/connect">try again</a>.</p>'));
      return html(res, 200, page('Drive connected', '<p>Copy this key and paste it as <b>GOOGLE_REFRESH_TOKEN</b> in Vercel and in GitHub, as described in the setup guide. It is shown only once and is not stored anywhere else.</p><textarea id="k" readonly rows="4" style="width:100%;font:13px ui-monospace,monospace;padding:10px;border-radius:8px;border:1px solid #d4d4d0">' + esc(t.refresh_token) + '</textarea><p><button onclick="navigator.clipboard.writeText(document.getElementById(\'k\').value);this.textContent=\'Copied\'">Copy key</button></p>'));
    }

    if (path === '/drive-token' && req.method === 'GET') {
      await G.accessToken();
      return send(res, 200, G.tokenInfo());
    }
    if (path === '/options' && req.method === 'GET') {
      try { return send(res, 200, await siteOptions()); } catch (e) { console.error('options', e.message); return send(res, 200, { speakers: [], tags: [] }); }
    }

    if (path === '/vimeo-quota' && req.method === 'GET') {
      try { return send(res, 200, await vimeoQuota()); } catch (e) { console.error('quota', e.message); return send(res, 200, { storage: null, periodic: null }); }
    }

    // ----- messages -----
    if (parts[0] === 'messages') {
      const id = parts[1];
      const action = parts[2];
      if (!id && req.method === 'GET') return send(res, 200, { messages: await M.listOpen() });
      if (!id && req.method === 'POST') {
        const b = await readBody(req);
        const m = await M.create({ ...b, user, origin: origin(req) });
        return send(res, 200, M.view(m));
      }
      if (!/^[\w-]{10,}$/.test(id || '')) return send(res, 404, { error: 'That post could not be found.' });
      const m = await M.load(id);
      const b = req.method === 'GET' ? {} : await readBody(req);
      if (!action && req.method === 'GET') {
        try { await M.heal(m); } catch (e) { console.error('heal', e.message); }
        return send(res, 200, M.view(m));
      }
      if (!action && req.method === 'PUT') { await M.saveChanges(m, b); return send(res, 200, { ok: true }); }
      if (!action && req.method === 'DELETE') return send(res, 200, await M.discard(m));
      if (action === 'thumb-upload') return send(res, 200, { sessionUrl: await M.thumbUploadSession(m, b, origin(req)) });
      if (action === 'thumb') { await M.setThumb(m, b.thumb); return send(res, 200, M.view(m)); }
      if (action === 'upload-offset') return send(res, 200, await M.uploadOffset(m, b, origin(req)));
      if (action === 'uploaded') { await M.markUploaded(m, b); return send(res, 200, M.view(m)); }
      if (action === 'notes' && req.method === 'POST') { const added = await M.addNotes(m, b.files, origin(req)); return send(res, 200, { added, message: M.view(m) }); }
      if (action === 'notes' && req.method === 'DELETE') { await M.removeNote(m, parts[3]); return send(res, 200, M.view(m)); }
      if (action === 'render') { await M.requestRender(m, b); return send(res, 200, M.view(m)); }
      if (action === 'finish') { await M.finish(m, b); return send(res, 200, M.view(m)); }
      if (action === 'publish') { await M.publish(m); return send(res, 200, M.view(m)); }
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(req.method, path, e.status || '', e.message);
    return send(res, e.userMessage ? (e.status || 400) : 500, { error: friendly(e) });
  }
}

let statusCache = null;
async function status() {
  if (statusCache && statusCache.at > Date.now() - 60000) return statusCache.data;
  const check = async (names, fn) => {
    if (names.some((n) => !process.env[n])) return 'missing';
    try { return (await fn()) ? 'ok' : 'failed'; } catch (e) { console.error('status', names[0], e.message); return 'failed'; }
  };
  const data = {
    signIn: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && allowedEmails().length ? 'ok' : 'missing',
    drive: await check(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'], async () => {
      const r = await G.gfetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)');
      const j = await r.json();
      return r.ok && String(j.user && j.user.emailAddress).toLowerCase() === CONFIG.driveAccount;
    }),
    library: await check(['GOOGLE_REFRESH_TOKEN'], async () => {
      const f = await G.getFile(CONFIG.libraryFolderId, 'id,trashed,capabilities(canAddChildren)');
      return f && !f.trashed && f.capabilities && f.capabilities.canAddChildren;
    }),
    website: await check(['WEBFLOW_TOKEN'], async () => {
      const r = await fetch('https://api.webflow.com/v2/collections/' + CONFIG.webflow.collections.Sunday.id, { headers: { Authorization: 'Bearer ' + process.env.WEBFLOW_TOKEN } });
      return r.ok;
    }),
    vimeo: await check(['VIMEO_TOKEN'], async () => {
      const r = await fetch('https://api.vimeo.com/me?fields=uri', { headers: { Authorization: 'bearer ' + process.env.VIMEO_TOKEN, Accept: 'application/vnd.vimeo.*+json;version=3.4' } });
      return r.ok;
    }),
    zoom: process.env.ZOOM_WEBHOOK_SECRET ? 'ok' : 'missing',
    renderJobs: await check(['GH_DISPATCH_TOKEN'], async () => {
      const r = await fetch('https://api.github.com/repos/' + CONFIG.githubRepo + '/actions/workflows/render.yml', { headers: { Authorization: 'Bearer ' + process.env.GH_DISPATCH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'message-desk' } });
      return r.ok;
    })
  };
  statusCache = { at: Date.now(), data };
  return data;
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function page(title, body) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Message Desk</title>' +
    '<style>body{margin:0;background:#f5f5f4;color:#1c1c1e;font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","Segoe UI",Roboto,Arial,sans-serif}' +
    'main{max-width:520px;margin:64px auto;padding:28px;background:#fff;border-radius:12px;box-shadow:0 0 0 1px rgba(0,0,0,.07)}h1{font-size:20px;font-weight:400;margin:0 0 12px}' +
    'button{height:32px;padding:0 14px;border-radius:8px;border:0;background:#2f5bea;color:#fff;font:inherit;cursor:pointer}a{color:#2f5bea}b{font-weight:600}' +
    '@media(prefers-color-scheme:dark){body{background:#111113;color:#ececef}main{background:#1b1b1e}textarea{background:#26262a;color:#ececef}}</style>' +
    '<main><h1>' + esc(title) + '</h1>' + body + '<p style="margin-top:20px"><a href="/">Back to Message Desk</a></p></main>';
}
