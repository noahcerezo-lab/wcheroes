# Concept-art hero animation (preview, opt-in with `?newart=1`)

Seven heroes × six actions (idle 6f, run 8f, attack 8f, special 8f, hurt 4f, down 4f). Frames are 96×128
(down is 128×128 so the lying pose isn't cropped). Feet sit on row 122 of every frame. `manifest.json`
holds frame counts, sizes, timing and which mastery tiers have art.

## Where the sheets come from

`tools/concept_v2_build.py` rebuilds every sheet from the original prototype pack in
`art-src/concept-v2-original/` (kept unchanged for reference). The prototype pack contains only
**three illustrations per hero** (idle, run, attack); its other frames were whole-image shifts with
wrap-around. The build script cleans those 21 drawings (black-matte un-premultiply, 1-bit alpha,
wrap-around/junk removal, dark-fringe peel, 1 px hue-tinted outline, shared feet baseline) and then
animates them with pixel-exact operations only (integer shifts, row shears, band squash, exact 90°
rotation, palette tints, ordered-dither FX dissolve). **No frame is hand-redrawn.**

## Mastery tiers

Tier 0 = Lv 1–9, 1 = Lv 10–19, 2 = Lv 20–29, 3 = Lv 30+. Put tier art in `concept-v2/tier{n}/` with the
same filenames and list the tier in `manifest.json` (`heroes.<hero>.tiers`; the build script fills this
in automatically). Missing tiers fall back to the highest lower tier, so no 404s. No tier art exists yet.

## Still needed before this can be the default

- Hand-animated run cycles (real leg alternation), attack wind-up/strike/recovery drawings, side-on idle.
- Special poses distinct from the attack drawing; a proper fall/lying drawing for down.
- Mastery I / II / Legendary costume art for all seven heroes (21 costume sets × 6 actions).
- Attack sheets bake in large FX (e.g. Smitesh's spirit wolf, Noah's/Dave's crescents) on top of the
  game's own procedural attack FX; final art should keep FX separate.
