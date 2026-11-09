// Turns the editor's Keep/Remove sections into one ffmpeg pass that cuts the full-quality
// original on exact frames (no keyframe snapping), compresses to H.264 and writes the MP3.

// Exact rates: 29.97 is really 30000/1001. Rounding it would drift ~21 frames over two hours.
const STD = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60];
const EXPR = new Map([[24000 / 1001, '24000/1001'], [30000 / 1001, '30000/1001'], [60000 / 1001, '60000/1001']]);

export function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a;
}

// Picks the standard rate closest to what the file reports.
export function standardFps(rate) {
  if (!rate || !isFinite(rate)) return 30;
  return STD.reduce((best, f) => (Math.abs(f - rate) < Math.abs(best - rate) ? f : best), 30);
}
// HandBrake's "Fast 1080p30" keeps at most 30 frames per second: 60 → 30, 59.94 → 29.97, 50 → 25.
export function outputFps(fps) { return fps > 31 ? fps / 2 : fps; }

export function rateExpr(fps) {
  for (const [k, v] of EXPR) if (Math.abs(k - fps) < 0.002) return v;
  return String(Math.round(fps * 1000) / 1000);
}

// The parts to keep, in order, merged and clamped to the recording.
export function keepRanges(segs, dur) {
  let keeps = Array.isArray(segs) && segs.length ? segs.filter((s) => s.t !== 'remove').map((s) => [+s.a, +s.b]) : [[0, dur]];
  keeps = keeps.map(([a, b]) => [Math.max(0, a), Math.min(dur, b)]).filter(([a, b]) => b - a > 0.001).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const k of keeps) {
    const l = out[out.length - 1];
    if (l && k[0] <= l[1] + 0.0005) l[1] = Math.max(l[1], k[1]); else out.push(k.slice());
  }
  return out;
}

// Frame-exact window for one kept range. A range [a, b) keeps frames round(a*fps) .. round(b*fps)-1.
// Video bounds sit half a frame early so float rounding can't add or drop a frame; audio is cut at
// the exact frame times so it stays in sync.
export function frameWindow(a, b, fps, dur) {
  const fa = Math.round(a * fps);
  const atEnd = b >= dur - 0.5 / fps;
  const fb = atEnd ? null : Math.round(b * fps);
  return {
    vStart: Math.max(0, (fa - 0.5) / fps),
    vEnd: fb === null ? null : (fb - 0.5) / fps,
    aStart: fa / fps,
    aEnd: fb === null ? null : fb / fps,
    frames: fb === null ? null : fb - fa
  };
}

const n6 = (x) => (Math.round(x * 1e6) / 1e6).toString();

// Returns ffmpeg arguments for: input → (cut + scale + H.264/AAC MP4) and (mono MP3).
// parts: 'both' (one machine does everything), 'video' (one piece of the picture, no sound), or
// 'audio' (all the sound: AAC for the MP4 plus the MP3).
export function buildRenderArgs({ input, outMp4, outMp3, outAudio, segs, dur, fps, hasAudio = true, maxHeight = 1080, parts = 'both' }) {
  const ranges = keepRanges(segs, dur);
  if (!ranges.length) throw new Error('Everything was removed');
  const N = ranges.length;
  const doV = parts !== 'audio', doA = hasAudio && parts !== 'video';
  // A piece of the video jumps straight to its part of the recording instead of reading from the start.
  // The jump lands on a whole frame a second early; every cut time below is shifted by the same amount.
  const seek = parts === 'video' ? Math.max(0, Math.floor((ranges[0][0] - 1) * fps) / fps) : 0;
  const wins = ranges.map(([a, b]) => frameWindow(a, b, fps, dur)).map((w) => ({
    vStart: Math.max(0, w.vStart - seek), vEnd: w.vEnd === null ? null : w.vEnd - seek, aStart: w.aStart, aEnd: w.aEnd
  }));
  const f = [];
  if (doV) {
    f.push('[0:v]' + (N > 1 ? 'split=' + N + wins.map((_, i) => '[vs' + i + ']').join('') : 'null[vs0]'));
    wins.forEach((w, i) => f.push('[vs' + i + ']trim=start=' + n6(w.vStart) + (w.vEnd !== null ? ':end=' + n6(w.vEnd) : '') + ',setpts=PTS-STARTPTS[v' + i + ']'));
  }
  if (doA) {
    f.push('[0:a]' + (N > 1 ? 'asplit=' + N + wins.map((_, i) => '[as' + i + ']').join('') : 'anull[as0]'));
    wins.forEach((w, i) => f.push('[as' + i + ']atrim=start=' + n6(w.aStart) + (w.aEnd !== null ? ':end=' + n6(w.aEnd) : '') + ',asetpts=PTS-STARTPTS[a' + i + ']'));
  }
  const ins = wins.map((_, i) => (doV ? '[v' + i + ']' : '') + (doA ? '[a' + i + ']' : '')).join('');
  f.push(ins + 'concat=n=' + N + ':v=' + (doV ? 1 : 0) + ':a=' + (doA ? 1 : 0) + (doV ? '[vc]' : '') + (doA ? '[ac]' : ''));
  const ofps = outputFps(fps);
  // 60 → 30 fps keeps exactly every other frame of the edited video (counted from its first frame), so the
  // result is the same whether one machine or several do the work.
  const half = ofps !== fps ? 'select=not(mod(n\\,2)),setpts=N/(' + rateExpr(ofps) + ')/TB,' : '';
  if (doV) f.push('[vc]' + half + "scale=-2:'min(" + maxHeight + ",ih)':flags=lanczos,format=yuv420p[vout]");
  if (doA) f.push(outMp3 ? '[ac]asplit=2[aout][amp3]' : '[ac]anull[aout]');

  const args = ['-hide_banner', '-y'];
  if (seek > 0) args.push('-ss', n6(seek));
  args.push('-i', input, '-filter_complex', f.join(';'));
  if (doV) {
    // MP4: like HandBrake's "Fast 1080p30" (1080p, up to 30 fps, RF 21, High profile, AAC 160k, web optimized),
    // with x264's "veryfast" speed setting so a two-hour service fits comfortably on a free GitHub machine
    args.push('-map', '[vout]');
    if (doA) args.push('-map', '[aout]');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level:v', '4.1',
      '-fps_mode', 'cfr', '-r', rateExpr(ofps), '-g', String(Math.round(ofps * 2)), '-pix_fmt', 'yuv420p');
    if (doA) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
    args.push('-movflags', '+faststart', outMp4);
  } else if (doA) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', outAudio);
  }
  // MP3: lightweight speech audio
  if (doA && outMp3) args.push('-map', '[amp3]', '-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-ar', '44100', outMp3);
  const kept = ranges.reduce((t, [a, b]) => t + (b - a), 0);
  return { args, kept, ranges };
}

// Splits the kept parts into pieces of roughly equal length for several machines to compress at once.
// Piece boundaries fall on whole output frames, so joining the pieces gives exactly the one-machine result.
export function planChunks(segs, dur, fps, { target = 600, max = 10 } = {}) {
  const ofps = outputFps(fps), step = Math.max(1, Math.round(fps / ofps));
  const endIdx = Math.round(dur * fps);
  const keeps = keepRanges(segs, dur).map(([a, b]) => {
    const fa = Math.round(a * fps), toEnd = b >= dur - 0.5 / fps;
    return { fa, fb: toEnd ? endIdx : Math.round(b * fps), toEnd };
  }).filter((k) => k.fb > k.fa);
  const total = keeps.reduce((t, k) => t + k.fb - k.fa, 0);
  const n = Math.max(1, Math.min(max, Math.ceil(total / fps / target)));
  const size = Math.ceil(total / n / step) * step;
  const chunks = [];
  let cur = [], left = size;
  for (const k of keeps) {
    let fa = k.fa;
    while (fa < k.fb) {
      const take = Math.min(left, k.fb - fa);
      const last = fa + take === k.fb;
      cur.push({ t: 'keep', a: fa / fps, b: last && k.toEnd ? dur : (fa + take) / fps });
      fa += take; left -= take;
      if (left === 0) { chunks.push(cur); cur = []; left = size; }
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Seconds removed before time t on the original recording (to find the same moment in the final edit).
export function removedBefore(t, segs) {
  if (!Array.isArray(segs)) return 0;
  return segs.reduce((a, s) => (s.t !== 'remove' ? a : a + Math.max(0, Math.min(t, s.b) - s.a)), 0);
}
