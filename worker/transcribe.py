# Writes out what was said, with the time of every word, using Whisper (open source, runs on the
# GitHub machine itself; no audio leaves it). Usage: python transcribe.py <audio file> <out.json>
# Prints "P 0.42" progress lines for the Node wrapper.
import json
import os
import sys

from faster_whisper import WhisperModel

audio, out = sys.argv[1], sys.argv[2]
model = WhisperModel(os.environ.get('WHISPER_MODEL', 'small.en'), device='cpu', compute_type='int8', cpu_threads=os.cpu_count() or 4)
segments, info = model.transcribe(
    audio, language='en', beam_size=1, vad_filter=True, word_timestamps=True,
    condition_on_previous_text=False
)
total = info.duration or 1
words = []
for seg in segments:
    for w in seg.words or []:
        text = w.word.strip()
        if text:
            words.append([round(w.start, 2), round(w.end, 2), text])
    print('P %.3f' % min(1, seg.end / total), flush=True)

with open(out, 'w') as f:
    json.dump({'words': words}, f, separators=(',', ':'))
print('words', len(words), flush=True)
