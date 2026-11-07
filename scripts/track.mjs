// Run the real in-app tracker on a local video and save the raw tracking JSON:
//   node scripts/track.mjs <video> <out.json>
// Playwright's Chromium can't decode HEVC, so pass an H.264/VP9 copy of an iPhone clip.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const [video, out, zoom = ""] = process.argv.slice(2);   // zoom: comma-separated impact times to re-track zoomed in
const { server, base } = serve([['/__fx/', path.dirname(path.resolve(video))], ['/', ROOT]]);
const b = await chromium.launch();
const p = await b.newPage();
p.on('pageerror', (e) => console.error('pageerror', e.message));
await p.goto(`${base}scripts/track-harness.html?file=/__fx/${encodeURIComponent(path.basename(video))}&zoom=${zoom}`);
const t0 = Date.now();
await p.waitForFunction(() => window.__out && window.__out.done, null, { timeout: 30 * 60 * 1000, polling: 1000 });
const o = await p.evaluate(() => window.__out);
if (o.err) { console.error(o.err); process.exit(1); }
fs.writeFileSync(out, JSON.stringify(o.result));
console.log(`swings ${o.result.swings.length}, frames ${o.result.swings.reduce((a, s) => a + s.frames.length, 0)}, delegate ${o.result.meta.delegate}, ${Math.round((Date.now() - t0) / 1000)} s`);
await b.close(); server.close();
