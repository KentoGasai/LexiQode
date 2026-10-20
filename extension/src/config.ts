import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Bridge between editor settings and the core process.
 *
 * Two kinds of value live in different places on purpose:
 *
 * * the **API key** goes into `SecretStorage`, which is backed by the operating
 *   system's credential store. It is handed to the core as an environment
 *   variable on spawn, so it never touches a settings file on disk and never
 *   reaches a webview.
 * * everything else (endpoint, model, approval policy, step budget) is ordinary
 *   workspace settings, mirrored into the running core through `PUT /api/settings`.
 */

export const API_KEY_SECRET = 'lexiqode.apiKey';

export interface EditorSettings {
  pythonPath: string;
  coreRoot: string;
  baseUrl: string;
  model: string;
  autoApproveReads: boolean;
  autoApproveWrites: boolean;
  autoApproveCommands: boolean;
  maxSteps: number;
  showDiffs: boolean;
  revealChangedFile: boolean;
  attachToRunningCore: boolean;
  inlineEditModel: string;
}

export function readSettings(scope?: vscode.ConfigurationScope): EditorSettings {
  const config = vscode.workspace.getConfiguration('lexiqode', scope ?? null);
  return {
    pythonPath: config.get<string>('pythonPath', 'python'),
    coreRoot: config.get<string>('coreRoot', ''),
    baseUrl: config.get<string>('baseUrl', '').trim(),
    model: config.get<string>('model', '').trim(),
    autoApproveReads: config.get<boolean>('autoApproveReads', true),
    autoApproveWrites: config.get<boolean>('autoApproveWrites', false),
    autoApproveCommands: config.get<boolean>('autoApproveCommands', false),
    maxSteps: config.get<number>('maxSteps', 40),
    showDiffs: config.get<boolean>('showDiffs', true),
    revealChangedFile: config.get<boolean>('revealChangedFile', true),
    attachToRunningCore: config.get<boolean>('attachToRunningCore', true),
    inlineEditModel: config.get<string>('inlineEditModel', '').trim(),
  };
}

/**
 * Locate the folder that contains the `lexiqode` Python package.
 *
 * Order matters. A shipped shell carries its own core next to the application,
 * and that copy must win: it is the one the product was tested with, and it does
 * not depend on which folder the user happens to open. Only then comes the
 * explicit setting and a `core/` folder beside each workspace directory, which is
 * how this repository is laid out during development.
 */
export function resolveCoreRoot(settings: EditorSettings): string | undefined {
  const candidates: string[] = [];
  // <shell>/resources/app/extensions/lexiqode/out -> <shell>/resources/lexiqode-core
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', 'lexiqode-core'));
  if (settings.coreRoot) {
    candidates.push(settings.coreRoot);
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(path.join(folder.uri.fsPath, 'core'));
  }
  candidates.push(path.resolve(__dirname, '..', '..', 'core'));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isCoreRoot(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

/** True when the folder holds an importable `lexiqode` package. */
export function isCoreRoot(candidate: string): boolean {
  try {
    return fs.statSync(path.join(candidate, 'lexiqode', '__init__.py')).isFile();
  } catch {
    return false;
  }
}

export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const value = await secrets.get(API_KEY_SECRET);
  return value && value.trim() ? value.trim() : undefined;
}

export async function setApiKey(secrets: vscode.SecretStorage, value: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed) {
    await secrets.store(API_KEY_SECRET, trimmed);
  } else {
    await secrets.delete(API_KEY_SECRET);
  }
}

/** Environment overrides handed to the core on spawn. */
export function coreEnvironment(settings: EditorSettings, apiKey?: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (settings.baseUrl) {
    env.LEXIQODE_BASE_URL = settings.baseUrl;
  }
  if (settings.model) {
    env.LEXIQODE_MODEL = settings.model;
  }
  if (apiKey) {
    env.LEXIQODE_API_KEY = apiKey;
  }
  return env;
}

/** The agent policy the core should apply, derived from editor settings. */
export function agentPatch(settings: EditorSettings): {
  max_steps: number;
  approve_writes: boolean;
  approve_commands: boolean;
} {
  return {
    max_steps: Math.max(1, Math.min(settings.maxSteps, 200)),
    approve_writes: !settings.autoApproveWrites,
    approve_commands: !settings.autoApproveCommands,
  };
}