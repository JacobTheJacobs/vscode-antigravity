"""Generate a crisp pixel-art spectrum arch on a dark plate.

Original composition: a pixelated arch is a stylised, retro treatment — not a
reproduction of Antigravity's smooth-gradient mark — so it adopts the category's
motif without being the official logo.
"""
import math

# --- spectrum stops around the arch, by math angle (0=right, 90=top, 180=left)
# Faithful to the reference: cool at both feet, warm at the peak; left runs
# blue->green->yellow going up, right runs red->pink->purple->blue going down.
STOPS = [
    (180, (59, 130, 246)),   # left foot  - blue
    (150, (34, 197, 94)),    #            - green
    (120, (234, 179, 8)),    #            - yellow
    (95,  (249, 115, 22)),   # near top   - orange
    (85,  (239, 68, 68)),    # peak       - red
    (60,  (236, 72, 153)),   #            - pink
    (30,  (139, 92, 246)),   #            - purple
    (0,   (59, 130, 246)),   # right foot - blue
]

def color_at(angle):
    a = max(0.0, min(180.0, angle))
    for i in range(len(STOPS) - 1):
        a0, c0 = STOPS[i]
        a1, c1 = STOPS[i + 1]
        if a1 <= a <= a0:
            t = (a0 - a) / (a0 - a1) if a0 != a1 else 0.0
            return tuple(round(c0[k] + (c1[k] - c0[k]) * t) for k in range(3))
    return STOPS[-1][1]

# --- grid: an arch ring in the upper half
N = 16            # grid cells across
cx = (N - 1) / 2.0
cy = N - 3.0      # centre low so the arch peaks high in the frame
R_OUT = 8.7
R_IN = 5.9

cells = []
for gy in range(N):
    for gx in range(N):
        dx = gx - cx
        dy = gy - cy
        r = math.hypot(dx, dy)
        if R_IN <= r <= R_OUT and dy <= 0.6:   # upper ring, small overhang at feet
            ang = math.degrees(math.atan2(-dy, dx))   # 0=right, 90=up, 180=left
            cells.append((gx, gy, color_at(ang)))

# --- emit SVG: dark rounded plate + pixel squares
CELL = 15                 # px per grid cell in the 256 art space
PAD = (256 - N * CELL) / 2
GAP = 0.6                 # hairline between pixels so the grid reads

rects = []
for gx, gy, (r, g, b) in cells:
    x = PAD + gx * CELL + GAP
    y = PAD + gy * CELL + GAP
    s = CELL - GAP * 2
    rects.append(
        '<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="1.4" fill="#%02x%02x%02x"/>'
        % (x, y, s, s, r, g, b))

svg = (
    '<svg id="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" '
    'width="256" height="256">\n'
    '  <defs>\n'
    '    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">\n'
    '      <stop offset="0" stop-color="#12182A"/>\n'
    '      <stop offset="1" stop-color="#05070E"/>\n'
    '    </linearGradient>\n'
    '    <radialGradient id="halo" cx="0.5" cy="0.4" r="0.5">\n'
    '      <stop offset="0" stop-color="#7B4DFF" stop-opacity="0.30"/>\n'
    '      <stop offset="1" stop-color="#7B4DFF" stop-opacity="0"/>\n'
    '    </radialGradient>\n'
    '  </defs>\n'
    '  <rect width="256" height="256" rx="56" fill="url(#plate)"/>\n'
    '  <circle cx="128" cy="104" r="92" fill="url(#halo)"/>\n'
    + '\n'.join('  ' + r for r in rects)
    + '\n</svg>\n'
)

out = r"C:/Temp/claude/c--Users-Jacob-The-God-Desktop-google-jobs/d3ddb959-4b51-4387-acb3-0cf7d438b8cc/scratchpad/pixel_icon.svg"
open(out, 'w', encoding='utf-8').write(svg)
print("  %d pixels, wrote pixel_icon.svg" % len(cells))
