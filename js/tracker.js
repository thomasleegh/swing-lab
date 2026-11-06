// On-device video tracking: MediaPipe pose for the body, a thin-line scan for the club shaft.
// Pass 1 samples the whole video at 5 fps to find swings; pass 2 tracks each swing at 30 fps.
import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const COARSE_FPS = 5, FINE_FPS = 30, PROC_W = 720;
let landmarker = null, landmarkerDelegate = null;

export async function getLandmarker(base = '.') {
  if (landmarker) return landmarker;
  const fs = await FilesetResolver.forVisionTasks(`${base}/vendor/mediapipe/wasm`);
  const opts = (delegate) => ({ baseOptions: { modelAssetPath: `${base}/models/pose_landmarker_full.task`, delegate }, runningMode: 'IMAGE', numPoses: 1, minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4 });
  const order = (globalThis.__FORCE_CPU || !('gpu' in navigator || /iPhone|iPad|Mac/.test(navigator.userAgent))) ? ['CPU'] : ['GPU', 'CPU'];
  let lastErr;
  for (const d of order) {
    try { landmarker = await PoseLandmarker.createFromOptions(fs, opts(d)); landmarkerDelegate = d; return landmarker; } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Pose model failed to load');
}
export function delegateInUse() { return landmarkerDelegate; }

// Seek and wait until the new frame is actually presented (paused seeks can otherwise hand back the old frame).
function seek(v, t) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    const to = setTimeout(fin, 1500);
    const ok = () => { clearTimeout(to); fin(); };
    if (v.requestVideoFrameCallback) { v.requestVideoFrameCallback(() => ok()); v.onseeked = () => setTimeout(ok, 120); }
    else v.onseeked = () => setTimeout(ok, 30);
    v.currentTime = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.02));
  });
}

export function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', '');
    // Inside the viewport (Safari may skip decoding off-screen video), but invisible.
    v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(v);
    const fail = () => { v.remove(); reject(new Error('This video could not be opened. Try exporting it from Photos as "Most Compatible".')); };
    v.onerror = fail;
    v.onloadeddata = async () => {
      // start decoding once (muted inline playback needs no tap on iOS), then pause and seek frame by frame
      try { await v.play(); } catch (e) {}
      v.pause();
      resolve(v);
    };
    v.src = url;
    v.load();
  });
}

function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function landmarkArrays(r) {
  if (!r || !r.landmarks || !r.landmarks[0]) return { lm: null, wl: null };
  const lm = r.landmarks[0].map((p) => [round(p.x, 4), round(p.y, 4), round(p.z, 4), round(p.visibility ?? 0, 2)]);
  const wl = r.worldLandmarks && r.worldLandmarks[0] ? r.worldLandmarks[0].map((p) => [round(p.x, 4), round(p.y, 4), round(p.z, 4), round(p.visibility ?? 0, 2)]) : null;
  return { lm, wl };
}
function round(x, d) { const m = 10 ** d; return Math.round(x * m) / m; }

// ---------- club shaft scan ----------
// For each direction out from the grip, measure how much a thin line (brighter or darker than both sides)
// runs along it, ignoring the stretches that pass over the body or forearms.
const NANG = 180; // 2-degree bins
const SEGS = [[11, 12], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [11, 13], [12, 14], [13, 15], [14, 16], [0, 11], [0, 12], [7, 8]];
export function gripPx(lm, W, H) {
  const ids = [15, 16, 17, 18, 19, 20]; let sx = 0, sy = 0, sw = 0;
  for (const i of ids) { const w = (lm[i][3] || 0) + 1e-3; sx += lm[i][0] * W * w; sy += lm[i][1] * H * w; sw += w; }
  return [sx / sw, sy / sw];
}
export function bodyPx(lm, H) { return Math.abs((lm[27][1] + lm[28][1]) / 2 - lm[0][1]) * H; }
export function clubScores(gray, W, H, lm) {
  const out = new Float32Array(NANG);
  if (!lm) return out;
  const G = gripPx(lm, W, H), body = bodyPx(lm, H), L = body * 0.9 / 1.55;
  const P = (i) => [lm[i][0] * W, lm[i][1] * H];
  const segs = SEGS.map(([a, b]) => [P(a), P(b)]);
  const minD = 0.06 * body, NR = 56;
  const fa = [(lm[15][0] - lm[13][0]) + (lm[16][0] - lm[14][0]), (lm[15][1] - lm[13][1]) + (lm[16][1] - lm[14][1]) * (H / W)];
  const fan = Math.hypot(fa[0], fa[1]) || 1;
  const px = (x, y) => { const xi = x | 0, yi = y | 0; return (xi < 0 || yi < 0 || xi >= W || yi >= H) ? -1 : gray[yi * W + xi]; };
  for (let k = 0; k < NANG; k++) {
    const a = k * 2 * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    let sum = 0, cnt = 0;
    for (let j = 0; j < NR; j++) {
      const r = (0.15 + 0.83 * j / (NR - 1)) * L;
      const x = G[0] + dx * r, y = G[1] + dy * r;
      if (x < 7 || y < 7 || x >= W - 7 || y >= H - 7) continue;
      let near = false;
      for (const [s0, s1] of segs) {
        const abx = s1[0] - s0[0], aby = s1[1] - s0[1], l2 = abx * abx + aby * aby + 1e-9;
        let t = ((x - s0[0]) * abx + (y - s0[1]) * aby) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x - (s0[0] + t * abx), ey = y - (s0[1] + t * aby);
        if (ex * ex + ey * ey < minD * minD) { near = true; break; }
      }
      if (near) continue;
      const c = px(x, y), l1 = px(x + 3 * nx, y + 3 * ny), r1 = px(x - 3 * nx, y - 3 * ny), l2 = px(x + 6 * nx, y + 6 * ny), r2 = px(x - 6 * nx, y - 6 * ny);
      if (c < 0 || l1 < 0 || r1 < 0 || l2 < 0 || r2 < 0) continue;
      const ridge = Math.abs(c - (l1 + r1 + l2 + r2) / 4) - 0.25 * Math.abs((l1 + l2) - (r1 + r2));
      if (ridge > 0) sum += ridge;
      cnt++;
    }
    let v = cnt >= 10 ? sum / cnt * Math.min(1, cnt / 25) : 0;
    const cosF = (dx * fa[0] + dy * fa[1]) / fan;          // shaft continues the forearms (wrist hinge < ~105°)
    if (cosF < Math.cos(105 * Math.PI / 180)) v *= 0.15;
    out[k] = v;
  }
  return out;
}

function frameSig(ctx, W, H) { // cheap fingerprint of a frame: a few rows of pixels
  const d = ctx.getImageData(0, Math.floor(H * 0.3), W, 1).data, e = ctx.getImageData(0, Math.floor(H * 0.7), W, 1).data;
  let h = 0; for (let i = 0; i < d.length; i += 16) h = (h * 31 + d[i] + e[i]) | 0; return h;
}
function toGray(ctx, W, H) {
  const d = ctx.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return g;
}

// ---------- main entry ----------
export async function trackVideo(url, { onProgress = () => {}, base = '.', findSwings, isCancelled = () => false } = {}) {
  const pl = await getLandmarker(base);
  const v = await loadVideo(url);
  try {
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error('This video has no readable length.');
    const vw = v.videoWidth, vh = v.videoHeight;
    const W = Math.min(PROC_W, vw), H = Math.round(vh * W / vw);
    const c = mkCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
    const coarse = [];
    const sigs = new Set();
    const nCoarse = Math.floor(dur * COARSE_FPS);
    const report = (stage, frac, extra) => onProgress({ stage, frac: Math.max(0, Math.min(1, frac)), ...extra });
    // Pass 1
    for (let i = 0; i <= nCoarse; i++) {
      if (isCancelled()) throw new Error('cancelled');
      const t = i / COARSE_FPS;
      await seek(v, t); ctx.drawImage(v, 0, 0, W, H);
      sigs.add(frameSig(ctx, W, H));
      const { lm } = landmarkArrays(pl.detect(c));
      coarse.push({ t: round(t, 3), lm });
      if (i % 5 === 0) report('scan', 0.35 * i / Math.max(1, nCoarse), { found: null });
    }
    if (nCoarse > 10 && sigs.size <= 2) throw new Error('This phone returned the same picture for every frame of the video, so it could not be analyzed. Close other apps and try again, or re-export the clip from Photos.');
    const windows = findSwings(coarse, dur);
    report('scan', 0.35, { found: windows.length });
    // Pass 2
    const totalFine = windows.reduce((a, w) => a + Math.ceil((w.t1 - w.t0) * FINE_FPS) + 1, 0) || 1;
    let doneFine = 0;
    const swings = [];
    for (let s = 0; s < windows.length; s++) {
      const w = windows[s], frames = [];
      const n = Math.ceil((w.t1 - w.t0) * FINE_FPS);
      for (let i = 0; i <= n; i++) {
        if (isCancelled()) throw new Error('cancelled');
        const t = w.t0 + i / FINE_FPS;
        await seek(v, t); ctx.drawImage(v, 0, 0, W, H);
        const { lm, wl } = landmarkArrays(pl.detect(c));
        const sc = lm ? clubScores(toGray(ctx, W, H), W, H, lm) : new Float32Array(NANG);
        frames.push({ t: round(t, 4), lm, wl, sc: Array.from(sc, (x) => Math.round(x * 10) / 10) });
        doneFine++;
        if (doneFine % 3 === 0) report('track', 0.35 + 0.6 * doneFine / totalFine, { found: windows.length, swing: s + 1 });
      }
      swings.push({ t0: w.t0, t1: w.t1, tImpact: w.tImpact, frames });
    }
    return { meta: { duration: dur, W, H, vw, vh, delegate: landmarkerDelegate }, coarse, swings, video: v, canvas: c };
  } catch (e) { v.remove(); throw e; }
}

// Grab still frames (JPEG blobs) at given times for the keyframe cards.
export async function grabFrames(v, times, width = 540) {
  const vw = v.videoWidth, vh = v.videoHeight, W = Math.min(width, vw), H = Math.round(vh * W / vw);
  const c = mkCanvas(W, H), ctx = c.getContext('2d');
  const out = [];
  for (const t of times) {
    await seek(v, t); ctx.drawImage(v, 0, 0, W, H);
    out.push(await new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', 0.82)));
  }
  return { blobs: out, W, H };
}
