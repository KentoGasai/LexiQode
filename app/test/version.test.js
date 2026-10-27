'use strict';

/**
 * One product, one version.
 *
 * The archive is named after the version in `app/package.json`, and the core
 * introduces itself with `__version__` from `core/lexiqode/version.py`. They have
 * disagreed twice: once as 0.1.0 against 1.0.0, and once when the application was
 * bumped to 0.2.1 and the core was left at 0.2.0. Both times the disagreement was
 * invisible - the artefact looked right and `lexiqode doctor` looked right -
 * until somebody put the two side by side.
 *
 * A version bump is a two-file edit, and this is what makes forgetting the
 * second file fail loudly at build time instead of quietly at release time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const coreVersion = fs.readFileSync(path.join(APP, '..', 'core', 'lexiqode', 'version.py'), 'utf8');

test('the application and the core report the same version', () => {
  const declared = coreVersion.match(/^__version__\s*=\s*["']([^"']+)["']/m);
  assert.ok(declared, 'core/lexiqode/version.py should declare __version__');
  assert.equal(
    declared[1],
    pkg.version,
    'app/package.json and core/lexiqode/version.py disagree about which release this is'
  );
});

test('the version reads as a release number', () => {
  assert.match(
    pkg.version,
    /^\d+\.\d+\.\d+$/,
    `"${pkg.version}" is not a three-part version, and the tag and the archive name are built from it`
  );
});