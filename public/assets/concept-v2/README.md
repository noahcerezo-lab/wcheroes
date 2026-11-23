# Concept-art character animation (preview)

The browser can now load the seven high-detail 96×128 hero sheets without changing combat or existing artwork.

## Install art assets

Extract the supplied `wcheroes_concept_animation_v2.zip` and copy the 42 PNGs into `public/assets/concept-v2/`. Do **not** place `manifest.json` or `README.txt` in the loader path unless useful for documentation.

Naming example: `public/assets/concept-v2/noah_idle_96x128_6f.png`.

## Test

Start the game at `/?newart=1` to opt in. A pose uses the new art only after its PNG loads successfully; if missing or still loading, the old sprite is drawn. Without the flag the live game remains unchanged.

Test seven heroes, idle/run/attack/hurt/down, iPhone Safari, and multiplayer fights. Check for cropped weapon tips, dark transparency halos, feet anchor alignment, and rapid transitions. The PNGs are **pose-derived prototypes**, not polished hand-animated sequences; they should not be made the default before review.

## Follow-up production

- Clean transparent edges and remove black matte halos.
- Animate distinct intermediary frames for each action.
- Add special, hurt and downed transitions and directional perspectives.
- Create level 10/20/30 mastery art, preserving Dave's long hair/mustache and Markie's clean-shaven face.
- Once assets are approved and deployed, remove the opt-in and preload only nearby active heroes.
