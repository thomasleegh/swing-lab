// Swing Lab app: library drawer, upload + on-device analysis, wireframe playback, notes, keyframes, compare.
import { store } from './store.js';
import { drawView, drawMarkup, youToQ, css } from './render.js';

const Core = globalThis.Core, Rig = globalThis.Rig, V = Rig.V;
const $ = (id) => document.getElementById(id);
const KEYFRAMES = ['address', 'takeaway', 'top', 'transition', 'impact', 'finish'];
const PHASE_NAMES = Object.fromEntries(Rig.PHASES.map((p) => [p.id, p.name]));
const LS = { get(k) { try { return localStorage.getItem('swinglab_' + k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem('swinglab_' + k, v); } catch (e) {} } };
const TEST = globalThis.__SWINGLAB_TEST || {};

const state = {
  sessions: [], cur: null, swingIdx: 0, res: null, t: 0, tStart: 0, tEnd: 1, playing: false, speed: 0.5, show: 'both', trace: true,
  ghost: null, paths: null, imgs: {}, processing: null, openActions: null,
};

// ---------- utils ----------
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function toast(msg, ms = 1800) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms); }
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
function svgIcon(d) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s; }
function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ---------- drawer ----------
function openDrawer(on) {
  const d = $('drawer'), s = $('scrim');
  if (on) { s.hidden = false; requestAnimationFrame(() => { s.classList.add('on'); d.classList.add('on'); }); d.removeAttribute('inert'); d.setAttribute('aria-hidden', 'false'); $('menuBtn').setAttribute('aria-expanded', 'true'); renderList(); setTimeout(() => $('addDrawer').focus(), 50); }
  else { s.classList.remove('on'); d.classList.remove('on'); d.setAttribute('inert', ''); d.setAttribute('aria-hidden', 'true'); $('menuBtn').setAttribute('aria-expanded', 'false'); setTimeout(() => { if (!d.classList.contains('on')) s.hidden = true; }, 260); }
}
const thumbURLs = {};
async function thumbFor(sess) {
  if (thumbURLs[sess.id]) return thumbURLs[sess.id];
  try { const b = await store.getFrame(`${sess.id}:0:address`); if (b) { thumbURLs[sess.id] = URL.createObjectURL(b); return thumbURLs[sess.id]; } } catch (e) {}
  return null;
}
function sessionLine(s) {
  if (s.status === 'processing') return el('span', {}, s.progressText || 'Analyzing…');
  if (s.status === 'queued') return el('span', {}, 'Waiting to analyze');
  if (s.status === 'interrupted') return el('span', { class: 'fault' }, 'Stopped. Open to resume.');
  if (s.status === 'error') return el('span', { class: 'fault' }, 'Could not analyze');
  const n = s.summary?.count || 0;
  return el('span', {}, n ? `${n} swing${n > 1 ? 's' : ''} · ${s.summary.view === 'faceon' ? 'face-on' : 'down the line'}` : 'No swings found');
}
async function renderList() {
  const list = $('list'); list.textContent = '';
  const sess = state.sessions;
  const proc = sess.filter((s) => s.status === 'processing' || s.status === 'queued');
  const rest = sess.filter((s) => !(s.status === 'processing' || s.status === 'queued'));
  const row = (s) => {
    const img = el('img', { class: 'thumb', alt: '' });
    thumbFor(s).then((u) => { if (u) img.src = u; });
    const meta = el('span', { class: 'meta' }, el('b', {}, s.title), sessionLine(s));
    if (s.status === 'done' && s.summary?.mainFault) meta.append(el('span', { class: s.summary.mainFault === 'No major fault' ? 'ok' : 'fault' }, s.summary.mainFault === 'No major fault' ? 'No major fault' : `Main fault: ${s.summary.mainFault.toLowerCase()}`));
    if (s.status === 'processing') { const b = el('span', { class: 'bar' }, el('i', { style: `width:${Math.round((s.progress || 0) * 100)}%` })); meta.append(b); }
    const open = el('button', { class: 'open', type: 'button', 'aria-label': `Open ${s.title}`, onclick: () => { openDrawer(false); openSession(s.id); } }, img, meta);
    const more = el('button', { class: 'more', type: 'button', 'aria-label': `More for ${s.title}`, 'aria-expanded': state.openActions === s.id ? 'true' : 'false', onclick: () => { state.openActions = state.openActions === s.id ? null : s.id; renderList(); } }, svgIcon('M5 12h.01M12 12h.01M19 12h.01'));
    const wrap = el('div', {}, el('div', { class: 'item' + (state.cur?.id === s.id ? ' cur' : ''), 'data-id': s.id }, open, more));
    if (state.openActions === s.id) {
      const acts = el('div', { class: 'actions' });
      const canCompare = state.cur && state.cur.id !== s.id && state.cur.status === 'done' && s.status === 'done' && (s.summary?.count || 0) > 0 && (state.cur.summary?.count || 0) > 0;
      if (canCompare) acts.append(el('button', { type: 'button', onclick: () => { openDrawer(false); startCompare(s.id); } }, 'Compare with current'));
      if (s.status !== 'processing' && s.status !== 'queued') acts.append(el('button', { type: 'button', onclick: () => { state.openActions = null; openDrawer(false); openSession(s.id).then(() => processSession(s.id)); } }, 'Analyze again'));
      acts.append(el('button', { type: 'button', class: 'del', onclick: () => askDelete(s, acts) }, 'Delete'));
      wrap.append(acts);
    }
    return wrap;
  };
  if (proc.length) { list.append(el('div', { class: 'dr-sec' }, 'Processing')); proc.forEach((s) => list.append(row(s))); }
  list.append(el('div', { class: 'dr-sec' }, 'Your uploads'));
  if (!rest.length) list.append(el('p', { class: 'fine', style: 'padding:4px 16px' }, proc.length ? 'Finished uploads will show here.' : 'Nothing yet. Tap Add video to start.'));
  rest.forEach((s) => list.append(row(s)));
  const u = await store.usage();
  $('usage').textContent = u && u.usage ? `Using ${(u.usage / 1e6).toFixed(0)} MB on this phone.` : '';
}
function askDelete(s, box) {
  box.textContent = '';
  box.append(el('span', { style: 'align-self:center;font-size:14px' }, 'Delete this upload?'),
    el('button', { type: 'button', class: 'del', onclick: async () => { await store.deleteSession(s.id); if (thumbURLs[s.id]) URL.revokeObjectURL(thumbURLs[s.id]); delete thumbURLs[s.id]; if (state.ghost?.id === s.id) stopCompare(); state.openActions = null; await refresh(); if (state.cur?.id === s.id) { state.cur = null; LS.set('cur', ''); showSession(null); } renderList(); toast('Deleted'); } }, 'Delete'),
    el('button', { type: 'button', onclick: () => { state.openActions = null; renderList(); } }, 'Cancel'));
}

// ---------- sessions ----------
async function refresh() { state.sessions = await store.listSessions(); }
async function addFile(file) {
  if (!file) return;
  if (!/^video\//.test(file.type) && !/\.(mov|mp4|m4v|webm)$/i.test(file.name)) { toast('That file is not a video.'); return; }
  const id = newId();
  try {
    await store.putVideo(id, file);
  } catch (e) { toast('Not enough storage on this phone for that video.'); return; }
  const shot = file.lastModified && file.lastModified < Date.now() + 6e4 && file.lastModified > Date.now() - 5 * 365 * 864e5 ? file.lastModified : Date.now();
  const rec = { id, title: fmtDate(shot), addedAt: Date.now(), shotAt: shot, fileName: file.name, size: file.size, status: 'queued', progress: 0 };
  await store.putSession(rec);
  store.persist();
  await refresh();
  openDrawer(false);
  await openSession(id);
  processSession(id);
}
async function openSession(id) {
  stopPlay();
  const s = await store.getSession(id);
  if (!s) { showSession(null); return; }
  state.cur = s; LS.set('cur', id);
  if (state.ghost && state.ghost.id === id) stopCompare(false);
  state.swingIdx = Math.min(+LS.get('swing_' + id) || 0, Math.max(0, (s.swings?.length || 1) - 1));
  showSession(s);
}

function showSession(s) {
  const has = !!s;
  $('empty').hidden = has || state.sessions.length > 0 && false;
  if (!has) {
    $('empty').hidden = false; $('session').hidden = true; $('status').hidden = true;
    $('title').textContent = 'Swing Lab'; $('subtitle').textContent = state.sessions.length ? 'Open the library to pick an upload' : 'Your swing vs an on-plane model';
    return;
  }
  $('empty').hidden = true;
  $('title').textContent = s.title;
  const n = s.summary?.count || 0;
  $('subtitle').textContent = s.status === 'done' ? (n ? `${n} swing${n > 1 ? 's' : ''} · ${s.summary.view === 'faceon' ? 'face-on' : 'down the line'} · ${s.summary.handed === 'left' ? 'lefty' : 'righty'}` : 'No swings found') : 'Analyzing on your phone';
  renderStatus(s);
  if (s.status === 'done' && n) { $('session').hidden = false; loadSwing(state.swingIdx); }
  else $('session').hidden = true;
}

function diagText(s) {
  const d = s.diag || {};
  const lines = [`Found ${d.found ?? '?'} swing(s) · frames ${d.frames ?? '?'} · with body ${d.withBody ?? '?'} · with 3D ${d.with3D ?? '?'}`,
    `Tracker ${d.delegate || '?'} · video ${d.video || '?'} → ${d.processed || '?'} · ${d.duration ?? '?'} s`, ...(d.failures || []), s.error ? `Error: ${s.error}` : null, d.ua || navigator.userAgent.slice(0, 120)];
  return lines.filter(Boolean).join('\n');
}
function diagBox(s) {
  if (!s.diag && !s.error) return null;
  const pre = el('pre', { style: 'white-space:pre-wrap;font:12px/1.4 var(--f-mono);margin:6px 0 0;color:var(--muted);user-select:text;-webkit-user-select:text' }, diagText(s));
  const det = el('details', {}, el('summary', { style: 'cursor:pointer;font-weight:600;min-height:36px;display:flex;align-items:center' }, 'Details for Claude'), pre,
    el('button', { type: 'button', style: 'margin-top:8px', onclick: async (e) => { try { await navigator.clipboard.writeText(diagText(s)); toast('Copied'); } catch (x) { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Selected. Tap Copy.'); } } }, 'Copy details'));
  return det;
}
function renderStatus(s) {
  const box = $('status'); box.textContent = ''; box.className = 'card banner';
  if (s.status === 'done') {
    if (!(s.summary?.count)) {
      box.hidden = false; box.classList.add('err');
      box.append(el('b', {}, 'No full swings found in this video.'),
        el('span', {}, s.note || 'Make sure your whole body and the club are in the frame, filmed down the line or face-on, with the swing at normal speed.'),
        el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => processSession(s.id) }, 'Analyze again')), diagBox(s));
    } else box.hidden = true;
    return;
  }
  box.hidden = false;
  if (s.status === 'processing' || s.status === 'queued') {
    const pct = Math.round((s.progress || 0) * 100);
    box.append(el('div', { class: 'row' }, el('b', {}, s.progressText || 'Getting ready…'), el('span', { class: 'pill info', style: 'margin-left:auto' }, `${pct}%`)),
      el('span', { class: 'bar' }, el('i', { style: `width:${pct}%` })),
      el('small', {}, state.processing?.id === s.id ? 'Keep Swing Lab open; the screen stays on while it works. The first run also downloads the pose model (about 28 MB).' : 'Waiting to start.'));
    return;
  }
  if (s.status === 'interrupted') {
    box.classList.add('err');
    box.append(el('b', {}, 'Analysis stopped before it finished.'), el('span', {}, 'This happens if Swing Lab is closed or the phone locks for a while.'),
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn-dark', onclick: () => processSession(s.id) }, 'Resume analysis')));
    return;
  }
  if (s.status === 'error') {
    box.classList.add('err');
    box.append(el('b', {}, 'Could not analyze this video.'), el('span', {}, s.error || 'Unknown error.'),
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn-dark', onclick: () => processSession(s.id) }, 'Try again')), diagBox(s));
  }
}

// ---------- processing ----------
let wakeLock = null;
async function keepAwake(on) {
  try { if (on && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.processing) keepAwake(true); });

async function processSession(id) {
  if (state.processing) { if (state.processing.id !== id) toast('Another video is still being analyzed.'); return; }
  const rec = await store.getSession(id); if (!rec) return;
  state.processing = { id };
  try { await store.deleteFrames(id); } catch (e) {}
  for (const k of Object.keys(state.imgs)) if (k.startsWith(id + ':')) delete state.imgs[k];
  delete thumbURLs[id];
  Object.assign(rec, { status: 'processing', progress: 0, progressText: 'Loading pose model…', error: null });
  await store.putSession(rec); await refresh(); if (state.cur?.id === id) { state.cur = rec; showSession(rec); }
  keepAwake(true);
  let lastSave = 0, url = null;
  const update = async (p) => {
    rec.progress = p.frac;
    rec.progressText = p.stage === 'scan' ? (p.found == null ? 'Finding swings…' : `Found ${p.found} swing${p.found === 1 ? '' : 's'}`) : p.stage === 'track' ? `Tracking swing ${p.swing} of ${p.found}…` : p.stage === 'frames' ? 'Saving keyframes…' : p.text || 'Working…';
    if (state.cur?.id === id) { state.cur = rec; renderStatus(rec); }
    const now = Date.now();
    if (now - lastSave > 2500) { lastSave = now; store.putSession({ ...rec }).catch(() => {}); refresh().then(() => { if ($('drawer').classList.contains('on')) renderList(); }); }
  };
  try {
    const blob = await store.getVideo(id);
    if (!blob) throw new Error('The video file is missing from storage. Delete this upload and add the video again.');
    url = URL.createObjectURL(blob);
    const { trackVideo, grabFrames } = TEST.tracker || await import('./tracker.js');
    const tr = await trackVideo(url, { findSwings: Core.findSwings, onProgress: update, isCancelled: () => !state.processing || state.processing.id !== id });
    const swings = [], failures = [];
    tr.swings.forEach((sw, i) => {
      let a;
      try { a = Core.analyzeSwing(sw, tr.meta); } catch (e) { a = { ok: false, reason: `${e.name || 'Error'}: ${e.message || e}${e.stack ? ' @ ' + String(e.stack).split('\n').slice(0, 2).join(' | ') : ''}` }; }
      if (a.ok) swings.push(slim(a)); else failures.push(`Swing ${i + 1}: ${a.reason}`);
    });
    const diag = { delegate: tr.meta.delegate, video: `${tr.meta.vw}×${tr.meta.vh}`, processed: `${tr.meta.W}×${tr.meta.H}`, duration: Math.round(tr.meta.duration * 10) / 10,
      found: tr.swings.length, frames: tr.swings.reduce((n, s) => n + s.frames.length, 0), withBody: tr.swings.reduce((n, s) => n + s.frames.filter((f) => f.lm).length, 0),
      with3D: tr.swings.reduce((n, s) => n + s.frames.filter((f) => f.wl).length, 0), ua: navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 120), failures };
    update({ stage: 'frames', frac: 0.96 });
    for (let s = 0; s < swings.length; s++) {
      const times = KEYFRAMES.map((k) => swings[s].phases[k]);
      const { blobs, W, H } = await grabFrames(tr.video, times);
      swings[s].frameSize = [W, H];
      for (let i = 0; i < KEYFRAMES.length; i++) if (blobs[i]) await store.putFrame(`${id}:${s}:${KEYFRAMES[i]}`, blobs[i]);
    }
    tr.video.remove();
    const summary = Core.summarize(swings);
    Object.assign(rec, { status: 'done', progress: 1, progressText: 'Done', swings, summary, diag, meta: { duration: tr.meta.duration, delegate: tr.meta.delegate, found: tr.swings.length }, note: tr.swings.length && !swings.length ? 'Swings were found but you were not tracked clearly enough. Try a brighter clip with your whole body in frame.' : null });
    delete thumbURLs[id];
    await store.putSession(rec);
    toast(swings.length ? `Analyzed ${swings.length} swing${swings.length > 1 ? 's' : ''}` : 'No full swings found');
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg === 'cancelled') return;
    Object.assign(rec, { status: 'error', error: friendly(msg) });
    await store.putSession(rec).catch(() => {});
  } finally {
    if (url) URL.revokeObjectURL(url);
    state.processing = null; keepAwake(false);
    await refresh();
    if (state.cur?.id === id) { state.cur = rec; showSession(rec); }
    if ($('drawer').classList.contains('on')) renderList();
  }
}
function friendly(msg) {
  if (/QuotaExceeded|quota/i.test(msg)) return 'This phone is out of storage for Swing Lab. Delete old uploads and try again.';
  if (/fetch|network|Failed to load|404/i.test(msg)) return 'The pose model could not be downloaded. Check your connection and try again (it is saved for offline use after the first time).';
  return msg;
}
// keep only what the UI needs (landmarks only on keyframes)
function slim(a) {
  const keep = new Set(KEYFRAMES.map((k) => a.idx[k]));
  const frames = a.frames.map((f, i) => ({ t: f.t, j: f.j, club: { dir: f.club.dir.map((x) => Math.round(x * 1000) / 1000), ang: f.club.ang, conf: Math.round(f.club.conf * 10) / 10 }, lm: keep.has(i) ? f.lm : undefined }));
  return { ...a, frames };
}

// ---------- swing view ----------
function curSwing() { return state.cur?.swings?.[state.swingIdx]; }
function loadSwing(i) {
  const s = state.cur; if (!s?.swings?.length) return;
  state.swingIdx = Math.max(0, Math.min(i, s.swings.length - 1)); LS.set('swing_' + s.id, state.swingIdx);
  const r = curSwing();
  state.res = r;
  state.tStart = Math.max(r.frames[0].t, r.phases.address - 0.3);
  state.tEnd = Math.min(r.frames[r.frames.length - 1].t, r.phases.finish + 0.7);
  // both figures are the same rig (see Core.fitRig): same body, feet, ball and ground
  state.scale = 1; state.clubLen = Rig.CLUB_LEN;
  state.keys = Core.fitRig(r);
  const a = Rig.pose(Rig.sample(Rig.IDEAL, 0));
  state.ball = Rig.BALL;
  state.addr = { hands: a.H, neck: a.neck };
  state.mirror = r.view === 'dtl' ? { bs: r.ballSide, ts: r.ballSide } : { bs: r.targetSide, ts: r.targetSide };
  state.leadAnkleX = a.lAnk[0];
  state.paths = buildPaths();
  state.t = clampT(state.t || r.phases.transition);
  if (state.t <= state.tStart || state.t >= state.tEnd) state.t = r.phases[r.mainFault?.phase || 'top'];
  renderSwingChips(); renderPhaseChips(); renderTags(); renderKeyframes(); renderMetrics(); renderGhostBar();
  $('dtlNote').textContent = r.view === 'dtl' ? 'tracked from your video' : 'rebuilt from your face-on video';
  $('foNote').textContent = r.view === 'faceon' ? 'tracked from your video' : 'rebuilt from your down-the-line video';
  $('foCap').textContent = r.view === 'faceon' ? 'Bars show pressure on the lead foot: ideal and yours (estimated from hip position).' : 'Bar shows the ideal pressure on the lead foot. Your weight shift needs a face-on video to measure.';
  $('howBuilt').textContent = `How this was built: your body and head come from on-phone pose tracking of this video${r.approx ? ' (some swing positions are approximate)' : ''}. The club is estimated from the shaft line in each frame. Clubface angle can't be measured from phone video. Distances are estimates, good to a few centimetres. The ideal is a standard on-plane iron swing scaled to you.`;
  render();
}
function clampT(t) { return Math.max(state.tStart, Math.min(state.tEnd, t)); }
function buildPaths() {
  const r = state.res, out = { you: [], ideal: [], ghost: [] };
  for (let t = state.tStart; t <= state.tEnd + 1e-6; t += 1 / 60) {
    out.you.push({ t, p: Core.youRigPose(r, state.keys, t).club });
    out.ideal.push({ t, p: Core.idealPose(r.phases, t, 1).club });
    if (state.ghost) { const g = ghostAt(t); if (g) out.ghost.push({ t, p: g.club }); }
  }
  return out;
}
function ghostAt(t) {
  const g = state.ghost; if (!g) return null;
  const tg = mapTime(state.res.phases, g.res.phases, t);
  if (!g.keys) g.keys = Core.fitRig(g.res);
  return Core.youRigPose(g.res, g.keys, tg);
}
function mapTime(pa, pb, t) {
  const ks = Core.PH;
  if (t <= pa[ks[0]]) return pb[ks[0]] - (pa[ks[0]] - t);
  for (let i = 0; i < ks.length - 1; i++) { const a0 = pa[ks[i]], a1 = pa[ks[i + 1]]; if (t <= a1) return pb[ks[i]] + (pb[ks[i + 1]] - pb[ks[i]]) * (t - a0) / Math.max(1e-3, a1 - a0); }
  return pb[ks[ks.length - 1]] + (t - pa[ks[ks.length - 1]]);
}
function nearestPhase(t) {
  const r = state.res; let best = 'address';
  for (const k of Core.PH) if (Math.abs(r.phases[k] - t) < Math.abs(r.phases[best] - t)) best = k;
  return best;
}
function leadPct(q) { const a = q.lAnk[0], b = q.tAnk[0], p = (q.lHip[0] + q.tHip[0]) / 2; return Math.max(0, Math.min(100, (p - b) / Math.max(0.05, a - b) * 100)); }

function render() {
  const r = state.res; if (!r || $('session').hidden) return;
  const qYou = Core.youRigPose(r, state.keys, state.t);
  const qIdeal = Core.idealPose(r.phases, state.t, 1);
  const qGhost = state.ghost ? ghostAt(state.t) : null;
  const s = {
    q: { you: qYou, ideal: qIdeal, ghost: qGhost }, paths: state.paths, t: state.t, show: state.show, trace: state.trace,
    planes: state.planes, ball: state.ball, addr: state.addr, mirror: state.mirror, leadAnkleX: state.leadAnkleX, ballGone: state.t > r.phases.impact + 0.02,
    lead: { ideal: leadPct(qIdeal), you: r.view === 'faceon' ? leadPct(qYou) : null },
  };
  drawView($('cvDtl'), 'dtl', s);
  drawView($('cvFo'), 'fo', s);
  const ph = nearestPhase(state.t);
  $('phaseName').textContent = PHASE_NAMES[ph];
  const n = r.notes[ph];
  $('noteYou').textContent = n.you; $('noteYou').className = 'lv-' + (n.level === 'info' ? 'info' : n.level); $('noteYou').style.color = n.level === 'good' || n.level === 'info' ? 'var(--ink)' : '';
  $('noteIdeal').textContent = n.ideal;
  const v = Math.round((state.t - state.tStart) / Math.max(1e-3, state.tEnd - state.tStart) * 1000);
  for (const e of document.querySelectorAll('input.pos')) e.value = v;
  for (const e of document.querySelectorAll('.vph')) e.textContent = PHASE_NAMES[ph];
  for (const b of document.querySelectorAll('#phaseChips button')) b.setAttribute('aria-pressed', b.dataset.id === ph ? 'true' : 'false');
  $('phName').textContent = PHASE_NAMES[ph];
  const ids = Core.PH; $('phPrev').disabled = ph === ids[0] && state.t <= r.phases[ids[0]] + 1e-3; $('phNext').disabled = ph === ids[ids.length - 1] && state.t >= r.phases[ids[ids.length - 1]] - 1e-3;
}

function renderSwingChips() {
  const box = $('swingChips'); box.textContent = '';
  state.cur.swings.forEach((sw, i) => {
    const bad = sw.mainFault && sw.mainFault.label !== 'No major fault';
    box.append(el('button', { type: 'button', role: 'tab', 'aria-pressed': i === state.swingIdx ? 'true' : 'false', 'aria-selected': i === state.swingIdx ? 'true' : 'false', title: sw.mainFault?.label || '', onclick: () => { stopPlay(); state.t = 0; loadSwing(i); } }, `Swing ${i + 1}`));
  });
  const r = curSwing();
  if (r.mainFault) box.append(el('span', { class: 'pill ' + (r.mainFault.label === 'No major fault' ? 'good' : 'bad'), style: 'align-self:center;flex:none' }, r.mainFault.label));
}
function renderPhaseChips() {
  const box = $('phaseChips'); box.textContent = '';
  const fault = state.res.mainFault?.label !== 'No major fault' ? state.res.mainFault?.phase : null;
  for (const p of Rig.PHASES) box.append(el('button', { type: 'button', 'data-id': p.id, 'aria-pressed': 'false', 'aria-label': p.name, title: p.name, class: p.id === fault ? 'flag' : '', onclick: () => goPhase(p.id) }, el('i')));
}
function goPhase(id) { stopPlay(); state.t = state.res.phases[id]; render(); }
function stepPhase(d) {
  const ids = Rig.PHASES.map((p) => p.id), cur = nearestPhase(state.t);
  let i = ids.indexOf(cur);
  // if we're between positions, the first step goes to the next one in that direction
  if (d > 0 && state.t < state.res.phases[cur] - 1e-3) i -= 1; if (d < 0 && state.t > state.res.phases[cur] + 1e-3) i += 1;
  goPhase(ids[Math.max(0, Math.min(ids.length - 1, i + d))]);
}
function renderTags() {
  const r = state.res, box = $('tags'); box.textContent = '';
  const conf = r.frames.reduce((a, f) => a + (f.club.conf || 0), 0) / r.frames.length;
  box.append(el('span', { class: 'pill good' }, 'BODY · tracked'), el('span', { class: 'pill good' }, 'HEAD · tracked'),
    el('span', { class: 'pill warn' }, conf > 6 ? 'CLUB · estimated' : 'CLUB · rough estimate'), el('span', { class: 'pill bad' }, 'CLUBFACE · not from video'),
    el('span', { class: 'pill info' }, r.view === 'dtl' ? 'WEIGHT · needs face-on video' : 'WEIGHT · estimated'));
}
function renderMetrics() {
  const m = state.res.metrics, r = state.res, box = $('metrics'); box.textContent = '';
  const row = (k, v) => box.append(el('div', {}, el('span', {}, k), el('span', {}, v)));
  row('Hips-to-shoulders tilt at address', `${m.spineAddress}°`);
  row('Clubhead vs hands at takeaway', m.takeawayClubVsHands == null ? 'too blurred to measure' : m.takeawayClubVsHands < 0 ? `${-m.takeawayClubVsHands} cm inside` : `${m.takeawayClubVsHands} cm outside`);
  if (r.view === 'dtl') { row('Hands at top vs shoulder plane', m.topVsShoulder > 0 ? `${m.topVsShoulder} cm above` : `${-m.topVsShoulder} cm below`); row('Over the top (worst, downswing)', m.overTop > 0 ? `${m.overTop} cm above plane` : 'none'); }
  row('Hands at impact vs address', `${m.handsOutImpact >= 0 ? '+' : ''}${m.handsOutImpact} cm out, ${m.handsUpImpact >= 0 ? '+' : ''}${m.handsUpImpact} cm up`);
  row('Hips toward ball at impact', `${m.hipsTowardBall >= 0 ? '+' : ''}${m.hipsTowardBall} cm`);
  row('Spine angle lost by impact', `${m.standUp}°`);
  row('Head movement to impact', `${m.headMoveImpact} cm`);
  if (r.view === 'faceon') { row('Sway at top', `${m.swayTop} cm`); row('Lead foot at impact', `${m.leadPctImpact}%`); }
  row('Tempo (back : down)', `${m.tempo} : 1`);
  row('Finish held', m.finishHoldCapped ? `${m.finishHold}+ s` : `${m.finishHold} s`);
}

// ---------- keyframes ----------
async function loadImg(key) {
  if (state.imgs[key]) return state.imgs[key];
  const b = await store.getFrame(key); if (!b) return null;
  const url = URL.createObjectURL(b);
  const img = new Image(); img.src = url; try { await img.decode(); } catch (e) { return null; }
  state.imgs[key] = img; return img;
}
function markupFor(r, phase, img) {
  const [W, H] = r.frameSize || [540, 960];
  const sx = W / r.imgW, sy = H / r.imgH;
  const i = r.idx[phase], f = r.frames[i], fa = r.frames[r.idx.address];
  if (!f.lm || !fa.lm) return { img, W, H };
  const P = (lm, k) => [lm[k][0] * W, lm[k][1] * H];
  const grip = (lm) => { const g = Core.gripN(lm); return [g[0] * W, g[1] * H]; };
  const C = { you: css('--you'), ideal: css('--ideal'), plane: css('--plane'), plane2: css('--plane2'), muted: css('--muted') };
  const m = { img, W, H, lines: [], marks: [], arrows: [] };
  const pxm = r.pxPerM * sx;
  const g = grip(f.lm), gA = grip(fa.lm);
  // focus box around the golfer + club
  const xs = f.lm.map((p) => p[0] * W).concat(fa.lm.map((p) => p[0] * W)), ys = f.lm.map((p) => p[1] * H).concat(fa.lm.map((p) => p[1] * H));
  const shaftPx = Math.hypot(r.ballPx[0] * sx - gA[0], r.ballPx[1] * sy - gA[1]) || 0.8 * pxm;   // grip-to-clubhead length as seen at address
  const shaftEnd = [g[0] + Math.cos(f.club.ang * Math.PI / 180) * shaftPx, g[1] + Math.sin(f.club.ang * Math.PI / 180) * shaftPx];
  xs.push(shaftEnd[0], r.ballPx[0] * sx); ys.push(shaftEnd[1], r.ballPx[1] * sy);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padX = (x1 - x0) * 0.12 + 10, padY = (y1 - y0) * 0.08 + 10; x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
  // keep 3:4
  const cw = x1 - x0, ch = y1 - y0; if (cw / ch > 0.75) { const nh = cw / 0.75; y0 -= (nh - ch) / 2; y1 += (nh - ch) / 2; } else { const nw = ch * 0.75; x0 -= (nw - cw) / 2; x1 += (nw - cw) / 2; }
  // keep the crop inside the photo (shift it, then shrink if it is still too big)
  let fw = x1 - x0, fh = y1 - y0;
  if (fw > W) { const k = W / fw; fw = W; fh *= k; } if (fh > H) { const k = H / fh; fh = H; fw *= k; }
  const cx = Math.min(Math.max((x0 + x1) / 2, fw / 2), W - fw / 2), cy = Math.min(Math.max((y0 + y1) / 2, fh / 2), H - fh / 2);
  m.focus = [cx - fw / 2, cy - fh / 2, cx + fw / 2, cy + fh / 2];
  if ((f.club.conf || 0) >= 6) m.lines.push({ a: g, b: shaftEnd, color: C.you, w: 1.2 });
  if (r.view === 'dtl') {
    const B = [r.ballPx[0] * sx, r.ballPx[1] * sy];
    const N = [(fa.lm[11][0] + fa.lm[12][0]) / 2 * W, (fa.lm[11][1] + fa.lm[12][1]) / 2 * H];
    const ext = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
    if (state.planes) m.lines.push({ a: B, b: ext(B, gA, 2.6), color: C.plane, dash: true }, { a: B, b: ext(B, N, 1.6), color: C.plane2, dash: true });
    const hipBackX = (lm) => { const xa = lm[23][0] * W, xb = lm[24][0] * W; return r.ballSide > 0 ? Math.min(xa, xb) - 0.11 * pxm : Math.max(xa, xb) + 0.11 * pxm; };
    const hipY = (lm) => (lm[23][1] + lm[24][1]) / 2 * H;
    if (phase === 'address' || phase === 'impact') {
      const tx = hipBackX(fa.lm); m.lines.push({ a: [tx, hipY(fa.lm) - 0.25 * pxm], b: [tx, hipY(fa.lm) + 0.35 * pxm], color: C.plane2, dash: true });
      const head = P(fa.lm, 0), ear = [(fa.lm[7][0] + fa.lm[8][0]) / 2 * W, (fa.lm[7][1] + fa.lm[8][1]) / 2 * H];
      m.marks.push({ p: [(head[0] + ear[0]) / 2, (head[1] + ear[1]) / 2], color: C.muted, r: 0.12 * pxm / (W / 170) * 1.6 });
    }
    if (phase === 'takeaway') {
      const inside = r.metrics.takeawayClubVsHands != null && r.metrics.takeawayClubVsHands < -12;
      m.marks.push({ p: shaftEnd, color: inside ? C.you : C.ideal, r: 9 });
      if (inside) { const target = [g[0] + r.ballSide * 0.06 * pxm, g[1] + 0.12 * pxm]; m.marks.push({ p: target, color: C.ideal, r: 9 }); m.arrows.push({ a: shaftEnd, b: target, color: C.ideal }); }
    } else if (phase === 'top') {
      m.marks.push({ p: g, color: r.notes.top.level === 'good' ? C.ideal : C.you, r: 9 });
    } else if (phase === 'transition') {
      const bad = r.metrics.overTop > 3;
      m.marks.push({ p: g, color: bad ? C.you : C.ideal, r: 9 });
      if (bad) { // where the hands should be: dropped to between the planes at this height
        const pl = Core.planesImg(r); const toI = (p) => [p[0] * sx, p[1] * sy];
        const yAt = g[1]; const xOn = (ln) => { const a = toI(ln.a), b = toI(ln.b); return a[0] + (b[0] - a[0]) * (yAt - a[1]) / ((b[1] - a[1]) || 1e-3); };
        const target = [(xOn(pl.shoulder) + xOn(pl.shaft)) / 2, yAt + 0.12 * pxm];
        m.marks.push({ p: target, color: C.ideal, r: 9 }); m.arrows.push({ a: g, b: target, color: C.ideal });
      }
    } else if (phase === 'impact') {
      const moved = Math.abs(r.metrics.handsOutImpact) >= 6 || r.metrics.handsUpImpact >= 5;
      m.marks.push({ p: g, color: moved ? C.you : C.ideal, r: 9 });
      if (moved) { m.marks.push({ p: gA, color: C.ideal, r: 9 }); m.arrows.push({ a: g, b: gA, color: C.ideal }); }
      if (r.metrics.hipsTowardBall >= 3) { const a = hipBackX(fa.lm), b = hipBackX(f.lm), y = hipY(f.lm); m.arrows.push({ a: [b, y], b: [a, y], color: C.ideal }); }
    } else if (phase === 'finish') {
      m.marks.push({ p: g, color: r.notes.finish.level === 'good' ? C.ideal : C.muted, r: 9 });
    }
  } else {
    // face-on: lead-side wall and head box from address, hips now
    const leadX = (lm) => (r.handed === 'right' ? lm[27] : lm[28])[0] * W;
    const lx = leadX(fa.lm), top = Math.min(fa.lm[0][1], f.lm[0][1]) * H;
    m.lines.push({ a: [lx, top], b: [lx, Math.max(fa.lm[27][1], fa.lm[28][1]) * H], color: C.plane2, dash: true });
    const ear = (lm) => [(lm[7][0] + lm[8][0]) / 2 * W, (lm[7][1] + lm[8][1]) / 2 * H];
    m.marks.push({ p: ear(fa.lm), color: C.muted, r: 12 });
    const pel = (lm) => [(lm[23][0] + lm[24][0]) / 2 * W, (lm[23][1] + lm[24][1]) / 2 * H];
    m.marks.push({ p: pel(f.lm), color: C.you, r: 7 }, { p: pel(fa.lm), color: C.ideal, r: 7 });
    m.marks.push({ p: g, color: C.you, r: 8 });
  }
  return m;
}
async function renderKeyframes() {
  const box = $('kf'); box.textContent = '';
  const r = state.res, s = state.cur, si = state.swingIdx;
  for (const ph of KEYFRAMES) {
    const n = r.notes[ph] || { level: 'info', you: '' };
    const cv = el('canvas', { 'aria-hidden': 'true' });
    const short = { good: 'Good', warn: 'Check', bad: r.mainFault?.phase === ph ? 'Main fault' : 'Fix', info: 'See photo' }[n.level] || '';
    const b = el('button', { type: 'button', class: r.mainFault?.phase === ph && n.level === 'bad' ? 'flag' : '', 'aria-label': `${PHASE_NAMES[ph]}: ${n.you}`, onclick: () => openKeyframe(ph) },
      cv, el('span', { class: 'cap' }, el('b', {}, PHASE_NAMES[ph]), el('span', { class: 'lv-' + n.level }, short)));
    box.append(b);
    loadImg(`${s.id}:${si}:${ph}`).then((img) => { if (state.res !== r) return; drawMarkup(cv, markupFor(r, ph, img)); });
  }
}
async function openKeyframe(ph) {
  const r = state.res, s = state.cur;
  $('dlgTitle').textContent = PHASE_NAMES[ph];
  $('dlgText').textContent = r.notes[ph].you + ' ' + r.notes[ph].ideal;
  const d = $('dlg'); if (!d.open) d.showModal();
  const img = await loadImg(`${s.id}:${state.swingIdx}:${ph}`);
  requestAnimationFrame(() => drawMarkup($('dlgCv'), markupFor(r, ph, img)));
}

// ---------- compare ----------
async function startCompare(otherId) {
  const o = await store.getSession(otherId); if (!o?.swings?.length) return;
  const idx = Math.min(state.swingIdx, o.swings.length - 1);
  state.ghost = { id: otherId, title: o.title, swing: idx, res: o.swings[idx] };
  state.paths = buildPaths(); renderGhostBar(); render();
  toast('Comparing. Purple dashes = the older upload.');
}
function stopCompare(redraw = true) { state.ghost = null; if (state.res) state.paths = buildPaths(); renderGhostBar(); if (redraw) render(); }
async function renderGhostBar() {
  const bar = $('ghostBar'); bar.textContent = '';
  if (!state.ghost) { bar.hidden = true; return; }
  bar.hidden = false;
  const o = await store.getSession(state.ghost.id);
  const sel = el('select', { 'aria-label': 'Swing to compare', style: 'min-height:36px;border-radius:8px;border:1px solid var(--line);background:var(--chip);color:var(--ink);font:600 14px var(--f-body);padding:0 8px' },
    ...o.swings.map((_, i) => el('option', { value: i, selected: i === state.ghost.swing }, `Swing ${i + 1}`)));
  sel.addEventListener('change', () => { state.ghost.swing = +sel.value; state.ghost.res = o.swings[+sel.value]; state.ghost.keys = null; state.paths = buildPaths(); render(); });
  bar.append(el('span', {}, 'Comparing with ', el('b', {}, o.title)), sel, el('button', { type: 'button', style: 'margin-left:auto', onclick: () => stopCompare() }, 'Stop comparing'));
}

// ---------- playback ----------
let lastTs = 0, holdT = 0;
function tick(now) {
  if (!state.playing) return;
  const dt = Math.min(0.05, (now - lastTs) / 1000); lastTs = now;
  if (holdT > 0) { holdT -= dt; if (holdT <= 0) state.t = state.tStart; }
  else { state.t += dt * state.speed; if (state.t >= state.tEnd) { state.t = state.tEnd; holdT = 1.0; } }
  render(); requestAnimationFrame(tick);
}
function setPlay(on) { state.playing = on; $('play').textContent = on ? 'Pause' : 'Play'; if (on) { if (state.t >= state.tEnd - 1e-3) state.t = state.tStart; holdT = 0; lastTs = performance.now(); requestAnimationFrame(tick); } }
function stopPlay() { if (state.playing) setPlay(false); }

// ---------- wiring ----------
$('menuBtn').addEventListener('click', () => openDrawer(true));
$('closeDrawer').addEventListener('click', () => openDrawer(false));
$('scrim').addEventListener('click', () => openDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('drawer').classList.contains('on')) openDrawer(false); });
for (const id of ['addTop', 'addDrawer', 'addEmpty']) $(id).addEventListener('click', () => { $('file').value = ''; $('file').click(); });
$('file').addEventListener('change', (e) => addFile(e.target.files && e.target.files[0]));
$('play').addEventListener('click', () => setPlay(!state.playing));
for (const r of document.querySelectorAll('input.pos')) r.addEventListener('input', (e) => { stopPlay(); state.t = state.tStart + (state.tEnd - state.tStart) * e.target.value / 1000; render(); });
for (const r of document.querySelectorAll('input[name=spd]')) r.addEventListener('change', (e) => { state.speed = +e.target.value; });
for (const r of document.querySelectorAll('input[name=show]')) r.addEventListener('change', (e) => { state.show = e.target.value; render(); });
$('trace').addEventListener('change', (e) => { state.trace = e.target.checked; render(); });
$('planes').addEventListener('change', (e) => { state.planes = e.target.checked; LS.set('planes', state.planes ? '1' : '0'); render(); if (state.res) renderKeyframes(); });
$('phPrev').addEventListener('click', () => stepPhase(-1));
$('phNext').addEventListener('click', () => stepPhase(1));
state.planes = LS.get('planes') !== '0'; $('planes').checked = state.planes;
// swipe the position carousel left/right to step
{ let x0 = null; const box = document.querySelector('.pcar');
  box.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  box.addEventListener('touchend', (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) stepPhase(dx < 0 ? 1 : -1); x0 = null; }, { passive: true }); }
$('reanalyze').addEventListener('click', () => { if (state.cur) { stopPlay(); stopCompare(false); processSession(state.cur.id); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
$('dlgClose').addEventListener('click', () => $('dlg').close());
$('dlg').addEventListener('click', (e) => { if (e.target === $('dlg')) $('dlg').close(); });
window.addEventListener('resize', () => { render(); if (state.res) renderKeyframes(); });
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { render(); if (state.res) renderKeyframes(); }); } catch (e) {}
window.addEventListener('scroll', () => $('topbar').classList.toggle('scrolled', scrollY > 4), { passive: true });
// swipe from the left edge opens the library; swipe left on it closes
let sx0 = null;
document.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx0 = (t.clientX < 22 || $('drawer').classList.contains('on')) ? [t.clientX, t.clientY] : null; }, { passive: true });
document.addEventListener('touchend', (e) => { if (!sx0) return; const t = e.changedTouches[0], dx = t.clientX - sx0[0], dy = Math.abs(t.clientY - sx0[1]); const on = $('drawer').classList.contains('on'); if (!on && dx > 60 && dy < 50) openDrawer(true); else if (on && dx < -60 && dy < 50) openDrawer(false); sx0 = null; }, { passive: true });

async function boot() {
  try { await refresh(); } catch (e) { $('empty').hidden = false; $('status').hidden = false; $('status').className = 'card banner err'; $('status').textContent = 'Storage is not available in this browser mode. Open Swing Lab from the home screen or a normal Safari tab.'; return; }
  // anything left "processing" from a previous run was interrupted
  for (const s of state.sessions) if (s.status === 'processing') { s.status = 'interrupted'; await store.putSession(s); }
  await refresh();
  const last = LS.get('cur');
  const target = state.sessions.find((s) => s.id === last) || state.sessions[0];
  if (target) await openSession(target.id); else showSession(null);
  const q = state.sessions.find((s) => s.status === 'queued');
  if (q) processSession(q.id);
}
window.__swinglab = { state, render, loadSwing, openSession, processSession, startCompare, addFile, store };
boot();

if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !TEST.noSW) {
  const had = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!had || reloaded || state.processing) return; reloaded = true; location.reload(); });
  navigator.serviceWorker.register('sw.js').then((reg) => { document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); }); }).catch(() => {});
}
