/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CHART_VIEW_TYPE, ChartEditorProvider } from './chart/chartEditor';
import { defaultChartContent } from './chart/chartModel';
import { Logger } from './logger';
import { ConnectionState, MarketDataClient } from './marketData/client';
import { registerIndicatorCommands } from './chart/indicatorCommands';
import { BacktestRunner, formatResult } from './strategies/backtestRunner';
import { StrategiesProvider, StrategyNode } from './strategies/strategiesView';
import { STRATEGY_VIEW_TYPE, StrategyEditorProvider } from './strategy/strategyEditor';
import { defaultStrategyContent } from './strategy/strategyModel';
import { StrategyRunner } from './strategy/strategyRunner';
import { SymbolNode, WatchlistProvider } from './watchlist/watchlistView';

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

	context.subscriptions.push(ChartEditorProvider.register(context, client, log));
	context.subscriptions.push(StrategyEditorProvider.register(context, new StrategyRunner(log), log));
	context.subscriptions.push(registerIndicatorCommands(log));
	context.subscriptions.push(createStatusBarItem(client));

	context.subscriptions.push(
		vscode.commands.registerCommand('quant.connect', () => client.connect()),
		vscode.commands.registerCommand('quant.disconnect', () => client.disconnect()),
		vscode.commands.registerCommand('quant.showLog', () => log.show()),
		vscode.commands.registerCommand('quant.newStrategy', () => openNewStrategy()),

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
