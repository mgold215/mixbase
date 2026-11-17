---
name: cassette-studio
description: Cassette Studio, the owner-only cover maker on web and iOS - one-click covers drawn around the owner's cassette, lettered in their own handwriting, with moving covers and optional Runway filming. Holds the owner's verdicts on what a good cover is, what each step costs, and the state of the owner's own files. Use before changing or answering anything about covers, ideas, takes, the judge or critic, handwriting, lettering or titles, the cover viewer, looks and filters, moving covers, "Film it", or files under mf-artwork/studio/.
---

# Cassette Studio

Covers built around the owner's cassette and lettered in their own handwriting. Owner-only, web + iOS.

Deeper notes, read when the work touches them:

- [lettering.md](lettering.md): the handwriting lift, the glyph bank, how a title is set, ink colour, the stored lockup
- [motion.md](motion.md): moving covers, designed motion, reels, filming with Runway

## The bar

- The owner called the old covers "soulless, lifeless, generic" and the lettering "crooked and sloppy" (2026-11-10).
- The reference is their ChatGPT-made CAPITAL HILL cover: the cassette inside a fresco, small neat cream lettering bottom-centre.
- The bar is "made by a person with intent", never "realistic". See [Taste](#taste-the-owners-verdicts).

## Access and storage

- Routes are `/api/cassette-studio/*`. NOT under `/api/artwork*`: that prefix is public.
- Every handler 404s unless `isAdminIdentity`. Clients learn it from `GET /api/auth/me` → `owner_tools`, never from `profiles.is_owner`.
- Studio files live in `mf-artwork/studio/<userId>/`: `subject-`, `lettering-<projectId>-`, `plate-<ts>.jpg`, `layer-<ts>-<left>-<top>.png`, `title-<fts>-<pos>-<size>.png`. Metadata is in the KEY because the bucket only accepts images. Account deletion removes the folder.
- Every Studio cover is saved as `<projectId>/ai-cassette-<ts>.jpg`.

## Two engines (since 2026-11-10)

- **Art engine** (the default, one click): an image model DRAWS the whole picture with the cassette photo as its reference.
- **Classic engine** (under Advanced, and the fallback): the photographed cassette pasted untouched into a FLUX Fill scene. Only there are the cassette's pixels never generated. Its covers are the frontal cassette on a ledge the owner tired of, so don't make it the default again.

Code map:

| File | What it does |
|---|---|
| `src/lib/cassette-studio.ts` | Cut-out clean-up incl. clear-plastic matting, placement, FLUX Fill request, layers → still |
| `src/lib/cassette-scenes.ts` | Scene presets |
| `src/lib/cassette-quick.ts` | The one-click run |
| `src/lib/cover-concept.ts` | Ideas, concept, `OWNER_VERDICTS`, `MEDIUMS` |
| `src/lib/cassette-art.ts`, `src/lib/cassette-server.ts` | Reference image, art prompt, takes |
| `src/lib/cover-filters.ts` | Looks |

`placeSubject(…, { x, y, scale })` ← render fields `place_x` / `place_y` / `place_scale` (cassette position + size; default = the old jittered framing).

## One click

`POST|GET /api/cassette-studio/quick`, at the top of the Studio on web + app. An in-memory background job like finalize-video (lost on deploy by design; see [Restore](#a-runs-result-outlives-the-servers-memory)).

1. **Ideas first.** `POST /api/cassette-studio/ideas` → three ideas in words (`writeCoverIdeas`, text only, about a cent). The screens show them and draw nothing until one is tapped, then send it back as `concept` in `POST /quick` (`parseConcept`). "Other ideas" sends `shown` labels. The box is OPTIONAL since 2026-11-10 (the artist's own idea; empty → the idea comes from the song's title).
2. **Concept.** `writeCoverConcept` (Claude `claude-opus-5-5`, structured output): `idea` (one sentence the artist reads), `label`, `scene` (the brief for the image model: medium, setting, the cassette's ROLE in the picture, light, palette) and `motion`. It is shown three random `MEDIUMS` to start from, the song's genre/BPM/key, and the labels of the artist's recent runs (`recentIdeas`, read back from the saved clips' titles) so covers don't repeat. `templateConcept` without a key.
3. **Lettering.** Signature over the song title, written from the glyph bank (`handwriting-sheet.ts`). Falls back to the song's own photographed lettering. Never invents a letter.
4. **Takes.** `cassette-art.ts` + `generateTakes`: the cut-out on a plain studio backdrop (`buildReference`) is the reference image; `artPrompt` = the cassette's identity + the scene + the rules (one cassette, no text, lower-centre calm). 3 takes at 2048² from `ART_MODELS`, best first:
   - `openai/gpt-image-2`: the model family behind the owner's reference; ~$0.13 a picture at Replicate's listed high-quality rate, 2–3 min for three
   - then `google/nano-banana-pro`, then `black-forest-labs/flux-2-max`
   - Slow models are created WITHOUT `Prefer: wait` and polled (`runReplicateAll`), or a paid-for picture is lost with its id.
   - Kept as `studio/<uid>/take-<projectId>-<run>-<i>.jpg` (the two newest runs per song).
5. **Pick.** `judgeTakes` (Claude vision next to the reference): is it the same cassette (clear shell, grey label, A tag, red/blue/yellow in order) and is it a cover; says where the title sits; without a key, the first take. `critiqueTakes` marks how human-made each take looks. `chooseTake` needs both marks; see [The critic](#the-critic).
6. **Cover.** `makeStudioCover` scene `take` (`finishTake`: exactly 3000², one fine grain pass). `POST /render` with `scene=take` + `take=<key>` makes another take of the run the cover with no new generation (the "Other takes" fold on both clients; `parseTakeKey` pins owner + song).
7. **Clips.** Canvas 9:16 + YouTube 16:9: the cover extended by FLUX Fill outpainting (`buildOutpaintRequest` / `finishOutpaint`: the real cover pixels stay in the middle; `fitStill` if that fails) and set in no-AI motion (see [motion.md](motion.md)). Saved (`mb_visualizers`, settings `{ source: 'cassette-quick' }`) and pinned: Canvas → `visualizer_url`, YouTube → `visualizer_wide_url`.

If no art model answers, the classic engine makes the cover and the run says so.

Job JSON adds `idea`, `takes`, `take`, `model` (null = classic) and the step state `skipped`. API-only fields: `formats`, `prompt` (an exact scene brief), `takes` 1–4, `model`.

## Taste: the owner's verdicts

Written out once as `OWNER_VERDICTS` (`cover-concept.ts`) and given to BOTH the art director and the critic. Change them only on a new verdict of the owner's.

- 2026-11-11, on the first drawn covers: ECHOES OF THE DUST and VITALS approved, ERIS "to an extent", BELLADONNA "clear AI look", 9AM IN ROSSLYN "very AI and fake looking". "There needs to be some kind of anti-slop agent that ensures it doesn't obviously look like AI. We're walking a thin line here."
- Corrected the same day, after the first rules had turned everything into true-to-life photographs: "it doesn't always need to be true to life. Just not clearly AI looking, maybe like digital art. Like Bugonia or the other 2 I mentioned I liked."
- Their BUGONIA cover (the cassette under a soap-bubble dome on a tiny flat earth, in a cave of honeycomb rock lit by lava) is the sixth verdict: APPROVED.
- So an imagined world as digital art is as welcome as a photograph. Do not tighten this back toward realism.

### Art direction (`CONCEPT_SYSTEM`)

Two kinds of picture, and three ideas include at least one of each:

- A photograph a person could really have taken: the cassette at its real size, about 10 cm, somewhere real.
- An imagined world as digital art (stylised 3D render, digital painting, designed illustration), where impossible things are welcome as long as it is ONE specific invention for that title, built from materials you could touch, in one palette, with every light and wisp of mist coming from something in the scene.

Never written, because it reads as AI: stock decoration (moons, sparkles, roses, crystals), glow or haze with no source, neon, purple-and-teal, golden-hour skylines, an impossible thing pasted into an ordinary photograph, crowds of figures, a generic epic vista.

`MEDIUMS` has five digital-art entries beside the photographs and handmade pieces. `artPrompt` carries the same two-way rule to the image model (true-to-life scale only when the brief is a photograph).

### The critic

- `critiqueTakes`: its own Claude vision call that sees only the takes and marks each 0–10 on `real` (does it pass for something a person made: a photograph, or art with a style of its own, true to life or not), with `tells` and a `fix`.
- `chooseTake` (pure, tested) needs BOTH the judge's cassette mark and the critic's mark to reach 7 (`CASSETTE_PASS`, `REAL_PASS`). When no take does: ONE corrected redraw, and the run says so if it still falls short.
- `POST /api/cassette-studio/critique { project_id, paths }` points the same critic at existing covers. No screen calls it. `instructions` on it and on `/ideas` replaces the standing prompt, for tuning without a deploy.

### What the first live runs taught

All in the prompts now, each with a test where one is possible:

- The image model PASTES the front-on reference view unless told to redraw the cassette in the scene's own perspective with a contact shadow and wear. The critic's commonest tell was "pasted on, too clean".
- "Real size" alone shrank the cassette to 8% of the frame. The camera comes close and the cassette fills a quarter to a half of the width.
- A black-and-white idea turned the red/blue/yellow stripes grey (or gave a selective-colour cassette the critic rejected). No black-and-white and no one- or two-ink medium.
- A Polaroid idea brought its white border, which the judge faults and the title cannot be read on. The picture fills the square.
- A filmed clip turned a small cassette green until `FILM_KEEP` (`cassette-quick.ts`) told the video model what must not change.

## Spend

The owner, 2026-11-11: "$.50 per run seems risky if I don't like the concept". Hence ideas first, and filming as its own step.

- Ideas: about a cent.
- A cover: 3 takes (~38¢), plus up to 2 more on a redraw (~26¢), plus ~10¢ to extend it for the clips. Three of the first four runs needed the redraw, so the screens say 50 to 75 cents.
- Filming (see [motion.md](motion.md)): about 80 Runway credits a clip, shown before the tap.
- Never start a run while a deploy is still swapping replicas: the job dies with the old one, paid pictures and all. Wait for the previous deployment to read REMOVED.
- A paid test run needs the owner's yes first (AGENTS.md → Working with the owner).

## After the run

### Adjust the title (web + app, under the result; 2026-11-02)

The cover re-lettered after the fact in a chosen colour / spot (the six corners or `auto`) / size: `POST /render` with `scene=keep` + the run's own `lettering` path. No AI. The job reports `title` (resolved colour + spot) so the chips start from what the run used. `syncQuickCover` (called by render-keep and filter-save) keeps the in-memory job's cover current so a reload shows the adjusted cover. The filmed clips keep their title; Make it again refilms.

### Cover viewer (2026-11-03)

- Web: `src/components/CoverViewer.tsx`, opened from the dashboard list's art and the project header's art.
- App: `CoverViewerView.swift`, opened from the songs list's art and the song screen's art.
- Tap the album art → the full cover + Save. The owner also gets "The title" (render `scene=keep` with the song's newest lettering, then the remembered look re-applied) and "The look" (the shared look editor, `heading` prop/param) right there, no Studio needed.

### Finish the look

`/api/cassette-studio/filter`, `src/lib/cover-filters.ts`: 10 presets + 7 sliders + Color/B&W/Sepia, previewed at ≤1080px and saved as `finalized_artwork_url` = `<projectId>/finalized-<fts>-f<code>.jpg`.

- The look is encoded in the KEY (strict `encodeFilter` / `decodeFilter`).
- It is always applied to the UNFILTERED base the server resolves from the project's own keys (plain `finalized-<fts>.jpg`, else the artwork), so looks never stack. Saving "Original" resets.
- `finalizedCoverStamp` accepts the `-f<code>` suffix, and the moving cover re-applies the same grade to its plate/cassette/title.

### A run's result outlives the server's memory

2026-11-12, the owner: "Film it disappears after I edit artwork". The result card, and with it Title / Look / Film it, used to exist only while the in-memory job did (three hours, one replica, until the next deploy).

`GET /quick?project_id=` now falls back to `restoreQuickJob`: the song's current cover, the clips saved for THAT cover, the idea and the newest lettering, put back together from `mb_projects` + `mb_visualizers` as a finished job (id `restored-<projectId>`, no takes). Both clients show it as they show any finished run, with no client change.

## Setup

`GET|POST /api/cassette-studio/setup`.

- The newest cassette cut-out is used.
- ONE handwriting-sheet photo teaches the letters and the signature; nothing to type. How it is read: [lettering.md](lettering.md).
- **From mixBase** (`GET /api/cassette-studio/photos`, `POST /subject` JSON `{ source_path }`): cut a cassette out of an image already under one of the owner's `<projectId>/` folders instead of re-uploading. `parseSourcePath` pins the shape, the route checks project ownership and size, and reads it from Storage by key (never by URL).

## Screen rules

- 2026-10-28: the owner wants ONE box + ONE button; everything else folds under "Advanced".
- 2026-11-06, "too cluttered": the result's Title/Look editors fold behind two chips; Setup folds to one status line once the cassette + a full sheet are in; on the Visualizer screen the finished video's options, the loop makers (open only while nothing is pinned) and the library fold too.
- Never add a visible control to these screens without a fold.
- 2026-10-24, still holds: NEVER pin one clip across all songs.
- The saved "theme" (2026-10-24) was REMOVED 2026-10-28 as too complicated. Consistency comes from the one-click flow itself: same cassette, same handwriting, auto placement.

## State of the owner's files

- **Spare covers.** The covers the 2026-11-10 test runs drew were copied into the matching songs' own folders (`<projectId>/ai-cassette-<ts>.jpg` + its lettered `finalized-<ts>.jpg`): ERIS twice, VITALS, ECHOES OF THE DUST, BELLADONNA, 9AM IN ROSSLYN. They are NOT live. They show in each song's Artwork History (web only). Making one live is a restore of the `ai-cassette` file and then of its `finalized` file (`POST /api/projects/<id>/artwork-history`).
- Lettering and signature files: see [lettering.md](lettering.md).

## Testing

The Studio answers 404 to everyone but the owner, and its runs cost money. How to test it live, and what to ask first: the `debugging-production` skill → Testing live.
