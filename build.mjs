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
 * The visualizer worker: ESM, because it loads user code with a dynamic `import()` of a data
 * URL and top-level `await`. Emitted as `.mjs` so Node treats it as a module regardless of the
 * package type, which a `.js` beside a CommonJS package.json would not.
 *
 * Bundled separately rather than folded into the host: it is spawned by path, and sucrase - the
 * only reason this extension has a runtime dependency at all - belongs here rather than in the
 * bundle that loads on activation.
 */
const visualizerWorker = {
	entryPoints: [path.join(root, 'src', 'visualizers', 'worker.mts')],
	outfile: path.join(root, 'out', 'visualizerWorker.mjs'),
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
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
	const contexts = await Promise.all([esbuild.context(host), esbuild.context(visualizerWorker), esbuild.context(webviews)]);
	await Promise.all(contexts.map(context => context.watch()));
	console.log('watching');
} else {
	await Promise.all([esbuild.build(host), esbuild.build(visualizerWorker), esbuild.build(webviews)]);
	console.log('built');
}
