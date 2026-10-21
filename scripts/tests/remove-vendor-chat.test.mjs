#!/usr/bin/env node
/**
 * Tests for scripts/remove-vendor-chat.mjs.
 *
 * The script edits upstream sources, and every mistake it makes costs a full
 * Windows build to discover - two references were missed that way. So it is
 * tested here instead, against fixtures copied from the pinned upstream tag, and
 * CI runs this file on every commit.
 *
 *     node scripts/tests/remove-vendor-chat.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'remove-vendor-chat.mjs');

/** The lines below are quoted from microsoft/vscode at the pinned tag. */
const UPSTREAM_SCRIPTS = {
	compile: 'npm-run-all2 -lp compile-client compile-copilot',
	'compile-copilot': 'npm --prefix extensions/copilot run compile',
	'compile-client': 'npm run gulp compile',
	watch: 'npm-run-all2 -lp watch-client-transpile watch-client watch-extensions watch-copilot',
	'watch-transpile': 'npm-run-all2 -lp watch-client-transpile watch-extensions watch-copilot',
	'watch-client': 'npm run gulp watch-client',
	'watch-copilot': 'npm --prefix extensions/copilot run watch',
	'watch-copilotd': 'deemon npm run watch-copilot',
	'kill-watch-copilotd': 'deemon --kill npm run watch-copilot',
	'copilot:setup': 'npm --prefix extensions/copilot run setup',
	'copilot:get_token': 'npm --prefix extensions/copilot run get_token',
	'agent-host:generate-copilot-meta': 'node build/agentHost/generateCopilotMetadata.ts',
};

const UPSTREAM_DIRS = ["\t'extensions/copilot',\n", "\t'extensions/git',\n"].join('');

const UPSTREAM_GULPFILE = [
	'\t\tconst dependenciesSrc = productionDependencies.map(d => path.relative(root, d));\n',
	'\t\tensureCopilotPlatformPackage(platform, arch);\n',
	'\t\tconst deps = es.merge(cleanedDeps, osProxyResolverPlatformPackage)\n',
	'\t\t\t\tcompileNonNativeExtensionsBuildTask,\n',
	'\t\t\t\tcompileCopilotExtensionBuildTask,\n',
	'\t\t\t\tcompileNativeExtensionsBuildTask,\n',
	'\t},\n',
	// No trailing comma here, unlike the compile entries above: this one is the last
	// argument of its series call upstream, and the pattern has to match it exactly.
	'\t\t\tprepareCopilotRipgrepShimTask(platform, arch, destinationFolderName)\n',
	'\t\t\tcreateChecksumsTask(platform, arch, destinationFolderName, destinationFolderName)\n',
	'\t);\n',
	'function prepareCopilotRipgrepShimTask(platform: string, arch: string, destinationFolderName: string) {\n',
	'\tvoid platform; void arch; void destinationFolderName;\n',
	'}\n',
].join('');

let workdir;

function buildTree({ omitDirEntry = false } = {}) {
	const root = fs.mkdtempSync(path.join(workdir, 'src-'));
	fs.mkdirSync(path.join(root, 'build', 'npm'), { recursive: true });
	fs.mkdirSync(path.join(root, 'extensions', 'copilot', 'node_modules', '@github', 'copilot', 'sdk'), { recursive: true });
	fs.writeFileSync(path.join(root, 'extensions', 'copilot', 'package.json'), '{"name":"copilot-chat"}\n');
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'code-oss-dev', scripts: { ...UPSTREAM_SCRIPTS } }, null, 2) + '\n');
	fs.writeFileSync(path.join(root, 'build', 'npm', 'dirs.ts'), omitDirEntry ? UPSTREAM_DIRS.replace("\t'extensions/copilot',\n", '') : UPSTREAM_DIRS);
	fs.writeFileSync(path.join(root, 'build', 'gulpfile.vscode.ts'), UPSTREAM_GULPFILE);
	return root;
}

function run(root, extraArgs = []) {
	return spawnSync(process.execPath, [SCRIPT, root, ...extraArgs], { encoding: 'utf8' });
}

before(() => {
	workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-vendor-chat-'));
});

after(() => {
	fs.rmSync(workdir, { recursive: true, force: true });
});

describe('remove-vendor-chat', () => {
	it('removes every reference to the vendor chat extension', () => {
		const root = buildTree();
		const result = run(root);
		assert.equal(result.status, 0, `the script failed:\n${result.stdout}\n${result.stderr}`);

		// The directory is gone.
		assert.equal(fs.existsSync(path.join(root, 'extensions', 'copilot')), false);

		// Every script that drove it is gone, and the scripts that must survive did.
		const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
		for (const gone of ['compile-copilot', 'watch-copilot', 'watch-copilotd', 'kill-watch-copilotd', 'copilot:setup', 'copilot:get_token']) {
			assert.equal(gone in scripts, false, `${gone} should have been deleted`);
		}
		assert.equal(scripts.compile, 'npm-run-all2 -lp compile-client', 'compile must keep working without the vendor step');
		assert.equal(scripts.watch, 'npm-run-all2 -lp watch-client-transpile watch-client watch-extensions');
		assert.equal(scripts['watch-transpile'], 'npm-run-all2 -lp watch-client-transpile watch-extensions');
		assert.equal(scripts['compile-client'], 'npm run gulp compile', 'unrelated scripts must not change');

		// No script may still reach the removed directory, at all.
		for (const [name, value] of Object.entries(scripts)) {
			assert.ok(
				!value.includes('extensions/copilot') && !/^(compile|watch)-copilot/.test(name),
				`${name} can still reach the removed extension: ${value}`
			);
		}
		// A script whose value only names an unrelated build file must survive: the
		// first version of this check rejected it, which is why it is asserted here.
		assert.equal(
			scripts['agent-host:generate-copilot-meta'],
			UPSTREAM_SCRIPTS['agent-host:generate-copilot-meta'],
			'a script naming an unrelated build file must be left alone'
		);

		// The two build files lost their lines, and nothing else moved.
		const dirs = fs.readFileSync(path.join(root, 'build', 'npm', 'dirs.ts'), 'utf8');
		assert.equal(dirs, UPSTREAM_DIRS.replace("\t'extensions/copilot',\n", ''));

		const gulp = fs.readFileSync(path.join(root, 'build', 'gulpfile.vscode.ts'), 'utf8');
		assert.doesNotMatch(gulp, /^\s*compileCopilotExtensionBuildTask,\n/m);
		assert.doesNotMatch(gulp, /^\s*prepareCopilotRipgrepShimTask\(platform, arch, destinationFolderName\)\n/m);
		// The neighbours must be untouched, and the definition must stay: removing it
		// would be dead code either way, but touching it is not this script's job.
		assert.match(gulp, /^\s*compileNonNativeExtensionsBuildTask,\n/m);
		assert.match(gulp, /^\s*compileNativeExtensionsBuildTask,\n/m);
		assert.match(gulp, /function prepareCopilotRipgrepShimTask\(platform: string/);
		assert.match(gulp, /ensureCopilotPlatformPackage\(platform, arch\);/);
	});

	it('is a no-op when the tree is already clean, so a re-run is safe', () => {
		const root = buildTree();
		assert.equal(run(root).status, 0);
		const second = run(root);
		assert.equal(second.status, 0, `a second run failed:\n${second.stdout}\n${second.stderr}`);
		assert.match(second.stdout, /already removed/);
	});

	it('refuses a tree where upstream moved a line it must edit', () => {
		const root = buildTree({ omitDirEntry: true });
		const result = run(root);
		assert.notEqual(result.status, 0, 'a missing upstream line must fail the run, not be skipped');
		assert.match(result.stderr, /the install list entry/);
		assert.match(result.stderr, /Upstream changed that line/);
		// A failed run must not leave the tree half-edited.
		const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
		assert.equal('compile-copilot' in scripts, true, 'nothing should have been applied');
		assert.equal(fs.existsSync(path.join(root, 'extensions', 'copilot')), true);
	});

	it('refuses something that is not a source tree', () => {
		const empty = fs.mkdtempSync(path.join(workdir, 'empty-'));
		const result = run(empty);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /not a VS Code source tree/);
	});

	it('refuses to run without a source directory', () => {
		const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /usage: node scripts\/remove-vendor-chat\.mjs/);
	});
});