// Drive filing against a pretend Drive that mirrors the real 2026 library.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.LIBRARY_FOLDER_ID = 'LIB';
const FOLDER = 'application/vnd.google-apps.folder';
let files, seq;
function reset() {
  files = new Map(); seq = 0;
  const add = (id, name, parent, mime = FOLDER) => files.set(id, { id, name, parents: parent ? [parent] : [], mimeType: mime, trashed: false });
  add('LIB', '01_SLC Media Library', null);
  add('Y26', '2026', 'LIB');
  add('HEB', '03_HEBRON', 'Y26');
  ['01_HEBRON_01.10.2026', '07_HEBRON_09.12.2026', '08_HEBRON_10.10.2026'].forEach((n, i) => add('h' + i, n, 'HEB'));
  add('CX', '04_Charis/X-Elle', 'Y26');
  ['01_CX_2026-01-17', '09_CX_2026-10-24', 'CX GGC Meetings'].forEach((n, i) => add('c' + i, n, 'CX'));
  add('SUN', '01_SLC_Sundays_2026', 'Y26');
  add('s0', '44_Sunday_2026_11_01', 'SUN');
  add('MSG', 'msg', 'ROOT');
}
const kids = (p) => [...files.values()].filter((f) => f.parents.includes(p) && !f.trashed);
const pathOf = (id) => { const out = []; let f = files.get(id); let guard = 0; while (f) { if (++guard > 50) throw new Error('loop at ' + out.slice(0, 6).join('/')); out.unshift(f.name); f = files.get(f.parents[0]); } return out.join(' / '); };

mock.module('../lib/google.js', {
  namedExports: {
    FOLDER,
    q: (s) => "'" + s + "'",
    listChildren: async (p, onlyFolders) => kids(p).filter((f) => !onlyFolders || f.mimeType === FOLDER),
    listFiles: async (query) => {
      const m = /'([^']+)' in parents.*name = '([^']+)'/.exec(query);
      return m ? kids(m[1]).filter((f) => f.name === m[2] && f.mimeType === FOLDER) : [];
    },
    getFile: async (id) => files.get(id) || null,
    createFolder: async (parent, name) => { const id = 'new' + (++seq); files.set(id, { id, name, parents: [parent], mimeType: FOLDER, trashed: false }); return files.get(id); },
    ensureFolder: async (parent, name, existing) => {
      const hit = (existing || kids(parent)).find((f) => f.name === name && f.mimeType === FOLDER);
      if (hit) return { folder: hit, created: false };
      const id = 'new' + (++seq); files.set(id, { id, name, parents: [parent], mimeType: FOLDER, trashed: false });
      return { folder: files.get(id), created: true };
    },
    placeFile: async (file, folderId, name) => { const f = files.get(file.id); f.parents = [folderId]; if (name) f.name = name; return f; },
    trashFile: async (id) => { files.get(id).trashed = true; }
  }
});
let fileToLibrary;
test.before(async () => { ({ fileToLibrary } = await import('../lib/messages.js')); });

function upload(id, name, parent = 'MSG') { files.set(id, { id, name, parents: [parent], mimeType: 'video/quicktime', trashed: false }); }
function message(d, origId, notes = []) {
  return {
    id: 'MSG', kids: kids('MSG'), render: null,
    edit: { d: { part: '', ...d }, file: { ext: 'mov' }, original: { fileId: origId }, notes: notes.map((n) => ({ name: files.get(n).name, fileId: n })), filing: null }
  };
}

test('a new Hebron meeting gets the next number and fixed names', async () => {
  reset();
  upload('o1', 'IMG_4471.MOV'); upload('n1', 'Handout week 3.pdf');
  const m = message({ coll: 'Hebron', date: '2026-11-07' }, 'o1', ['n1']);
  await fileToLibrary(m);
  assert.equal(pathOf('o1'), '01_SLC Media Library / 2026 / 03_HEBRON / 09_HEBRON_2026_11_07 / Original / Hebron_2026_11_07.mov');
  assert.equal(pathOf('n1'), '01_SLC Media Library / 2026 / 03_HEBRON / 09_HEBRON_2026_11_07 / Original / Handout week 3.pdf');
  assert.ok(kids(m.edit.filing.meetingFolderId).some((f) => f.name === 'Final edit'));
  assert.deepEqual(m.edit.filing.final, ['Hebron_2026_11_07.mp4', 'Hebron_2026_11_07.mp3']);
  assert.equal(m.edit.filing.createdMeetingFolder, true);
});

test('a second part on the same date shares the folder and gets _Part2', async () => {
  reset();
  upload('o1', 'a.mov'); upload('o2', 'b.mov');
  await fileToLibrary(message({ coll: 'Hebron', date: '2026-11-07' }, 'o1'));
  const m2 = message({ coll: 'Hebron', date: '2026-11-07' }, 'o2');
  await fileToLibrary(m2);
  assert.equal(pathOf('o2'), '01_SLC Media Library / 2026 / 03_HEBRON / 09_HEBRON_2026_11_07 / Original / Hebron_2026_11_07_Part2.mov');
  assert.equal(m2.edit.d.part, '2');
  assert.equal(kids('HEB').filter((f) => f.name.startsWith('09_')).length, 1);
});

test('an existing folder in an older date style is reused', async () => {
  reset();
  upload('o1', 'a.mov');
  await fileToLibrary(message({ coll: 'Hebron', date: '2026-10-10' }, 'o1'));
  assert.equal(pathOf('o1'), '01_SLC Media Library / 2026 / 03_HEBRON / 08_HEBRON_10.10.2026 / Original / Hebron_2026_10_10.mov');
});

test('a new year creates the year and collection folders', async () => {
  reset();
  upload('o1', 'a.mp4');
  const m = message({ coll: 'Sunday', date: '2027-01-03' }, 'o1');
  m.edit.file.ext = 'mp4';
  await fileToLibrary(m);
  assert.equal(pathOf('o1'), '01_SLC Media Library / 2027 / 01_SLC_Sundays_2027 / 01_Sunday_2027_01_03 / Original / Sunday_2027_01_03.mp4');
});

test('Charis uses the CX code and its own numbering', async () => {
  reset();
  upload('o1', 'a.mov');
  await fileToLibrary(message({ coll: 'Charis', date: '2026-11-21' }, 'o1'));
  assert.equal(pathOf('o1'), '01_SLC Media Library / 2026 / 04_Charis/X-Elle / 10_CX_2026_11_21 / Original / Charis_2026_11_21.mov');
});

test('changing the collection after Finish moves the files and removes the empty folder it made', async () => {
  reset();
  upload('o1', 'a.mov');
  const m = message({ coll: 'Hebron', date: '2026-11-21' }, 'o1');
  await fileToLibrary(m);
  const first = m.edit.filing.meetingFolderId;
  m.edit.d.coll = 'Charis';
  m.kids = [];
  await fileToLibrary(m);
  assert.equal(pathOf('o1'), '01_SLC Media Library / 2026 / 04_Charis/X-Elle / 10_CX_2026_11_21 / Original / Charis_2026_11_21.mov');
  assert.equal(files.get(first).trashed, true);
});
