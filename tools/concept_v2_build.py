#!/usr/bin/env python3
"""Rebuild the concept-v2 hero sheets from the original prototype pack.

The prototype pack (art-src/concept-v2-original/) holds 42 sheets, but every frame in it is an
integer translation of one of THREE illustrations per hero (idle, run, attack); 'special' re-uses
the attack drawing, 'hurt' re-uses the idle drawing and 'down' is the idle drawing plus a cropped
90-degree rotation. The translations were made with wrap-around, so weapon tips and dust leak into
the opposite edge of the cell.

This script:
  1. extracts the 21 base illustrations,
  2. cleans them (un-premultiplies the black-keyed edge, hard 1-bit alpha, removes wrap-around and
     detached junk, peels the dark matte fringe, re-adds a clean hero-tinted 1 px outline),
  3. normalises the feet to one baseline and one centre column,
  4. builds every animation with pixel-exact operations only (integer shifts, row-band shears,
     exact 90-degree rotation, palette tints, ordered-dither fades and an angular reveal of the
     weapon/FX layer). Nothing is resampled, so the pixel art stays sharp.

These are still procedural animations of single drawings, NOT hand-redrawn frames.
Run:  python3 tools/concept_v2_build.py   (needs Pillow, numpy, scipy)
"""
import json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'art-src', 'concept-v2-original')
OUT = os.path.join(ROOT, 'public', 'assets', 'concept-v2')
HEROES = ['noah', 'destiny', 'markie', 'espirit', 'smitesh', 'dave', 'donna']
FW, FH, FEET = 96, 128, 122           # cell size and the feet row every frame shares
DOWN_FW = 128                          # lying pose needs a wider cell
# outline tint (dark, hue-matched) and energy colour used for special/charge frames
TINT = {
    'noah':    ((14, 14, 40),  (110, 170, 255)),
    'destiny': ((40, 28, 12),  (255, 226, 140)),
    'markie':  ((40, 12, 10),  (255, 140, 70)),
    'espirit': ((10, 32, 16),  (140, 240, 150)),
    'smitesh': ((8, 30, 34),   (110, 235, 240)),
    'dave':    ((38, 8, 12),   (255, 110, 110)),
    'donna':   ((22, 34, 8),   (200, 245, 120)),
}
# ordered-dither matrix for crisp (no partial alpha) fades
BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16.0


def load_frame(hero, anim, n, i):
    im = Image.open(os.path.join(SRC, f'{hero}_{anim}_96x128_{n}f.png')).convert('RGBA')
    return np.array(im)[:, i * FW:(i + 1) * FW].astype(np.float32)


def clean(a, hero, keep_fx=True):
    """a: HxWx4 float. Returns cleaned uint8 RGBA with 1-bit alpha."""
    rgb, al = a[..., :3], a[..., 3]
    semi = (al > 0) & (al < 255)
    # Black-keyed edges are premultiplied against black: recover the colour.
    rgb = rgb.copy()
    rgb[semi] = np.clip(rgb[semi] * 255.0 / np.maximum(al[semi, None], 1), 0, 255)
    solid = al >= 120
    # connected components (8-way); keep the main body and anything touching it
    lab, n = ndi.label(solid, structure=np.ones((3, 3)))
    if n:
        sizes = ndi.sum(solid, lab, range(1, n + 1))
        main = int(np.argmax(sizes)) + 1
        body = lab == main
        near = ndi.binary_dilation(body, iterations=4)
        ys, xs = np.where(body)
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        keep = body.copy()
        for k in range(1, n + 1):
            if k == main: continue
            comp = lab == k
            sz = sizes[k - 1]
            cy, cx = np.where(comp)
            touches_edge = cx.min() == 0 or cx.max() == a.shape[1] - 1 or cy.min() == 0
            inside = cy.min() >= y0 - 6 and cy.max() <= y1 + 6 and cx.min() >= x0 - 6 and cx.max() <= x1 + 6
            if touches_edge and sz < 400: continue          # wrap-around leak from the shift
            if (comp & near).any() and sz >= 3: keep |= comp; continue
            if keep_fx and inside and sz >= 6: keep |= comp; continue
        solid = keep
    # peel near-black matte fringe: boundary pixels that are almost black and unsaturated
    lum = rgb @ np.array([.299, .587, .114])
    sat = rgb.max(-1) - rgb.min(-1)
    for _ in range(2):
        edge = solid & ~ndi.binary_erosion(solid, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]), border_value=0)
        dark = edge & (lum < 34) & (sat < 26)
        solid = solid & ~dark
    # drop single isolated pixels
    nb = ndi.convolve(solid.astype(int), np.ones((3, 3), int), mode='constant') - solid
    solid &= ~(nb == 0)
    out = np.zeros(a.shape, np.uint8)
    out[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    out[..., 3] = np.where(solid, 255, 0)
    out[~solid, :3] = 0
    return add_outline(out, TINT[hero][0])


def add_outline(img, col):
    """1 px hue-tinted outline (4-neighbour) where the silhouette edge isn't already dark."""
    solid = img[..., 3] > 0
    ring = ndi.binary_dilation(solid, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]])) & ~solid
    out = img.copy()
    out[ring, :3] = col
    out[ring, 3] = 255
    return out


def trim_box(img):
    ys, xs = np.where(img[..., 3] > 0)
    return ys.min(), ys.max(), xs.min(), xs.max()


def feet_x(img):
    """centre column of the lowest 14 rows (the feet / boots)."""
    al = img[..., 3] > 0
    y1 = np.where(al.any(1))[0].max()
    band = al[max(0, y1 - 14):y1 + 1]
    xs = np.where(band.any(0))[0]
    return (xs.min() + xs.max()) / 2.0


def place(img, cw=FW, ch=FH, cx=None, feet=FEET, dx=0, dy=0):
    """Paste trimmed img into a cw x ch cell with its feet on row `feet` and its foot centre on cx."""
    y0, y1, x0, x1 = trim_box(img)
    crop = img[y0:y1 + 1, x0:x1 + 1]
    fx = feet_x(img) - x0
    cx = cw / 2 if cx is None else cx
    ox = int(round(cx - fx)) + dx
    oy = feet - (y1 - y0) + dy
    cell = np.zeros((ch, cw, 4), np.uint8)
    h, w = crop.shape[:2]
    sy0, sx0 = max(0, -oy), max(0, -ox)
    dy0, dx0 = max(0, oy), max(0, ox)
    hh, ww = min(h - sy0, ch - dy0), min(w - sx0, cw - dx0)
    if hh > 0 and ww > 0:
        src = crop[sy0:sy0 + hh, sx0:sx0 + ww]
        dst = cell[dy0:dy0 + hh, dx0:dx0 + ww]
        m = src[..., 3] > 0
        dst[m] = src[m]
    return cell


# ---------- pixel-exact transforms ----------
def shear_rows(cell, top_shift, pivot=FEET):
    """Lean: each row is shifted horizontally by an integer amount growing from 0 at `pivot`
    to `top_shift` at the top of the sprite (no resampling, rows stay intact)."""
    al = cell[..., 3] > 0
    ys = np.where(al.any(1))[0]
    if not len(ys) or top_shift == 0: return cell
    top = ys.min(); out = np.zeros_like(cell)
    for y in range(cell.shape[0]):
        t = (pivot - y) / max(1, pivot - top)
        s = int(round(top_shift * min(1, max(0, t))))
        out[y] = np.roll(cell[y], s, axis=0)
        if s > 0: out[y, :s] = 0
        elif s < 0: out[y, s:] = 0
    return out


def band_shift(cell, y_split, dy):
    """Move everything above row y_split down by dy (squash/breath). Rows below are untouched."""
    if dy == 0: return cell
    out = cell.copy()
    upper = cell[:y_split].copy()
    out[:y_split] = 0
    out[dy:y_split + dy] = np.where(upper[..., 3:] > 0, upper, out[dy:y_split + dy])
    return out


def leg_swing(cell, y_split, amt):
    """Shear only the leg band (rows below y_split) so feet swing by `amt` px."""
    out = cell.copy()
    h = cell.shape[0]
    for y in range(y_split, h):
        t = (y - y_split) / max(1, FEET - y_split)
        s = int(round(amt * min(1, t)))
        if s:
            row = np.roll(cell[y], s, axis=0)
            if s > 0: row[:s] = 0
            else: row[s:] = 0
            out[y] = row
    return out


def shift(cell, dx, dy):
    out = np.zeros_like(cell)
    h, w = cell.shape[:2]
    src = cell[max(0, -dy):h - max(0, dy), max(0, -dx):w - max(0, dx)]
    out[max(0, dy):max(0, dy) + src.shape[0], max(0, dx):max(0, dx) + src.shape[1]] = src
    return out


def tint(cell, col, amt):
    out = cell.copy(); m = out[..., 3] > 0
    out[m, :3] = (out[m, :3] * (1 - amt) + np.array(col) * amt).astype(np.uint8)
    return out


def recolor_outline(cell, outline_col, new_col):
    out = cell.copy()
    m = (out[..., 3] > 0) & np.all(out[..., :3] == np.array(outline_col, np.uint8), -1)
    out[m, :3] = new_col
    return out


def dither_keep(mask, frac, seed=0):
    """Ordered-dither: keep `frac` of the pixels of mask, crisp 1-bit."""
    h, w = mask.shape
    th = np.tile(BAYER, (h // 4 + 1, w // 4 + 1))[:h, :w]
    return mask & (th < frac)


def fx_layer(cell, hero, rx=None, pad=2):
    """Split the attack drawing into a body core (always shown) and a swing layer (weapon arc + FX)
    using an ellipse around the trunk anchored at the feet."""
    h, w = cell.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    al = cell[..., 3] > 0
    ys = np.where(al.any(1))[0]
    cx = feet_x(cell)
    top = ys.min()
    cy = (FEET + max(top, FEET - 90)) / 2
    ry = (FEET - max(top, FEET - 90)) / 2 + pad
    rx = rx or (17 if hero != 'markie' else 20)
    core = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1
    return al & core, al & ~core, (cx, cy - ry * .35)


def sweep_mask(shape, pivot, frac, start=-150, end=110):
    """Angular reveal around pivot from `start` degrees (behind/above, facing east) to start+frac*(end-start)."""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    ang = np.degrees(np.arctan2(yy - pivot[1], xx - pivot[0]))   # 0 = east, +90 = down
    ang = np.where(ang < start, ang + 360, ang)
    return ang <= start + frac * (end - start)


def compose(cell, core, swing, swing_keep):
    out = np.zeros_like(cell)
    m = core | (swing & swing_keep)
    out[m] = cell[m]
    return out


# ---------- animation builders ----------
def build_idle(base, hero):
    frames = []
    al = base[..., 3] > 0
    top = np.where(al.any(1))[0].min()
    waist = int(top + (FEET - top) * .55)
    chest = int(top + (FEET - top) * .30)
    # breathe: chest band settles 1 px, head band follows a frame later; eased in/out
    for k, (b1, b2) in enumerate([(0, 0), (0, 0), (1, 0), (1, 1), (1, 1), (0, 1)]):
        f = band_shift(base, waist, b1)
        f = band_shift(f, chest, b2) if b2 else f
        frames.append(f)
    return frames


def build_run(base, hero):
    al = base[..., 3] > 0
    top = np.where(al.any(1))[0].min()
    hips = int(top + (FEET - top) * .62)
    frames = []
    # two strides per cycle: contact (low) -> passing (high), legs swing via a leg-band shear
    bob = [1, 0, -1, -2, 1, 0, -1, -2]
    swing = [3, 1, -1, -3, -3, -1, 1, 3]
    lean = [-2, -2, -1, -1, -2, -2, -1, -1]
    for k in range(8):
        f = leg_swing(base, hips, swing[k])
        f = shear_rows(f, lean[k] * -1)
        f = shift(f, 0, bob[k])
        frames.append(f)
    return frames


def fx_pixels(cell, hero):
    """Weapon-arc / energy pixels: outside a generous trunk ellipse AND bright or saturated.
    Used only to dissolve the baked swing FX on recovery frames (limbs are mostly kept)."""
    _, swing, pivot = fx_layer(cell, hero, rx=24, pad=6)
    rgb = cell[..., :3].astype(int)
    lum = rgb @ np.array([.299, .587, .114]); sat = rgb.max(-1) - rgb.min(-1)
    return swing & ((sat > 90) | (lum > 165)), pivot


def build_attack(idle, atk, hero):
    """Two drawings: the idle drawing is the wind-up (lean back + crouch), the attack drawing is the
    strike. Recovery dissolves only the baked FX pixels with an ordered dither, then returns to idle."""
    al = idle[..., 3] > 0
    top = np.where(al.any(1))[0].min()
    waist = int(top + (FEET - top) * .55)
    fx, _ = fx_pixels(atk, hero)
    def fade(keep):
        out = atk.copy(); drop = fx & ~dither_keep(fx, keep); out[drop] = 0; return out
    return [
        shift(shear_rows(band_shift(idle, waist, 1), 3), -2, 0),      # anticipation: lean back, settle
        shift(shear_rows(band_shift(idle, waist, 2), 5), -3, 0),      # deeper wind-up
        shift(tint(atk, (255, 255, 255), .18), 2, 0),                  # strike (smear-bright)
        shift(atk, 3, 0),                                              # impact
        shift(atk, 2, 0),                                              # hold
        shift(fade(.66), 1, 0),                                        # follow-through, FX dissolving
        shift(fade(.33), 0, 0),
        shift(shear_rows(idle, 1), 0, 0),                              # recovery back to guard
    ]


def build_special(idle, atk, hero):
    """Charge on the idle drawing (crouch + energy-coloured outline), release on the attack drawing
    with a white flash, then dissolve the baked FX."""
    outline, energy = TINT[hero]
    al = idle[..., 3] > 0
    top = np.where(al.any(1))[0].min()
    waist = int(top + (FEET - top) * .55)
    fx, _ = fx_pixels(atk, hero)
    glow = lambda f, g: recolor_outline(f, outline, tuple(int(outline[i] + (energy[i] - outline[i]) * g) for i in range(3)))
    def fade(keep):
        out = atk.copy(); drop = fx & ~dither_keep(fx, keep); out[drop] = 0; return out
    return [
        glow(band_shift(idle, waist, 1), .4),
        glow(shift(band_shift(idle, waist, 2), 0, 0), .75),
        tint(glow(shift(band_shift(idle, waist, 3), 0, 0), 1.), energy, .25),
        shift(tint(glow(atk, 1.), (255, 255, 255), .35), 2, -1),
        shift(glow(atk, 1.), 2, -1),
        shift(glow(atk, .8), 1, 0),
        glow(fade(.55), .5),
        glow(fade(.22), .2),
    ]


def build_hurt(base, hero):
    return [
        shift(tint(shear_rows(base, -3), (255, 255, 255), .65), -2, 0),   # impact flash
        shift(tint(shear_rows(base, -4), (255, 60, 60), .30), -3, 0),     # recoil, red
        shift(shear_rows(base, -3), -2, 0),
        shift(shear_rows(base, -1), -1, 0),
    ]


def build_down(base, hero):
    """Collapse (lean, buckle), then lying on the ground (exact 90-degree rotation) with a breath."""
    cw = DOWN_FW
    f0 = place(base, cw, FH, cx=cw / 2 + 4)
    f0 = tint(shear_rows(f0, -8), (40, 30, 50), .15)
    # buckle: drop the upper body down 6 px over the knees and lean further back
    al = base[..., 3] > 0
    top = np.where(al.any(1))[0].min()
    knees = int(top + (FEET - top) * .7)
    f1 = place(band_shift(base, knees, 6), cw, FH, cx=cw / 2 + 6)
    f1 = tint(shear_rows(f1, -16), (40, 30, 50), .25)
    y0, y1, x0, x1 = trim_box(base)
    crop = base[y0:y1 + 1, x0:x1 + 1]
    lying = np.rot90(crop, k=1)            # head to the left (falls backwards when facing east)
    lying = tint(lying, (40, 30, 50), .30)
    lh, lw = lying.shape[:2]
    def lie(breath):
        cell = np.zeros((FH, cw, 4), np.uint8)
        ox = max(0, (cw - lw) // 2); oy = FEET - lh + 2
        src = lying[:, :min(lw, cw)]
        dst = cell[oy:oy + lh, ox:ox + src.shape[1]]
        m = src[..., 3] > 0
        dst[m] = src[m]
        if breath:  # chest (left-centre third) rises 1 px
            x_a, x_b = ox + lw // 4, ox + lw // 2
            cell[:, x_a:x_b] = band_shift(cell[:, x_a:x_b], FEET - 10, -0) if False else np.roll(cell[:, x_a:x_b], -1, axis=0)
        return cell
    return [f0, f1, lie(False), lie(True)]


ANIMS = {  # name: (frames, frame ms, loop)
    'idle': (6, 150, True), 'run': (8, 85, True), 'attack': (8, 0, False),
    'special': (8, 70, False), 'hurt': (4, 70, False), 'down': (4, 160, False),
}


def sheet(frames):
    return Image.fromarray(np.concatenate(frames, axis=1), 'RGBA')


def main():
    os.makedirs(OUT, exist_ok=True)
    report = {}
    for h in HEROES:
        idle = clean(load_frame(h, 'idle', 6, 0), h, keep_fx=False)
        run = clean(load_frame(h, 'run', 8, 0), h, keep_fx=False)
        atk = clean(load_frame(h, 'attack', 8, 0), h, keep_fx=True)
        idle_c, run_c, atk_c = place(idle), place(run), place(atk)
        built = {
            'idle': build_idle(idle_c, h), 'run': build_run(run_c, h), 'attack': build_attack(idle_c, atk_c, h),
            'special': build_special(idle_c, atk_c, h), 'hurt': build_hurt(idle_c, h), 'down': build_down(idle_c, h),
        }
        report[h] = {}
        for a, frames in built.items():
            n = len(frames); fw = frames[0].shape[1]
            assert n == ANIMS[a][0], (h, a, n)
            name = f'{h}_{a}_{fw}x{FH}_{n}f.png'
            sheet(frames).save(os.path.join(OUT, name), optimize=True)
            report[h][a] = name
        y0, y1, _, _ = trim_box(idle_c)
        report[h]['_idleHeightPx'] = int(y1 - y0 + 1)
    # Runtime manifest read by public/js/hero-sheets.js. 'tiers' lists the mastery tiers that have
    # their own art in concept-v2/tier{n}/ (same filenames). Only base art (tier 0) exists today.
    manifest = {
        'version': 3, 'feet': FEET,
        'anims': {a: {'n': n, 'fw': DOWN_FW if a == 'down' else FW, 'fh': FH, 'ms': ms, 'loop': loop}
                  for a, (n, ms, loop) in ANIMS.items()},
        'heroes': {h: {'tiers': sorted(int(d[4:]) for d in os.listdir(OUT) if d.startswith('tier')
                                       and os.path.exists(os.path.join(OUT, d, report[h]['idle']))) or [0]}
                   for h in HEROES},
    }
    for h in HEROES:
        if 0 not in manifest['heroes'][h]['tiers']: manifest['heroes'][h]['tiers'].insert(0, 0)
    with open(os.path.join(OUT, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
