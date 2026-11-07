# Social Git product intro: Higgsfield shot pack

Target: 45–50 s vertical-safe cut, 16:9 master, 1080p. Each shot is generated separately, then cut to the voiceover and beat in editing.

Account check: the Higgsfield connector reports 8,994 credits on the Ultra plan. It can read models and history, but it can't start generations, so these shots must be run in the Higgsfield app (or a generation tool added to this session).

## Model choice

| Use | Model (catalog id) | Why |
| --- | --- | --- |
| Hero shots, cinematic camera | `cinematic_studio_3_0` (Cinema Studio Video 3.0) | Top cinema model, 4–15 s, up to 4K, optional audio |
| Brand-consistent objects, reference-driven | `seedance_2_0` (Seedance 2.0) | Consistent identity and multi-reference inputs, up to 4K |
| Physics / impacts (glass, bursts) | `minimax_hailuo` (Minimax Hailuo) | Natural physics, 1080p, 6–10 s |
| Cheap drafts before final render | `seedance_2_5` with `draft: true` | 480p draft, finalize at 1080p within 7 days |

Generate audio off for every shot. The voiceover and music are mixed in editing.

## Visual language

- Dark navy space (`#05070f`), cyan `#22d3ee`, violet `#a78bfa`, amber `#fbbf24`, green `#34d399`, coral-red `#fb7185` for the UNKNOWN beat.
- Glass and emissive light: cubes, rings, and data packets glow.
- Camera: fast push-ins and orbits, whip pans between shots, a slow dolly on the hero.

## Shots

**S1 · 0:00–0:04 · Logo reveal (3–4 s)**
Start image: black frame. Prompt: "Abstract dark void, a dense field of glowing cyan light particles converges into a sharp chrome cube that splits open, volumetric light, cinematic lens flare, slow push-in, 4k, no text."
Model: `cinematic_studio_3_0`, 1080p, 4 s.

**S2 · 0:04–0:08 · One gateway (4 s)**
Prompt: "Camera orbits a glowing isometric gateway tower; thousands of small glowing tiles light up one after another across a dark floor, each tile a different color, sweeping dolly, smooth motion, no text."
Model: `cinematic_studio_3_0`, 1080p, 5–6 s.

**S3 · 0:08–0:12 · Encrypted sessions (4 s)**
Prompt: "A translucent violet vault cube rotates and locks with a pulsing cyan shield ring, sparks of light, macro lens, shallow depth of field, slow motion, no text."
Model: `seedance_2_0`, 1080p, 5 s.

**S4 · 0:12–0:18 · Action verbs (6 s)**
Prompt: "Fast montage of abstract glowing light streaks that snap into five colored blocks, quick whip-pan transitions, energetic, neon, kinetic motion graphics, no text."
Model: `minimax_hailuo`, 1080p, 6 s.

**S5 · 0:18–0:23 · Queue and ledger (5 s)**
Prompt: "Glowing amber data packets travel along a path and drop into a stacked ledger tower, the tower pulses, a steady clean glow, dolly-in, no text."
Model: `cinematic_studio_3_0`, 1080p, 5 s.

**S6 · 0:23–0:28 · UNKNOWN beat (5 s)**
Prompt: "A coral-red light packet hits a glass barrier and freezes, the image glitches and flickers for half a second, then settles into a steady red question-mark glow, dramatic, dark, tense, no text."
Model: `minimax_hailuo`, 1080p, 6 s.

**S7 · 0:28–0:33 · One contract (5 s)**
Prompt: "Four glowing capsule-shaped interfaces assemble in the air around a central gateway core, rotating into a clean symmetrical arrangement, cinematic, clean light, no text."
Model: `seedance_2_0`, 1080p, 5 s.

**S8 · 0:33–0:38 · Reddit first (5 s)**
Prompt: "A glowing green platform rises out of the dark floor, a wide orbit camera reveals a bright orange and green signal beam, smooth epic motion, no text."
Model: `cinematic_studio_3_0`, 1080p, 5 s.

**S9 · 0:38–0:44 · Self-host (6 s)**
Prompt: "A sleek dark rack server room with cyan light strips, a single console glowing, slow dolly toward the glow, shallow depth of field, moody, no text."
Model: `cinematic_studio_video_v2`, 1080p, 6 s.

**S10 · 0:44–0:50 · End card and logo hold (6 s)**
Prompt: "Light particles drift and gather into a gradient glow behind a dark empty center, a soft horizontal light sweep, premium brand ending, no text."
Model: `cinematic_studio_3_0`, 1080p, 6 s.

## Editing notes

- Typography, the wordmark, the terminal, and the UNKNOWN text are overlays added in editing. Keep the prompts text-free.
- Cut to the beat (120 BPM, a beat every 0.5 s). Flash cuts on the downbeat of each VO line.
- VO lines and timings: `media/lines.txt`. Music: `media/music.py`.
