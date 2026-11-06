// Test-only: a fake tracker that produces MediaPipe-shaped output from the ideal rig, so the e2e suite can run
// the whole app (analysis, storage, UI) without a real video. Injected by scripts/e2e.mjs before the app loads.
// Modes via __SWINGLAB_TEST.mode: 'dtl-left' (default), 'dtl-right', 'faceon-right', 'none', 'error', 'slow'.
(function () {
  const T = (globalThis.__SWINGLAB_TEST = globalThis.__SWINGLAB_TEST || {});
  const W = 540, H = 960, FPS_C = 5, FPS_F = 30;
  const SWING_STARTS = [2.0, 7.0];           // address times of the two swings in the fake clip
  const DUR = 11.5;
  function rigAt(t) {
    const R = globalThis.Rig, end = R.PHASES[R.PHASES.length - 1].t;
    for (const s0 of SWING_STARTS) {
      if (t >= s0 - 1.6 && t <= s0 + end + 1.6) {
        const u = Math.max(0, Math.min(end, t - s0));
        const q = R.pose(R.sample(R.IDEAL, u));
        // over-the-top flavour for swing 2: hands pushed toward the ball in the downswing
        if (s0 === SWING_STARTS[1] && u > 0.86 && u < 1.12) q.H = [q.H[0], q.H[1], q.H[2] + 0.5 * Math.sin((u - 0.86) / 0.26 * Math.PI)];
        return q;
      }
    }
    return globalThis.Rig.pose(globalThis.Rig.sample(globalThis.Rig.IDEAL, 0));
  }
  function landmarks(q, mode) {
    const V = globalThis.Rig.V, view = mode.startsWith('faceon') ? 'faceon' : 'dtl';
    const lefty = mode.endsWith('left'), side = lefty ? -1 : 1;
    // canonical -> camera (x right, y down, z away from camera), like MediaPipe world landmarks
    const cam = view === 'dtl' ? (p) => [side * p[2], -p[1], p[0]] : (p) => [side * p[0], -p[1], -p[2]];
    const look = q.look, lat = V.norm(V.cross(look, [0, 1, 0]));
    const nose = V.add(q.head, V.mul(look, 0.1));
    const dir = V.norm(V.sub(q.club, q.H));
    const J = {};
    // lead side is +X. For a righty that's the left landmarks (odd), for a lefty the right ones (even).
    const L = lefty ? 'R' : 'L', Tr = lefty ? 'L' : 'R';
    J['nose'] = nose; J['earL'] = V.add(q.head, V.mul(lat, -0.07)); J['earR'] = V.add(q.head, V.mul(lat, 0.07));
    const put = (k, v) => { J[k] = v; };
    put('sh' + L, q.lSh); put('sh' + Tr, q.tSh); put('el' + L, q.lElb); put('el' + Tr, q.tElb);
    put('wr' + L, q.H); put('wr' + Tr, q.tHand); put('hip' + L, q.lHip); put('hip' + Tr, q.tHip);
    put('kn' + L, q.lKnee); put('kn' + Tr, q.tKnee); put('an' + L, q.lAnk); put('an' + Tr, q.tAnk);
    put('toe' + L, q.lToe); put('toe' + Tr, q.tToe);
    const idx = { nose: 0, earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16, hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28, toeL: 31, toeR: 32 };
    const world = Array.from({ length: 33 }, () => null);
    for (const k in idx) world[idx[k]] = J[k];
    const fill = (i, src, off) => { world[i] = V.add(world[src], off); };
    for (const i of [1, 2, 3, 4, 5, 6, 9, 10]) world[i] = V.add(nose, V.mul(look, -0.02));
    fill(17, 15, V.mul(dir, 0.04)); fill(19, 15, V.mul(dir, 0.05)); fill(21, 15, V.mul(dir, 0.03));
    fill(18, 16, V.mul(dir, 0.04)); fill(20, 16, V.mul(dir, 0.05)); fill(22, 16, V.mul(dir, 0.03));
    fill(29, 27, [0, 0, -0.05]); fill(30, 28, [0, 0, -0.05]);
    const hipMid = V.mul(V.add(world[23], world[24]), 0.5);
    const wl = world.map((p) => { const c = cam(V.sub(p, hipMid)); return [c[0], c[1], c[2], 0.95]; });
    // image: orthographic, 300 px per metre, ankles at the bottom third
    const s = 300, cx = W * 0.55, gy = H * 0.88;
    const img = (p) => { const c = cam(p); return [(cx + c[0] * s) / W, (gy + c[1] * s) / H, c[2] * 0.1, 0.95]; };
    const lm = world.map(img);
    // club score: a peak at the true image angle of the shaft
    const g = img(q.H), e = img(q.club);
    const ang = ((Math.atan2((e[1] - g[1]) * H, (e[0] - g[0]) * W) * 180 / Math.PI) + 360) % 360;
    const sc = Array.from({ length: 180 }, (_, k) => { const d = Math.min(Math.abs(k * 2 - ang), 360 - Math.abs(k * 2 - ang)); return Math.round(Math.max(0, 22 - d * 0.6) * 10) / 10; });
    return { lm, wl, sc };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  T.tracker = {
    async trackVideo(url, { onProgress = () => {}, findSwings }) {
      const mode = T.mode || 'dtl-left';
      if (mode === 'error') { await sleep(200); throw new Error('This video could not be opened. Try exporting it from Photos as "Most Compatible".'); }
      const still = mode === 'none';
      const coarse = [];
      for (let i = 0; i <= DUR * FPS_C; i++) {
        const t = i / FPS_C, q = still ? rigAt(0) : rigAt(t);
        coarse.push({ t, lm: landmarks(q, mode).lm });
        if (i % 10 === 0) { onProgress({ stage: 'scan', frac: 0.35 * i / (DUR * FPS_C), found: null }); if (mode === 'slow') await sleep(250); }
      }
      const windows = findSwings(coarse, DUR);
      onProgress({ stage: 'scan', frac: 0.35, found: windows.length });
      const swings = [];
      for (let s = 0; s < windows.length; s++) {
        const w = windows[s], frames = [];
        for (let t = w.t0; t <= w.t1 + 1e-6; t += 1 / FPS_F) { const d = landmarks(rigAt(t), mode); frames.push({ t: Math.round(t * 1e4) / 1e4, lm: d.lm, wl: d.wl, sc: d.sc }); }
        swings.push({ ...w, frames });
        onProgress({ stage: 'track', frac: 0.35 + 0.6 * (s + 1) / windows.length, found: windows.length, swing: s + 1 });
        if (mode === 'slow') await sleep(1500);
      }
      return { meta: { duration: DUR, W, H, vw: 1080, vh: 1920, delegate: 'MOCK' }, coarse, swings, video: { remove() {}, mock: true } };
    },
    async grabFrames(v, times, width = 540) {
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
      const blobs = [];
      for (const t of times) {
        x.fillStyle = '#16231d'; x.fillRect(0, 0, W, H); x.fillStyle = '#3b6b40'; x.fillRect(0, H * 0.55, W, H * 0.45);
        const d = landmarks(rigAt(t), T.mode || 'dtl-left').lm; x.strokeStyle = '#ddd'; x.lineWidth = 8; x.lineCap = 'round';
        for (const [a, b] of [[11, 12], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [11, 13], [13, 15], [12, 14], [14, 16]]) { x.beginPath(); x.moveTo(d[a][0] * W, d[a][1] * H); x.lineTo(d[b][0] * W, d[b][1] * H); x.stroke(); }
        blobs.push(await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8)));
      }
      return { blobs, W, H };
    },
  };
})();
