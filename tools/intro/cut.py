# Cuts the screencast into the five intro clips.
# Screencast frames only arrive when the screen changes, so each frame's on-screen time is the gap to
# the next one. Each clip is a slice of that timeline between two markers (loading frames fall outside
# every slice), time-scaled to its narration length, then encoded at a constant 30fps.
import json, subprocess, os
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
D = os.path.join(HERE, 'out', 'product')
OUT = os.path.join(ROOT, 'web', 'media', 'intro')
os.makedirs(OUT, exist_ok=True)
cap = json.load(open(D + '/capture.json'))
F = cap['frames']; M = cap['marks']; T0 = F[0]['t']
PAD = 0.3
# (name, start mark, end mark, target seconds, extra hold on the last frame before scaling)
CLIPS = [
  ('s1', 'paste_start', 'click_analyse', 3.48 + PAD, 0.5),
  # ends on the walk-through opener; the next slide shows an empty room until the avatars load
  ('s2', 'score_shown', ('walk_open', 2.3), 5.99 + PAD, 0),
  ('s3', 'act1_start',  'patterns',      6.27 + PAD, 0),
  # ends on 'How to improve'; the 'What you did well' slide that follows does not match the caption
  ('s4', 'patterns',    ('improve', 1.65), 5.62 + PAD, 0),
  ('s5', 'dash',        'end',           4.32 + PAD, 0),
]
def slice_(a, b):
    at = lambda m: M[m[0]] + m[1] if isinstance(m, tuple) else M[m]
    ta, tb = at(a), at(b)
    seg = []
    for k, fr in enumerate(F):
        nxt = F[k + 1]['t'] if k + 1 < len(F) else tb
        s, e = max(fr['t'], ta), min(nxt, tb)
        if e > s: seg.append([fr['f'], e - s])
    return seg
for name, a, b, target, hold in CLIPS:
    seg = slice_(a, b)
    seg[-1][1] += hold
    total = sum(x[1] for x in seg)
    k = target / total
    lst = D + '/%s.ffconcat' % name
    with open(lst, 'w') as fh:
        fh.write('ffconcat version 1.0\n')
        for f, dur in seg: fh.write("file '%s'\nduration %.4f\n" % (f, dur * k))
        fh.write("file '%s'\n" % seg[-1][0])
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst,
        '-vf', 'scale=720:1280:flags=lanczos,fps=30,format=yuv420p', '-t', '%.3f' % target,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-movflags', '+faststart', '-an',
        OUT + '/%s.mp4' % name], check=True)
    print('%s  %d frames  footage %.2fs -> %.2fs (x%.2f)  %d KB' % (name, len(seg), total, target, k,
        os.path.getsize(OUT + '/%s.mp4' % name) // 1024))
