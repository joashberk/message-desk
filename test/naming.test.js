import test from 'node:test';
import assert from 'node:assert/strict';
import { nextNumber, findSameDateFolder, meetingFolderName, baseName, choosePart, autoTitle, autoSlug, collectionFolderName } from '../lib/naming.js';

const hebron = ['01_HEBRON_01.10.2026', '02_HEBRON_04.11.2026', '07_HEBRON_09.12.2026', '08_HEBRON_10.10.2026'];
const charis = ['01_CX_2026-01-17', '02_CX Special Meeting 2026-04-04', '09_CX_2026-10-24', 'CX GGC Meetings'];
const sunday = ['43_Sunday_2026_10_25', '44_Sunday_2026_11_01', '12_Sunday_2026_03_22 Mental Health'];

test('next number follows the highest prefix', () => {
  assert.equal(nextNumber(hebron), 9);
  assert.equal(nextNumber(charis), 10);
  assert.equal(nextNumber(sunday), 45);
  assert.equal(nextNumber([]), 1);
});

test('meeting folder names', () => {
  assert.equal(meetingFolderName(9, 'Hebron', '2026-11-07'), '09_HEBRON_2026_11_07');
  assert.equal(meetingFolderName(10, 'Charis', '2026-11-21'), '10_CX_2026_11_21');
  assert.equal(meetingFolderName(45, 'Sunday', '2026-11-08'), '45_Sunday_2026_11_08');
  assert.equal(meetingFolderName(100, 'Sunday', '2026-11-08'), '100_Sunday_2026_11_08');
});

test('collection folder names', () => {
  assert.equal(collectionFolderName('Sunday', '2027'), '01_SLC_Sundays_2027');
  assert.equal(collectionFolderName('Hebron', '2027'), '03_HEBRON');
  assert.equal(collectionFolderName('Charis', '2027'), '04_Charis/X-Elle');
});

test('same-date folders are found in every date style', () => {
  const f = (n) => ({ name: n });
  assert.equal(findSameDateFolder(hebron.map(f), '2026-10-10').name, '08_HEBRON_10.10.2026');
  assert.equal(findSameDateFolder(charis.map(f), '2026-04-04').name, '02_CX Special Meeting 2026-04-04');
  assert.equal(findSameDateFolder(sunday.map(f), '2026-11-01').name, '44_Sunday_2026_11_01');
  assert.equal(findSameDateFolder(sunday.map(f), '2026-11-08'), null);
});

test('file base names and parts', () => {
  assert.equal(baseName('Hebron', '2026-11-07', ''), 'Hebron_2026_11_07');
  assert.equal(baseName('Hebron', '2026-11-07', '2'), 'Hebron_2026_11_07_Part2');
  assert.equal(choosePart('Hebron', '2026-11-07', '', 'mov', []), '');
  assert.equal(choosePart('Hebron', '2026-11-07', '', 'mov', ['Hebron_2026_11_07.mov', 'notes.pdf']), '2');
  assert.equal(choosePart('Hebron', '2026-11-07', '', 'mov', ['Hebron_2026_11_07.mov', 'Hebron_2026_11_07_Part2.mov']), '3');
  assert.equal(choosePart('Hebron', '2026-11-07', '3', 'mov', ['Hebron_2026_11_07.mov']), '3');
});

test('titles and slugs match the prototype and the site', () => {
  const d = { coll: 'Hebron', date: '2026-11-07', part: '1', title: '' };
  assert.equal(autoTitle(d), 'Hebron - November 7th, 2026 - Part 1');
  assert.equal(autoSlug(d), 'hebron---november-7th-2026---part-1');
  assert.equal(autoSlug({ coll: 'Sunday', date: '2026-11-01', title: 'INTO THE DEEP' }), 'into-the-deep-2026-11-01');
});
