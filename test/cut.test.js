// Proves the cut is frame-exact: every source frame carries its own brightness (4 x frame number),
// so after cutting we can read back exactly which source frames made it into the output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRenderArgs, keepRanges, frameWindow, standardFps, parseRate } from '../lib/cut.js';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch (e) { return false; } })();

test('keep ranges merge and clamp', () => {
  assert.deepEqual(keepRanges(null, 10), [[0, 10]]);
  assert.deepEqual(keepRanges([{ a: 0, b: 2, t: 'keep' }, { a: 2, b: 5, t: 'remove' }, { a: 5, b: 12, t: 'keep' }], 10), [[0, 2], [5, 10]]);
  assert.deepEqual(keepRanges([{ a: 0, b: 3, t: 'remove' }, { a: 3, b: 10, t: 'keep' }], 10), [[3, 10]]);
});

test('frame windows', () => {
  const w = frameWindow(10 / 30, 20 / 30, 30, 2);
  assert.equal(w.frames, 10);
  assert.ok(Math.abs(w.aStart - 1 / 3) < 1e-9);
  assert.equal(frameWindow(1, 2, 30, 2).vEnd, null);
  assert.equal(standardFps(parseRate('30000/1001')), 30000 / 1001);
  assert.equal(standardFps(29.7), 30000 / 1001);
});

function probeFrames(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', 'movie=' + file + ',signalstats', '-show_entries', 'frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0'], { encoding: 'utf8' });
  return out.trim().split('\n').map((l) => Math.round(parseFloat(l) / 4));
}

test('cuts land on exact frames, with audio in sync', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdcut-'));
  const src = path.join(dir, 'src.mov');
  // 60 frames at 30 fps; luma = 4 * frame number. Audio tone alongside.
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=black:s=128x72:r=30:d=2,geq=lum=mod(N*4\\,256):cb=128:cr=128',
    '-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=48000',
    '-c:v', 'libx264', '-qp', '0', '-g', '30', '-pix_fmt', 'yuv444p', '-c:a', 'pcm_s16le', '-shortest', src]);

  const segs = [
    { a: 0, b: 10 / 30, t: 'remove' },
    { a: 10 / 30, b: 20 / 30, t: 'keep' },
    { a: 20 / 30, b: 40 / 30, t: 'remove' },
    { a: 40 / 30, b: 50 / 30, t: 'keep' },
    { a: 50 / 30, b: 2, t: 'remove' }
  ];
  const outMp4 = path.join(dir, 'out.mp4'), outMp3 = path.join(dir, 'out.mp3');
  const { args, kept } = buildRenderArgs({ input: src, outMp4, outMp3, segs, dur: 2, fps: 30 });
  execFileSync('ffmpeg', ['-v', 'error', ...args]);

  const frames = probeFrames(outMp4);
  const want = [...Array(10).keys()].map((i) => 10 + i).concat([...Array(10).keys()].map((i) => 40 + i));
  assert.deepEqual(frames, want);
  assert.ok(Math.abs(kept - 20 / 30) < 1e-9);

  const dur = (f, s) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-select_streams', s, '-show_entries', 'stream=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }));
  assert.ok(Math.abs(dur(outMp4, 'a:0') - 20 / 30) < 0.03, 'audio length matches the kept video');
  assert.ok(fs.statSync(outMp3).size > 1000, 'mp3 written');
});

test('the whole recording when nothing is removed', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdcut-'));
  const src = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=128x72:r=25:d=1,geq=lum=mod(N*4\\,256):cb=128:cr=128',
    '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', '-shortest', src]);
  const outMp4 = path.join(dir, 'o.mp4');
  const { args } = buildRenderArgs({ input: src, outMp4, outMp3: path.join(dir, 'o.mp3'), segs: null, dur: 1, fps: 25 });
  execFileSync('ffmpeg', ['-v', 'error', ...args]);
  assert.deepEqual(probeFrames(outMp4), [...Array(25).keys()]);
});

test('29.97 fps footage whose timestamps start late', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdcut-'));
  const src = path.join(dir, 'src.mov');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=128x72:r=30000/1001:d=2.2,geq=lum=mod(N*4\\,256):cb=128:cr=128',
    '-f', 'lavfi', '-i', 'sine=d=2.2', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', '-c:a', 'pcm_s16le', '-shortest', '-output_ts_offset', '7.5', src]);
  const st = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', src], { encoding: 'utf8' }));
  assert.ok(st > 7);
  const F = (n) => n / (30000 / 1001);
  const segs = [{ a: 0, b: F(5), t: 'remove' }, { a: F(5), b: F(17), t: 'keep' }, { a: F(17), b: 2.2, t: 'remove' }];
  const outMp4 = path.join(dir, 'o.mp4');
  const { args } = buildRenderArgs({ input: src, outMp4, outMp3: path.join(dir, 'o.mp3'), segs, dur: 2.2, fps: standardFps(29.97) });
  execFileSync('ffmpeg', ['-v', 'error', ...args]);
  assert.deepEqual(probeFrames(outMp4), [...Array(12).keys()].map((i) => 5 + i));
});

test('60 fps footage comes out at 30 fps, still cut on exact frames', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdcut-'));
  const src = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=128x72:r=60:d=1,geq=lum=mod(N*4\\,256):cb=128:cr=128',
    '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', '-shortest', src]);
  const segs = [{ a: 0, b: 10 / 60, t: 'remove' }, { a: 10 / 60, b: 30 / 60, t: 'keep' }, { a: 30 / 60, b: 1, t: 'remove' }];
  const outMp4 = path.join(dir, 'o.mp4');
  const { args } = buildRenderArgs({ input: src, outMp4, outMp3: path.join(dir, 'o.mp3'), segs, dur: 1, fps: 60 });
  execFileSync('ffmpeg', ['-v', 'error', ...args]);
  const frames = probeFrames(outMp4);
  assert.equal(frames.length, 10, '20 source frames at 60 fps become 10 at 30 fps');
  assert.ok(frames[0] >= 10 && frames[0] <= 11 && frames[9] >= 28 && frames[9] <= 29, 'nothing from the removed parts: ' + frames.join(','));
});
