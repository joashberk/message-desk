// Health check for one post: are the files the editor and render need still there?
// Prints only yes/no, sizes and dates (no names or links). node worker/check.js <message id>
import * as G from '../lib/google.js';
import * as M from '../lib/messages.js';

const id = process.argv[2];
const m = await M.load(id);
const v = M.view(m);
const kidIds = new Set(m.kids.map((k) => k.id));
async function about(label, fid) {
  if (!fid) return console.log(label.padEnd(16), 'none recorded');
  const f = await G.getFile(fid, 'id,size,trashed,parents,modifiedTime,mimeType').catch((e) => ({ err: e.message }));
  if (!f) return console.log(label.padEnd(16), 'MISSING (deleted for good)');
  if (f.err) return console.log(label.padEnd(16), 'error', f.err.slice(0, 80));
  console.log(label.padEnd(16), f.trashed ? 'IN TRASH' : 'ok', '|', Math.round((+f.size || 0) / 1e6), 'MB |', f.mimeType, '|', kidIds.has(fid) ? 'in working folder' : 'elsewhere (e.g. library)', '|', f.modifiedTime);
}
console.log('status', m.edit.status, '| uploaded', !!m.edit.original.uploaded, '| originalRemoved', !!m.edit.originalRemoved, '| preview status', m.prepare && m.prepare.status, '| duration', Math.round(v.duration));
await about('original', m.edit.original.fileId);
await about('preview (saved)', m.prepare && m.prepare.proxyId);
await about('thumbs (saved)', m.prepare && m.prepare.thumbsId);
await about('wave (saved)', m.prepare && m.prepare.waveId);
console.log('editor is told: proxy', v.preview.proxyId === (m.prepare && m.prepare.proxyId) ? 'saved one' : v.preview.proxyId ? 'a spare copy' : 'NONE', '| thumbs', !!v.preview.thumbsId, '| wave', !!v.preview.waveId, '| transcript', v.preview.transcript && v.preview.transcript.status);
await about('preview (sent)', v.preview.proxyId);
console.log('working folder has', m.kids.length, 'files:', m.kids.map((k) => k.name.replace(/^.*\.(mp4|mov|m4v)$/i, '<video>.$1')).join(', '));
