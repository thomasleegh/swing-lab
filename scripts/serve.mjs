// Tiny static server with HTTP range support (video seeking needs it). Used by the test scripts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
export function serve(roots) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    let f = null;
    for (const [prefix, dir] of roots) if (p.startsWith(prefix)) { const c = path.join(dir, p.slice(prefix.length)); if (c.startsWith(dir) && fs.existsSync(c) && fs.statSync(c).isFile()) { f = c; break; } }
    if (!f) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(f).size, type = TYPES[path.extname(f)] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const a = m[1] ? +m[1] : 0, b = m[2] ? +m[2] : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1 });
      return fs.createReadStream(f, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
    fs.createReadStream(f).pipe(res);
  }).listen(0);
  return { server, base: `http://localhost:${server.address().port}/` };
}
