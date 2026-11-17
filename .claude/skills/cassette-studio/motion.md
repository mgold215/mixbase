# Cassette Studio: moving covers and filming

Part of the `cassette-studio` skill. Read when the work touches the free clips of a cover, reels, the motion plan, or filming with Runway.

## The bar

The owner on the old drift, 2026-11-12: "all the video did was slightly move around. Very underwhelming". The loop must read as ALIVE at a glance. Do not turn the amounts back down.

## Which motion a cover gets

| Cover | Motion |
|---|---|
| Classic cover with its own layers | `makeMovingCover`: reel hubs turn, two-plane camera drift, per-frame grain |
| A cover with no layers of its own (drawn by the art engine, or older than layer persistence) | Designed motion: a plan written for that cover, drawn over its real pixels (`makeStillCover`) |
| Planning or drawing the designed motion fails | `stillLoop`: the still itself in a slow floating drift with live grain |

## Classic moving cover

`/api/cassette-studio/motion`, `src/lib/cassette-motion*.ts`, `cassette-render*.ts`.

- A no-AI loop from the cover's layers: reel hubs turn (whole turns per loop), two-plane camera drift, per-frame grain.
- Saved as a `free`-kind visualizer, settings `{ source: 'cassette-motion', format, title }`. `title: false` = the loop without the handwritten title.

## Still loop (`still-loop.ts`)

zoompan + noise, one camera turn per loop so it is seamless. `fitStill` puts any shape into the format over a blur of itself.

## Designed motion (2026-11-11; shipped 2026-11-12)

The owner: "I also like using fable for visualizer".

- A model LOOKS at the finished cover and writes a motion plan for it: `cover-motion-direct.ts` `writeMotionRecipe`, effort low, one call per run shared by both clips, a few cents. `MOTION_MODELS` are tried in order: `claude-fable-5-2`, then the art director's `claude-opus-5-5` as stand-in.
- `templateRecipe` (no key) = a push-in and grain, deliberately with no elements: effects added blind are the stock look.
- The server draws that plan over the real cover pixels:
  - `cover-motion.ts`: the plan + `parseMotionRecipe`, which clamps or drops anything a model got wrong
  - `cover-motion-scene.ts`: the frame
  - `cover-motion-render.ts` + `cover-motion-worker.ts`: the same sliced Skia-into-ffmpeg render as the other no-AI loops, about 7 s a clip
- Nothing is regenerated, so the cassette cannot change (the reason a filmed clip once turned it green).

### The plan

A camera (`push` the default, `float` / `sway` / `rise` / `still`), grain, and at most 7 elements:

| Element | What it is |
|---|---|
| `spin` | A cassette reel turning. Asked for on BOTH reels of every cover, because it says the tape is playing |
| `particles` | Dust, sand in gusts, snow, rain, embers, bubbles, moths |
| `glow` | Breathe/flicker/pulse on a light already in the picture |
| `shimmer` | Breeze for leaves and cloth, heat, water |
| `sweep` | One glint across glass or the cassette's shell |
| `mist` | Mist |
| `trace` | A point of light running along a drawn line, e.g. the VITALS pulse line |

- Plans are written against the SQUARE cover. `areaToFrame` carries them into 9:16 and 16:9, where an area touching the cover's edge runs to the frame's edge.
- Everything is periodic. A particle LIVES (fades in, travels a little, fades out, a whole number of times per loop), because a whole crossing per 8 s is far too fast for dust.

### Reels (`refineSpins` / `findHub`)

- A model aims a reel to within a few percent, and a disc turned about a centre that far off wobbles. So each spin is searched for in the picture: a hub has six teeth, so about its true centre the picture survives a sixth of a turn and not a twelfth.
- The search also finds how flat the hub looks and which way it leans (covers show the cassette in perspective) and where its teeth end. The reel is turned in that plane (`squash` / `tilt`, never asked of a model).
- No hub found (`HUB_SYMMETRY`), or one of two: no reel turns.
- On the owner's covers it finds BELLADONNA's and VITALS's reels and declines BUGONIA's (irregular teeth) and ECHOES's (too small).

### Remembering the plan

- The clip's settings keep the plan (`motion: 'designed'`, `recipe`, `motion_model`), and the run adds one "How it moves:" note.
- The Advanced moving-cover button re-uses a cover's saved plan (`rememberedMotion`), or has the cover looked at once (a few cents) and keeps that plan with the clip. That button is how a cover made before this change gets the new motion without being redrawn.

### Not yet run live

The model call itself has never run live (no key in a remote session, and a paid test needs the owner's yes). The first real run is its test: read `[cassette-quick] motion plan by …` in the deploy logs.

## Filming with Runway (its own paid step)

`runway-video.ts`, then `video-loop.ts` makes the seamless silent loop (trim/fade/overlay; the 2018 ffmpeg has no xfade).

- A run makes the cover + the free clips only. `POST /quick { film: true }` (the "Film it" fold on both clients, price shown from `job.film.credits_each`) films the CURRENT cover afterwards.
- Runway bills by the second in credits (1 credit = 1 cent): Veo 3.1 is 40/s with sound, 20 without; Fast 15/10; Gen-4.5 12; Gen-4 Turbo 5.
- Until 2026-11-11 every run filmed two 8 s Veo 3.1 clips WITH sound, about $6.40, automatically, before the owner had seen the cover. That is where the credits went by 2026-11-02.
- Now `audio: false` and Veo 3.1 Fast first: about 80 credits a clip.
- A shot that fails leaves the pinned clip alone.
- The clips' settings remember the idea (`idea` / `brief` / `move`) so filming later picks the same picture up.
- `FILM_KEEP` (`cassette-quick.ts`) tells the video model what must not change.
- The filmed clips keep their title; Make it again refilms.
