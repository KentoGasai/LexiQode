#!/usr/bin/env node
/**
 * Removes the vendor chat extension from the VS Code sources.
 *
 * Upstream ships its own chat extension as a built-in directory and a packaging
 * step that materializes that extension's SDK natives. The step throws when the
 * directory is missing, which is how the first packaging run failed:
 *
 *   Error: [prepareBuiltInCopilotRipgrepShim] Copilot SDK directory not found at
 *   ...\resources\app\extensions\copilot\node_modules\@github\copilot\sdk
 *
 * Neither the extension nor the step belongs in this product: our agent is its
 * own, and the product is meant to run without a vendor account.
 *
 * Why this is a script rather than a few lines in the PowerShell build
 * ----------------------------------------------------------------
 * The removal touches nine entries in `package.json`, one line in the install
 * list, two lines in the packaging series and the directory itself. Doing that
 * with regular expressions against hand-written fixed strings is exactly how the
 * previous attempts went wrong: two references were missed, and each miss cost a
 * full forty-minute Windows build to discover. So the surgery lives here, where
 * it can be tested offline with `node scripts/tests/remove-vendor-chat.test.mjs`,
 * and CI runs that test on every commit.
 *
 * Every step verifies the text it edits. A line that has moved because upstream
 * refactored fails immediately and by name, before anything expensive starts.
 *
 * Nothing is written until every edit has been planned and validated, so a run
 * that fails leaves the tree exactly as it found it. Half-applied sources are
 * worse than untouched ones: they produce a failure that looks unrelated.
 *
 *     node scripts/remove-vendor-chat.mjs <vscode-source-dir>
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const sourceDir = argv.find((argument) => !argument.startsWith('--'));
const quiet = argv.includes('--quiet');

/** Scripts that exist only to drive the removed extension. */
const SCRIPTS_TO_DELETE = [
	'compile-copilot',
	'watch-copilot',
	'watch-copilotd',
	'kill-watch-copilotd',
	'copilot:setup',
	'copilot:get_token',
];

/** Scripts that keep working, minus their reference to the removed extension. */
const SCRIPT_TOKENS_TO_TRIM = ['compile-copilot', 'watch-copilot'];

/**
 * Lines to delete from the build files, each anchored to a whole line. The
 * patterns are deliberately narrow: the bare name also occurs in the definition
 * of the removed task and in an import, and removing those would break the build.
 */
const LINE_EDITS = [
	{
		file: 'build/npm/dirs.ts',
		why: 'the install list entry',
		pattern: /^[ \t]*'extensions\/copilot',\r?\n/m,
	},
	{
		file: 'build/gulpfile.vscode.ts',
		why: 'the compile step',
		pattern: /^[ \t]*compileCopilotExtensionBuildTask,\r?\n/m,
	},
	{
		file: 'build/gulpfile.vscode.ts',
		why: 'the shim step',
		pattern: /^[ \t]*prepareCopilotRipgrepShimTask\(platform, arch, destinationFolderName\)\r?\n/m,
	},
];

const EXTENSION_DIR = 'extensions/copilot';

/** Whether a script value can still reach the extension that is being removed. */
function stillReachesExtension(value) {
	return value.includes(EXTENSION_DIR) || SCRIPTS_TO_DELETE.some((name) => value.includes(name));
}

function fail(message) {
	console.error(`error: ${message}`);
	process.exit(1);
}

function say(message) {
	if (!quiet) {
		console.log(`  ${message}`);
	}
}

function read(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch (error) {
		fail(`cannot read ${file}: ${error.message}`);
	}
}

// ------------------------------------------------------------------ package.json

/**
 * Edit `package.json` through the JSON parser rather than by text.
 *
 * The scripts are plain string values inside a large document, and a regex
 * against them would be fragile in a way that is invisible until it silently
 * matches nothing. Parsing also lets the result be verified structurally.
 */
function editPackageJson(root) {
	const file = path.join(root, 'package.json');
	const original = read(file);

	let document;
	try {
		document = JSON.parse(original);
	} catch (error) {
		fail(`package.json is not valid JSON: ${error.message}`);
	}
	const scripts = document.scripts;
	if (!scripts || typeof scripts !== 'object') {
		fail('package.json has no scripts block');
	}

	let removed = 0;
	for (const name of SCRIPTS_TO_DELETE) {
		if (Object.prototype.hasOwnProperty.call(scripts, name)) {
			delete scripts[name];
			removed += 1;
			say(`removed the ${name} script`);
		}
	}

	let trimmed = 0;
	for (const [name, value] of Object.entries(scripts)) {
		if (typeof value !== 'string') {
			continue;
		}
		const tokens = value.split(/\s+/);
		const kept = tokens.filter((token) => !SCRIPT_TOKENS_TO_TRIM.includes(token));
		if (kept.length !== tokens.length) {
			scripts[name] = kept.join(' ');
			trimmed += 1;
			say(`trimmed ${name} to: ${kept.join(' ')}`);
		}
	}

	// The point of the edit is that nothing can reach the removed directory any
	// more, so that is what is checked. Matching the word "copilot" instead would
	// reject scripts that merely name an unrelated build file.
	const leftovers = Object.entries(scripts)
		.filter(([, value]) => typeof value === 'string' && stillReachesExtension(value))
		.map(([name, value]) => `${name}: ${value}`);
	if (leftovers.length > 0) {
		fail(
			`package.json still has scripts that mention the vendor extension, which would fail the build:\n    ${leftovers.join('\n    ')}`
		);
	}

	// Match the original formatting: indentation width and final newline.
	const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? '\t';
	const trailingNewline = original.endsWith('\n');
	say(`package.json: ${removed} script(s) removed, ${trimmed} trimmed`);
	return {
		file,
		text: JSON.stringify(document, null, indent) + (trailingNewline ? '\n' : ''),
	};
}

// ------------------------------------------------------------------ build files

/** Plan the line removals, validating every one of them first. */
function planLines(root, edits) {
	const byFile = new Map();
	for (const edit of edits) {
		if (!byFile.has(edit.file)) {
			byFile.set(edit.file, []);
		}
		byFile.get(edit.file).push(edit);
	}

	const results = [];
	for (const [relative, fileEdits] of byFile) {
		const file = path.join(root, relative);
		let text = read(file);
		for (const edit of fileEdits) {
			const scan = new RegExp(edit.pattern.source, `${edit.pattern.flags.replace('g', '')}g`);
			const matches = text.match(scan);
			if (!matches || matches.length !== 1) {
				fail(
					`${relative}: expected exactly one occurrence of ${edit.why}, found ${matches ? matches.length : 0}. ` +
						'Upstream changed that line, and leaving it would fail the build again.'
				);
			}
			text = text.replace(edit.pattern, '');
			say(`removed ${edit.why} from ${relative}`);
		}
		// The applied edits must stay applied.
		for (const edit of fileEdits) {
			if (edit.pattern.test(text)) {
				fail(`${relative}: ${edit.why} is still present after the edit`);
			}
		}
		results.push({ file, text });
	}
	return results;
}

// ------------------------------------------------------------------ the folder

function removeExtensionDir(root) {
	const target = path.join(root, ...EXTENSION_DIR.split('/'));
	if (!fs.existsSync(target)) {
		say(`${EXTENSION_DIR} was already absent`);
		return;
	}
	fs.rmSync(target, { recursive: true, force: true });
	if (fs.existsSync(target)) {
		fail(`could not remove ${EXTENSION_DIR}`);
	}
	say(`removed ${EXTENSION_DIR}`);
}

// ------------------------------------------------------------------ re-runs

/**
 * Whether the tree is already in the state this script produces.
 *
 * Without this, a second run on the same source tree would fail on "expected one
 * occurrence, found none" - and the interesting question at that point is not
 * "was this line already deleted" but "can anything still reach the extension".
 * That is what is checked instead, so a re-run is a no-op and a half-applied
 * tree is still an error.
 */
function isAlreadyClean(root) {
	if (fs.existsSync(path.join(root, ...EXTENSION_DIR.split('/')))) {
		return false;
	}
	for (const edit of LINE_EDITS) {
		if (edit.pattern.test(read(path.join(root, edit.file)))) {
			return false;
		}
	}
	const scripts = JSON.parse(read(path.join(root, 'package.json'))).scripts ?? {};
	return !Object.values(scripts).some((value) => typeof value === 'string' && stillReachesExtension(value));
}

// ------------------------------------------------------------------ main

function main() {
	if (!sourceDir) {
		fail('usage: node scripts/remove-vendor-chat.mjs <vscode-source-dir>');
	}
	const root = path.resolve(sourceDir);
	if (!fs.existsSync(path.join(root, 'package.json'))) {
		fail(`no package.json under ${root}; that is not a VS Code source tree`);
	}
	if (isAlreadyClean(root)) {
		say('the vendor chat extension was already removed from this tree');
		return;
	}

	// Plan everything before writing anything: a failure halfway through would
	// leave sources that are neither the original nor the intended result.
	const planned = [editPackageJson(root), ...planLines(root, LINE_EDITS)];
	for (const file of planned) {
		fs.writeFileSync(file.file, file.text, 'utf8');
	}
	removeExtensionDir(root);

	if (!quiet) {
		console.log('  the vendor chat extension is gone, and nothing references it');
	}
}

main();