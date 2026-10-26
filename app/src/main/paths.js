'use strict';

/**
 * Where this app keeps its own state.
 *
 * Electron hands out `userData` (`%APPDATA%\\LexiQode` on Windows), which is the
 * one directory no other program claims. The Python core deliberately uses the
 * same product folder for its own settings file, so both halves of the product
 * are found and backed up together, while the two writers stay in separate files
 * that cannot corrupt each other.
 */

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function userDataDir() {
  return app.getPath('userData');
}

function settingsFile() {
  return path.join(userDataDir(), 'app-settings.json');
}

function logsDir() {
  return path.join(userDataDir(), 'logs');
}

function coreLogFile() {
  return path.join(logsDir(), 'core.log');
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** The folder the window's own files are served from. */
function rendererRoot() {
  return path.join(__dirname, '..', 'renderer');
}

/** The third-party browser bundles, copied there by `npm run vendor`. */
function vendorRoot() {
  return path.join(__dirname, '..', '..', 'vendor');
}

/** The Python core sources, which live beside this app in the repository. */
function coreRoot() {
  return path.join(__dirname, '..', '..', '..', 'core');
}

module.exports = {
  coreLogFile,
  coreRoot,
  ensureDir,
  logsDir,
  rendererRoot,
  settingsFile,
  userDataDir,
  vendorRoot
};