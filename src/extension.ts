/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CHART_VIEW_TYPE, ChartEditorProvider, defaultChartContent } from './chart/chartEditor';
import { Logger } from './logger';
import { ConnectionState, MarketDataClient } from './marketData/client';
import { StrategiesProvider } from './strategies/strategiesView';
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
	context.subscriptions.push(createStatusBarItem(client));

	context.subscriptions.push(
		vscode.commands.registerCommand('quant.connect', () => client.connect()),
		vscode.commands.registerCommand('quant.disconnect', () => client.disconnect()),
		vscode.commands.registerCommand('quant.showLog', () => log.show()),

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
 * Charts are untitled `.chart` documents unless the user saves them. Saving a chart into the
 * workspace is what turns a layout into a versioned artifact.
 */
async function openChart(symbol: string): Promise<void> {
	const uri = vscode.Uri.parse(`untitled:${symbol}.chart`);
	const document = await vscode.workspace.openTextDocument(uri);
	if (document.getText().trim().length === 0) {
		const edit = new vscode.WorkspaceEdit();
		edit.insert(uri, new vscode.Position(0, 0), defaultChartContent(symbol));
		await vscode.workspace.applyEdit(edit);
	}
	await vscode.commands.executeCommand('vscode.openWith', uri, CHART_VIEW_TYPE);
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
