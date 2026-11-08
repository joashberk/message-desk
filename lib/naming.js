// Pure naming rules shared by the server, the workers and the tests.
import { CONFIG } from './config.js';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function pad2(n) { return String(n).padStart(2, '0'); }

export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return n + 'th';
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

export function splitDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) throw new Error('Bad date ' + date);
  return { y: m[1], m: m[2], d: m[3] };
}

// Same rules as the prototype
export function autoTitle(d) {
  let ds = '';
  try { const p = splitDate(d.date); ds = MONTHS[+p.m - 1] + ' ' + ordinal(+p.d) + ', ' + p.y; } catch (e) { /* no date */ }
  return d.coll + ' - ' + ds + (d.part ? ' - Part ' + d.part : '');
}
export function title(d) { return (d.title || '').trim() || autoTitle(d); }
export function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-'); }
export function autoSlug(d) { return (d.title || '').trim() ? slugify(d.title.trim() + ' ' + d.date) : slugify(autoTitle(d)); }
export function slug(d) { return d.slugEdited && d.slug ? d.slug : autoSlug(d); }

export function collectionFolderName(coll, year) { return CONFIG.collections[coll].folder(year); }

export function meetingFolderName(n, coll, date) {
  const p = splitDate(date);
  return pad2(n) + '_' + CONFIG.collections[coll].code + '_' + p.y + '_' + p.m + '_' + p.d;
}

// "Next number after the highest existing prefix in that folder"
export function nextNumber(names) {
  let max = 0;
  for (const n of names) {
    const m = /^(\d+)_/.exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

// Finds a numbered folder for the same meeting date. Older folders use other date styles
// (03_HEBRON_05.09.2026, 01_CX_2026-01-17), so all of them count as the same date.
export function findSameDateFolder(folders, date) {
  const p = splitDate(date);
  const forms = [p.y + '_' + p.m + '_' + p.d, p.y + '-' + p.m + '-' + p.d, p.m + '.' + p.d + '.' + p.y];
  return folders.find((f) => /^\d+_/.test(f.name) && forms.some((s) => f.name.includes(s))) || null;
}

// Hebron_2026_11_07, Hebron_2026_11_07_Part2
export function baseName(coll, date, part) {
  const p = splitDate(date);
  return coll + '_' + p.y + '_' + p.m + '_' + p.d + (part ? '_Part' + part : '');
}

// When no part is set and the name is already taken by another recording, use the next free part (2, 3, ...).
export function choosePart(coll, date, part, ext, takenNames) {
  if (part) return String(part);
  const taken = new Set(takenNames.map((s) => s.toLowerCase()));
  if (!taken.has((baseName(coll, date, '') + '.' + ext).toLowerCase())) return '';
  for (let n = 2; n < 100; n++) {
    if (!taken.has((baseName(coll, date, n) + '.' + ext).toLowerCase())) return String(n);
  }
  return '';
}

export function fileExt(name, fallback = 'mov') {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  return m ? m[1].toLowerCase() : fallback;
}

export function liveUrl(d) {
  return CONFIG.webflow.domain + '/' + CONFIG.webflow.collections[d.coll].slug + '/' + slug(d);
}
