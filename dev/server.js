// Local test bench. `npm run dev` serves the app on http://localhost:3000.
// With no Google settings it runs against a pretend Drive/Webflow/render (dev/mock.js),
// so the screens can be clicked through without any keys.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const useMock = !process.env.GOOGLE_REFRESH_TOKEN;
const handler = useMock ? (await import('./mock.js')).default : (await import('../api/index.js')).default;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/fake-')) return handler(req, res);
  let p = path.join(root, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, 'index.html');
  res.setHeader('Content-Type', TYPES[path.extname(p)] || 'application/octet-stream');
  if (p.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
  fs.createReadStream(p).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log('Message Desk on http://localhost:' + (process.env.PORT || 3000) + (useMock ? ' (pretend services)' : '')));
