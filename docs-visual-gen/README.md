# docs-visual-gen

React + anime.js scenes rendered to PNG / GIF for the m4trix docs.

```bash
pnpm --filter docs-visual-gen dev                  # live preview gallery at http://localhost:5199
pnpm --filter docs-visual-gen render               # render every scene into docs/images/visuals
pnpm --filter docs-visual-gen render fan-out       # render one scene
pnpm --filter docs-visual-gen render --out ./tmp   # render somewhere else
```

Rendering drives your installed Google Chrome through `playwright-core` (no browser download).
Set `CHROME_PATH` to use a different Chromium binary.

## Layout

```
src/
  lib/            shared components, one file each, with co-located CSS and motion helpers
  scenes/         one file per visual; composes lib components and builds its timeline
    manifest.ts   scene ids, sizes and output settings (shared with the render script)
  runtime/        timeline hook: plays in preview, is seeked frame by frame when captured
scripts/render.ts Vite + Chrome → PNG, or frames → GIF (+ .poster.png)
```

Scenes only **compose** `src/lib`. To redesign an agent, a channel, the frame, or how a token
moves, change it in `src/lib` and re-render; every scene picks it up.

| Component       | Material    | Used for                                          |
| --------------- | ----------- | ------------------------------------------------- |
| `Frame`         | dotted gray | the canvas every visual sits on                   |
| `Network`       | glass       | `AgentNetwork` boundary                           |
| `Channel`       | tinted glass, dashed | channels; overlap = subscribe one / publish other |
| `Agent`         | neumorphic  | agents; `animateAgentRun` shows the logic running |
| `Port`          | neumorphic  | `expose()`, `proxy.sse()` on the network border   |
| `EventStack`    | glass       | static event with queued events behind it         |
| `Token`         | violet pill | event in motion (`tokenIn` / `tokenTravel` / `tokenOut`) |
| `ClientCard`    | neumorphic  | browser receiving the stream                      |
| `Wires`         | dashed SVG  | routes tokens travel along                        |

## Adding a scene

1. Add an entry to `src/scenes/manifest.ts` (`png` with a `scale`, or `gif` with `fps`,
   `durationMs`, `posterAtMs`).
2. Create `src/scenes/<id>.tsx`. Position things in canvas pixels.
3. For GIFs, build the motion in `useSceneTimeline((tl) => …)`. Only use anime.js (no CSS
   animations, they can't be seeked), and end in the same state you start in so the loop is
   seamless.
4. Register the component in `src/scenes/index.ts` and run `render <id>`.

## How GIFs are made

The page is opened with `?capture`, which pauses the timeline. The renderer seeks it to each
frame time and takes a screenshot, so output is deterministic. Frames are encoded with
[gifenc](https://github.com/mattdesl/gifenc) using:

- one palette for the whole loop (no color flicker between frames),
- exact nearest-color mapping plus a light ordered dither (soft shadows don't band),
- frame-diff transparency (unchanged pixels are transparent, so files stay around 1 MB).

A `<id>.poster.png` is written next to every GIF for places that can't autoplay.
