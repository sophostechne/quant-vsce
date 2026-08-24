/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activeChartDocument, CHART_VIEW_TYPE, ChartEditorProvider } from './chart/chartEditor';
import { defaultChartContent } from './chart/chartModel';
import { Logger } from './logger';
import { ConnectionState, MarketDataClient } from './marketData/client';
import { registerIndicatorCommands } from './chart/indicatorCommands';
import { BacktestRunner, formatResult } from './strategies/backtestRunner';
import { StrategiesProvider, StrategyNode } from './strategies/strategiesView';
import { STRATEGY_VIEW_TYPE, StrategyEditorProvider } from './strategy/strategyEditor';
import { defaultStrategyContent } from './strategy/strategyModel';
import { ForecastAudit, ForecastPayload, ForecastReport, StrategyRunner } from './strategy/strategyRunner';
import { SymbolNode, WatchlistProvider } from './watchlist/watchlistView';
import { VisualizerRegistry } from './visualizers/registry';
import { newVisualizer } from './visualizers/scaffold';

export function activate(context: vscode.ExtensionContext): void {
	const log = new Logger('Quant');
	context.subscriptions.push(log);

	const client = new MarketDataClient(log);
	context.subscriptions.push(client);

	const watchlist = new WatchlistProvider(context.workspaceState, client);
	context.subscriptions.push(watchlist);
	context.subscriptions.push(vscode.window.createTreeView('quant.watchlist', {
		treeDataProvider: watchlist,
		showCollapseAll: false
	}));

	const strategies = new StrategiesProvider();
	context.subscriptions.push(strategies);
	context.subscriptions.push(vscode.window.createTreeView('quant.strategies', {
		treeDataProvider: strategies,
		showCollapseAll: true
	}));

	const visualizers = new VisualizerRegistry(context.extensionPath, log);
	context.subscriptions.push(visualizers);
	context.subscriptions.push(ChartEditorProvider.register(context, client, visualizers, log));

	context.subscriptions.push(vscode.commands.registerCommand('quant.newVisualizer', () => {
		// The chart the user is looking at, so a new visualizer is attached to it rather than
		// created into the void. Undefined when no chart is open, which the scaffold reports
		// rather than picking one.
		return newVisualizer(context.extensionUri, activeChartDocument(), log);
	}));
	const engineRunner = new StrategyRunner(log);
	context.subscriptions.push(StrategyEditorProvider.register(context, engineRunner, log));
	context.subscriptions.push(registerIndicatorCommands(log));
	context.subscriptions.push(createStatusBarItem(client));

	context.subscriptions.push(
		vscode.commands.registerCommand('quant.connect', () => client.connect()),
		vscode.commands.registerCommand('quant.disconnect', () => client.disconnect()),
		vscode.commands.registerCommand('quant.showLog', () => log.show()),
		vscode.commands.registerCommand('quant.newStrategy', () => openNewStrategy()),
		vscode.commands.registerCommand('quant.runForecast', () => runForecast(engineRunner, log)),
		vscode.commands.registerCommand('quant.resolveForecasts', () => resolveForecasts(engineRunner, log)),
		vscode.commands.registerCommand('quant.showForecastReport', () => showForecastReport(engineRunner, log)),
		vscode.commands.registerCommand('quant.auditForecasts', () => auditForecasts(engineRunner, log)),

		vscode.commands.registerCommand('quant.addSymbol', async () => {
			const symbol = await vscode.window.showInputBox({
				title: vscode.l10n.t('Add Symbol'),
				prompt: vscode.l10n.t('Ticker to add to the watchlist'),
				placeHolder: 'AAPL',
				validateInput: value => /^[A-Za-z0-9.:_-]{1,24}$/.test(value.trim())
					? undefined
					: vscode.l10n.t('Enter a valid ticker.')
			});
			if (symbol) {
				await watchlist.add(symbol);
			}
		}),

		vscode.commands.registerCommand('quant.removeSymbol', async (node?: SymbolNode) => {
			if (node) {
				await watchlist.remove(node.symbol);
			}
		}),

		vscode.commands.registerCommand('quant.runBacktest', async (node?: StrategyNode) => {
			const strategyFile = node?.uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!strategyFile) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Open a strategy file, or run this from the Strategies view.'));
				return;
			}
			await runBacktest(new BacktestRunner(log), log, strategyFile);
		}),

		vscode.commands.registerCommand('quant.openChart', async (node?: SymbolNode) => {
			const symbol = node?.symbol ?? watchlist.symbols[0];
			if (!symbol) {
				return;
			}
			await openChart(symbol);
		})
	);

	if (vscode.workspace.getConfiguration('quant').get<boolean>('daemon.autoConnect', true)) {
		client.connect();
	}
}

async function runForecast(runner: StrategyRunner, log: Logger): Promise<void> {
	try {
		const forecast = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t('Generating market forecast…'), cancellable: true,
		}, (_progress, token) => runner.forecast(token));
		log.info('\n' + formatForecast(forecast));
		log.show();
		void vscode.window.showInformationMessage(vscode.l10n.t(
			'{0}: {1}% turning-point probability over {2} bars.', forecast.market,
			(forecast.turn_probability * 100).toFixed(1), String(forecast.horizon_bars)));
	} catch (error) {
		reportForecastError(log, vscode.l10n.t('Forecast failed'), error);
	}
}

async function resolveForecasts(runner: StrategyRunner, log: Logger): Promise<void> {
	try {
		const result = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t('Resolving forecast outcomes…'), cancellable: true,
		}, (_progress, token) => runner.resolveForecasts(token));
		log.info(`Forecast outcomes: ${result.resolved} resolved, ${result.pending} pending.`);
		void vscode.window.showInformationMessage(vscode.l10n.t(
			'{0} forecast outcomes resolved; {1} still pending.',
			String(result.resolved), String(result.pending)));
	} catch (error) {
		reportForecastError(log, vscode.l10n.t('Forecast resolution failed'), error);
	}
}

async function showForecastReport(runner: StrategyRunner, log: Logger): Promise<void> {
	try {
		const report = await runner.forecastReport();
		log.info('\n' + formatForecastReport(report));
		log.show();
	} catch (error) {
		reportForecastError(log, vscode.l10n.t('Forecast report failed'), error);
	}
}

async function auditForecasts(runner: StrategyRunner, log: Logger): Promise<void> {
	try {
		const audit = await runner.auditForecasts();
		log.info('\n' + formatForecastAudit(audit));
		log.show();
		if (!audit.ok) {
			void vscode.window.showWarningMessage(vscode.l10n.t(
				'Forecast registry audit found {0} errors.', String(audit.errors.length)));
		}
	} catch (error) {
		reportForecastError(log, vscode.l10n.t('Forecast audit failed'), error);
	}
}

function formatForecast(forecast: ForecastPayload): string {
	const lines = [
		`${forecast.market} · ${forecast.model_version} · ${forecast.timeframe}`,
		`Turn ${(forecast.turn_probability * 100).toFixed(1)}% · volatility ${(forecast.volatility_probability * 100).toFixed(1)}%`,
		`Direction: up ${(forecast.direction_probability.up * 100).toFixed(1)}% · flat ${(forecast.direction_probability.flat * 100).toFixed(1)}% · down ${(forecast.direction_probability.down * 100).toFixed(1)}%`,
		`Reversals: bullish ${formatLevel(forecast.bullish_reversal)} · bearish ${formatLevel(forecast.bearish_reversal)}`,
		...forecast.explanation.map(statement => `  ${statement}`),
		`Registry: ${forecast.recorded ? forecast.registry : 'not recorded'}`,
	];
	return lines.join('\n');
}

function formatForecastReport(report: ForecastReport): string {
	const lines = ['Forecast performance by immutable model version'];
	for (const [version, model] of Object.entries(report.models)) {
		lines.push(
			`${version} (${model.forecasts} resolved)`,
			`  Brier: turn ${model.turn_brier.toFixed(4)} · direction ${model.direction_brier.toFixed(4)} · volatility ${model.volatility_brier.toFixed(4)}`,
			`  Direction log loss ${model.direction_log_loss.toFixed(4)} · mean return ${(model.mean_realised_return * 100).toFixed(2)}%`,
			`  Turn precision ${(model.turn_precision * 100).toFixed(1)}% · recall ${(model.turn_recall * 100).toFixed(1)}%`,
			`  Directional return ${(model.directional_net_return * 100).toFixed(2)}% · max drawdown ${(model.directional_max_drawdown * 100).toFixed(2)}%`,
		);
	}
	if (Object.keys(report.models).length === 0) {
		lines.push('No resolved forecasts yet.');
	}
	lines.push(formatForecastAudit(report.audit));
	return lines.join('\n');
}

function formatForecastAudit(audit: ForecastAudit): string {
	return [
		`Registry audit: ${audit.ok ? 'clean' : 'failed'}`,
		`  ${audit.forecasts} forecasts · ${audit.outcomes} outcomes · ${audit.unresolved} unresolved`,
		...audit.errors.map(error => `  ERROR: ${error}`),
	].join('\n');
}

function formatLevel(value: number | null): string {
	return value === null ? 'n/a' : value.toFixed(4);
}

function reportForecastError(log: Logger, title: string, error: unknown): void {
	if (error instanceof vscode.CancellationError) {
		log.info(`${title}: cancelled.`);
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	log.error(`${title}: ${message}`);
	void vscode.window.showErrorMessage(`${title}: ${message}`);
}

export function deactivate(): void {
	// Disposal is handled through `context.subscriptions`.
}

/**
 * Runs one backtest, reporting progress in a cancellable notification and the outcome in the
 * log. The numbers land in the output channel rather than a toast because a backtest result is
 * something to read and compare, not to acknowledge and dismiss.
 */
async function runBacktest(runner: BacktestRunner, log: Logger, strategyFile: vscode.Uri): Promise<void> {
	const config = vscode.workspace.getConfiguration('quant');
	const name = strategyFile.path.split('/').pop() ?? 'strategy';

	try {
		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Backtesting {0}', name),
				cancellable: true,
			},
			(progress, token) => runner.run({
				strategyFile,
				product: config.get<string>('backtest.product', 'BTC-USD'),
				timeframe: config.get<string>('backtest.timeframe', '1h'),
				bars: config.get<number>('backtest.bars', 1200),
				params: config.get<Record<string, unknown>>('backtest.params', {}),
			}, token, progress),
		);

		log.info('\n' + formatResult(name, result));
		log.show();

		const pnl = result.realised_pnl;
		void vscode.window.showInformationMessage(
			pnl === undefined
				? vscode.l10n.t('{0}: no positions taken over {1} bars.', name, String(result.bars))
				: vscode.l10n.t('{0}: {1} USD over {2} positions.', name, pnl.toFixed(2), String(result.positions)),
		);
	} catch (error) {
		if (error instanceof vscode.CancellationError) {
			log.info('Backtest cancelled.');
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		log.error(`Backtest failed: ${message}`);
		void vscode.window.showErrorMessage(vscode.l10n.t('Backtest failed: {0}', message));
	}
}

/**
 * Charts and strategies belong to the user, not to whatever project happens to be open: the same
 * BABA layout is the one they want from any window. `~/.quant` is that home, so a chart survives
 * closing the workspace it was drawn in and never lands in someone else's repository.
 */
function quantHome(): vscode.Uri {
	return vscode.Uri.file(path.join(os.homedir(), '.quant'));
}

/**
 * Charts are untitled `.chart` documents unless the user saves them. Saving a chart into
 * `~/.quant` is what turns a layout into something that comes back next time.
 */
async function openChart(symbol: string): Promise<void> {
	const home = quantHome();
	const fileName = `${symbol}.chart`;

	// A saved layout for this symbol is one the user built and kept, so open that rather than
	// shadowing it with a fresh untitled chart claiming the same name.
	const saved = vscode.Uri.joinPath(home, fileName);
	if (await exists(saved)) {
		await vscode.commands.executeCommand('vscode.openWith', saved, CHART_VIEW_TYPE);
		return;
	}

	const document = await openUntitled(home, fileName, () => defaultChartContent(symbol));
	await vscode.commands.executeCommand('vscode.openWith', document.uri, CHART_VIEW_TYPE);
}

/**
 * Opens an untitled `.strategy` file in the designer.
 *
 * Untitled rather than written to disk, so a strategy the user abandons leaves nothing behind
 * and the save prompt is the ordinary one for a new file.
 */
async function openNewStrategy(): Promise<void> {
	const home = quantHome();
	// New means new. A `~/.quant` already holding strategy.strategy gets strategy-2.strategy, so
	// the command keeps working instead of failing on a name the user cannot see or choose.
	const fileName = await unusedName(home, 'strategy', '.strategy');

	const document = await openUntitled(home, fileName, defaultStrategyContent);
	await vscode.commands.executeCommand('vscode.openWith', document.uri, STRATEGY_VIEW_TYPE);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/** The first name in the `base.ext`, `base-2.ext`, … series that no file in `folder` holds. */
async function unusedName(folder: vscode.Uri, base: string, extension: string): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? `${base}${extension}` : `${base}-${n}${extension}`;
		if (!await exists(vscode.Uri.joinPath(folder, candidate))) {
			return candidate;
		}
	}
}

/**
 * Opens an untitled document called `fileName` inside `folder`, seeded with `content` if it is
 * not already open.
 *
 * The path on an `untitled:` URI is the path Save writes to, and it writes there directly rather
 * than asking. A bare file name is a *relative* path, which resolves against the filesystem
 * root - so saving an untitled chart attempted `/BABA.chart` and failed on permissions, naming a
 * location the user had never chosen.
 *
 * The folder is created up front rather than left to Save: an untitled document promising to
 * write to a directory that does not exist yet is a failure deferred to the moment the user
 * finally wants to keep their work.
 */
async function openUntitled(folder: vscode.Uri, fileName: string, content: () => string): Promise<vscode.TextDocument> {
	await vscode.workspace.fs.createDirectory(folder);

	const uri = vscode.Uri.joinPath(folder, fileName).with({ scheme: 'untitled' });
	const document = await vscode.workspace.openTextDocument(uri);
	if (document.getText().trim().length === 0) {
		const edit = new vscode.WorkspaceEdit();
		edit.insert(uri, new vscode.Position(0, 0), content());
		await vscode.workspace.applyEdit(edit);
	}
	return document;
}

function createStatusBarItem(client: MarketDataClient): vscode.Disposable {
	const item = vscode.window.createStatusBarItem('quant.connection', vscode.StatusBarAlignment.Right, 100);
	item.name = vscode.l10n.t('Quant Connection');
	item.command = 'quant.showLog';

	const render = (state: ConnectionState) => {
		switch (state) {
			case ConnectionState.Connected:
				item.text = `$(pulse) ${vscode.l10n.t('Market Data')}`;
				item.tooltip = vscode.l10n.t('Connected to the market data daemon.');
				item.backgroundColor = undefined;
				break;
			case ConnectionState.Connecting:
				item.text = `$(sync~spin) ${vscode.l10n.t('Market Data')}`;
				item.tooltip = vscode.l10n.t('Connecting to the market data daemon…');
				item.backgroundColor = undefined;
				break;
			case ConnectionState.Simulated:
				item.text = `$(beaker) ${vscode.l10n.t('Simulated')}`;
				item.tooltip = vscode.l10n.t('No daemon reachable. Prices are synthetic and must not be traded on.');
				item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				break;
			case ConnectionState.Disconnected:
				item.text = `$(debug-disconnect) ${vscode.l10n.t('Offline')}`;
				item.tooltip = vscode.l10n.t('Not connected to market data.');
				item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
				break;
		}
	};

	render(client.state);
	item.show();

	const listener = client.onDidChangeState(render);
	return vscode.Disposable.from(item, listener);
}
