/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Executes a compiled visualizer under a deadline, and validates what comes back.
 *
 * Everything a visualizer returns is checked before it reaches the chart. It is ordinary for
 * user code to return the not-quite-right shape while it is being written, and the failure that
 * matters is the quiet one: a NaN or a string where a price belongs draws a chart that is wrong
 * rather than absent, which is the outcome this workbench spends most of its effort avoiding.
 */

import * as path from 'path';
import { Worker } from 'worker_threads';

/** One line of a visualizer's output, matching the webview's `IndicatorSeries`. */
export interface VisualizerSeries {
	readonly label: string;
	readonly color: string;
	readonly fill: boolean;
	readonly overlay: boolean;
	readonly lines: readonly (readonly (number | undefined)[])[];
}

export type RunResult =
	| { readonly kind: 'series'; readonly series: readonly VisualizerSeries[] }
	| { readonly kind: 'failed'; readonly message: string; readonly line?: number };

/**
 * How long a visualizer may run before it is killed.
 *
 * The measured cost of a real one over 300 bars is ~50ms including worker startup, so this is
 * two orders of margin. It exists for the loop that never ends rather than the script that is
 * merely slow.
 */
const TIMEOUT_MS = 2_000;

/** Caps a runaway allocation as well as a runaway loop. */
const MAX_HEAP_MB = 256;

/**
 * Recovers the user's line from a stack frame naming their own file.
 *
 * Possible because Node imports the `.mts` directly: there is no generated file in between, so
 * the line in the trace is the line they wrote. Node also reports syntax errors from type
 * stripping with the same shape.
 */
const USER_FRAME = /\.mts:(\d+):(\d+)/;

export class VisualizerRunner {

	constructor(private readonly _workerPath: string) { }

	async run(file: string, bars: readonly unknown[], context: unknown): Promise<RunResult> {
		const raw = await this._execute(file, bars, context);
		if (raw.kind === 'failed') {
			return raw;
		}
		return validate(raw.value);
	}

	private _execute(file: string, bars: readonly unknown[], context: unknown):
		Promise<{ kind: 'value'; value: unknown } | { kind: 'failed'; message: string; line?: number }> {

		return new Promise(resolve => {
			let worker: Worker;
			try {
				worker = new Worker(this._workerPath, {
					workerData: { file, bars, context },
					resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB },
				});
			} catch (error) {
				resolve({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
				return;
			}

			let settled = false;
			const finish = (result: { kind: 'value'; value: unknown } | { kind: 'failed'; message: string; line?: number }) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				void worker.terminate();
				resolve(result);
			};

			const timer = setTimeout(() => {
				finish({ kind: 'failed', message: `Visualizer did not finish within ${TIMEOUT_MS}ms and was stopped.` });
			}, TIMEOUT_MS);

			worker.on('message', (message: { ok: boolean; series?: unknown; message?: string; stack?: string }) => {
				if (message.ok) {
					finish({ kind: 'value', value: message.series });
					return;
				}
				const frame = message.stack ? USER_FRAME.exec(message.stack) : undefined;
				finish({
					kind: 'failed',
					message: message.message ?? 'Visualizer failed.',
					line: frame ? Number(frame[1]) : undefined,
				});
			});

			// Reached when the module itself fails to parse or its top level throws, which the
			// worker's own try/catch never sees.
			worker.on('error', error => finish({ kind: 'failed', message: error.message }));

			worker.on('exit', code => {
				// A non-zero exit with no message is the resource limit, which kills the isolate
				// outright rather than raising something catchable.
				finish({ kind: 'failed', message: `Visualizer stopped unexpectedly (exit ${code}); it may have exceeded ${MAX_HEAP_MB}MB.` });
			});
		});
	}
}

/** Where a visualizer's worker bundle sits inside the installed extension. */
export function workerPath(extensionPath: string): string {
	return path.join(extensionPath, 'out', 'visualizerWorker.mjs');
}

function validate(value: unknown): RunResult {
	const list = Array.isArray(value) ? value : [value];
	const series: VisualizerSeries[] = [];

	for (const [index, entry] of list.entries()) {
		if (typeof entry !== 'object' || entry === null) {
			return { kind: 'failed', message: `Series ${index} is not an object. Return { label, lines } or an array of them.` };
		}
		const candidate = entry as Partial<VisualizerSeries>;
		if (typeof candidate.label !== 'string' || !candidate.label) {
			return { kind: 'failed', message: `Series ${index} has no label.` };
		}
		if (!Array.isArray(candidate.lines) || candidate.lines.length === 0) {
			return { kind: 'failed', message: `Series "${candidate.label}" has no lines. Give it at least one array of values.` };
		}
		const lines: (number | undefined)[][] = [];
		for (const line of candidate.lines) {
			if (!Array.isArray(line)) {
				return { kind: 'failed', message: `Series "${candidate.label}" has a line that is not an array.` };
			}
			// Anything that is not a finite number becomes a gap. NaN and Infinity are what
			// arithmetic on a warm-up window produces, and drawing them would put a spike or a
			// break in the line that no data supports.
			lines.push(line.map(point => typeof point === 'number' && Number.isFinite(point) ? point : undefined));
		}
		series.push({
			label: candidate.label,
			color: typeof candidate.color === 'string' ? candidate.color : '',
			fill: candidate.fill === true,
			// Overlaying on the price pane is the common case and the one a user means when they
			// have not said; a study pane has to be asked for.
			overlay: candidate.overlay !== false,
			lines,
		});
	}
	return { kind: 'series', series };
}
