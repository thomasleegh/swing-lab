// Swing analysis: pure functions (no DOM) so they run in the app and in Node tests.
// Input is MediaPipe pose output per frame; output is the swing positions, a 3D skeleton per frame in the
// canonical frame (X = toward target, Y = up, Z = toward ball, metres, origin on the ground between the ankles),
// the club, measurements and coaching notes.
(function () {
const R = (typeof module !== 'undefined' && typeof require !== 'undefined') ? require('./rig.js') : globalThis.Rig;
const V = R.V;
const PH = R.PHASES.map((p) => p.id);
const NANG = 180;

// ---------- helpers ----------
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, u) => a + (b - a) * u;
const lerp3 = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
function median(xs) { const s = xs.filter((x) => isFinite(x)).slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; }
function gripN(lm) { // grip in normalised image coords, weighted by landmark visibility
  const ids = [15, 16, 17, 18, 19, 20]; let x = 0, y = 0, w = 0;
  for (const i of ids) { const k = (lm[i][3] || 0) + 1e-3; x += lm[i][0] * k; y += lm[i][1] * k; w += k; }
  return [x / w, y / w];
}
function gripW(wl, lm) { // grip in world coords
  const ids = [15, 16, 17, 18, 19, 20]; const o = [0, 0, 0]; let w = 0;
  for (const i of ids) { const k = ((lm || wl)[i][3] || 0) + 1e-3; o[0] += wl[i][0] * k; o[1] += wl[i][1] * k; o[2] += wl[i][2] * k; w += k; }
  return [o[0] / w, o[1] / w, o[2] / w];
}

// Hands height above the shoulders, in torso lengths (+ = hands above shoulders).
function handHeight(lm) {
  if (!lm) return NaN;
  const sh = (lm[11][1] + lm[12][1]) / 2, hp = (lm[23][1] + lm[24][1]) / 2, tor = hp - sh;
  if (!(tor > 0.02)) return NaN;
  const s = (sh - gripN(lm)[1]) / tor;
  return s < -4 || s > 4 ? NaN : s;
}

// ---------- 1. find swings in the coarse 5 fps pass ----------
// A real swing: hands high (top), a sharp dip to impact, high again (finish), all within ~1.6 s.
// Slow rehearsals don't dip fast enough and are skipped.
function findSwings(coarse, duration) {
  const s = coarse.map((f) => handHeight(f.lm));
  const t = coarse.map((f) => f.t);
  const hits = [];
  for (let i = 1; i < s.length - 1; i++) {
    if (!(s[i] < -0.75)) continue;
    let hiBefore = false, hiAfter = false;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) if (s[j] > -0.25) hiBefore = true;
    for (let j = i + 1; j <= Math.min(s.length - 1, i + 4); j++) if (s[j] > -0.3) hiAfter = true;
    // the frame before the dip must not be a long low stretch (that is address, not impact)
    if (hiBefore && hiAfter) hits.push(t[i]);
  }
  const merged = [];
  for (const h of hits) { if (merged.length && h - merged[merged.length - 1] < 1.6) continue; merged.push(h); }
  return merged.map((ti) => ({ tImpact: ti, t0: Math.max(0, ti - 2.4), t1: Math.min(duration - 0.05, ti + 2.2) }));
}

// ---------- 2. club angle path (dynamic programming over 2-degree bins) ----------
function clubPath(frames, hint) {
  const n = frames.length; if (!n) return [];
  const D = new Float32Array(NANG * NANG);
  for (let a = 0; a < NANG; a++) for (let b = 0; b < NANG; b++) { const d = Math.abs(a - b) * 2; D[a * NANG + b] = Math.min(d, 360 - d); }
  const score = (i, k) => {
    let s = frames[i].sc ? frames[i].sc[k] || 0 : 0;
    if (hint && hint[i] != null) { // near impact the shaft is blurred: favour pointing at the ball
      const d = Math.abs(k * 2 - hint[i]); const dd = Math.min(d, 360 - d);
      s += Math.max(0, 14 - dd * 0.35);
    }
    return s;
  };
  let cost = new Float32Array(NANG); for (let k = 0; k < NANG; k++) cost[k] = -score(0, k);
  const back = [];
  for (let i = 1; i < n; i++) {
    const dt = Math.max(1e-3, frames[i].t - frames[i - 1].t);
    const lam = 0.05 * (1 / 30) / dt;
    const nc = new Float32Array(NANG), bk = new Int16Array(NANG);
    for (let b = 0; b < NANG; b++) {
      let best = Infinity, arg = 0;
      for (let a = 0; a < NANG; a++) { const c = cost[a] + lam * D[a * NANG + b]; if (c < best) { best = c; arg = a; } }
      nc[b] = best - score(i, b); bk[b] = arg;
    }
    cost = nc; back.push(bk);
  }
  let k = 0; for (let b = 1; b < NANG; b++) if (cost[b] < cost[k]) k = b;
  const path = new Array(n); path[n - 1] = k;
  for (let i = n - 1; i > 0; i--) { k = back[i - 1][k]; path[i - 1] = k; }
  return path.map((p, i) => ({ ang: p * 2, conf: frames[i].sc ? (frames[i].sc[p] || 0) : 0 }));
}

// ---------- 3. full analysis of one swing ----------
function analyzeSwing(sw, meta) {
  const raw = sw.frames.filter((f) => f.lm && f.wl);
  if (raw.length < 20) return { ok: false, reason: 'Not enough frames with you in view.' };
  const W = meta.W, H = meta.H;
  const T = raw.map((f) => f.t);
  // --- view & orientation from a still frame near the start
  const lm0 = raw[Math.min(5, raw.length - 1)].lm;
  const shDx = Math.abs(lm0[11][0] - lm0[12][0]) * W, torPx = Math.abs((lm0[23][1] + lm0[24][1]) / 2 - (lm0[11][1] + lm0[12][1]) / 2) * H;
  const view = shDx / Math.max(1, torPx) > 0.42 ? 'faceon' : 'dtl';
  const hipX = (lm) => (lm[23][0] + lm[24][0]) / 2;
  // hand height track (image) to find the top coarsely
  const hh = raw.map((f) => handHeight(f.lm));
  const iImpC = nearestIdx(T, sw.tImpact);
  let iTop = argmax(hh, Math.max(0, iImpC - 40), iImpC);
  // orientation
  let ballSide = 1, targetSide = 1; // +1: ball (DTL) / target (face-on) is on the image's right
  if (view === 'dtl') ballSide = Math.sign(gripN(lm0)[0] - hipX(lm0)) || 1;
  else targetSide = -(Math.sign(gripN(raw[iTop].lm)[0] - hipX(raw[iTop].lm)) || 1);
  // world landmark -> canonical
  const toC = view === 'dtl'
    ? (p) => [p[2], -p[1], ballSide * p[0]]
    : (p) => [targetSide * p[0], -p[1], -p[2]];
  // lead side: landmark set (left=odd indices 11,13,15,23,25,27; right=even) nearer the target
  const wl0 = raw[Math.min(5, raw.length - 1)].wl;
  const leadIsLeft = toC(wl0[11])[0] + toC(wl0[23])[0] > toC(wl0[12])[0] + toC(wl0[24])[0];
  const handed = leadIsLeft ? 'right' : 'left';
  const L = leadIsLeft ? { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27, toe: 31, heel: 29 } : { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28, toe: 32, heel: 30 };
  const Tr = leadIsLeft ? { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28, toe: 32, heel: 30 } : { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27, toe: 31, heel: 29 };

  // --- canonical joints per frame (hip-centred), then smoothing
  const rel = raw.map((f) => {
    const c = (i) => toC(f.wl[i]);
    const g = toC(gripW(f.wl, f.lm));
    const earM = V.mul(V.add(c(7), c(8)), 0.5);
    return {
      lSh: c(L.sh), tSh: c(Tr.sh), lElb: c(L.el), tElb: c(Tr.el), lWr: c(L.wr), tWr: c(Tr.wr), H: g,
      lHip: c(L.hip), tHip: c(Tr.hip), lKnee: c(L.kn), tKnee: c(Tr.kn), lAnk: c(L.an), tAnk: c(Tr.an), lToe: c(L.toe), tToe: c(Tr.toe),
      ear: earM, nose: c(0),
    };
  });
  smoothJoints(rel, 2);
  smoothAxis(rel, view === 'dtl' ? 0 : 2, 5);   // depth from a single camera is the noisiest axis
  // --- in-plane positions from the 2D landmarks (MediaPipe is most accurate in the image plane);
  // depth (the axis along the camera) comes from the 3D landmarks.
  const imgPx = raw.map((f) => {
    const p = (i) => [f.lm[i][0] * W, f.lm[i][1] * H];
    const gi = gripN(f.lm);
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return {
      lSh: p(L.sh), tSh: p(Tr.sh), lElb: p(L.el), tElb: p(Tr.el), lWr: p(L.wr), tWr: p(Tr.wr), H: [gi[0] * W, gi[1] * H],
      lHip: p(L.hip), tHip: p(Tr.hip), lKnee: p(L.kn), tKnee: p(Tr.kn), lAnk: p(L.an), tAnk: p(Tr.an), lToe: p(L.toe), tToe: p(Tr.toe),
      ear: mid(p(7), p(8)), nose: p(0),
    };
  });
  smooth2D(imgPx, 1);
  const n = rel.length;
  // --- phases from the hand path
  const handY = rel.map((r) => r.H[1] - r.lAnk[1]);   // hand height above lead ankle (m)
  const handPos = rel.map((r) => V.sub(r.H, r.lAnk));
  const speed = handPos.map((p, i) => i === 0 ? 0 : V.len(V.sub(p, handPos[i - 1])) / Math.max(1e-3, T[i] - T[i - 1]));
  iTop = argmax(handY, Math.max(0, iImpC - 45), Math.min(n - 1, iImpC + 3));
  // address: last still stretch (hands < 0.25 m/s for 0.2 s) before the top
  let iAddr = -1;
  for (let i = iTop - 1, still = 0; i > 0; i--) {
    if (speed[i] < 0.25) { still++; if (still >= 6) { iAddr = i + still - 1; break; } } else still = 0;
  }
  if (iAddr < 0) iAddr = Math.max(0, iTop - 30);
  // walk forward to the last still frame before the takeaway
  while (iAddr + 1 < iTop && speed[iAddr + 1] < 0.25) iAddr++;
  const hA = handY[iAddr], hTop = handY[iTop], pA = handPos[iAddr];
  let iImp = iTop + 1, bestD = Infinity;
  for (let i = iTop + 1; i < Math.min(n, iTop + 22); i++) { const d = V.len(V.sub(handPos[i], pA)); if (handY[i] < hA + 0.25 && d < bestD) { bestD = d; iImp = i; } }
  let iFin = Math.min(n - 1, iImp + 40);
  for (let i = iImp + 9; i < Math.min(n, iImp + 45); i++) if (speed[i] < 0.5) { iFin = i; break; }
  const hImp = handY[iImp], hFin = Math.max(...handY.slice(iImp, iFin + 1));
  const firstAfter = (from, to, pred) => { for (let i = from; i <= to; i++) if (pred(i)) return i; return Math.round((from + to) / 2); };
  // takeaway (club about parallel to the ground): ~40% of the backswing time, or earlier if the hands are already rising
  const tTake = T[iAddr] + 0.4 * (T[iTop] - T[iAddr]);
  const iTake = Math.min(firstAfter(iAddr + 1, iTop - 2, (i) => T[i] >= tTake), firstAfter(iAddr + 1, iTop - 2, (i) => handY[i] >= hA + 0.2 * (hTop - hA)));
  const iP3 = firstAfter(iTake, iTop, (i) => handY[i] >= hA + 0.62 * (hTop - hA));
  const iTrans = firstAfter(iTop, iImp, (i) => handY[i] <= hTop - 0.35 * (hTop - hImp));
  const iDel = firstAfter(iTrans, iImp, (i) => handY[i] <= hImp + 0.22 * (hTop - hImp));
  const iRel = firstAfter(iImp, iFin, (i) => handY[i] >= hImp + 0.25 * (hFin - hImp));
  const idx = { address: iAddr, takeaway: iTake, p3: iP3, top: iTop, transition: iTrans, delivery: iDel, impact: iImp, release: iRel, finish: iFin };
  const phases = {}; for (const k of PH) phases[k] = T[idx[k]];
  if (!(iAddr < iTake && iTake <= iP3 && iP3 < iTop && iTop < iTrans && iTrans <= iDel && iDel < iImp && iImp < iRel && iRel <= iFin)) {
    // keep going, but flag it: the positions are approximate
    phases._approx = true;
  }

  // --- body scale (px per metre) from the address frame: shoulder-mid to ankle-mid, world vs image
  const a0 = rel[iAddr], i0 = imgPx[iAddr];
  const midW = (o, x, y) => V.mul(V.add(o[x], o[y]), 0.5);
  const mW = V.len(V.sub(midW(a0, 'lSh', 'tSh'), midW(a0, 'lAnk', 'tAnk')));
  const shI = [(i0.lSh[0] + i0.tSh[0]) / 2, (i0.lSh[1] + i0.tSh[1]) / 2], anI = [(i0.lAnk[0] + i0.tAnk[0]) / 2, (i0.lAnk[1] + i0.tAnk[1]) / 2];
  const pxPerM = Math.hypot(shI[0] - anI[0], shI[1] - anI[1]) / Math.max(0.3, mW);
  const groundY = Math.max(i0.lAnk[1], i0.tAnk[1]) + 0.08 * pxPerM, originX = anI[0];
  // depth anchoring: the lead ankle stays where it was at address
  const mid0 = V.mul(V.add(a0.lAnk, a0.tAnk), 0.5);
  const depthIdx = view === 'dtl' ? 0 : 2, side = view === 'dtl' ? ballSide : targetSide;
  const joints = rel.map((r, fi) => {
    const shift = r.lAnk[depthIdx] - a0.lAnk[depthIdx];
    const o = {};
    for (const k in r) {
      const ip = imgPx[fi][k];
      const inX = side * (ip[0] - originX) / pxPerM, inY = (groundY - ip[1]) / pxPerM;
      const d = r[k][depthIdx] - mid0[depthIdx] - shift;
      o[k] = view === 'dtl' ? [d, inY, inX] : [inX, inY, d];
    }
    return o;
  });
  // ground the figure: lowest ankle at address = 0.08
  // --- club: image angle path, then 3D
  const ballImgAngle = (() => { // shaft angle from grip to the ball, from the address frames
    return null;
  })();
  // first pass without hint to get address shaft angle -> ball position in the image
  const clubFrames = raw;
  let cp = clubPath(clubFrames, null);
  const gA = gripN(raw[iAddr].lm);
  const bodyA = Math.abs((raw[iAddr].lm[27][1] + raw[iAddr].lm[28][1]) / 2 - raw[iAddr].lm[0][1]) * H;
  const Lpx = bodyA * 0.9 / 1.55;
  const angA = median(cp.slice(Math.max(0, iAddr - 4), iAddr + 1).map((c) => c.ang));
  const ballPx = [gA[0] * W + Lpx * Math.cos(angA * Math.PI / 180), gA[1] * H + Lpx * Math.sin(angA * Math.PI / 180)];
  const hint = raw.map((f, i) => {
    if (i < iDel || i > iRel) return null;
    const g = gripN(f.lm); const a = Math.atan2(ballPx[1] - g[1] * H, ballPx[0] - g[0] * W) * 180 / Math.PI;
    return (a + 360) % 360;
  });
  cp = clubPath(clubFrames, hint);
  const club = cp.map((c, i) => {
    const a = c.ang * Math.PI / 180, u = Math.cos(a), v = Math.sin(a);
    const ideal = idealAt(phases, T[i]).C;
    let inPlane, dir;
    if (view === 'dtl') { inPlane = [ballSide * u, -v]; const dx = clamp(ideal[0], -0.97, 0.97), k = Math.sqrt(1 - dx * dx); dir = [dx, inPlane[1] * k, inPlane[0] * k]; }
    else { inPlane = [targetSide * u, -v]; const dz = clamp(ideal[2], -0.97, 0.97), k = Math.sqrt(1 - dz * dz); dir = [inPlane[0] * k, inPlane[1] * k, dz]; }
    return { dir: V.norm(dir), ang: c.ang, conf: c.conf };
  });
  { const src = club.map((c) => c.dir.slice()); // light smoothing (the angle comes in 2-degree steps)
    for (let i = 0; i < club.length; i++) { const acc = [0, 0, 0]; for (let d = -1; d <= 1; d++) { const q = src[Math.max(0, Math.min(src.length - 1, i + d))]; const w = d === 0 ? 2 : 1; acc[0] += q[0] * w; acc[1] += q[1] * w; acc[2] += q[2] * w; } club[i].dir = V.norm(acc); } }

  const legs = V.len(V.sub(a0.lHip, a0.lKnee)) + V.len(V.sub(a0.lKnee, a0.lAnk));
  const torso = V.len(V.sub(midW(a0, 'lHip', 'tHip'), midW(a0, 'lSh', 'tSh')));
  const neckY = (joints[iAddr].lSh[1] + joints[iAddr].tSh[1]) / 2;
  const idealNeckY = R.pose(R.sample(R.IDEAL, 0)).neck[1];
  const stature = clamp(1.75 * neckY / idealNeckY, 1.4, 2.1);   // scale the ideal so shoulders match at address
  // --- frames out
  const out = raw.map((f, i) => ({ t: T[i], j: roundJoints(joints[i]), club: club[i], lm: f.lm }));
  const res = {
    ok: true, view, handed, ballSide, targetSide, phases, idx, pxPerM, stature: round2(stature),
    ballPx, imgW: W, imgH: H, frames: out, approx: !!phases._approx,
  };
  delete phases._approx;
  res.metrics = measure(res);
  res.notes = notesFor(res);
  res.mainFault = mainFault(res);
  return res;
}

function round2(x) { return Math.round(x * 100) / 100; }
function roundJoints(j) { const o = {}; for (const k in j) o[k] = j[k].map((x) => Math.round(x * 1000) / 1000); return o; }
function nearestIdx(T, t) { let b = 0; for (let i = 1; i < T.length; i++) if (Math.abs(T[i] - t) < Math.abs(T[b] - t)) b = i; return b; }
function argmax(a, i0, i1) { let b = i0; for (let i = i0; i <= i1; i++) if (isFinite(a[i]) && !(a[i] <= a[b])) b = i; return b; }
function smoothAxis(rel, ax, r) {
  const keys = Object.keys(rel[0]), n = rel.length;
  const src = rel.map((o) => { const c = {}; for (const k of keys) c[k] = o[k][ax]; return c; });
  for (let i = 0; i < n; i++) for (const k of keys) { let x = 0, w = 0; for (let d = -r; d <= r; d++) { const j = i + d; if (j < 0 || j >= n) continue; const ww = r + 1 - Math.abs(d); x += src[j][k] * ww; w += ww; } rel[i][k][ax] = x / w; }
}
function smooth2D(arr, r) {
  const keys = Object.keys(arr[0]), n = arr.length;
  const src = arr.map((o) => { const c = {}; for (const k of keys) c[k] = o[k].slice(); return c; });
  for (let i = 0; i < n; i++) for (const k of keys) { let x = 0, y = 0, w = 0; for (let d = -r; d <= r; d++) { const j = i + d; if (j < 0 || j >= n) continue; const ww = r + 1 - Math.abs(d); x += src[j][k][0] * ww; y += src[j][k][1] * ww; w += ww; } arr[i][k] = [x / w, y / w]; }
}
function smoothJoints(rel, r) {
  const keys = Object.keys(rel[0]), n = rel.length;
  const src = rel.map((o) => { const c = {}; for (const k of keys) c[k] = o[k].slice(); return c; });
  for (let i = 0; i < n; i++) for (const k of keys) {
    const acc = [0, 0, 0]; let w = 0;
    for (let d = -r; d <= r; d++) { const j = i + d; if (j < 0 || j >= n) continue; const ww = r + 1 - Math.abs(d); acc[0] += src[j][k][0] * ww; acc[1] += src[j][k][1] * ww; acc[2] += src[j][k][2] * ww; w += ww; }
    rel[i][k] = [acc[0] / w, acc[1] / w, acc[2] / w];
  }
}

// ---------- 4. ideal model on the golfer's own timeline ----------
function idealTime(phases, t) {
  const ut = PH.map((k) => phases[k]), it = R.PHASES.map((p) => p.t);
  if (t <= ut[0]) return it[0] - (ut[0] - t);
  for (let i = 0; i < ut.length - 1; i++) if (t <= ut[i + 1]) return lerp(it[i], it[i + 1], (t - ut[i]) / Math.max(1e-3, ut[i + 1] - ut[i]));
  return it[it.length - 1] + (t - ut[ut.length - 1]);
}
function idealAt(phases, t) { return R.sample(R.IDEAL, clamp(idealTime(phases, t), 0, R.PHASES[R.PHASES.length - 1].t)); }
function idealPose(phases, t, scale = 1) {
  const q = R.pose(idealAt(phases, t));
  if (scale === 1) return q;
  const o = {}; for (const k in q) o[k] = k === 'look' ? q[k] : V.mul(q[k], scale);
  return o;
}

// ---------- 5. measurements ----------
function spineTilt(j) { // forward bend from vertical, degrees (in the Y-Z plane)
  const sh = V.mul(V.add(j.lSh, j.tSh), 0.5), hp = V.mul(V.add(j.lHip, j.tHip), 0.5), d = V.sub(sh, hp);
  return Math.atan2(d[2], d[1]) * 180 / Math.PI;
}
function measure(r) {
  const F = r.frames, I = r.idx, j = (k) => F[I[k]].j, m = {};
  const cm = (x) => Math.round(x * 100);
  m.spineAddress = Math.round(spineTilt(j('address')));
  m.spineImpact = Math.round(spineTilt(j('impact')));
  m.standUp = m.spineAddress - m.spineImpact;                         // degrees lost (+ = stood up)
  m.handsOutImpact = cm(j('impact').H[2] - j('address').H[2]);        // + = farther from body
  m.handsUpImpact = cm(j('impact').H[1] - j('address').H[1]);
  const pelZ = (k) => (j(k).lHip[2] + j(k).tHip[2]) / 2;
  m.hipsTowardBall = cm(pelZ('impact') - pelZ('address'));            // + = early extension
  const headC = (k) => j(k).ear;
  m.headDropImpact = cm(headC('impact')[1] - headC('address')[1]);
  m.headMoveImpact = cm(V.len(V.sub(headC('impact'), headC('address'))));
  // takeaway: clubhead relative to the hands, toward/away from the ball
  const clubHead = (k) => V.add(j(k).H, V.mul(F[I[k]].club.dir, R.CLUB_LEN));
  // only trust the takeaway club position when the shaft was clearly visible (it is often motion-blurred)
  const tkConf = Math.max(...[-1, 0, 1].map((d) => (F[I.takeaway + d] || F[I.takeaway]).club.conf || 0));
  m.takeawayClubVsHands = tkConf >= 8 ? cm(clubHead('takeaway')[2] - j('takeaway').H[2]) : null; // - = inside (behind the hands)
  m.takeawayClubConf = Math.round(tkConf);
  // planes (down-the-line view): signed distance in metres of the grip from the shoulder plane and shaft plane
  if (r.view === 'dtl') {
    const pl = planesImg(r);
    const dShoulder = (i) => pl.side(pl.shoulder, gripImg(r, i)) / r.pxPerM;
    const dShaft = (i) => pl.side(pl.shaft, gripImg(r, i)) / r.pxPerM;
    let worst = -Infinity, iw = I.top;
    for (let i = I.top; i <= I.delivery; i++) { const d = dShoulder(i); if (d > worst) { worst = d; iw = i; } }
    m.overTop = cm(worst);                                             // + = hands above (outside) the shoulder plane
    m.overTopAt = F[iw].t;
    m.topVsShoulder = cm(dShoulder(I.top));
    m.topVsShaft = cm(dShaft(I.top));
  }
  // weight / sway (meaningful from face-on; estimated from depth in down-the-line)
  const pelX = (k) => (j(k).lHip[0] + j(k).tHip[0]) / 2;
  m.swayTop = cm(pelX('top') - pelX('address'));                     // - = moved away from target
  m.shiftImpact = cm(pelX('impact') - pelX('address'));              // + = toward target
  const leadPct = (k) => { const a = j(k).lAnk[0], b = j(k).tAnk[0]; return Math.round(clamp((pelX(k) - b) / Math.max(0.05, a - b), 0, 1) * 100); };
  m.leadPctTop = leadPct('top'); m.leadPctImpact = leadPct('impact'); m.leadPctFinish = leadPct('finish');
  // finish hold: time the hands stay quiet after the finish
  // hands speed over a 5-frame span; the hold ends when they move faster than 0.9 m/s for 4 frames running
  let hold = 0, fast = 0; const iF = I.finish;
  for (let i = iF + 3; i < F.length; i++) {
    const v = V.len(V.sub(F[i].j.H, F[i - 3].j.H)) / Math.max(1e-3, F[i].t - F[i - 3].t);
    if (v > 0.9) { if (++fast >= 4) break; } else { fast = 0; hold = F[i].t - F[iF].t; }
  }
  m.finishHold = Math.round(hold * 10) / 10;
  m.finishHoldCapped = iF + 1 >= F.length - 1 || hold >= (F[F.length - 1].t - F[iF].t) - 0.05;
  m.tempo = Math.round((r.phases.top - r.phases.address) / Math.max(0.05, r.phases.impact - r.phases.top) * 10) / 10;
  return m;
}
function gripImg(r, i) { const g = gripN(r.frames[i].lm); return [g[0] * r.imgW, g[1] * r.imgH]; }
function planesImg(r) {
  const I = r.idx, lmA = r.frames[I.address].lm;
  const B = r.ballPx, Hd = gripImg(r, I.address);
  const N = [(lmA[11][0] + lmA[12][0]) / 2 * r.imgW, (lmA[11][1] + lmA[12][1]) / 2 * r.imgH];
  const line = (a, b) => ({ a, b });
  // side(): + on the far side from the golfer (above/outside), using the golfer's hips as the reference point
  const hip = [(lmA[23][0] + lmA[24][0]) / 2 * r.imgW, (lmA[23][1] + lmA[24][1]) / 2 * r.imgH];
  const side = (ln, p) => {
    const dx = ln.b[0] - ln.a[0], dy = ln.b[1] - ln.a[1], len = Math.hypot(dx, dy) || 1;
    const s = ((p[0] - ln.a[0]) * dy - (p[1] - ln.a[1]) * dx) / len;
    const sh = ((hip[0] - ln.a[0]) * dy - (hip[1] - ln.a[1]) * dx);
    return sh > 0 ? -s : s;
  };
  return { ball: B, hands: Hd, neck: N, shaft: line(B, Hd), shoulder: line(B, N), side };
}

// ---------- 6. notes ----------
const IDEAL_TEXT = {
  address: 'Bent from the hips (about 20–35° hips-to-shoulders), knees flexed, arms hanging under the shoulders.',
  takeaway: 'Chest turns the club back. At hip height the shaft is parallel to the target line with the clubhead roughly over the hands.',
  p3: 'Lead arm about parallel to the ground, shaft pointing roughly up, chest still turning.',
  top: 'About a 90° shoulder turn, hands between the shaft plane and the shoulder plane.',
  transition: 'Lead side moves toward the target first while the hands drop below the shoulder plane.',
  delivery: 'Shaft about parallel to the target line, hands close to the trail thigh.',
  impact: 'Hands back near where they were at address, hips still back, most of the weight on the lead foot.',
  release: 'Arms extend down the target line as the chest keeps turning.',
  finish: 'Chest to the target, balanced on the lead foot. Hold it for 3 seconds.',
};
function notesFor(r) {
  const m = r.metrics, dtl = r.view === 'dtl', n = {};
  const say = (id, you, level) => { n[id] = { you, ideal: IDEAL_TEXT[id], level }; };
  // address
  const st = m.spineAddress;
  say('address', st < 17 ? `Fairly upright setup: hips-to-shoulders tilted ${st}° forward. Bend a little more from the hips.` : st > 42 ? `Very bent over: hips-to-shoulders tilted ${st}° forward.` : `Good athletic posture: hips-to-shoulders tilted ${st}° forward.`, st < 17 || st > 42 ? 'warn' : 'good');
  // takeaway
  const tw = m.takeawayClubVsHands;
  if (tw == null) say('takeaway', 'The club is too blurred here to measure where the clubhead is. Check the keyframe: the clubhead should stay roughly over your hands.', 'info');
  else say('takeaway', tw < -12 ? `The clubhead gets inside early: about ${-tw} cm behind your hands at hip height.` : tw > 15 ? `The clubhead goes outside your hands (about ${tw} cm) on the way back.` : 'Club stays in front of your hands on the way back. Good.', tw < -12 || tw > 15 ? 'bad' : 'good');
  say('p3', 'Lead arm parallel. Check the club keeps pointing up rather than flattening behind you.', 'info');
  // top
  if (dtl) {
    const above = m.topVsShoulder > 2, below = m.topVsShaft < -2;
    say('top', above ? `Hands about ${m.topVsShoulder} cm above the shoulder plane at the top: steep and lifted.` : below ? `Hands below the shaft plane at the top (about ${-m.topVsShaft} cm): flat and deep.` : 'Hands finish between the two planes at the top. Good position to swing from.', above || below ? 'warn' : 'good');
  } else say('top', `Hips moved ${Math.abs(m.swayTop)} cm ${m.swayTop < 0 ? 'away from' : 'toward'} the target by the top.${m.swayTop < -8 ? ' That is a sway; turn around your trail hip instead.' : ''}`, m.swayTop < -8 ? 'warn' : 'good');
  // transition
  if (dtl) say('transition', m.overTop > 3 ? `Over the top: your hands move out about ${m.overTop} cm above the shoulder plane as the downswing starts.` : 'Hands drop under the shoulder plane as the downswing starts. Good.', m.overTop > 3 ? 'bad' : 'good');
  else say('transition', `Weight on the lead foot early in the downswing: about ${m.leadPctTop}% at the top, ${m.leadPctImpact}% at impact.`, m.leadPctImpact < 60 ? 'warn' : 'good');
  say('delivery', dtl && m.overTop > 3 ? 'The club comes down outside your hands, steep.' : 'Club approaches from inside your hands.', dtl && m.overTop > 3 ? 'bad' : 'good');
  // impact
  const imp = [];
  if (Math.abs(m.handsOutImpact) >= 7) imp.push(`hands ${Math.abs(m.handsOutImpact)} cm ${m.handsOutImpact > 0 ? 'farther from' : 'closer to'} your body than at address`);
  if (m.handsUpImpact >= 5) imp.push(`${m.handsUpImpact} cm higher`);
  if (m.hipsTowardBall >= 3) imp.push(`hips ${m.hipsTowardBall} cm toward the ball`);
  if (m.standUp >= 7) imp.push(`spine ${m.standUp}° more upright`);
  say('impact', imp.length ? `At impact: ${imp.join(', ')}.` : 'Impact looks close to your address position. Good.', imp.length >= 2 ? 'bad' : imp.length ? 'warn' : 'good');
  say('release', m.handsOutImpact > 8 ? 'Your arms keep working out away from your body.' : 'Arms extend through toward the target.', m.handsOutImpact > 8 ? 'warn' : 'good');
  const hold = m.finishHoldCapped ? `at least ${m.finishHold} s` : `${m.finishHold} s`;
  say('finish', m.finishHold >= 2.5 ? `Balanced finish, held ${hold}.` : `Finish held ${hold} before you moved. Aim for 3 s.`, m.finishHold >= 2.5 ? 'good' : 'warn');
  return n;
}
function mainFault(r) {
  // each fault scored as (measured / its threshold); the biggest one over 1 wins
  const m = r.metrics, c = [];
  if (r.view === 'dtl' && m.overTop != null) c.push([m.overTop / 3, 'Over the top', 'transition']);
  if (m.takeawayClubVsHands != null) c.push([-m.takeawayClubVsHands / 12, 'Inside takeaway', 'takeaway']);
  c.push([Math.max(m.hipsTowardBall / 3, m.standUp / 7), 'Early extension', 'impact']);
  c.push([m.handsOutImpact / 9, 'Hands out at impact', 'impact']);
  if (r.view === 'faceon') { c.push([-m.swayTop / 8, 'Sway off the ball', 'top']); c.push([(60 - m.leadPctImpact) / 20, 'Hanging back', 'impact']); }
  c.sort((a, b) => b[0] - a[0]);
  return c[0][0] >= 1 ? { label: c[0][1], phase: c[0][2], score: Math.round(c[0][0] * 10) / 10 } : { label: 'No major fault', phase: 'top', score: 0 };
}

// ---------- 7. whole-session summary ----------
function summarize(swings) {
  const ok = swings.filter((s) => s.ok);
  if (!ok.length) return { count: 0, view: null, handed: null, mainFault: null };
  // most common real fault across the swings, weighted by how far past its threshold it was
  const tally = {};
  for (const s of ok) if (s.mainFault.label !== 'No major fault') tally[s.mainFault.label] = (tally[s.mainFault.label] || 0) + (s.mainFault.score || 1);
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const top = ranked.length && ranked[0][1] >= ok.length * 0.3 ? ranked[0][0] : 'No major fault';
  return { count: ok.length, view: ok[0].view, handed: ok[0].handed, mainFault: top };
}

// Interpolate the tracked skeleton at time t.
function youAt(res, t) {
  const F = res.frames; if (t <= F[0].t) return { j: F[0].j, club: F[0].club };
  let i = 1; while (i < F.length - 1 && F[i].t < t) i++;
  const a = F[i - 1], b = F[i], u = clamp((t - a.t) / Math.max(1e-3, b.t - a.t), 0, 1);
  const j = {}; for (const k in a.j) j[k] = lerp3(a.j[k], b.j[k], u);
  return { j, club: { dir: V.norm(lerp3(a.club.dir, b.club.dir, u)), conf: lerp(a.club.conf, b.club.conf, u) } };
}

const Core = { findSwings, analyzeSwing, clubPath, idealPose, idealAt, idealTime, youAt, measure, notesFor, summarize, planesImg, gripN, handHeight, spineTilt, PH, IDEAL_TEXT };
if (typeof module !== 'undefined') module.exports = Core;
if (typeof globalThis !== 'undefined') globalThis.Core = Core;
})();
