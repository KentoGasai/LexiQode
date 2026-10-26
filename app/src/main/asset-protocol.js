'use strict';

/**
 * Serving the window over `app://` instead of `file://`.
 *
 * A `file://` page is an opaque origin. Workers are refused, module scripts have
 * no stable base, and a content security policy has nothing meaningful to
 * restrict - which matters because Monaco runs language services in web workers,
 * and without them every language degrades to plain text.
 *
 * Registering `app` as a standard, secure scheme gives the window a real origin,
 * so workers load, `'self'` in the policy means this application's own files, and
 * nothing on disk outside `renderer/` and `vendor/` can be reached from the page.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { protocol } = require('electron');

const SCHEME = 'app';
const HOST = 'lexiqode';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/** Must run before the app is ready, or Electron ignores the registration. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ]);
}

function mimeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Map a request path to a file inside one of two roots.
 *
 * `/vendor/...` is the copied third-party bundles; everything else is the
 * window's own files. Traversal is refused by resolving and comparing, not by
 * looking for `..`, so an encoded or unusual spelling is judged by where it
 * lands.
 */
function resolveRequest(requestPath, roots) {
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded.replace(/^\/+/, '');
  const root = relative.startsWith('vendor/') ? roots.vendorRoot : roots.rendererRoot;
  const within = relative.startsWith('vendor/') ? relative.slice('vendor/'.length) : relative;
  const target = path.resolve(root, within);
  const base = path.resolve(root);
  const rel = path.relative(base, target);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return null;
  return target;
}

/**
 * Serve `app://lexiqode/<path>`.
 *
 * `no-store` on the window's own files: this app is updated by replacing a
 * folder, and a cached `index.html` pointing at a script that no longer exists
 * is a white window with no error. Vendored bundles keep a long cache, because
 * their names and contents change together with the app version.
 */
function handleRequests(roots) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== HOST) return new Response('not found', { status: 404 });

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = resolveRequest(requested, roots);
    if (!file) return new Response('refused', { status: 403 });

    try {
      const info = await fsp.stat(file);
      if (info.isDirectory()) return new Response('not a file', { status: 404 });
      const body = await fsp.readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': mimeFor(file),
          'cache-control': requested.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-store'
        }
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/** A header worth failing the start over: without it the window is blank. */
function assertAssetsPresent(roots) {
  const required = [
    path.join(roots.rendererRoot, 'index.html'),
    path.join(roots.vendorRoot, 'monaco', 'vs', 'loader.js'),
    path.join(roots.vendorRoot, 'xterm', 'xterm.js')
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length) {
    throw new Error(`missing window assets (run "npm run vendor"): ${missing.join(', ')}`);
  }
}

function urlFor(relative) {
  return `${SCHEME}://${HOST}/${String(relative).replace(/^\/+/, '')}`;
}

module.exports = { SCHEME, HOST, assertAssetsPresent, handleRequests, mimeFor, registerScheme, resolveRequest, urlFor };