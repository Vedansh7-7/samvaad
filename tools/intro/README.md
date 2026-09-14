# Intro reel tooling

Rebuilds the product clips in `web/media/intro/` and the marketing cut in `docs/media/`.
Needs Node with Playwright (`npm i playwright`), Google Chrome, Python 3 and ffmpeg on the PATH.
Serve `web/` locally first: `cd web && python -m http.server 8123`.

| Step | Command | What it does |
|---|---|---|
| 1 | `node record-product.js` | Drives the real `app.html` against a mocked API and records it with Chrome's screencast at 1080x1920, with markers for every step. |
| 2 | `python cut.py` | Cuts the recording into `s1.mp4` to `s5.mp4`, dropping loading frames and fitting each clip to its voice line. |
| 3 | `node intro-check.js` | Checks the reel at phone size: sound, skips, layout, blocked autoplay. Screenshots land in `out/check/`. |
| 4 | `node record-film.js` then `python film.py` | Records `intro.html?film=1` and muxes the narration into `docs/media/samvaad-intro.mp4`. |

If the app's copy changes, update the text the recorder waits for (for example `Play the reflection`)
and the marker offsets in `cut.py`. Everything under `out/` is scratch and is not committed.
