/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds the extension host bundle and the two webview bundles.
 *
 * The host code is bundled rather than emitted as a tree of modules, because an extension
 * installed from a `.vsix` loads a single file and carries its own dependencies.
 *
 * `vscode` is external in every case. It is not a package: the extension host injects it at
 * runtime, and bundling it would produce a module resolution error at activation.
 */

import esbuild from 'esbuild';
import path from 'node:path';

const root = import.meta.dirname;
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** The extension host: CommonJS, Node platform, `vscode` provided by the runtime. */
const host = {
	entryPoints: [path.join(root, 'src', 'extension.ts')],
	outfile: path.join(root, 'out', 'extension.js'),
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	external: ['vscode'],
	minify: production,
	sourcemap: !production
};

/**
 * The webviews: ESM, browser platform, one bundle per view beside its own stylesheet.
 *
 * Keyed by output path so `media/chart/chart.js` lands next to `media/chart/chart.css`, which
 * is what the editors reference.
 */
const webviews = {
	entryPoints: {
		'chart/chart': path.join(root, 'preview-src', 'chart.ts'),
		'designer/designer': path.join(root, 'preview-src', 'designer.ts')
	},
	outdir: path.join(root, 'media'),
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2024',
	minify: production,
	sourcemap: false,
	logOverride: { 'import-is-undefined': 'error' }
};

if (watch) {
	const contexts = await Promise.all([esbuild.context(host), esbuild.context(webviews)]);
	await Promise.all(contexts.map(context => context.watch()));
	console.log('watching');
} else {
	await Promise.all([esbuild.build(host), esbuild.build(webviews)]);
	console.log('built');
}
