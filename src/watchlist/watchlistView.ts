/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConnectionState, MarketDataClient } from '../marketData/client';

const STORAGE_KEY = 'quant.watchlist.symbols';
/**
 * Crypto is included because the default daemon provider is Coinbase, which trades
 * continuously - so a fresh profile shows real prices at any hour. The equities entries only
 * resolve once an equities provider is configured, and read as "no data" until then.
 */
const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'SPY', 'BTC-USD', 'ETH-USD'];

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

	/**
	 * One node per symbol, for the lifetime of that symbol in the list.
	 *
	 * `onDidChangeTreeData.fire(node)` identifies the row to repaint by object identity, so
	 * handing out a fresh `SymbolNode` per `getChildren` call would leave every targeted refresh
	 * matching nothing and silently repainting nothing.
	 */
	private readonly _nodes = new Map<string, SymbolNode>();

	/** Symbols quoted since the last repaint. */
	private readonly _dirty = new Set<string>();

	constructor(
		private readonly _storage: vscode.Memento,
		private readonly _client: MarketDataClient
	) {
		this._symbols = this._storage.get<string[]>(STORAGE_KEY) ?? [...DEFAULT_SYMBOLS];

		this._disposables.push(this._client.onDidChangeQuote(quote => { this._dirty.add(quote.symbol); }));
		// Closes arrive asynchronously after a row has already painted "no data", so the row has
		// to be told to repaint or it would keep saying that until something else disturbed it.
		this._disposables.push(this._client.onDidChangeLastClose(symbol => { this._dirty.add(symbol); }));
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

		const live = this._client.quotes.get(element.symbol);
		// A live quote wins outright; the close is only what to show in its absence.
		const quote = live ?? this._client.lastClose(element.symbol);
		if (!quote) {
			item.description = this._client.state === ConnectionState.Connecting
				? vscode.l10n.t('connecting…')
				: vscode.l10n.t('no data');
			item.iconPath = new vscode.ThemeIcon('circle-outline');
			return item;
		}

		const sign = quote.change >= 0 ? '+' : '';
		if (!live) {
			// Real prices, but the last one a session closed at rather than one from a moment
			// ago. Marked on the row rather than left to look live: the whole point of showing
			// it is that the alternative said "no data" beside a chart drawing the same symbol,
			// and replacing one wrong impression with another would not be progress.
			item.description = `${quote.last.toFixed(2)}  ${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)  ${vscode.l10n.t('close')}`;
			item.iconPath = new vscode.ThemeIcon(
				quote.change >= 0 ? 'arrow-up' : 'arrow-down',
				new vscode.ThemeColor('descriptionForeground')
			);
			item.tooltip = new vscode.MarkdownString(
				`**${element.symbol}**\n\n` +
				`Close: ${quote.last.toFixed(2)}\n\n` +
				`Change: ${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)\n\n` +
				`_Last published close. Connect a daemon for live prices._`
			);
			return item;
		}

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
		return this._symbols.map(symbol => {
			let node = this._nodes.get(symbol);
			if (!node) {
				node = new SymbolNode(symbol);
				this._nodes.set(symbol, node);
			}
			return node;
		});
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
		this._nodes.delete(symbol);
		this._dirty.delete(symbol);
		await this._persist();
		this._client.unsubscribe([symbol]);
		// Adding and removing change the shape of the tree rather than one row in it, so these
		// stay root refreshes. They happen at human speed, where one progress bar is unremarkable.
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
			if (this._dirty.size === 0) {
				return;
			}
			// Per row rather than `fire(undefined)`. A root refresh is a reload as far as the
			// workbench is concerned, so it draws the view's progress bar - and at a quarter of a
			// second against a live feed that indicator never finishes, which reads as a fault
			// rather than as prices arriving.
			for (const symbol of this._dirty) {
				const node = this._nodes.get(symbol);
				if (node) {
					this._onDidChangeTreeData.fire(node);
				}
			}
			this._dirty.clear();
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
