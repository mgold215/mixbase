# Cassette Studio: handwriting and lettering

Part of the `cassette-studio` skill. Read when the work touches the handwriting sheet, the glyph bank, how a title is set or coloured, or a question like "why does this song's title look old?".

## A title is a stored picture (2026-11-10)

- A song's lockup is ONE file: `lettering-<pid>-<ts>.png`, the newest wins, written when Make it runs.
- "The title" / "Adjust the title" (`scene=keep`), the public share page (`newestLetteringUrl`) and the finished videos all re-use that file.
- So a change to the lettering engine, or to the handwriting on file, does NOT reach a song lettered before it until the song is made again. Expect that question after any lettering change, and check what the stored file actually says before blaming the engine.

## The owner's files

- 2026-11-10: the 36 sheet letters were re-measured in place (keys renamed; B, 6, 8, 9 replaced, because their counters had been sealed).
- The signature is the pen-written name from their CATALYST lettering photo, not the whiteboard-marker line. A fat marker at lowercase size is blobs no tracing can undo. If they redo the sheet with a marker, the newest signature wins and it will be blobby again.
- The two machine-written lockups on file were re-filed with ones the live site wrote: ERIS, and ECHOES OF THE DUST (whose old one read "moodmixformat ATE": a signature once cut wrong out of the NOT 2 LATE photo).
- CATALYST, 9AM IN ROSSLYN and NOT 2 LATE keep the owner's own photographed lettering. Never replace those unasked.

## Lifting ink off a photo (`src/lib/handwriting.ts`)

No font and no AI: a paper map immune to fat letters, a hysteresis threshold, holes and breaks in a stroke repaired, counters kept open. The lift no longer seals a fat marker's small counters (`classifyHoles`: glare sits inside one stroke, a counter between two).

## Type in my handwriting (`src/lib/handwriting-glyphs.ts`)

- Letters taught from a photo + the text it says become a glyph bank: `studio/<userId>/glyph-<cp>-<unit>-<base>-<ts>.png`.
- Routes: `GET|POST|DELETE /api/cassette-studio/glyphs`.
- `POST /api/cassette-studio/lettering` JSON `{ project_id, text, align }` composes a title from the bank the way a sign-writer sets it. A missing letter is reported, never invented.

## Reading the handwriting sheet (Setup)

ONE photo: the name on its own line, the other lines A–Z 0–9 in capitals labelled by ORDER (36 or 26 shapes).

- **The name line** is TOP or BOTTOM (`pickSignatureRow`, 2026-11-07): the end line that looks like a name (joined-up or lowercase), else the one leaving 36 shapes, else the top. Kept whole as `studio/<uid>/signature-<ts>.png`. `neatSignature` saves signatures already levelled.
- **Too many shapes.** With 1–2 shapes too many, `src/lib/handwriting-align.ts` `findExtraMarks` works out WHICH are not letters by comparing every shape with the bundled Futura type of the letter it would be labelled under every way of leaving them out. The clearly best way wins, else it is refused with EVERY line's count. The owner's whiteboard has a `#` before the digits and now reads.
- **Order check.** `readsInOrder` refuses a labelling that does not read as written (e.g. a sloping line cut in two) instead of teaching wrong letters.
- **Rows.** `segmentGlyphs` takes the photo's tilt out of the row grouping (`lineSlope`, ±12°) and drops rule-like strokes (frame/table edges).
- With no sheet, the signature is recovered once from the first line of a two-line lettering photo (`loadSignature`).

## The look (2026-11-06)

After the owner's reference cover: signature over title, small, bottom-centre, part of the picture rather than a caption.

- `pickLetteringPosition` tries bottom-centre FIRST (then bottom-left/right, top-centre/left/right; rank weight 4, so only a clearly busier patch or the cassette moves it). It holds bottom-centre unless another spot is clearly calmer in FINE detail (`SPOT_COST`; a gradient is not "busy").
- `stackLockup` centres the two lines.
- `SIZE_FRAC` is small 0.22 / medium 0.30 / large 0.40 of the cover width (was 0.32/0.42/0.54). `letteringRect` in `cassette-motion-scene.ts` mirrors the same fractions: keep them equal.

## The engine (2026-11-10, "crooked and sloppy")

- **Level lines.** `labelGlyphs` fits each row's baseline as a LINE (`robustLine`, Theil–Sen). The owner's rows climb 2–3°, and a flat baseline hung every letter at a different height.
- **Each capital its own measure.** Each capital/digit has its own height → `unit` and its own foot → `base`. One hanging below the line by > 1/7 cap (their J, Q, looped Y, 9) is measured from the line up. So every capital is set the same height on one level line.
- **Pen** (`handwriting-pen.ts`): traces a fat marker finer WITHOUT redrawing it.
  - `repen`: the outline moved inward on a 3× distance field, then redrawn with a round nib, so the beads of ink at stroke ends go instead of getting louder. A stroke too thin for the nib keeps its centre line and stays joined.
  - `strokeWidthOf` reads the pen off stroke centre lines so blobs don't count.
  - `prepareGlyph` takes less off whenever a letter would come apart or a counter's wall give way.
  - Pens: `fine` / `medium` (default, ≈ cap/7.8) / `bold` / `marker` (as written).
- **Spacing.** `composeHandwriting` has NO tilt or jitter any more and spaces by the white between the shapes (`letterGap`: tracking less most of the openness of the two facing sides, never closer than `CLEAR`).
- **Lockup.** `stackLockup(sig, title, {cap, stroke})`:
  - levels the name (`lineSlopeOf` + `shearLevel`, a shear so uprights stay upright) and drops strays under its baseline (`tidyLine`)
  - traces it to the title's pen
  - sizes its small letters at 0.7 of a capital (tall strokes ≤ 1.12)
  - sets a short title up to 1.3× larger
  - never returns a lockup narrower than 9 capitals (clear margin either side)
- **Even size across covers.** Lockups are drawn at a share of the cover's WIDTH. With that floor, and titles breaking onto two lines past 13 characters (`TITLE_LINE`), every cover's letters land within about a third of one size.

## Ink (`resolveInk`)

- Auto colour is light up to a mid-tone patch (luma ≤ 150) and dark on anything paler, leaned toward the cover's own highlights/shadows.
- It sits over a soft halo of the patch's own colour, whose strength follows how little the ink stands off and how busy the patch is.
- The SAME overlay goes to the moving cover's title layer (`tintLettering(…, halo)`).
