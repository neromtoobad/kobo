# Slice a row sheet into sprites by empty alpha columns; trim each; save webp.
import sys
from PIL import Image
src, prefix, n, minw = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
im = Image.open(src).convert('RGBA'); a = im.split()[3]
W, H = im.size; px = a.load()
cols = [any(px[x, y] > 40 for y in range(0, H, 3)) for x in range(W)]
runs = []; x = 0
while x < W:
    if cols[x]:
        s = x
        while x < W and cols[x]: x += 1
        runs.append([s, x])
    else: x += 1
# merge runs separated by small gaps (e.g. the zzz / stop sign floating beside)
merged = []
for r in runs:
    if merged and r[0] - merged[-1][1] < 40: merged[-1][1] = r[1]
    else: merged.append(r)
merged = [r for r in merged if r[1] - r[0] > 30]
print(len(merged), merged)
# if more pieces than wanted, attach small ones to nearest neighbour
while len(merged) > n:
    i = min(range(len(merged)), key=lambda k: merged[k][1] - merged[k][0])
    j = i - 1 if i > 0 and (i == len(merged) - 1 or merged[i][0] - merged[i-1][1] < merged[i+1][0] - merged[i][1]) else i + 1
    lo, hi = sorted([i, j]); merged[lo] = [merged[lo][0], merged[hi][1]]; del merged[hi]
for k, (x0, x1) in enumerate(merged):
    c = im.crop((x0, 0, x1, H)); bb = c.split()[3].point(lambda v: 255 if v > 20 else 0).getbbox(); c = c.crop(bb)
    c.thumbnail((700, 700)); c.save(f'{prefix}{k+1}.webp', quality=88); print(prefix, k+1, c.size)
