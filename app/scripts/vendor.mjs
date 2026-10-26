/**
 * Copy the third-party browser bundles the window loads into `vendor/`.
 *
 * The window is served from a custom scheme with a strict content security
 * policy and no network access, so Monaco and xterm cannot be loaded from a CDN
 * and must ship with the app. Copying from `node_modules` rather than committing
 * a vendored copy keeps one version of the truth: whatever `npm install`
 * resolved is what the app runs.
 *
 * A missing source fails the run. Finding out at build time that a package
 * renamed a directory is cheap; finding out from a white window in a packaged
 * build is not.
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const modules = path.join(appRoot, 'node_modules');
const vendor = path.join(appRoot, 'vendor');

const COPIES = [
  {
    label: 'monaco',
    from: path.join(modules, 'monaco-editor', 'min', 'vs'),
    to: path.join(vendor, 'monaco', 'vs'),
    directory: true
  },
  {
    label: 'xterm',
    from: path.join(modules, '@xterm', 'xterm', 'lib', 'xterm.js'),
    to: path.join(vendor, 'xterm', 'xterm.js')
  },
  {
    label: 'xterm css',
    from: path.join(modules, '@xterm', 'xterm', 'css', 'xterm.css'),
    to: path.join(vendor, 'xterm', 'xterm.css')
  },
  {
    label: 'xterm fit addon',
    from: path.join(modules, '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
    to: path.join(vendor, 'xterm', 'addon-fit.js')
  }
];

async function main() {
  await rm(vendor, { recursive: true, force: true });
  await mkdir(vendor, { recursive: true });

  const missing = [];
  const copied = [];

  for (const entry of COPIES) {
    if (!existsSync(entry.from)) {
      missing.push(`${entry.label}: ${path.relative(appRoot, entry.from)}`);
      continue;
    }
    await mkdir(path.dirname(entry.to), { recursive: true });
    await cp(entry.from, entry.to, { recursive: Boolean(entry.directory) });
    const info = await stat(entry.to);
    copied.push(`${entry.label} -> ${path.relative(appRoot, entry.to)}${info.isDirectory() ? '/' : ''}`);
  }

  if (missing.length) {
    console.error('vendor: these packages are not installed:');
    for (const line of missing) console.error(`  ${line}`);
    console.error('run `npm install` in app/ first');
    process.exitCode = 1;
    return;
  }

  console.log(`vendor: copied ${copied.length} item(s) into vendor/`);
  for (const line of copied) console.log(`  ${line}`);
}

await main();