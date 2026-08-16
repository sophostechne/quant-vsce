/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Finds, compiles and runs the visualizers a chart asks for.
 *
 * Visualizer files live in the user's workspace rather than in extension storage, so they get
 * version control, diffs, review and sharing for nothing - the same reason `.chart` documents
 * are real files. A chart names the ones it wants, so opening someone else's chart tells you
 * what it needs rather than silently drawing less.
 *
 * Errors go to the Problems panel. A visualizer is code being written, so its failures belong
 * where the user already looks for compile errors, at the line that caused them - not in a
 * notification that disappears.
 *
 * Nothing is compiled here. Node strips the types when the worker imports the file, so there is
 * no build step to cache, no generated output to map back, and no compiler in the extension.
 */

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { RunResult, VisualizerMarker, VisualizerOutput, VisualizerRunner, VisualizerSeries, workerPath } from './runner';

/**
 * `.mts` rather than `.ts`: Node only treats a file as a module unambiguously with that
 * extension, and a `.ts` in a workspace that says commonjs - or says nothing - is parsed as
 * CommonJS, making `export default` a syntax error the user did not write.
 */
export const VISUALIZER_GLOB = '**/*.visualizer.mts';

/** Colours handed to a visualizer that does not choose its own. Matches the chart's own set. */
const PALETTE = ['charts.blue', 'charts.yellow', 'charts.purple', 'charts.orange'];

export interface VisualizerContext {
	readonly symbol: string;
	readonly timeframe: string;
	readonly palette: readonly string[];
}

export class VisualizerRegistry implements vscode.Disposable {

	private readonly _diagnostics = vscode.languages.createDiagnosticCollection('quant.visualizers');
	private readonly _runner: VisualizerRunner;
	private readonly _disposables: vscode.Disposable[] = [];

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	/** A visualizer file was created, edited or deleted; charts using one should redraw. */
	readonly onDidChange = this._onDidChange.event;

	constructor(extensionPath: string, private readonly _log: Logger) {
		this._runner = new VisualizerRunner(workerPath(extensionPath));

		const watcher = vscode.workspace.createFileSystemWatcher(VISUALIZER_GLOB);
		this._disposables.push(
			watcher,
			watcher.onDidChange(() => this._onDidChange.fire()),
			watcher.onDidCreate(() => this._onDidChange.fire()),
			watcher.onDidDelete(uri => {
				this._diagnostics.delete(uri);
				this._onDidChange.fire();
			}),
		);
	}

	/**
	 * Runs every visualizer a chart names, in order, and returns what they drew.
	 *
	 * One failing visualizer does not stop the others: they are independent, and a chart with
	 * three of them should lose only the broken one. The failure is reported at its own line.
	 */
	async run(paths: readonly string[], bars: readonly unknown[], context: VisualizerContext): Promise<VisualizerOutput> {
		const series: VisualizerSeries[] = [];
		const markers: VisualizerMarker[] = [];
		// Later visualizers paint over earlier ones bar by bar, rather than the whole tint being
		// replaced: two of them can then colour different stretches of the same chart.
		const background: (string | undefined)[] = [];

		for (const relative of paths) {
			const uri = this._resolve(relative);
			if (!uri) {
				continue;
			}
			const result = await this._runOne(uri, bars, context);
			if (result.kind !== 'output') {
				continue;
			}
			series.push(...result.output.series);
			markers.push(...result.output.markers);
			result.output.background.forEach((color, index) => {
				if (color) {
					background[index] = color;
				}
			});
		}
		return { series, markers, background };
	}

	/**
	 * The file is read from disk by the worker, so a chart redraws on save rather than on every
	 * keystroke. That is the trade for having no build step: the alternative is writing the
	 * editor's unsaved buffer to a temporary file per keypress, which buys a slightly tighter
	 * loop and costs a stack trace that names a path the user has never seen.
	 */
	private async _runOne(uri: vscode.Uri, bars: readonly unknown[], context: VisualizerContext): Promise<RunResult> {
		const result = await this._runner.run(uri.fsPath, bars, context);
		if (result.kind === 'failed') {
			this._report(uri, result.message, (result.line ?? 1) - 1);
			this._log.warn(`Visualizer ${uri.fsPath} failed: ${result.message}`);
		} else {
			this._diagnostics.delete(uri);
		}
		return result;
	}

	/** Workspace-relative, so a chart shared between machines still finds its visualizers. */
	private _resolve(relative: string): vscode.Uri | undefined {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return undefined;
		}
		return vscode.Uri.joinPath(folders[0]!.uri, relative);
	}

	private _report(uri: vscode.Uri, message: string, line: number, column = 0): void {
		const at = new vscode.Position(Math.max(0, line), Math.max(0, column));
		const diagnostic = new vscode.Diagnostic(
			new vscode.Range(at, at),
			message,
			vscode.DiagnosticSeverity.Error
		);
		diagnostic.source = 'quant';
		this._diagnostics.set(uri, [diagnostic]);
	}

	static context(symbol: string, timeframe: string): VisualizerContext {
		return { symbol, timeframe, palette: PALETTE };
	}

	dispose(): void {
		this._diagnostics.dispose();
		this._onDidChange.dispose();
		for (const disposable of this._disposables) {
			disposable.dispose();
		}
	}
}
