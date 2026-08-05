/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../logger';

/** Scalar summary of a backtest. Mirrors the Python `Result`. */
export interface EvaluationResult {
	readonly trades: number;
	readonly net_return: number;
	readonly max_drawdown: number;
	readonly profit_factor: number;
	readonly win_rate: number;
	readonly stability: number;
	readonly time_in_drawdown: number;
}

/** Where the observed outcome sits in the distribution of outcomes it could have had. */
export interface MonteCarlo {
	readonly trials: number;
	readonly return_p05: number;
	readonly return_p50: number;
	readonly return_p95: number;
	readonly drawdown_p50: number;
	readonly drawdown_p95: number;
	readonly drawdown_worst: number;
	readonly profitable_share: number;
	readonly observed_drawdown_percentile: number;
}

/** What random strategies achieved on the same bars, which is the only real baseline. */
export interface NoiseFloor {
	readonly trials: number;
	readonly beats: number;
	readonly verdict: string;
	readonly p50: number;
	readonly profitable_share: number;
}

export interface Evaluation {
	readonly product: string;
	readonly timeframe: string;
	readonly bars: number;
	readonly from: string;
	readonly to: string;
	readonly buy_hold: number;
	readonly render: string;
	readonly result: EvaluationResult;
	readonly meets_criteria: boolean;
	readonly reason: string;
	readonly monte_carlo: MonteCarlo | null;
	readonly noise_floor: NoiseFloor | null;
}

interface Response {
	readonly ok: boolean;
	readonly error?: string;
}

/** Progress from a search, one per generation. */
export interface Generation {
	readonly type: 'generation';
	readonly index: number;
	readonly viable: number;
	readonly fitness: number;
	readonly net_return: number;
	readonly trades: number;
}

export interface SearchStart {
	readonly type: 'start';
	readonly product: string;
	readonly timeframe: string;
	readonly train_bars: number;
	readonly test_bars: number;
	readonly train_buy_hold: number;
	readonly test_buy_hold: number;
	readonly generations: number;
}

/**
 * A strategy the search kept, scored twice.
 *
 * `test` comes from bars the search never saw. It is the only one of the two that carries
 * information about whether the strategy works, and the gap between them is the whole story.
 */
export interface Survivor {
	readonly strategy: unknown;
	readonly render: string;
	readonly train: EvaluationResult;
	readonly test: EvaluationResult | null;
}

export interface SearchDone {
	readonly type: 'done';
	readonly survivors: Survivor[];
}

export type SearchEvent = SearchStart | Generation | SearchDone | { type: 'error'; error: string };

export interface WalkStart {
	readonly type: 'start';
	readonly windows: number;
	readonly train_bars: number;
	readonly test_bars: number;
}

/** One train/test pair: a search was run on the first, and its winner applied to the second. */
export interface WalkWindow {
	readonly type: 'window';
	readonly index: number;
	readonly from: string;
	readonly to: string;
	readonly render: string;
	readonly train: EvaluationResult;
	readonly test: EvaluationResult;
}

export interface WalkDone {
	readonly type: 'done';
	/** Out-of-sample return per bar over in-sample. At or below zero, nothing transferred. */
	readonly efficiency: number;
	readonly stitched_return: number;
	readonly stitched_drawdown: number;
	readonly windows: number;
	readonly windows_held_up: number;
}

export type WalkEvent = WalkStart | WalkWindow | WalkDone | { type: 'error'; error: string };

export interface WalkOptions {
	readonly trainBars: number;
	readonly testBars: number;
	readonly population: number;
	readonly generations: number;
	readonly regimes: boolean;
}

export interface EvolveOptions {
	readonly population: number;
	readonly generations: number;
	readonly survivors: number;
	readonly regimes: boolean;
}

/**
 * Runs the evolutionary engine's evaluator over a strategy document.
 *
 * A subprocess rather than a reimplementation. The backtest, the resampling and the noise floor
 * are the parts of this system most easily made to lie, and having a second copy of them in
 * TypeScript would mean the number the designer shows and the number the search selects on
 * could differ - with no way to tell which was wrong.
 */
export class StrategyRunner {

	constructor(private readonly _log: Logger) { }

	/**
	 * Evaluates the strategy in `document`.
	 *
	 * The document is written to a temporary file rather than passed by path, so an unsaved or
	 * untitled strategy evaluates exactly as it appears on screen. Requiring a save first would
	 * make the fastest loop in the designer - adjust a threshold, re-run - the slowest.
	 */
	async evaluate(document: vscode.TextDocument, storage: vscode.Uri, token?: vscode.CancellationToken): Promise<Evaluation> {
		const { python, projectRoot } = this._resolvePaths();
		const config = vscode.workspace.getConfiguration('quant');

		await vscode.workspace.fs.createDirectory(storage);
		const scratch = vscode.Uri.joinPath(storage, 'evaluating.strategy');
		await vscode.workspace.fs.writeFile(scratch, Buffer.from(document.getText(), 'utf8'));

		const args = [
			'-m', 'quant.cli', 'evaluate',
			'--strategy', scratch.fsPath,
			'--product', config.get<string>('backtest.product', 'BTC-USD'),
			'--timeframe', config.get<string>('backtest.timeframe', '6h'),
			'--bars', String(config.get<number>('backtest.bars', 2000))
		];

		this._log.info(`Evaluating strategy: ${python} ${args.join(' ')}`);
		const payload = await this._run(python, args, projectRoot, token);

		if (!payload.ok) {
			throw new Error(payload.error ?? vscode.l10n.t('The engine reported no result.'));
		}
		return payload as unknown as Evaluation;
	}

	/**
	 * Runs the evolutionary search, reporting each generation as it completes.
	 *
	 * Streamed rather than awaited whole because a search runs for minutes. A progress bar that
	 * only knows "started" and "finished" gives the user no basis for deciding whether to wait,
	 * and no way to see that the population stopped improving ten generations ago.
	 */
	async evolve(options: EvolveOptions, onEvent: (event: SearchEvent) => void,
		token?: vscode.CancellationToken): Promise<void> {
		const { python, projectRoot } = this._resolvePaths();
		const config = vscode.workspace.getConfiguration('quant');

		const args = [
			'-m', 'quant.cli', 'evolve',
			'--product', config.get<string>('backtest.product', 'BTC-USD'),
			'--timeframe', config.get<string>('backtest.timeframe', '6h'),
			'--bars', String(config.get<number>('backtest.bars', 2000)),
			'--population', String(options.population),
			'--generations', String(options.generations),
			'--survivors', String(options.survivors)
		];
		if (options.regimes) {
			args.push('--regimes');
		}

		this._log.info(`Searching for strategies: ${python} ${args.join(' ')}`);
		await this._stream(python, args, projectRoot, onEvent, token);
	}

	/**
	 * Walks the search forward across the series, reporting each window as it completes.
	 *
	 * This tests the method rather than a strategy: the whole search re-runs in every training
	 * window and its winner is applied, untouched, to the window after. It is much slower than
	 * a single search, which is exactly why the windows stream - the first two or three usually
	 * settle the question.
	 */
	async walkForward(options: WalkOptions, onEvent: (event: WalkEvent) => void,
		token?: vscode.CancellationToken): Promise<void> {
		const { python, projectRoot } = this._resolvePaths();
		const config = vscode.workspace.getConfiguration('quant');

		const args = [
			'-m', 'quant.cli', 'walkforward',
			'--product', config.get<string>('backtest.product', 'BTC-USD'),
			'--timeframe', config.get<string>('backtest.timeframe', '6h'),
			'--bars', String(config.get<number>('backtest.bars', 2000)),
			'--train-bars', String(options.trainBars),
			'--test-bars', String(options.testBars),
			'--population', String(options.population),
			'--generations', String(options.generations)
		];
		if (options.regimes) {
			args.push('--regimes');
		}

		this._log.info(`Walking forward: ${python} ${args.join(' ')}`);
		await this._stream(python, args, projectRoot, onEvent as (event: SearchEvent) => void, token);
	}

	/** Spawns `python` and delivers each complete NDJSON line to `onEvent`. */
	private _stream(python: string, args: string[], cwd: string,
		onEvent: (event: SearchEvent) => void, token?: vscode.CancellationToken): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(python, args, {
				cwd,
				env: { ...process.env, PYTHONPATH: path.join(cwd, 'python') }
			});

			// Chunks arrive on no particular boundary, so the tail is held back until its
			// newline turns up rather than being parsed as a truncated object.
			let pending = '';
			let stderr = '';

			child.stdout.on('data', chunk => {
				pending += String(chunk);
				const lines = pending.split('\n');
				pending = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					try {
						onEvent(JSON.parse(line) as SearchEvent);
					} catch {
						this._log.warn(`Unparseable line from the engine: ${line}`);
					}
				}
			});
			child.stderr.on('data', chunk => { stderr += String(chunk); });

			const cancellation = token?.onCancellationRequested(() => child.kill());

			child.on('error', error => {
				cancellation?.dispose();
				reject(new Error(vscode.l10n.t('Could not start the engine: {0}', String(error))));
			});

			child.on('close', code => {
				cancellation?.dispose();
				if (stderr.trim()) {
					this._log.warn(stderr.trim());
				}
				if (code !== 0 && !token?.isCancellationRequested) {
					reject(new Error(stderr.trim() || vscode.l10n.t('The search failed.')));
					return;
				}
				resolve();
			});
		});
	}

	private _run(python: string, args: string[], cwd: string, token?: vscode.CancellationToken): Promise<Response> {
		return new Promise((resolve, reject) => {
			// PYTHONPATH rather than an install step, so the extension works against a checkout
			// without the package having been installed into the interpreter.
			const child = spawn(python, args, {
				cwd,
				env: { ...process.env, PYTHONPATH: path.join(cwd, 'python') }
			});

			let stdout = '';
			let stderr = '';
			child.stdout.on('data', chunk => { stdout += String(chunk); });
			child.stderr.on('data', chunk => { stderr += String(chunk); });

			const cancellation = token?.onCancellationRequested(() => child.kill());

			child.on('error', error => {
				cancellation?.dispose();
				reject(new Error(vscode.l10n.t('Could not start the engine: {0}', String(error))));
			});

			child.on('close', () => {
				cancellation?.dispose();
				if (stderr.trim()) {
					this._log.warn(stderr.trim());
				}
				try {
					// Parsed regardless of exit code: a failure is reported as JSON too, and its
					// message is far more useful than "exited with 1".
					resolve(JSON.parse(stdout.trim()) as Response);
				} catch {
					reject(new Error(stderr.trim() || vscode.l10n.t('The engine produced no output.')));
				}
			});
		});
	}

	/** Resolves the interpreter and engine checkout, or explains precisely what is missing. */
	private _resolvePaths(): { python: string; projectRoot: string } {
		const config = vscode.workspace.getConfiguration('quant');
		const configured = config.get<string>('engine.projectPath', '').trim();
		const projectRoot = configured || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

		if (!projectRoot) {
			throw new Error(vscode.l10n.t('Set "quant.engine.projectPath" to the quant engine directory.'));
		}

		const configuredPython = config.get<string>('engine.pythonPath', '').trim();
		const python = configuredPython || path.join(projectRoot, '.venv', 'bin', 'python');
		return { python, projectRoot };
	}
}
