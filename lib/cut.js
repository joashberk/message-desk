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
export function buildRenderArgs({ input, outMp4, outMp3, segs, dur, fps, hasAudio = true, maxHeight = 1080 }) {
  const ranges = keepRanges(segs, dur);
  if (!ranges.length) throw new Error('Everything was removed');
  const N = ranges.length;
  const wins = ranges.map(([a, b]) => frameWindow(a, b, fps, dur));
  // ffmpeg starts the input clock at zero (like the browser does), so times line up with the editor.
  const f = [];
  f.push('[0:v]' + (N > 1 ? 'split=' + N + wins.map((_, i) => '[vs' + i + ']').join('') : 'null[vs0]'));
  if (hasAudio) f.push('[0:a]' + (N > 1 ? 'asplit=' + N + wins.map((_, i) => '[as' + i + ']').join('') : 'anull[as0]'));
  wins.forEach((w, i) => {
    f.push('[vs' + i + ']trim=start=' + n6(w.vStart) + (w.vEnd !== null ? ':end=' + n6(w.vEnd) : '') + ',setpts=PTS-STARTPTS[v' + i + ']');
    if (hasAudio) f.push('[as' + i + ']atrim=start=' + n6(w.aStart) + (w.aEnd !== null ? ':end=' + n6(w.aEnd) : '') + ',asetpts=PTS-STARTPTS[a' + i + ']');
  });
  const ins = wins.map((_, i) => '[v' + i + ']' + (hasAudio ? '[a' + i + ']' : '')).join('');
  f.push(ins + 'concat=n=' + N + ':v=1:a=' + (hasAudio ? 1 : 0) + '[vc]' + (hasAudio ? '[ac]' : ''));
  f.push("[vc]scale=-2:'min(" + maxHeight + ",ih)':flags=lanczos,format=yuv420p[vout]");
  if (hasAudio) f.push('[ac]asplit=2[aout][amp3]');

  const args = ['-hide_banner', '-y', '-i', input, '-filter_complex', f.join(';'),
    // MP4: equivalent to HandBrake's "Fast 1080p30" (x264 fast, RF 22, High profile, AAC 160k, web optimized)
    '-map', '[vout]'];
  if (hasAudio) args.push('-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-profile:v', 'high', '-level:v', '4.1',
    '-fps_mode', 'cfr', '-r', rateExpr(fps), '-g', String(Math.round(fps * 2)), '-pix_fmt', 'yuv420p');
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
  args.push('-movflags', '+faststart', outMp4);
  // MP3: lightweight speech audio
  if (hasAudio && outMp3) args.push('-map', '[amp3]', '-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-ar', '44100', outMp3);
  const kept = ranges.reduce((s, [a, b]) => s + (b - a), 0);
  return { args, kept, ranges };
}
