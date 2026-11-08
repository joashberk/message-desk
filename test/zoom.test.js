import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.ZOOM_WEBHOOK_SECRET = 'test-secret';
const { collectionFor, pickFile, localDate, verifyWebhook, validationResponse, encodeUuid } = await import('../lib/zoom.js');

test('meeting names map to collections, others are ignored', () => {
  assert.equal(collectionFor('Hebron Gathering'), 'Hebron');
  assert.equal(collectionFor('CX Gathering - October'), 'Charis');
  assert.equal(collectionFor('Charis/X-Elle Monthly'), 'Charis');
  assert.equal(collectionFor('SENT Sunday Service'), 'Sunday');
  assert.equal(collectionFor('Staff check-in'), null);
  assert.equal(collectionFor('Hebronite planning'), null);
});

test('the best video layout is chosen', () => {
  const f = pickFile([
    { id: 'a', file_type: 'M4A', recording_type: 'audio_only', file_size: 10 },
    { id: 'b', file_type: 'MP4', recording_type: 'gallery_view', file_size: 900 },
    { id: 'c', file_type: 'MP4', recording_type: 'shared_screen_with_speaker_view', file_size: 800 },
    { id: 'd', file_type: 'TRANSCRIPT', file_size: 1 }
  ]);
  assert.equal(f.id, 'c');
  assert.equal(pickFile([{ file_type: 'M4A' }]), null);
});

test('dates follow the meeting time zone', () => {
  assert.equal(localDate('2026-11-08T02:30:00Z', 'America/New_York'), '2026-11-07');
  assert.equal(localDate('2026-11-08T02:30:00Z', 'Asia/Tokyo'), '2026-11-08');
});

test('only correctly signed, recent calls from Zoom are accepted', () => {
  const raw = '{"event":"recording.completed"}', ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', 'test-secret').update('v0:' + ts + ':' + raw).digest('hex');
  assert.equal(verifyWebhook(raw, { 'x-zm-request-timestamp': ts, 'x-zm-signature': sig }), true);
  assert.equal(verifyWebhook(raw + ' ', { 'x-zm-request-timestamp': ts, 'x-zm-signature': sig }), false);
  assert.equal(verifyWebhook(raw, { 'x-zm-request-timestamp': String(+ts - 1000), 'x-zm-signature': sig }), false);
  assert.equal(validationResponse('abc').encryptedToken, crypto.createHmac('sha256', 'test-secret').update('abc').digest('hex'));
  assert.equal(encodeUuid('/ab//c=='), encodeURIComponent(encodeURIComponent('/ab//c==')));
});
