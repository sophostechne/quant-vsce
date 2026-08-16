/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs one visualizer and exits.
 *
 * A worker rather than the extension host because a visualizer is code the extension did not
 * write, and the host is single threaded and shared with every other extension in the window. A
 * `while (true)` here costs one terminated worker; in the host it would wedge the editor. It is
 * not the webview either - the chart's CSP has no `unsafe-eval`, and widening it to run user
 * code would be a poor trade for a page that also renders fetched data.
 *
 * The TypeScript is not transformed. Node strips types itself from `.mts` since 22.18, so the
 * user's file is imported straight off disk: no compiler ships with this extension, and a stack
 * frame names their actual file and line rather than a generated one. `.mts` rather than `.ts`
 * because it is unambiguously a module - a `.ts` in a workspace whose package.json says
 * commonjs, or says nothing, is parsed as CommonJS and its `export default` is a syntax error.
 *
 * The cost is Node's strip-only rule: `enum`, `namespace` and parameter properties are rejected,
 * because erasing them would change what the code does rather than only what it declares. Every
 * other TypeScript feature erases cleanly and works here.
 *
 * One worker per run, thrown away afterwards. Pooling would save the ~35ms of startup at the
 * cost of leaking state between runs, and it is also what makes an edited file reload - Node
 * caches modules per worker, so a fresh worker is a fresh read.
 */

import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

interface Request {
	readonly file: string;
	readonly bars: readonly unknown[];
	readonly context: unknown;
}

const { file, bars, context } = workerData as Request;

try {
	const module = await import(pathToFileURL(file).href) as { default?: unknown };

	if (typeof module.default !== 'function') {
		throw new Error('A visualizer must `export default` a function.');
	}
	const produced: unknown = await (module.default as (bars: unknown, context: unknown) => unknown)(bars, context);
	parentPort?.postMessage({ ok: true, series: produced });
} catch (error) {
	// Serialised rather than thrown: an uncaught rejection reaches the host as a bare worker
	// error with the stack already flattened, and the frame naming the user's line is the only
	// part worth reporting. Syntax errors arrive here too, since Node's type stripping happens
	// during this import.
	parentPort?.postMessage({
		ok: false,
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
	});
}
