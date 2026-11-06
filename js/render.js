// Wireframe drawing: one 3D skeleton (canonical frame) projected to a down-the-line or face-on view.
const V = globalThis.Rig.V;
export const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// Build the drawable joint set from a tracked frame.
export function youToQ(j, club, clubLen) {
  const P = V.mul(V.add(j.lHip, j.tHip), 0.5), neck = V.mul(V.add(j.lSh, j.tSh), 0.5);
  const lookRaw = V.sub(j.nose, j.ear);
  const look = V.len(lookRaw) > 1e-3 ? V.norm(lookRaw) : [0, -0.5, 0.85];
  const head = V.add(j.ear, V.mul(look, 0.02));
  const dir = club.dir;
  return { P, neck, head, look, lSh: j.lSh, tSh: j.tSh, lElb: j.lElb, tElb: j.tElb, H: j.H, tHand: V.add(j.H, V.mul(dir, 0.05)), club: V.add(j.H, V.mul(dir, clubLen)),
    lHip: j.lHip, tHip: j.tHip, lKnee: j.lKnee, tKnee: j.tKnee, lAnk: j.lAnk, tAnk: j.tAnk, lToe: j.lToe, tToe: j.tToe };
}

// mirror: { bs, ts } = which way the ball (down-the-line) and target (face-on) point on screen (+1 right, -1 left)
export function viewFor(id, mirror) {
  if (id === 'dtl') return {
    name: 'dtl', proj: (p, W, H, k) => [W * (mirror.bs > 0 ? 0.4 : 0.6) + mirror.bs * p[2] * k, H * 0.9 - p[1] * k],
    dist: (p) => p[0], toCam: [-1, 0, 0], right: [0, 0, mirror.bs],
  };
  return {
    name: 'fo', proj: (p, W, H, k) => [W * 0.5 + mirror.ts * p[0] * k, H * 0.9 - p[1] * k],
    dist: (p) => -p[2], toCam: [0, 0, 1], right: [mirror.ts, 0, 0],
  };
}

export function setupCanvas(c) {
  const r = c.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { W: w, H: h, k: h / 3.0 };
}

const SEGS = [['lToe', 'lAnk'], ['lAnk', 'lKnee'], ['lKnee', 'lHip'], ['tToe', 'tAnk'], ['tAnk', 'tKnee'], ['tKnee', 'tHip'],
  ['lHip', 'tHip'], ['P', 'neck'], ['lSh', 'tSh'], ['lSh', 'lElb'], ['lElb', 'H'], ['tSh', 'tElb'], ['tElb', 'tHand']];

export function drawFigure(ctx, view, q, W, H, k, color, alpha, bold, key, dashed) {
  const P = (p) => view.proj(p, W, H, k);
  ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (dashed) ctx.setLineDash([k * 0.035, k * 0.025]);
  const lw = k * (bold ? 0.028 : 0.024);
  // One depth-sorted list (far first) for limbs, joints, club and head, so whichever is nearer the camera is drawn
  // on top. Drawing the head last made the arms look like they were behind it at the top and finish.
  // Limbs and the shaft are split into short pieces so a long segment that passes the head sorts correctly.
  const items = [], lerpP = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  const seg = (a, b, n, w) => { for (let i = 0; i < n; i++) { const pa = lerpP(a, b, i / n), pb = lerpP(a, b, (i + 1) / n); items.push({ d: (view.dist(pa) + view.dist(pb)) / 2, draw: () => { const x = P(pa), y = P(pb); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x[0], x[1]); ctx.lineTo(y[0], y[1]); ctx.stroke(); } }); } };
  const dot = (p, r) => items.push({ d: view.dist(p) - 1e-4, draw: () => { const c = P(p); ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.fill(); } });
  for (const [a, b] of SEGS) seg(q[a], q[b], 3, lw);
  for (const jn of ['lElb', 'tElb', 'lKnee', 'tKnee', 'lSh', 'tSh', 'lHip', 'tHip']) dot(q[jn], lw * 0.62);
  seg(q.H, q.club, 6, lw * 0.45);
  dot(q.club, lw * 0.9); dot(q.H, lw * 0.75);
  items.push({ d: view.dist(q.head), draw: () => {
    ctx.setLineDash([]);
    if (!dashed) drawHead(ctx, view, q, P, k, color, key);
    else { const c = P(q.head); ctx.lineWidth = lw * 0.7; ctx.beginPath(); ctx.arc(c[0], c[1], k * 0.11, 0, Math.PI * 2); ctx.stroke(); }
    if (dashed) ctx.setLineDash([k * 0.035, k * 0.025]);
  } });
  items.sort((u, v) => v.d - u.d);
  for (const it of items) it.draw();
  ctx.setLineDash([]);
  ctx.restore();
}

// ---- head: solid sphere with hair and eyes painted on it (they turn and foreshorten with the head) ----
const HAIR_POOL = {};
function hairCanvas(key) { if (!HAIR_POOL[key]) { const cv = document.createElement('canvas'); cv.width = cv.height = 112; HAIR_POOL[key] = { cv, cx: cv.getContext('2d') }; } return HAIR_POOL[key]; }
function hexRGB(h) { h = (h || '#2b211c').replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); const v = parseInt(h, 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
function drawHead(ctx, view, q, P, k, color, key) {
  const R = 0.11, c = P(q.head), L = q.look, rpx = k * R;
  ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(c[0], c[1], rpx, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  const latW = V.norm(V.cross(L, [0, 1, 0]));
  const eyes = [-1, 1].map((s) => V.norm(V.add(V.add(V.mul(L, 0.85), V.mul(latW, s * 0.42)), [0, 0.1, 0])));
  // One scratch canvas per head: Safari copies canvas-to-canvas lazily, so a shared one would give every head the last head's pixels.
  const { cv, cx } = hairCanvas(key + '|' + view.name);
  const S = cv.width, img = cx.createImageData(S, S), D = img.data;
  const [hr, hg, hb] = hexRGB(css('--hair')), [er, eg, eb] = hexRGB(css('--eye'));
  const EYE_COS = Math.cos(0.21), EYE_SOFT = 0.006;
  const hUp = V.norm(V.sub([0, 1, 0], V.mul(L, L[1]))), lat = V.norm(V.cross(L, hUp));
  const Rv = view.right, U = [0, 1, 0], T = view.toCam;
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const x = (px + 0.5) / S * 2 - 1, y = 1 - (py + 0.5) / S * 2, rr = x * x + y * y;
    if (rr > 1) continue;
    const z = Math.sqrt(1 - rr);
    const n = [Rv[0] * x + U[0] * y + T[0] * z, Rv[1] * x + U[1] * y + T[1] * z, Rv[2] * x + U[2] * y + T[2] * z];
    const side = V.dot(n, lat), ht = V.dot(n, hUp), f = V.dot(n, L);
    const phi = Math.atan2(side, f), cph = Math.cos(phi);
    let line = cph >= 0 ? 0.12 + 0.46 * cph : 0.12 + 0.74 * cph;
    if (cph > 0.5) line += 0.06 * Math.sin(phi * 16) - 0.04;
    const edge = ht - line, o = (py * S + px) * 4, aRim = Math.min(1, (1 - Math.sqrt(rr)) * S * 0.5);
    if (edge >= 0) { D[o] = hr; D[o + 1] = hg; D[o + 2] = hb; D[o + 3] = 255 * Math.min(1, edge * 25, aRim); continue; }
    for (const e of eyes) { const dd = V.dot(n, e) - EYE_COS; if (dd > -EYE_SOFT) { D[o] = er; D[o + 1] = eg; D[o + 2] = eb; D[o + 3] = 255 * Math.min(1, (dd + EYE_SOFT) / (2 * EYE_SOFT), aRim); break; } }
  }
  cx.putImageData(img, 0, 0);
  ctx.save(); ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = true; ctx.drawImage(cv, c[0] - rpx, c[1] - rpx, rpx * 2, rpx * 2); ctx.restore();
}

export function dashLine(ctx, a, b, color, w) { ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash([w * 4, w * 3]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.restore(); }
export function extend(a, b, s) { return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]; }
export function label(ctx, text, x, y, color, k, align = 'left') {
  ctx.save(); ctx.font = `600 ${Math.round(k * 0.055)}px "JetBrains Mono", ui-monospace, monospace`; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(text, x, y); ctx.restore();
}
function drawPath(ctx, view, pts, W, H, k, color, upTo) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = k * 0.007; ctx.globalAlpha = 0.6; ctx.setLineDash([k * 0.03, k * 0.018]);
  ctx.beginPath(); let started = false;
  for (const { t, p } of pts) { if (t > upTo) break; const [x, y] = view.proj(p, W, H, k); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
  ctx.stroke(); ctx.restore();
}

// Draw one view. s = { q:{you,ideal,ghost}, paths, t, show, trace, ball, addr:{hands,neck}, mirror, lead:{you,ideal}, labels }
export function drawView(canvas, id, s) {
  const ctx = canvas.getContext('2d'); const { W, H, k } = setupCanvas(canvas); const view = viewFor(id, s.mirror);
  const C = { you: css('--you'), ideal: css('--ideal'), ghost: css('--ghost'), plane: css('--plane'), plane2: css('--plane2'), ground: css('--ground'), ink: css('--ink'), muted: css('--muted') };
  ctx.clearRect(0, 0, W, H);
  ctx.save(); ctx.strokeStyle = C.ground; ctx.lineWidth = k * 0.012; ctx.beginPath(); ctx.moveTo(0, H * 0.9); ctx.lineTo(W, H * 0.9); ctx.stroke(); ctx.restore();
  const P = (p) => view.proj(p, W, H, k);
  const ballP = P(s.ball);
  if (!s.ballGone) { ctx.save(); ctx.fillStyle = C.ink; ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.arc(ballP[0], ballP[1] - k * 0.006, k * 0.022, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
  if (id === 'dtl') {
    const hands = P(s.addr.hands), neck = P(s.addr.neck);
    if (s.planes !== false) {
      dashLine(ctx, ballP, extend(ballP, hands, 3.2), C.plane, k * 0.008);
      dashLine(ctx, ballP, extend(ballP, neck, 1.75), C.plane2, k * 0.008);
      const al = s.mirror.bs > 0 ? 'right' : 'left', off = s.mirror.bs > 0 ? -k * 0.03 : k * 0.03;
      const a = extend(ballP, hands, 2.15), b = extend(ballP, neck, 1.7);
      label(ctx, 'shaft plane', a[0] + off, a[1] - k * 0.01, C.plane, k, al);
      label(ctx, 'shoulder plane', b[0] + off, b[1] + k * 0.02, C.plane2, k, al);
    }
    label(ctx, 'ball', ballP[0], ballP[1] + k * 0.07, C.muted, k, 'center');
  } else {
    label(ctx, s.mirror.ts > 0 ? 'target →' : '← target', s.mirror.ts > 0 ? W - k * 0.06 : k * 0.06, H * 0.9 + k * 0.08, C.muted, k, s.mirror.ts > 0 ? 'right' : 'left');
    const la = P([s.leadAnkleX ?? 0.2, 0, 0]);
    ctx.save(); ctx.strokeStyle = C.muted; ctx.globalAlpha = 0.35; ctx.lineWidth = k * 0.005; ctx.setLineDash([k * 0.02, k * 0.015]); ctx.beginPath(); ctx.moveTo(la[0], la[1]); ctx.lineTo(la[0], la[1] - k * 1.1); ctx.stroke(); ctx.restore();
    label(ctx, 'lead foot', la[0], la[1] - k * 1.13, C.muted, k, 'center');
    const bw = W * 0.56, bx = (W - bw) / 2, by = H * 0.9 + k * 0.13, bh = k * 0.032;
    const bar = (pct, y, col, txt) => { ctx.save(); ctx.fillStyle = C.ground; ctx.fillRect(bx, y, bw, bh); ctx.fillStyle = col; const f = pct / 100; if (s.mirror.ts > 0) ctx.fillRect(bx + bw * (1 - f), y, bw * f, bh); else ctx.fillRect(bx, y, bw * f, bh); ctx.restore(); label(ctx, txt, s.mirror.ts > 0 ? bx + bw : bx, y - k * 0.012, col, k, s.mirror.ts > 0 ? 'right' : 'left'); };
    if (s.lead.ideal != null && s.show !== 'you') bar(s.lead.ideal, by, C.ideal, `ideal lead ${Math.round(s.lead.ideal)}%`);
    if (s.lead.you != null && s.show !== 'ideal') bar(s.lead.you, by + bh + k * 0.09, C.you, `you lead ${Math.round(s.lead.you)}%`);
  }
  if (s.trace) {
    if (s.q.ideal && s.show !== 'you') drawPath(ctx, view, s.paths.ideal, W, H, k, C.ideal, s.t);
    if (s.q.ghost) drawPath(ctx, view, s.paths.ghost, W, H, k, C.ghost, s.t);
    if (s.q.you && s.show !== 'ideal') drawPath(ctx, view, s.paths.you, W, H, k, C.you, s.t);
  }
  if (s.q.ideal && s.show !== 'you') drawFigure(ctx, view, s.q.ideal, W, H, k, C.ideal, s.show === 'both' ? 0.6 : 1, false, 'ideal');
  if (s.q.ghost) drawFigure(ctx, view, s.q.ghost, W, H, k, C.ghost, 0.9, false, 'ghost', true);
  if (s.q.you && s.show !== 'ideal') drawFigure(ctx, view, s.q.you, W, H, k, C.you, 1, true, 'you');
}

// ---- keyframe markup on a still frame ----
// m = { img, W, H, lines:[{a,b,color,dash}], marks:[{p,color,r,ring}], arrows:[{a,b,color}] }  (image pixel coords)
export function drawMarkup(canvas, m) {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
  const cw = Math.max(1, Math.round(rect.width * dpr)), ch = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  // cover-fit around the focus box
  const f = m.focus || [0, 0, m.W, m.H];
  const sc = Math.max(cw / (f[2] - f[0]), ch / (f[3] - f[1]));
  const ox = cw / 2 - sc * (f[0] + f[2]) / 2, oy = ch / 2 - sc * (f[1] + f[3]) / 2;
  const T = (p) => [ox + p[0] * sc, oy + p[1] * sc];
  ctx.clearRect(0, 0, cw, ch);
  if (m.img) ctx.drawImage(m.img, ox, oy, m.W * sc, m.H * sc);
  const u = Math.max(1.5, cw / 170);
  for (const l of m.lines || []) { ctx.save(); ctx.strokeStyle = l.color; ctx.lineWidth = u * (l.w || 1); if (l.dash) ctx.setLineDash([u * 4, u * 3]); const a = T(l.a), b = T(l.b); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.restore(); }
  for (const a of m.arrows || []) {
    const p = T(a.a), q = T(a.b), ang = Math.atan2(q[1] - p[1], q[0] - p[0]), h = u * 4;
    ctx.save(); ctx.strokeStyle = a.color; ctx.lineWidth = u * 1.6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
    for (const s of [2.6, -2.6]) { ctx.moveTo(q[0], q[1]); ctx.lineTo(q[0] + h * Math.cos(ang + s), q[1] + h * Math.sin(ang + s)); }
    ctx.stroke(); ctx.restore();
  }
  for (const k of m.marks || []) { const p = T(k.p); ctx.save(); ctx.strokeStyle = k.color; ctx.lineWidth = u * 1.6; ctx.beginPath(); ctx.arc(p[0], p[1], (k.r || 9) * u / 1.6, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
}
