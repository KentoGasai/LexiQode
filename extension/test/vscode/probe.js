/**
 * Ask the running editor what it actually supports.
 *
 * Written because several things this project needs - placing the chat in the
 * secondary sidebar, branding that reaches `vscode.env`, a view that opens by
 * itself - differ between VS Code versions and forks. Guessing produces code
 * that silently does nothing; this prints the facts the implementation can rely
 * on, for whichever build it is run against.
 *
 *     powershell -File scripts/test-in-editor.ps1 -Runner test/vscode/probe.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const lines = [];
  const say = (label, value) => {
    lines.push(`${label.padEnd(34)} ${value}`);
  };

  // --- identity: which shell is this?
  say('appName', vscode.env.appName);
  say('appHost', vscode.env.appHost);
  say('uiKind', String(vscode.env.uiKind));
  say('language', vscode.env.language);
  say('version', vscode.version);
  say('execPath', process.execPath);
  say('appRoot', vscode.env.appRoot);
  const product = path.join(vscode.env.appRoot, 'product.json');
  let branding = {};
  try {
    branding = JSON.parse(fs.readFileSync(product, 'utf8'));
  } catch {
    branding = {};
  }
  for (const key of [
    'nameShort',
    'nameLong',
    'applicationName',
    'dataFolderName',
    'urlProtocol',
    'win32DirName',
    'win32AppUserModelId',
    'licenseName',
    'reportIssueUrl',
  ]) {
    say(`product.${key}`, String(branding[key]));
  }
  say(
    'extensionsGallery',
    String((branding.extensionsGallery || {}).serviceUrl || '(none)')
  );

  // --- is our extension built in, and where does it live?
  const extension = vscode.extensions.getExtension('lexiqode.lexiqode');
  say('extension found', String(!!extension));
  if (extension) {
    await extension.activate();
    say('extension active', String(extension.isActive));
    say('extensionPath', extension.extensionPath);
    const builtInRoot = path.join(vscode.env.appRoot, 'extensions');
    say(
      'is built-in',
      String(path.resolve(extension.extensionPath).startsWith(path.resolve(builtInRoot)))
    );
    // Where the manifest puts the chat decides where the user sees it.
    const contributes = extension.packageJSON.contributes || {};
    const containers = contributes.viewsContainers || {};
    say('viewsContainers keys', Object.keys(containers).join(', ') || '(none)');
    for (const key of Object.keys(containers)) {
      say(`  ${key} ids`, containers[key].map((entry) => entry.id).join(', '));
    }
    say('activationEvents', (extension.packageJSON.activationEvents || []).join(', '));
  }

  // --- what layout commands exist? This decides how the chat is placed.
  const commands = await vscode.commands.getCommands(true);
  const containerCommands = commands
    .filter((id) => id.startsWith('workbench.view.extension.lexiqode'))
    .sort();
  lines.push('');
  say('container commands', containerCommands.join(', ') || '(none)');
  const interesting = commands
    .filter((id) =>
      /moveView|moveFocusedView|auxiliarybar|auxiliaryBar|secondarySide|togglePanel|focusPanel|view\.extension/i.test(
        id
      )
    )
    .sort();
  lines.push('');
  lines.push('candidate layout commands:');
  for (const id of interesting) {
    lines.push(`  ${id}`);
  }
  say('total commands', String(commands.length));

  // --- what does the workspace look like to the extension?
  lines.push('');
  say('workspace folders', String((vscode.workspace.workspaceFolders || []).length));
  say('workspaceFile', String(vscode.workspace.workspaceFile || '(none)'));
  say('configuration keys', String(
    Object.keys(vscode.workspace.getConfiguration('lexiqode') || {}).length
  ));

  // --- layout experiments.
  //
  // `vscode.moveViews` is the supported way to relocate a view, but the
  // destination it accepts differs between builds, so each candidate is tried
  // and its outcome recorded instead of assumed. A failure here is information,
  // not an error: the fallback simply stays in the activity bar.
  lines.push('');
  lines.push('layout experiments (viewIds: lexiqode.chat):');
  const viewId = 'lexiqode.chat';
  const attempts = [
    { label: 'own container', args: { viewIds: [viewId], destinationId: 'workbench.view.extension.lexiqode' } },
    { label: 'destination "auxiliaryBar"', args: { viewIds: [viewId], destinationId: 'auxiliaryBar' } },
    { label: 'destination "workbench.view.auxiliarybar"', args: { viewIds: [viewId], destinationId: 'workbench.view.auxiliarybar' } },
    { label: 'location: 2 (AuxiliaryBar)', args: { viewIds: [viewId], location: 2 } },
    { label: 'destinationId + location 2', args: { viewIds: [viewId], destinationId: 'workbench.view.extension.lexiqode', location: 2 } },
  ];
  for (const attempt of attempts) {
    try {
      await vscode.commands.executeCommand('vscode.moveViews', attempt.args);
      lines.push(`  OK      ${attempt.label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`  refused ${attempt.label} -> ${message.slice(0, 110)}`);
    }
  }

  // Does the view actually report a location we can ask about?
  try {
    await vscode.commands.executeCommand('workbench.view.extension.lexiqode');
    lines.push('  OK      reveal workbench.view.extension.lexiqode');
  } catch (error) {
    lines.push(`  refused reveal -> ${String(error).slice(0, 110)}`);
  }
  for (const id of ['workbench.action.toggleAuxiliaryBar', 'workbench.action.focusAuxiliaryBar']) {
    try {
      await vscode.commands.executeCommand(id);
      lines.push(`  OK      ${id}`);
    } catch (error) {
      lines.push(`  refused ${id} -> ${String(error).slice(0, 110)}`);
    }
  }

  assert.ok(true);
  console.log('\n' + lines.join('\n') + '\n');
}

module.exports = { run };