// The push "signature" must be a valid ES256 token that the matching public key accepts.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

let store = null;
mock.module('../lib/google.js', {
  namedExports: {
    q: (s) => "'" + s + "'",
    listFiles: async () => (store ? [{ id: 'N1', modifiedTime: '1' }] : []),
    readJson: async () => JSON.parse(JSON.stringify(store)),
    writeJson: async (parent, name, data) => { store = JSON.parse(JSON.stringify(data)); return 'N1'; }
  }
});
mock.module('../lib/messages.js', { namedExports: { workingRoot: async () => 'ROOT' } });
let N;
test.before(async () => { N = await import('../lib/notify.js'); });

test('signed push reaches the device, expired devices are removed', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, ttl: req.headers.ttl });
    res.statusCode = req.url === '/gone' ? 410 : 201; res.end();
  }).listen(0);
  const port = srv.address().port;
  const pub = await N.publicKey();
  assert.equal(Buffer.from(pub, 'base64url').length, 65, 'uncompressed P-256 public key');
  await N.subscribe({ endpoint: 'https://localhost:' + port + '/ok' }, 'a@x.com');
  await N.subscribe({ endpoint: 'https://localhost:' + port + '/gone' }, 'b@x.com');
  // talk plain http to the fake push service
  for (const s of store.subs) s.endpoint = s.endpoint.replace('https:', 'http:');
  const sent = await N.notify({ title: 'Ready to publish', body: 'x', url: '/' });
  srv.close();
  assert.equal(sent, 1);
  assert.deepEqual(store.subs.map((s) => s.endpoint.split('/').pop()), ['ok']);
  // the token verifies with the public key the browser was given
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(seen[0].auth);
  assert.ok(m);
  assert.equal(m[2], pub);
  const [h, p, sig] = m[1].split('.');
  const raw = Buffer.from(pub, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.aud, 'http://localhost:' + port);
  assert.ok(claims.exp > Date.now() / 1000);
  assert.equal(seen[0].ttl, '86400');
  // only a subscribed device learns what the notification is about
  assert.equal((await N.latestFor(store.subs[0].endpoint)).title, 'Ready to publish');
  assert.equal(await N.latestFor('http://someone-else'), null);
});
