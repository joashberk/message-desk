// Weekly tidy-up: once a message has been live for 30 days, its preview copy and thumbnails are
// moved to the Drive trash to save space. Reopening it later makes a fresh preview automatically.
import * as G from '../lib/google.js';
import { log } from './common.js';

const DAYS = 30;

async function main() {
  const folders = await G.listFiles("appProperties has { key='md' and value='message' } and appProperties has { key='open' and value='0' } and trashed = false", 'id,name');
  let freed = 0;
  for (const f of folders) {
    const kids = await G.listChildren(f.id);
    const edit = kids.find((k) => k.name === 'edit.json');
    if (!edit) continue;
    const e = await G.readJson(edit.id);
    const at = e && e.webflow && e.webflow.publishedAt;
    if (!at || Date.now() - Date.parse(at) < DAYS * 864e5) continue;
    for (const k of kids) {
      if (k.name === 'preview.mp4' || k.name === 'thumbs.jpg') { await G.trashFile(k.id); freed += +k.size || 0; }
    }
  }
  log('previews cleaned up, about', Math.round(freed / 1e9 * 10) / 10, 'GB');
}

main().catch((e) => { console.error(e); process.exit(1); });
