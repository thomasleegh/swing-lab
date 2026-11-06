// Ideal swing rig: a 3D stick-figure model keyed at 9 swing positions.
// Canonical frame (used everywhere in the app): X = toward target, Y = up, Z = toward ball, metres,
// origin on the ground between the ankles. Lead side is +X. A lefty is the same figure drawn mirrored.
(function () {
const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const D2R = Math.PI / 180;
function rotAxis(v, k, ang) { // Rodrigues
  const c = Math.cos(ang), s = Math.sin(ang);
  return V.add(V.add(V.mul(v, c), V.mul(V.cross(k, v), s)), V.mul(k, V.dot(k, v) * (1 - c)));
}
function ik(S, H, a, b, pole) {
  const dv = V.sub(H, S); let d = V.len(dv);
  const u = V.norm(dv);
  d = Math.min(Math.max(d, Math.abs(a - b) + 1e-3), a + b - 1e-3);
  const x = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(a * a - x * x, 0));
  let p = V.sub(pole, V.mul(u, V.dot(pole, u)));
  if (V.len(p) < 1e-6) p = [0, -1, 0];
  p = V.norm(p);
  return V.add(V.add(S, V.mul(u, x)), V.mul(p, h));
}

const BALL = [-0.02, 0.021, 0.82];
const CLUB_LEN = 0.9;
const LEAD_ANKLE = [0.2, 0.08, 0], TRAIL_ANKLE = [-0.2, 0.08, 0];

// Phase times (seconds) and keyframes.
// pr = pelvis turn (deg, + = closed/backswing), cr = chest turn about spine, tilt = spine forward bend,
// bend = side bend (+ = away from target), px/pz = pelvis shift (m), H = lead-hand grip, C = club direction.
const PHASES = [
  { id: 'address', name: 'Address', t: 0.0 },
  { id: 'takeaway', name: 'Takeaway', t: 0.3 },
  { id: 'p3', name: 'Lead arm parallel', t: 0.55 },
  { id: 'top', name: 'Top', t: 0.85 },
  { id: 'transition', name: 'Transition', t: 1.0 },
  { id: 'delivery', name: 'Delivery', t: 1.08 },
  { id: 'impact', name: 'Impact', t: 1.14 },
  { id: 'release', name: 'Release', t: 1.22 },
  { id: 'finish', name: 'Finish', t: 1.65 },
];

const IDEAL = [
  { pr: 0, cr: 0, tilt: 40, bend: 12, px: 0, pz: -0.06, H: [0.04, 0.8, 0.36], C: null, heel: 0, lheel: 0 },
  { pr: 10, cr: 28, tilt: 40, bend: 6, px: -0.02, pz: -0.06, H: [-0.3, 0.92, 0.3], C: [-1, 0.02, 0.05], heel: 0, lheel: 0 },
  { pr: 30, cr: 65, tilt: 39, bend: 2, px: -0.03, pz: -0.06, H: [-0.42, 1.25, 0.1], C: [-0.1, 0.95, -0.25], heel: 0, lheel: 0.01 },
  { pr: 45, cr: 92, tilt: 38, bend: 0, px: -0.03, pz: -0.06, H: [-0.26, 1.5, -0.02], C: [0.95, -0.15, -0.25], heel: 0, lheel: 0.02 },
  { pr: 15, cr: 72, tilt: 38, bend: 8, px: 0.03, pz: -0.06, H: [-0.36, 1.15, 0.17], C: [-0.4, 0.65, -0.6], heel: 0, lheel: 0 },
  { pr: -15, cr: 40, tilt: 37, bend: 16, px: 0.06, pz: -0.06, H: [-0.26, 0.95, 0.22], C: [-0.98, 0.1, -0.12], heel: 0.01, lheel: 0 },
  { pr: -40, cr: -8, tilt: 36, bend: 22, px: 0.08, pz: -0.06, H: [0.08, 0.8, 0.38], C: null, heel: 0.03, lheel: 0 },
  { gz: 0.55, pr: -60, cr: -60, tilt: 32, bend: 20, px: 0.1, pz: -0.05, H: [0.32, 0.93, 0.32], C: [0.98, 0.05, 0.1], heel: 0.06, lheel: 0 },
  { gz: 0, pr: -90, cr: -105, tilt: 12, bend: 14, px: 0.13, pz: -0.03, H: [0.12, 1.62, -0.08], C: [-0.3, 0.85, -0.4], heel: 0.1, lheel: 0 },
];

function clubDirAt(k) { return k.C ? V.norm(k.C) : V.norm(V.sub(BALL, k.H)); }

function hermite(p0, p1, p2, p3, t0, t1, t2, t3, u) {
  const dt = t2 - t1;
  const m1 = (p2 - p0) / (t2 - t0 || 1) * dt;
  const m2 = (p3 - p1) / (t3 - t1 || 1) * dt;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
}
function sample(keys, t) {
  const n = PHASES.length;
  t = Math.max(0, Math.min(PHASES[n - 1].t, t));
  let i = 0; while (i < n - 2 && t > PHASES[i + 1].t) i++;
  const i0 = Math.max(i - 1, 0), i3 = Math.min(i + 2, n - 1);
  const T = [PHASES[i0].t, PHASES[i].t, PHASES[i + 1].t, PHASES[i3].t];
  const u = (t - T[1]) / (T[2] - T[1]);
  const K = [keys[i0], keys[i], keys[i + 1], keys[i3]];
  const sc = (f) => hermite(f(K[0]), f(K[1]), f(K[2]), f(K[3]), T[0], T[1], T[2], T[3], u);
  const out = {};
  for (const f of ['pr', 'cr', 'tilt', 'bend', 'px', 'pz', 'heel', 'lheel']) out[f] = sc((k) => k[f]);
  out.gz = Math.max(0, Math.min(1, sc((k) => (k.gz === undefined ? 1 : k.gz))));
  out.H = [0, 1, 2].map((j) => sc((k) => k.H[j]));
  const cd = [0, 1, 2].map((j) => sc((k) => clubDirAt(k)[j]));
  out.C = V.norm(cd);
  return out;
}

function pose(s) {
  const P = [s.px, 0.92, s.pz];
  const pr = s.pr * D2R;
  const hipAxis = [Math.cos(pr), 0, Math.sin(pr)];
  const lHip = V.add(P, V.mul(hipAxis, 0.13)), tHip = V.sub(P, V.mul(hipAxis, 0.13));
  const tl = s.tilt * D2R, bd = s.bend * D2R;
  const d = V.norm([-Math.sin(bd), Math.cos(tl) * Math.cos(bd), Math.sin(tl)]);
  const e0 = V.norm(V.sub([1, 0, 0], V.mul(d, d[0])));
  const e = rotAxis(e0, d, -s.cr * D2R);
  const neck = V.add(P, V.mul(d, 0.52));
  const lSh = V.add(neck, V.mul(e, 0.19)), tSh = V.sub(neck, V.mul(e, 0.19));
  const fwd = V.norm(V.cross(e, d));
  const headBase = V.add(neck, V.mul(d, 0.17));
  const tb = V.sub(BALL, headBase);
  const toBall = V.norm([tb[0], tb[1] * 0.42, tb[2]]); // head tips about halfway; the eyes do the rest
  const toTarget = V.norm(V.add(V.mul(fwd, 0.8), [0.35, 0.05, 0]));
  const look = V.norm(V.add(V.mul(toBall, s.gz), V.mul(toTarget, 1 - s.gz)));
  const head = V.add(headBase, V.mul(look, 0.05));
  const H = s.H, C = s.C;
  const tHand = V.add(H, V.mul(C, 0.05));
  const club = V.add(H, V.mul(C, CLUB_LEN));
  const armPole = [0, -1, -0.35];
  const lElb = ik(lSh, H, 0.31, 0.3, armPole);
  const tElb = ik(tSh, tHand, 0.31, 0.3, armPole);
  const lAnk = V.add(LEAD_ANKLE, [0, s.lheel, 0]);
  const tAnk = V.add(TRAIL_ANKLE, [0.04 * s.heel / 0.1, s.heel, 0.02 * s.heel / 0.1]);
  const lKnee = ik(lHip, lAnk, 0.46, 0.46, [0.15, 0, 1]);
  const tKnee = ik(tHip, tAnk, 0.46, 0.46, [-0.15 + s.heel * 3, 0, 1]);
  const lToe = [0.27, 0.02, 0.13], tToe = [-0.24, 0.02, 0.14];
  return { P, lHip, tHip, neck, lSh, tSh, head, look, H, tHand, club, lElb, tElb, lAnk, tAnk, lKnee, tKnee, lToe, tToe };
}

const Rig = { PHASES, IDEAL, sample, pose, V, BALL, CLUB_LEN, rotAxis, ik };
if (typeof module !== 'undefined') module.exports = Rig;
if (typeof globalThis !== 'undefined') globalThis.Rig = Rig;
})();
