// End-to-end checks in a real (headless) browser at iPhone size: node scripts/e2e.mjs
// The tracker is mocked (scripts/mock-tracker.js builds MediaPipe-shaped data from the ideal rig), so the
// analysis core, storage, drawer, wireframe, keyframes and compare all run for real without a video.
// The real tracker on a real clip is covered by scripts/realrun.mjs (needs a local clip; never committed).
// Every bug fixed so far has a test here; add a case for each new feature or fix.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
let playwright;
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { playwright = require(p); break; } catch (e) {} }
if (!playwright) { console.error('Playwright not found (npm i -g playwright)'); process.exit(1); }

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const { server, base: BASE } = serve([['/', ROOT]]);
const MOCK = fs.readFileSync(path.join(ROOT, 'scripts/mock-tracker.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'swinglab-'));
const fakeVideo = path.join(TMP, 'IMG_0914.mov'); fs.writeFileSync(fakeVideo, Buffer.alloc(2048, 7));
const notVideo = path.join(TMP, 'notes.txt'); fs.writeFileSync(notVideo, 'hello');

let pass = 0, fail = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

const browser = await playwright.chromium.launch();
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: opts.dark ? 'dark' : 'light', ...(opts.ctx || {}) });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|net::ERR/.test(m.text())) page.errors.push(m.text()); });
  await ctx.addInitScript(({ mode }) => { globalThis.__SWINGLAB_TEST = { noSW: true, mode }; }, { mode: opts.mode || 'dtl-left' });
  await ctx.addInitScript(MOCK);
  await page.goto(BASE);
  await page.waitForSelector('#topbar');
  page.setMode = (m) => page.evaluate((mm) => { globalThis.__SWINGLAB_TEST.mode = mm; }, m);
  return page;
}
// Tap a real "Add video" button and pick the file in the chooser, like on the phone.
async function pick(page, sel, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
  await chooser.setFiles(file);
}
async function upload(page, file = fakeVideo, sel = '#addTop') {
  await pick(page, sel, file);
  await page.waitForFunction(() => { const s = window.__swinglab.state.cur; return s && (s.status === 'done' || s.status === 'error'); }, null, { timeout: 30000 });
  await page.waitForTimeout(300);
}
async function noOverflow(page) { const w = await page.evaluate(() => document.documentElement.scrollWidth); assert(w <= 390, `page scrolls sideways (${w}px)`); }
async function inkPixels(page, sel) {
  return page.evaluate((s) => { const c = document.querySelector(s); const x = c.getContext('2d'); const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++; return n; }, sel);
}

console.log('Swing Lab e2e');

await test('first launch shows the empty state, no sideways scroll, no errors', async () => {
  const p = await newPage();
  assert(await p.isVisible('#empty'), 'empty state hidden');
  assert(!(await p.isVisible('#session')), 'session view should be hidden');
  await noOverflow(p);
  assert(p.errors.length === 0, 'errors: ' + p.errors.join(' | '));
  await p.context().close();
});

await test('upload → analysis → session view (lefty, down the line, 2 swings)', async () => {
  const p = await newPage();
  await upload(p);
  const st = await p.evaluate(() => ({ status: window.__swinglab.state.cur.status, n: window.__swinglab.state.cur.swings.length }));
  assert(st.status === 'done' && st.n === 2, JSON.stringify(st));
  assert((await p.textContent('#subtitle')).includes('2 swings · down the line · lefty'), await p.textContent('#subtitle'));
  assert(await p.isVisible('#session'));
  assert(!(await p.isVisible('#empty')));
  assert((await p.$$('#swingChips button')).length === 2, 'swing chips');
  await noOverflow(p);
  assert(p.errors.length === 0, 'errors: ' + p.errors.join(' | '));
  await p.context().close();
});

await test('wireframes draw in both views; sliders under each view stay in sync with the stage label', async () => {
  const p = await newPage(); await upload(p);
  assert(await inkPixels(p, '#cvDtl') > 2000, 'down-the-line canvas looks blank');
  assert(await inkPixels(p, '#cvFo') > 2000, 'face-on canvas looks blank');
  await p.fill('#posFo', '300'); await p.dispatchEvent('#posFo', 'input');
  const vals = await p.$$eval('input.pos', (xs) => xs.map((x) => x.value));
  assert(vals.every((v) => v === '300'), 'sliders not synced: ' + vals);
  const labels = await p.$$eval('.vph', (xs) => xs.map((x) => x.textContent));
  assert(labels[0] && labels[0] === labels[1] && labels[0] === (await p.textContent('#phaseName')), 'stage labels differ: ' + labels);
  // the slider spans the view's width and the label sits underneath it
  const geo = await p.evaluate(() => { const r = document.querySelector('#posDtl').getBoundingClientRect(), f = document.querySelector('#cvDtl').getBoundingClientRect(), l = document.querySelector('.vph').getBoundingClientRect(); return { rw: r.width, fw: f.width, below: l.top >= r.bottom - 1 }; });
  assert(geo.rw >= geo.fw - 30 && geo.below, JSON.stringify(geo));
  await p.context().close();
});

await test('phase chips jump to the position; play advances; show toggles redraw without errors', async () => {
  const p = await newPage(); await upload(p);
  await p.click('#phaseChips button[data-id="top"]');
  assert((await p.textContent('#phaseName')) === 'Top', 'phase name ' + await p.textContent('#phaseName'));
  assert((await p.getAttribute('#phaseChips button[data-id="top"]', 'aria-pressed')) === 'true');
  const t0 = await p.evaluate(() => window.__swinglab.state.t);
  await p.click('#play'); await p.waitForTimeout(600);
  assert((await p.textContent('#play')) === 'Pause');
  const t1 = await p.evaluate(() => window.__swinglab.state.t);
  assert(t1 !== t0, 'playback did not move');
  await p.click('#play'); assert((await p.textContent('#play')) === 'Play');
  for (const id of ['showYou', 'showIdeal', 'showBoth']) { await p.click(`label[for=${id}]`); }
  await p.click('#trace');
  assert(p.errors.length === 0, 'errors: ' + p.errors.join(' | '));
  await p.context().close();
});

await test('notes follow the position; the over-the-top swing flags transition as the main fault', async () => {
  const p = await newPage(); await upload(p);
  await p.click('#swingChips button:nth-child(2)');
  const fault = await p.evaluate(() => window.__swinglab.state.res.mainFault.label);
  assert(fault === 'Over the top', 'fault ' + fault);
  await p.click('#phaseChips button[data-id="transition"]');
  assert(/Over the top/.test(await p.textContent('#noteYou')), await p.textContent('#noteYou'));
  assert((await p.textContent('#noteIdeal')).length > 20);
  const flagged = await p.$$eval('.kf button.flag', (xs) => xs.map((x) => x.textContent));
  assert(flagged.length === 1 && /Transition/.test(flagged[0]), 'flagged keyframe: ' + flagged);
  await p.context().close();
});

await test('keyframes: 6 marked-up cards, tap to enlarge, close', async () => {
  const p = await newPage(); await upload(p);
  await p.waitForTimeout(500);
  assert((await p.$$('#kf button')).length === 6, 'keyframe count');
  assert(await inkPixels(p, '#kf button:nth-child(4) canvas') > 1000, 'keyframe canvas blank');
  await p.click('#kf button:nth-child(4)');
  assert(await p.evaluate(() => document.getElementById('dlg').open), 'dialog not open');
  await p.waitForTimeout(300);
  assert((await p.textContent('#dlgTitle')) === 'Transition');
  assert(await inkPixels(p, '#dlgCv') > 1000, 'enlarged keyframe blank');
  await p.click('#dlgClose');
  assert(!(await p.evaluate(() => document.getElementById('dlg').open)), 'dialog still open');
  assert((await p.$$('#metrics div')).length >= 8, 'numbers table');
  await p.context().close();
});

await test('library drawer: opens from ☰, lists the upload with its main fault, closes with scrim and Escape', async () => {
  const p = await newPage(); await upload(p);
  await p.click('#menuBtn'); await p.waitForTimeout(350);
  assert(await p.evaluate(() => document.getElementById('drawer').classList.contains('on')), 'drawer closed');
  assert((await p.getAttribute('#menuBtn', 'aria-expanded')) === 'true');
  const txt = await p.textContent('#list');
  assert(/Main fault: over the top/.test(txt), txt);
  assert(/2 swings · down the line/.test(txt), txt);
  const dw = await p.evaluate(() => document.getElementById('drawer').getBoundingClientRect().width);
  assert(dw <= 340 && dw >= 300, 'drawer width ' + dw);
  await p.mouse.click(380, 400); await p.waitForTimeout(350);
  assert(!(await p.evaluate(() => document.getElementById('drawer').classList.contains('on'))), 'scrim did not close');
  await p.click('#menuBtn'); await p.waitForTimeout(300); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  assert(!(await p.evaluate(() => document.getElementById('drawer').classList.contains('on'))), 'Escape did not close');
  await p.context().close();
});

await test('add from the drawer, open the older upload from the list, compare, stop comparing', async () => {
  const p = await newPage(); await upload(p);
  await p.setMode('dtl-right');
  await p.click('#menuBtn'); await p.waitForTimeout(300);
  await pick(p, '#addDrawer', fakeVideo);
  await p.waitForFunction(() => window.__swinglab.state.sessions.filter((s) => s.status === 'done').length === 2, null, { timeout: 30000 });
  await p.waitForTimeout(300);
  assert((await p.textContent('#subtitle')).includes('righty'), 'second upload should be the righty: ' + await p.textContent('#subtitle'));
  await p.click('#menuBtn'); await p.waitForTimeout(300);
  const items = await p.$$('#list .item');
  assert(items.length === 2, 'items ' + items.length);
  await p.locator('#list .item').nth(1).locator('.more').click();   // the older upload (list is newest first)
  await p.click('text=Compare with current');
  await p.waitForTimeout(300);
  assert(await p.isVisible('#ghostBar'), 'ghost bar hidden');
  assert(/Comparing with/.test(await p.textContent('#ghostBar')));
  assert(await inkPixels(p, '#cvDtl') > 2000);
  await p.click('text=Stop comparing');
  assert(!(await p.isVisible('#ghostBar')), 'ghost bar still shown');
  // open the older one
  await p.click('#menuBtn'); await p.waitForTimeout(300);
  await p.locator('#list .item').nth(1).locator('.open').click(); await p.waitForTimeout(300);
  assert((await p.textContent('#subtitle')).includes('lefty'), 'did not open the older upload');
  assert(p.errors.length === 0, 'errors: ' + p.errors.join(' | '));
  await p.context().close();
});

await test('delete an upload asks first, then removes it and falls back to the empty state', async () => {
  const p = await newPage(); await upload(p);
  await p.click('#menuBtn'); await p.waitForTimeout(300);
  await p.click('#list .more'); await p.click('#list .actions .del');
  assert(/Delete this upload\?/.test(await p.textContent('#list')), 'no confirm step');
  await p.click('#list .actions .del');
  await p.waitForTimeout(400);
  assert((await p.$$('#list .item')).length === 0, 'still listed');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  assert(await p.isVisible('#empty'), 'empty state not shown after delete');
  await p.context().close();
});

await test('uploads survive a reload and the last one reopens', async () => {
  const p = await newPage(); await upload(p);
  await p.reload(); await p.waitForFunction(() => window.__swinglab && window.__swinglab.state.cur && window.__swinglab.state.cur.status === 'done', null, { timeout: 10000 });
  assert(await p.isVisible('#session'), 'session not reopened');
  await p.waitForTimeout(300);
  assert(await inkPixels(p, '#kf button canvas') > 500, 'keyframe image not restored from storage');
  await p.context().close();
});

await test('analysis cut off by closing the app shows "stopped" and Resume finishes it', async () => {
  const p = await newPage({ mode: 'slow' });
  await pick(p, '#addEmpty', fakeVideo);
  await p.waitForFunction(() => /Tracking swing|Found/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
  const pct1 = await p.evaluate(() => window.__swinglab.state.cur.progress);
  assert(pct1 > 0, 'no progress');
  await p.waitForTimeout(2600);   // let the record be saved mid-way, then "close the app"
  await p.reload();
  await p.waitForSelector('text=Analysis stopped before it finished.', { timeout: 8000 });
  await p.setMode('dtl-left');
  await p.click('text=Resume analysis');
  await p.waitForFunction(() => window.__swinglab.state.cur.status === 'done', null, { timeout: 30000 });
  assert(await p.isVisible('#session'));
  await p.context().close();
});

await test('a video that can\'t be read shows the reason and Try again', async () => {
  const p = await newPage({ mode: 'error' });
  await upload(p);
  assert(await p.isVisible('text=Could not analyze this video.'), 'no error banner');
  assert(/Most Compatible/.test(await p.textContent('#status')), await p.textContent('#status'));
  assert(await p.isVisible('text=Try again'));
  await p.setMode('dtl-left'); await p.click('text=Try again');
  await p.waitForFunction(() => window.__swinglab.state.cur.status === 'done', null, { timeout: 30000 });
  assert(await p.isVisible('#session'), 'retry did not finish');
  await p.context().close();
});

await test('a clip with no swing says so and how to fix it', async () => {
  const p = await newPage({ mode: 'none' });
  await upload(p);
  assert(await p.isVisible('text=No full swings found in this video.'), 'no message');
  assert(!(await p.isVisible('#session')));
  await p.click('#menuBtn'); await p.waitForTimeout(300);
  assert(/No swings found/.test(await p.textContent('#list')));
  await p.context().close();
});

await test('face-on upload: tracked face-on view, your lead-foot bar, reconstructed down-the-line view', async () => {
  const p = await newPage({ mode: 'faceon-right' });
  await upload(p);
  assert((await p.textContent('#subtitle')).includes('face-on'), await p.textContent('#subtitle'));
  assert((await p.textContent('#foNote')) === 'tracked from your video');
  assert((await p.textContent('#dtlNote')).includes('rebuilt'));
  assert(/yours/.test(await p.textContent('#foCap')));
  assert(await inkPixels(p, '#cvFo') > 2000);
  assert(p.errors.length === 0, 'errors: ' + p.errors.join(' | '));
  await p.context().close();
});

await test('phone returns 2D body points without 3D: swings still analyze (iPhone regression)', async () => {
  const p = await newPage();
  await p.evaluate(() => { globalThis.__SWINGLAB_TEST.no3d = true; });
  await upload(p);
  const st = await p.evaluate(() => ({ status: window.__swinglab.state.cur.status, n: window.__swinglab.state.cur.swings.length, d: window.__swinglab.state.cur.diag }));
  assert(st.status === 'done' && st.n === 2, JSON.stringify(st));
  assert(st.d && st.d.with3D === 0 && st.d.withBody > 100, 'diag ' + JSON.stringify(st.d));
  assert(await p.isVisible('#session'));
  await p.context().close();
});

await test('when no swing survives analysis, the banner shows copyable details with the reason', async () => {
  const p = await newPage();
  await p.evaluate(() => { const orig = window.Core.analyzeSwing; window.Core.analyzeSwing = () => { throw new TypeError('boom in analysis'); }; window.__restore = () => { window.Core.analyzeSwing = orig; }; });
  await upload(p);
  assert(await p.isVisible('text=No full swings found in this video.'));
  await p.click('text=Details for Claude');
  const t = await p.textContent('#status pre');
  assert(/Swing 1: TypeError: boom in analysis/.test(t) && /with body/.test(t), t);
  await p.evaluate(() => window.__restore());
  await p.click('text=Analyze again');
  await p.waitForFunction(() => window.__swinglab.state.cur.status === 'done' && window.__swinglab.state.cur.swings.length === 2, null, { timeout: 30000 });
  await p.context().close();
});

await test('a finished upload can be analyzed again from the ⋯ menu and from the session screen', async () => {
  const p = await newPage(); await upload(p);
  await p.click('#menuBtn'); await p.waitForTimeout(300);
  await p.click('#list .more');
  assert(await p.isVisible('#list .actions >> text=Analyze again'), 'no Analyze again in the menu');
  await p.click('#list .actions >> text=Analyze again');
  await p.waitForFunction(() => window.__swinglab.state.processing, null, { timeout: 5000 }).catch(() => {});
  await p.waitForFunction(() => !window.__swinglab.state.processing && window.__swinglab.state.cur.status === 'done', null, { timeout: 30000 });
  assert(await p.isVisible('#session'));
  await p.waitForTimeout(300);
  assert(await inkPixels(p, '#kf button canvas') > 500, 'keyframes missing after re-analysis');
  await p.click('#reanalyze');
  await p.waitForFunction(() => !window.__swinglab.state.processing && window.__swinglab.state.cur.status === 'done', null, { timeout: 30000 });
  assert((await p.$$('#swingChips button')).length === 2);
  assert(p.errors.length === 0, 'errors: ' + p.errors.join(' | '));
  await p.context().close();
});

await test('"You" from your tracked joints: same body and spot as the ideal at address, feet planted, no jitter', async () => {
  const p = await newPage(); await upload(p);
  const r = await p.evaluate(() => {
    const st = window.__swinglab.state, res = st.res, C = window.Core;
    const a = C.youPose(res, res.phases.address), b = C.idealPose(res.phases, res.phases.address, 1);
    let dAddr = 0; for (const k of ['H', 'neck', 'P', 'lAnk', 'tAnk', 'club']) for (let i = 0; i < 3; i++) dAddr = Math.max(dAddr, Math.abs(a[k][i] - b[k][i]));
    let feet = 0, jerk = 0, jerkI = 0, pv = [], pi = [];
    const acc = (h, k) => Math.max(...[0, 1, 2].map((i) => Math.abs(h[2][k][i] - 2 * h[1][k][i] + h[0][k][i])));
    for (let t = res.phases.address; t <= res.phases.finish; t += 1 / 60) {
      const q = C.youPose(res, t), qi = C.idealPose(res.phases, t, 1);
      feet = Math.max(feet, Math.abs(q.lAnk[2] - qi.lAnk[2]), Math.abs(q.lAnk[0] - qi.lAnk[0]));
      pv.push(q); pi.push(qi); if (pv.length > 3) { pv.shift(); pi.shift(); }
      if (pv.length === 3) for (const k of ['lKnee', 'tKnee', 'H', 'head']) { jerk = Math.max(jerk, acc(pv, k)); jerkI = Math.max(jerkI, acc(pi, k)); }
    }
    return { dAddr, feet, jerk, jerkI };
  });
  assert(r.dAddr < 0.08, 'figures differ at address by ' + r.dAddr); // You = tracked joints now, same body and spot
  assert(r.feet < 0.02, 'feet not on the same spot: ' + r.feet);
  assert(r.jerk <= r.jerkI * 2 + 0.002, `jerkier than the ideal model itself: ${r.jerk} vs ${r.jerkI}`);
  await p.context().close();
});

await test('tempo: ideal builds smoothly, rests at the top, speeds up to impact; "You" moves with your tracked hands', async () => {
  const p = await newPage(); await upload(p);
  const r = await p.evaluate(() => {
    const st = window.__swinglab.state, res = st.res, C = window.Core, ph = res.phases, dt = 1 / 120;
    const sp = (a, b) => { const out = []; let prev = null; for (let t = a; t <= b + 1e-9; t += dt) { const q = C.idealPose(ph, t, 1).club; if (prev) out.push(Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]) / dt); prev = q; } return out; };
    // backswing: one rise and one fall (no surge/stall at takeaway or lead-arm-parallel)
    const back = sp(ph.address, ph.top), peak = Math.max(...back), atTop = back[back.length - 1];
    let turns = 0, dir = 1, ext = back[0]; // speed reversals bigger than 10% of peak (hysteresis)
    for (const v of back) { if (dir > 0) { if (v > ext) ext = v; else if (ext - v > 0.1 * peak) { turns++; dir = -1; ext = v; } } else { if (v < ext) ext = v; else if (v - ext > 0.1 * peak) { turns++; dir = 1; ext = v; } } }
    // downswing: never slows down by more than 10% before impact
    const down = sp(ph.top, ph.impact); let worstDrop = 0, best = 0;
    for (const v of down) { best = Math.max(best, v); worstDrop = Math.max(worstDrop, (best - v) / Math.max(1e-6, best)); }
    // "You": hands follow the tracked hands in the camera's plane
    const F = res.frames, I = res.idx, inP = (h) => res.view === 'dtl' ? [h[1], h[2]] : [h[0], h[1]];
    let err = 0, n = 0;
    for (let i = I.address; i <= I.finish; i++) { const q = inP(C.youPose(res, F[i].t).H), m = inP(F[i].j.H); err += (m[0] - q[0]) ** 2 + (m[1] - q[1]) ** 2; n++; }
    return { turns, peak, atTop, worstDrop, rms: Math.sqrt(err / n) };
  });
  assert(r.turns <= 1, 'ideal backswing surges/stalls: ' + r.turns + ' speed reversals');
  assert(r.atTop < r.peak * 0.1, `ideal not at rest at the top: ${r.atTop} vs peak ${r.peak}`);
  assert(r.worstDrop < 0.1, 'ideal downswing slows before impact by ' + Math.round(r.worstDrop * 100) + '%');
  assert(r.rms < 0.04, '"You" hands off the tracked hands by ' + (r.rms * 100).toFixed(1) + ' cm RMS');
  await p.context().close();
});

await test('"You" head follows the tracked head through the finish (spine-tilt change not counted twice)', async () => {
  const p = await newPage(); await upload(p);
  const worst = await p.evaluate(() => {
    const st = window.__swinglab.state, res = st.res, C = window.Core, F = res.frames, I = res.idx;
    const e0 = F[I.address].j.ear, q0 = C.youPose(res, F[I.address].t); let w = 0;
    for (const ph of C.PH) { const f = F[I[ph]], q = C.youPose(res, f.t);
      w = Math.max(w, Math.hypot((f.j.ear[1] - e0[1]) - (q.head[1] - q0.head[1]), (f.j.ear[2] - e0[2]) - (q.head[2] - q0.head[2]))); }
    return w;
  });
  assert(worst < 0.12, '"You" head off the tracked head by ' + Math.round(worst * 100) + ' cm');
  await p.context().close();
});

await test('tracking check: 9 frames with the figure on the video; challenge club, moment and body; regenerate applies them', async () => {
  const p = await newPage(); await upload(p);
  await p.waitForTimeout(800);
  assert((await p.$$('#tcar figure')).length === 9, '9 slides');
  assert(await inkPixels(p, '#tcar figure:nth-child(1) canvas') > 2000, 'first slide drawn');
  await p.click('#tcNext'); await p.click('#tcNext'); await p.click('#tcNext'); await p.waitForTimeout(900);
  assert((await p.textContent('#tcPos')).startsWith('Top'), 'three steps land on Top: ' + await p.textContent('#tcPos'));
  // club: tap a clubhead, save
  await p.click('#tcChallenge'); await p.click('#chPick button[data-k="club"]'); await p.waitForTimeout(300);
  assert(await p.isDisabled('#chSave'), 'save waits for a tap');
  const bb = await p.locator('#chCv').boundingBox(); await p.mouse.click(bb.x + bb.width * 0.75, bb.y + bb.height * 0.15);
  await p.click('#chSave'); await p.waitForTimeout(300);
  assert(await p.isVisible('#tcRegen'), 'regenerate offered');
  // moment: two frames later
  await p.click('#tcChallenge'); await p.click('#chPick button[data-k="moment"]'); await p.waitForTimeout(300);
  await p.click('#chFwd'); await p.click('#chFwd'); await p.waitForTimeout(200);
  assert((await p.textContent('#chT')).includes('+2'), 'stepper shows +2 frames');
  await p.click('#chSave'); await p.waitForTimeout(300);
  // body
  await p.click('#tcChallenge'); await p.click('#chPick button[data-k="body"]'); await p.waitForTimeout(300);
  assert((await p.textContent('#tcRegenText')).startsWith('3 fixes'), await p.textContent('#tcRegenText'));
  assert((await p.$$('#tcar figure[data-ph="top"] .fx.pend')).length === 3, 'top slide shows 3 waiting fixes');
  const before = await p.evaluate(() => window.__swinglab.state.res.phases.top);
  await p.evaluate(() => { const t = globalThis.__SWINGLAB_TEST.tracker, o = t.trackVideo; t.trackVideo = (u, opt) => { globalThis.__SWINGLAB_TEST.lastZoom = opt.zoom; return o.call(t, u, opt); }; });
  await p.click('#tcRegenBtn');
  await p.waitForFunction(() => { const L = window.__swinglab; return L.state.cur.status === 'done' && !L.state.processing && L.state.res?.fixed; }, null, { timeout: 30000 });
  await p.waitForTimeout(500);
  const r = await p.evaluate(() => { const L = window.__swinglab; return { top: L.state.res.phases.top, fixed: L.state.res.fixed, zoom: globalThis.__SWINGLAB_TEST.lastZoom, regenHidden: document.getElementById('tcRegen').hidden, done: document.querySelectorAll('#tcar figure[data-ph="top"] .fx:not(.pend)').length }; });
  assert(Math.abs(r.top - before - 2 / 30) < 0.02, `top moved by the fix: ${before} -> ${r.top}`);
  assert(r.fixed.club === 1 && r.fixed.phases.includes('top') && r.fixed.zoom, JSON.stringify(r.fixed));
  assert(r.zoom && r.zoom.length === 1, 'tracker asked for the second look: ' + JSON.stringify(r.zoom));
  assert(r.regenHidden && r.done === 3, 'fixes shown as applied: ' + JSON.stringify(r));
  // remove them again
  await p.click('#tcChallenge'); await p.click('#chRemove'); await p.waitForTimeout(300);
  assert(await p.isVisible('#tcRegen') && (await p.textContent('#tcRegenText')) === 'Fixes removed', 'removal offers regenerate');
  assert(p.errors.length === 0, 'errors: ' + p.errors.join(' | '));
  await p.context().close();
});

await test('position carousel: arrows and dots step through the 9 positions; planes toggle on and off', async () => {
  const p = await newPage(); await upload(p);
  assert((await p.$$('#phaseChips button')).length === 9, 'dots');
  await p.click('#phaseChips button[data-id="address"]');
  assert((await p.textContent('#phName')) === 'Address');
  assert(await p.isDisabled('#phPrev'), 'prev should be disabled at address');
  await p.click('#phNext'); assert((await p.textContent('#phName')) === 'Takeaway', await p.textContent('#phName'));
  await p.click('#phNext'); await p.click('#phNext'); assert((await p.textContent('#phName')) === 'Top');
  await p.click('#phPrev'); assert((await p.textContent('#phName')) === 'Lead arm parallel');
  await p.click('#phaseChips button[data-id="finish"]'); assert(await p.isDisabled('#phNext'), 'next should be disabled at finish');
  const h = await p.evaluate(() => document.querySelector('.pcar').getBoundingClientRect().height);
  assert(h <= 64, 'carousel too tall: ' + h);
  const on = await inkPixels(p, '#cvDtl');
  await p.click('#planes');
  const off = await inkPixels(p, '#cvDtl');
  assert(off < on, `planes did not disappear (${on} → ${off})`);
  await p.reload(); await p.waitForFunction(() => window.__swinglab?.state?.res, null, { timeout: 10000 });
  assert(!(await p.isChecked('#planes')), 'planes setting not remembered');
  await p.click('#planes'); assert(await p.isChecked('#planes'));
  await p.context().close();
});

await test('round play button is always on screen, restarts the swing, morphs to pause', async () => {
  const p = await newPage(); await upload(p);
  await p.waitForTimeout(200);
  assert(await p.isVisible('#fab'), 'fab should be on screen at the top');
  await p.evaluate(() => document.getElementById('kf').scrollIntoView()); await p.waitForTimeout(300);
  assert(await p.isVisible('#fab'), 'fab not shown after scrolling');
  const box = await p.evaluate(() => { const r = document.getElementById('fab').getBoundingClientRect(); return { b: r.bottom, r: r.right, h: r.height }; });
  assert(box.b <= 844 && box.r <= 390 && box.h >= 44, JSON.stringify(box));
  assert(Math.abs(box.h - (await p.evaluate(() => document.getElementById('fab').getBoundingClientRect().width))) < 1, 'fab is not a circle');
  await p.evaluate(() => { const st = window.__swinglab.state; st.t = st.res.phases.impact; window.__swinglab.render(); });
  await p.click('#fab'); await p.waitForTimeout(150);
  const st = await p.evaluate(() => { const s = window.__swinglab.state; return { playing: s.playing, t: s.t, start: s.tStart, top: s.res.phases.top }; });
  assert(st.playing, 'not playing');
  assert(st.t < st.top, `play should restart from the beginning (t=${st.t}, start=${st.start})`);
  assert((await p.getAttribute('#fab', 'aria-label')) === 'Pause' && await p.evaluate(() => document.getElementById('fab').classList.contains('on')), 'icon did not switch to pause');
  await p.click('#fab'); assert(!(await p.evaluate(() => window.__swinglab.state.playing)), 'did not pause');
  await p.click('#menuBtn').catch(() => {}); await p.waitForTimeout(300);
  assert(await p.isHidden('#fab'), 'fab should hide behind the open drawer');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300);
  assert(await p.isVisible('#fab'), 'fab should stay on screen after the drawer closes');
  await p.context().close();
});

await test('a non-video file is refused with a message', async () => {
  const p = await newPage();
  await pick(p, '#addEmpty', notVideo);
  await p.waitForSelector('#toast:not([hidden])', { timeout: 3000 });
  assert(/not a video/.test(await p.textContent('#toast')));
  assert(await p.isVisible('#empty'));
  await p.context().close();
});

await test('dark mode: dark background, readable text, wireframes draw', async () => {
  const p = await newPage({ dark: true });
  await upload(p);
  const c = await p.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color }));
  const lum = (s) => { const [r, g, b] = s.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  assert(lum(c.bg) < 40 && lum(c.ink) > 180, JSON.stringify(c));
  assert(await inkPixels(p, '#cvDtl') > 2000);
  await noOverflow(p);
  await p.context().close();
});

await test('touch targets and layout: buttons ≥ 36 px tall, nothing wider than the phone', async () => {
  const p = await newPage(); await upload(p);
  const small = await p.$$eval('button:not(.kf button)', (bs) => bs.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height < 36; }).map((b) => b.textContent.trim() || b.getAttribute('aria-label')));
  assert(small.length === 0, 'small buttons: ' + small.join(', '));
  const wide = await p.$$eval('main *', (es) => es.filter((e) => e.getBoundingClientRect().right > 391 && getComputedStyle(e).overflowX !== 'auto' && !e.closest('.chips') && !e.closest('.tcar')).map((e) => e.tagName + '.' + e.className).slice(0, 5));
  assert(wide.length === 0, 'wider than screen: ' + wide.join(', '));
  await p.context().close();
});

await browser.close(); server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const [n, e] of failures) console.log('\n✗', n, '\n', e && e.stack); process.exit(1); }
