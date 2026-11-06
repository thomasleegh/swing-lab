// Full app run on a real clip (not committed): upload through the UI, wait for analysis, screenshot.
//   node scripts/realrun.mjs <video.webm|mp4> <outdir>
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const [video, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const { server, base } = serve([['/', ROOT]]);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.addInitScript(() => { globalThis.__FORCE_CPU = true; globalThis.__SWINGLAB_TEST = { noSW: true }; });
await p.goto(base);
await p.waitForSelector('#addEmpty');
await p.screenshot({ path: path.join(outDir, '01-empty.png') });
await p.setInputFiles('#file', video);
await p.waitForTimeout(4000);
await p.screenshot({ path: path.join(outDir, '02-processing.png') });
const t0 = Date.now();
await p.waitForFunction(() => { const s = window.__swinglab?.state?.cur; return s && (s.status === 'done' || s.status === 'error'); }, null, { timeout: 25 * 60 * 1000, polling: 2000 });
const st = await p.evaluate(() => ({ status: window.__swinglab.state.cur.status, error: window.__swinglab.state.cur.error, n: window.__swinglab.state.cur.swings?.length, faults: window.__swinglab.state.cur.swings?.map((s) => s.mainFault.label) }));
console.log('analysis', st, Math.round((Date.now() - t0) / 1000), 's');
await p.waitForTimeout(1500);
await p.screenshot({ path: path.join(outDir, '03-session.png'), fullPage: true });
await p.click('#menuBtn'); await p.waitForTimeout(500);
await p.screenshot({ path: path.join(outDir, '04-drawer.png') });
const second = process.argv[4];
if (second) {
  // second clip, then compare the newest with the first
  await p.setInputFiles('#file', second);
  await p.waitForFunction(() => window.__swinglab.state.sessions.filter((s) => s.status === 'done').length === 2, null, { timeout: 25 * 60 * 1000, polling: 2000 });
  await p.waitForTimeout(800);
  await p.click('#menuBtn'); await p.waitForTimeout(400);
  await p.locator('#list .item').nth(1).locator('.more').click();
  await p.click('text=Compare with current'); await p.waitForTimeout(800);
  await p.click('#phaseChips button[data-id="transition"]'); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(outDir, '05-compare.png'), fullPage: true });
}
await p.emulateMedia({ colorScheme: 'dark' }); await p.keyboard.press('Escape'); await p.waitForTimeout(600);
await p.screenshot({ path: path.join(outDir, '06-dark.png') });
console.log('errors', errs);
await b.close(); server.close();
