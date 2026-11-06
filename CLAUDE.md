# Swing Lab

Personal PWA: upload a golf swing video, get a stick-figure wireframe of your body, head and club next to an
on-plane model (down-the-line + face-on views, You / Ideal / Both, scrubber), coaching notes per swing position,
marked-up keyframes, a numbers table, and compare against older uploads. Thomas uses it on his iPhone home screen.
He swings left-handed. Proposal "A" (side drawer library) was the chosen UI.

## Stack & files
- `index.html` (markup + CSS), `js/app.js` (UI), `js/core.js` (analysis, pure, runs in Node), `js/rig.js`
  (ideal 3D rig), `js/render.js` (canvas drawing), `js/tracker.js` (MediaPipe + club scan), `js/store.js` (IndexedDB).
  Vanilla JS, no build step.
- `vendor/mediapipe/` (Tasks Vision 0.10.14 bundle + wasm) and `models/pose_landmarker_full.task` are bundled so
  nothing depends on a CDN. Apache 2.0, see `vendor/mediapipe/NOTICE.md`. ~28 MB, cached once by the service worker.
- `sw.js`: network-first app shell, cache-first `vendor/` + `models/`. Bump `CACHE` when shipping.
- Deploy: Netlify, auto-deploy on push to `main`, publish dir = repo root. Same URL = same IndexedDB (uploads survive).

## How the analysis works (js/core.js)
1. Pass 1: pose at 5 fps over the whole clip. `findSwings`: hands high (top) → sharp dip (impact) → high again
   within ~1.6 s. Slow rehearsals don't dip fast enough and are skipped.
2. Pass 2: each swing window (impact −2.4 s … +2.2 s) at 30 fps: pose + a thin-line scan for the shaft from the
   grip (`clubScores`, body/forearms masked, shaft must continue the forearms), then a DP path over 2° bins.
   Around impact the shaft is blurred, so the DP is nudged toward the ball found at address.
3. `analyzeSwing`: view (down-the-line vs face-on from shoulder width), ball/target side, lead side (→ lefty/righty),
   9 positions from the hand path, skeleton in the canonical frame (X target, Y up, Z ball, metres, origin between
   the ankles). **In-plane coordinates come from the 2D landmarks** (MediaPipe's most accurate output);
   only depth comes from the 3D world landmarks (smoothed harder). Lead ankle anchors the depth axis.
4. Metrics → notes → main fault (each fault = measured / its threshold; largest ≥ 1 wins).
- Clubface is never claimed. Weight shift is only measured from face-on clips. Club = "estimated".

## Rules (carried over from Kiu / Snowline)
1. **Close the loop, prove it, keep the test.** Trace each state (processing, interrupted, error, no swings,
   face-on, lefty/righty, light/dark) to an end the user can see. Add a case to `scripts/e2e.mjs`.
2. **Before pushing:** `node scripts/e2e.mjs` all passing; bump `CACHE` in `sw.js`.
3. Test at 390×844 first. iOS Safari is the target.
4. Honest data: label estimates as estimates, never invent a measurement.
5. **Never commit swing videos or tracking dumps** (public repo). `.gitignore` blocks video files and `fixtures/`.

## Tests
- `node scripts/e2e.mjs` — 22 checks with a mock tracker (`scripts/mock-tracker.js` builds MediaPipe-shaped data
  from the rig: lefty/righty, down-the-line/face-on, no-swing, error, slow).
- `node scripts/realrun.mjs <clip.webm> <outdir> [second.webm]` — the whole app on a real clip (local only).
- `node scripts/track.mjs <clip> <out.json>` + `node scripts/analyze.js <out.json>` — tracker + core on real clips.
- Headless Chromium can't decode HEVC (iPhone .mov) — convert test clips to VP9/H.264 first. Its GPU path is
  software-only, so test pages set `__FORCE_CPU`. Video seeking needs HTTP range requests (`scripts/serve.mjs`).

## Previously fixed bugs (don't regress)
- Frames looked frozen in tests: the static server had no range support, so `<video>` couldn't seek. App uses
  blob URLs; test server supports ranges.
- Seeked frame not presented yet → stale pixels. `seek()` waits for `requestVideoFrameCallback` (fallback: seeked+120 ms).
- Shaft detector locked onto the forearm/body edges → forearms masked + forearm-direction prior.
- Spine/hips/hands numbers were off from 3D depth noise → in-plane values from 2D landmarks.
- iPhone (Nov 6): swings found but every swing failed analysis, reason hidden ("not tracked clearly enough").
  Now: frames without 3D points are rebuilt from 2D (`worldFrom2D`, depth flattened), and per-swing failure
  reasons + frame counts + tracker/UA show under "Details for Claude" on the banner (copyable).
- Far (lead) leg wobbled and the shins crossed (Nov 6, lefty down the line): `stabilize()` = median-5 + visibility-
  weighted zero-phase Gaussian (legs strong, hands light), feet pinned (lead → finish, trail → impact), knees
  rebuilt from fixed thigh/shin lengths and forced to bend toward the ball. Leg jitter down ~60–90%, metrics unchanged.
- Nov 6: drawing the raw tracked joints looked jittery, off-proportion and "on a different plane" from the ideal.
  The wireframe now draws **both figures with the rig**: `Core.fitRig` turns the measurements at the 9 positions into
  rig keyframes (hand path in the image plane + club angle + spine tilt + hip shift, all relative to your own address;
  depth/turns kept from the ideal) and `youRigPose` blends them like the artifact did. Raw joints only feed metrics.
- Safari copies canvas-to-canvas lazily: each head gets its own scratch canvas (else heads show another view's face).

## Working style (user: Thomas)
Casual, direct. Concise numbered answers. Honest, evidence-based. Develops and tests from his iPhone only:
push changes, he reopens the app. Don't ask him to download or drag files.
