/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConnectionState, MarketDataClient } from '../marketData/client';

const STORAGE_KEY = 'quant.watchlist.symbols';
const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'SPY'];

export class SymbolNode {
	constructor(readonly symbol: string) { }
}

/**
 * The watchlist is a `TreeView`, which is DOM backed. Ticks arrive far faster than a tree can
 * repaint, so quote updates are coalesced onto a timer rather than fired per tick.
 */
export class WatchlistProvider implements vscode.TreeDataProvider<SymbolNode>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SymbolNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly _disposables: vscode.Disposable[] = [];
	private _symbols: string[];
	private _refreshTimer: NodeJS.Timeout | undefined;
	private _dirty = false;

	constructor(
		private readonly _storage: vscode.Memento,
		private readonly _client: MarketDataClient
	) {
		this._symbols = this._storage.get<string[]>(STORAGE_KEY) ?? [...DEFAULT_SYMBOLS];

		this._disposables.push(this._client.onDidChangeQuote(() => { this._dirty = true; }));
		this._disposables.push(this._client.onDidChangeState(() => this._onDidChangeTreeData.fire(undefined)));

		this._startRefreshLoop();
		this._disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('quant.watchlist.refreshIntervalMs')) {
				this._startRefreshLoop();
			}
		}));

		this._client.subscribe(this._symbols);
	}

	get symbols(): readonly string[] {
		return this._symbols;
	}

	getTreeItem(element: SymbolNode): vscode.TreeItem {
		const item = new vscode.TreeItem(element.symbol, vscode.TreeItemCollapsibleState.None);
		item.contextValue = 'quant.symbol';
		item.command = {
			command: 'quant.openChart',
			title: vscode.l10n.t('Open Chart'),
			arguments: [element]
		};

		const quote = this._client.quotes.get(element.symbol);
		if (!quote) {
			item.description = this._client.state === ConnectionState.Connecting
				? vscode.l10n.t('connecting…')
				: vscode.l10n.t('no data');
			item.iconPath = new vscode.ThemeIcon('circle-outline');
			return item;
		}

		const sign = quote.change >= 0 ? '+' : '';
		item.description = `${quote.last.toFixed(2)}  ${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`;
		item.iconPath = new vscode.ThemeIcon(
			quote.change >= 0 ? 'arrow-up' : 'arrow-down',
			new vscode.ThemeColor(quote.change >= 0 ? 'charts.green' : 'charts.red')
		);
		item.tooltip = new vscode.MarkdownString(
			`**${element.symbol}**\n\n` +
			`Last: ${quote.last.toFixed(2)}\n\n` +
			`Change: ${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)\n\n` +
			`Updated: ${new Date(quote.timestamp).toLocaleTimeString()}` +
			(this._client.state === ConnectionState.Simulated ? '\n\n_Simulated data._' : '')
		);
		return item;
	}

	getChildren(element?: SymbolNode): SymbolNode[] {
		if (element) {
			return [];
		}
		return this._symbols.map(symbol => new SymbolNode(symbol));
	}

	async add(symbol: string): Promise<void> {
		const normalized = symbol.trim().toUpperCase();
		if (!normalized || this._symbols.includes(normalized)) {
			return;
		}
		this._symbols.push(normalized);
		await this._persist();
		this._client.subscribe([normalized]);
		this._onDidChangeTreeData.fire(undefined);
	}

	async remove(symbol: string): Promise<void> {
		const index = this._symbols.indexOf(symbol);
		if (index === -1) {
			return;
		}
		this._symbols.splice(index, 1);
		await this._persist();
		this._client.unsubscribe([symbol]);
		this._onDidChangeTreeData.fire(undefined);
	}

	private _persist(): Thenable<void> {
		return this._storage.update(STORAGE_KEY, this._symbols);
	}

	private _startRefreshLoop(): void {
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
		}
		const interval = vscode.workspace.getConfiguration('quant').get<number>('watchlist.refreshIntervalMs', 250);
		this._refreshTimer = setInterval(() => {
			if (this._dirty) {
				this._dirty = false;
				this._onDidChangeTreeData.fire(undefined);
			}
		}, interval);
	}

	dispose(): void {
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
			this._refreshTimer = undefined;
		}
		for (const disposable of this._disposables) {
			disposable.dispose();
		}
		this._onDidChangeTreeData.dispose();
	}
}
