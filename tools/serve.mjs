#!/usr/bin/env node
/**
 * THE BETRAYED WILL — serve.mjs
 *
 * A static file server for local play, in about a hundred lines and no dependency.
 *
 * It exists because the game is ES modules loaded from disk, and a browser will not
 * fetch modules over file:// - the CORS rules make every import fail. Serving over
 * HTTP is not optional, and pulling in a dependency to do it would break the "no
 * external runtime dependency" rule for something that is not even part of the game.
 *
 * Two details matter and are easy to get wrong:
 *   - .js and .mjs MUST be served as text/javascript. A server that guesses
 *     text/plain makes the browser refuse every module, with an error that looks
 *     like a syntax problem in the game rather than a header problem in the server.
 *   - Paths are resolved and then checked to be inside the project root, because
 *     string-replacing ".." does not stop traversal and a dev server should not be
 *     able to read the rest of the disk.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(HERE);
const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve a URL path to a real file inside ROOT, or null if it escapes. */
function safePath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const abs = resolve(join(ROOT, rel));
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end('405');
    }
    let abs = safePath(req.url ?? '/');
    if (!abs) { res.writeHead(403); return res.end('403 forbidden'); }

    let info = await stat(abs).catch(() => null);
    if (info?.isDirectory()) {
      abs = join(abs, 'index.html');
      info = await stat(abs).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`404 not found: ${req.url}`);
    }

    const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const body = await readFile(abs);
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      // No caching during development: a stale module is indistinguishable from a
      // build that did not pick up the change, and that costs an hour to diagnose.
      'cache-control': 'no-store, must-revalidate',
      'cross-origin-opener-policy': 'same-origin',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(body);
    const ms = Date.now() - started;
    if (ms > 40 || res.statusCode !== 200) {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
    }
  } catch (err) {
    console.error('[serve]', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err?.message ?? err}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`THE BETRAYED WILL — serving ${ROOT}`);
  console.log(`  http://${HOST}:${PORT}/   (bind ${HOST})`);
  console.log('  Ctrl-C to stop.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); process.exit(0); });
}
