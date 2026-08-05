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
