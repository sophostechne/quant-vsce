/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Keeps the fork's built-in copy of this extension in step with this repository.
 *
 * The workbench fork ships the extension built in, and this repository packages the same code
 * as an ordinary `.vsix`. Two copies of anything drift, and the failure is quiet: a command
 * added in one, a rendering fixed in the other, and the two disagree for weeks before anyone
 * opens both.
 *
 * This repository is the source of truth, because it is the copy that is linted, tested and
 * typechecked against the published API. The fork's copy is a build artefact of it.
 *
 * Only the shared surface is compared. Build configuration is *expected* to differ: the fork
 * compiles through gulp against its own vscode.d.ts, this repository bundles with esbuild
 * against `@types/vscode`, and forcing those together would defeat the point of the split. What
 * must not differ is the code, the stylesheets, the localized strings, and the manifest's
 * contributions - the last being the easiest to change in one place and forget in the other.
 *
 *   node scripts/sync-fork.mjs            report differences, exit non-zero if any
 *   node scripts/sync-fork.mjs --write    copy this repository's version into the fork
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const fork = process.env.QUANT_FORK
	?? path.join(root, '..', 'vscode', 'extensions', 'quant');
const write = process.argv.includes('--write');

if (!fs.existsSync(fork)) {
	console.warn(`skipped: no fork checkout at ${fork}`);
	console.warn('set QUANT_FORK to compare against one');
	process.exit(0);
}

/** Directories copied wholesale, minus paths that belong to only one side. */
const TREES = [
	{ dir: 'src', skip: ['test'] },
	// The fork's tsconfig extends its own base and points at its bundled API declarations.
	{ dir: 'preview-src', skip: ['dist', 'tsconfig.json'] }
];

/** Individual files that must match byte for byte. */
const FILES = [
	'media/chart/chart.css',
	'media/designer/designer.css',
	'package.nls.json'
];

/**
 * Manifest keys that describe the extension rather than how it is built.
 *
 * `contributes` is the one that matters: commands, menus, custom editors and settings all live
 * there, and adding one to a single copy produces an extension that behaves differently
 * depending on how it was installed.
 */
const MANIFEST_KEYS = ['contributes', 'activationEvents', 'categories', 'capabilities'];

function walk(dir, skip, base = dir) {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		if (skip.includes(entry.name)) {
			return [];
		}
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? walk(full, skip, base) : [full];
	});
}

const differences = [];

for (const { dir, skip } of TREES) {
	for (const source of walk(path.join(root, dir), skip)) {
		const relative = path.relative(root, source);
		const target = path.join(fork, relative);
		const ours = fs.readFileSync(source, 'utf8');
		const theirs = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

		if (ours !== theirs) {
			differences.push(relative);
			if (write) {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, ours);
			}
		}
	}
}

for (const relative of FILES) {
	const source = path.join(root, relative);
	const target = path.join(fork, relative);
	const ours = fs.readFileSync(source, 'utf8');
	const theirs = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

	if (ours !== theirs) {
		differences.push(relative);
		if (write) {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, ours);
		}
	}
}

const ours = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const forkManifestPath = path.join(fork, 'package.json');
const theirs = JSON.parse(fs.readFileSync(forkManifestPath, 'utf8'));

for (const key of MANIFEST_KEYS) {
	if (JSON.stringify(ours[key]) !== JSON.stringify(theirs[key])) {
		differences.push(`package.json: ${key}`);
		if (write) {
			theirs[key] = ours[key];
		}
	}
}
if (write) {
	// Rewritten key by key rather than replaced, so the fork keeps `main`, its proposed API
	// declarations and its own build scripts - the things that make it a built-in.
	fs.writeFileSync(forkManifestPath, JSON.stringify(theirs, undefined, '\t') + '\n');
}

if (!differences.length) {
	console.log('fork copy is in sync');
	process.exit(0);
}

if (write) {
	console.log(`updated ${differences.length} file(s) in the fork:`);
	for (const file of differences) {
		console.log(`  ${file}`);
	}
	console.log('\nRebuild the fork copy so the change reaches a running workbench:');
	console.log('  npx gulp compile-extension:quant && npm run build-webview');
	process.exit(0);
}

console.error(`the fork copy differs in ${differences.length} file(s):`);
for (const file of differences) {
	console.error(`  ${file}`);
}
console.error('\nCopy this repository over it with:');
console.error('  npm run sync:fork -- --write');
process.exit(1);
