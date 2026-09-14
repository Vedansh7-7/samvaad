# Builds docs/media/samvaad-intro.mp4 from the film-mode screencast plus the narration on card timings.
import json, subprocess, os
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
D = os.path.join(HERE, 'out', 'film')
WEB = os.path.join(ROOT, 'web') + '/'
OUTF = os.path.join(ROOT, 'docs', 'media', 'samvaad-intro.mp4')
cap = json.load(open(D + '/capture.json'))
F, start, total = cap['frames'], cap['start'], cap['total']
end = start + total + 1.2          # a short hold on the call to action

seg = []
for k, fr in enumerate(F):
    nxt = F[k + 1]['t'] if k + 1 < len(F) else end
    a, b = max(fr['t'], start), min(nxt, end)
    if b > a: seg.append((fr['f'], b - a))
if seg and sum(x[1] for x in seg) < end - start:           # screen went still before the end: hold it
    f, d = seg[-1]; seg[-1] = (f, d + (end - start) - sum(x[1] for x in seg))
with open(D + '/film.ffconcat', 'w') as fh:
    fh.write('ffconcat version 1.0\n')
    for f, d in seg: fh.write("file '%s'\nduration %.4f\n" % (f, d))
    fh.write("file '%s'\n" % seg[-1][0])

cards = [c for c in cap['cards'] if c['audio']]
args = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', D + '/film.ffconcat']
for c in cards: args += ['-i', WEB + c['audio']]
fc = ''.join('[%d:a]adelay=%d:all=1,volume=0.75[a%d];' % (k + 1, round(c['at'] * 1000), k) for k, c in enumerate(cards))
fc += ''.join('[a%d]' % k for k in range(len(cards))) + 'amix=inputs=%d:normalize=0,apad[aout]' % len(cards)
args += ['-filter_complex', fc, '-map', '0:v', '-map', '[aout]',
         '-vf', 'scale=720:1280:flags=lanczos,fps=30,format=yuv420p', '-t', '%.3f' % (end - start),
         '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', OUTF]
subprocess.run(args, check=True)
dur = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUTF], capture_output=True, text=True).stdout.strip()
print('marketing cut: %.1fs, %.2f MB, %d frames' % (float(dur), os.path.getsize(OUTF) / 1e6, len(seg)))
