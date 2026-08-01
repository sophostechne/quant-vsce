/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../logger';

/**
 * Result summary emitted by the runner. Field names mirror the Python side; anything the
 * runner omits (a backtest that produced no positions has no win rate) stays undefined rather
 * than being defaulted to a number that reads as real.
 */
export interface BacktestResult {
	readonly product: string;
	readonly timeframe: string;
	readonly bars: number;
	readonly fills: number;
	readonly positions: number;
	readonly starting_balance: number;
	readonly realised_pnl?: number;
	readonly wins?: number;
	readonly losses?: number;
	readonly win_rate?: number;
	readonly best?: number;
	readonly worst?: number;
	readonly return_pct?: number;
}

export interface BacktestOptions {
	readonly strategyFile: vscode.Uri;
	readonly product: string;
	readonly timeframe: string;
	readonly bars: number;
	readonly params: Record<string, unknown>;
}

interface RunnerEvent {
	readonly event: 'start' | 'progress' | 'result' | 'error';
	readonly message?: string;
	readonly stage?: string;
	readonly [key: string]: unknown;
}

/**
 * Drives the Nautilus backtest runner as a child process, translating its NDJSON output into
 * progress reports and a typed result.
 *
 * Deliberately a subprocess rather than an embedded runtime: Nautilus is a Python/Rust engine
 * with its own lifecycle, and a backtest that hangs or crashes must not be able to take the
 * extension host with it.
 */
export class BacktestRunner {

	constructor(private readonly _log: Logger) { }

	/** Resolves the interpreter and project root, or explains what is missing. */
	private _resolvePaths(): { python: string; projectRoot: string } {
		const config = vscode.workspace.getConfiguration('quant');
		const configuredRoot = config.get<string>('nautilus.projectPath', '').trim();

		const projectRoot = configuredRoot
			|| vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
			|| '';
		if (!projectRoot) {
			throw new Error(vscode.l10n.t('Set "quant.nautilus.projectPath" to the strategies project directory.'));
		}

		const configuredPython = config.get<string>('nautilus.pythonPath', '').trim();
		const python = configuredPython || path.join(projectRoot, '.venv', 'bin', 'python');
		return { python, projectRoot };
	}

	async run(options: BacktestOptions, token: vscode.CancellationToken, progress: vscode.Progress<{ message?: string }>): Promise<BacktestResult> {
		const { python, projectRoot } = this._resolvePaths();
		const runner = path.join(projectRoot, 'backtests', 'run_json.py');

		const args = [
			runner,
			'--strategy-file', options.strategyFile.fsPath,
			'--product', options.product,
			'--timeframe', options.timeframe,
			'--bars', String(options.bars),
			'--params', JSON.stringify(options.params),
		];

		this._log.info(`Backtest: ${python} ${args.join(' ')}`);

		return new Promise<BacktestResult>((resolve, reject) => {
			const child = spawn(python, args, { cwd: projectRoot });
			let result: BacktestResult | undefined;
			let runnerError: string | undefined;
			let stdout = '';
			let stderrTail = '';

			const cancellation = token.onCancellationRequested(() => {
				child.kill('SIGTERM');
				reject(new vscode.CancellationError());
			});

			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString();
				// NDJSON: a chunk can split a line, so keep the trailing partial for next time.
				const lines = stdout.split('\n');
				stdout = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					let event: RunnerEvent;
					try {
						event = JSON.parse(line) as RunnerEvent;
					} catch {
						this._log.warn(`Unparsable runner output: ${line}`);
						continue;
					}
					switch (event.event) {
						case 'progress':
							if (event.message) {
								progress.report({ message: event.message });
								this._log.info(`Backtest: ${event.message}`);
							}
							break;
						case 'result':
							result = event as unknown as BacktestResult;
							break;
						case 'error':
							runnerError = event.message ?? 'Backtest failed.';
							break;
					}
				}
			});

			// Python logging and tracebacks come down stderr; keep the tail for diagnosis.
			child.stderr.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				stderrTail = (stderrTail + text).slice(-4000);
			});

			child.on('error', error => {
				cancellation.dispose();
				reject(new Error(vscode.l10n.t('Could not start the backtest runner ({0}): {1}', python, error.message)));
			});

			child.on('close', code => {
				cancellation.dispose();
				if (runnerError) {
					this._log.error(`Backtest failed: ${runnerError}`);
					if (stderrTail) {
						this._log.error(stderrTail);
					}
					reject(new Error(runnerError));
					return;
				}
				if (code !== 0) {
					if (stderrTail) {
						this._log.error(stderrTail);
					}
					reject(new Error(vscode.l10n.t('Backtest runner exited with code {0}. See the Quant log.', String(code))));
					return;
				}
				if (!result) {
					reject(new Error(vscode.l10n.t('Backtest produced no result.')));
					return;
				}
				resolve(result);
			});
		});
	}
}

/** Renders a result as a fixed-width block for the output channel. */
export function formatResult(strategy: string, result: BacktestResult): string {
	const rule = '-'.repeat(58);
	const lines = [
		rule,
		`  ${strategy}  ${result.product} ${result.timeframe}  (${result.bars} bars)`,
		rule,
		`  orders filled     ${result.fills}`,
		`  positions         ${result.positions}`,
	];

	if (result.realised_pnl !== undefined) {
		const pct = result.return_pct !== undefined ? ` (${(result.return_pct * 100).toFixed(2)}%)` : '';
		lines.push(`  realised PnL      ${result.realised_pnl.toFixed(2)} USD${pct}`);
	}
	if (result.win_rate !== undefined) {
		lines.push(`  win rate          ${result.wins}/${(result.wins ?? 0) + (result.losses ?? 0)} (${(result.win_rate * 100).toFixed(0)}%)`);
	}
	if (result.best !== undefined && result.worst !== undefined) {
		lines.push(`  best / worst      ${result.best.toFixed(2)} / ${result.worst.toFixed(2)}`);
	}

	lines.push(rule);
	// Restated on every run: these assumptions are what separate a backtest from a result.
	lines.push('  Fills at bar close, worst-tier taker fees, no slippage.');
	return lines.join('\n');
}
