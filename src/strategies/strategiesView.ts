/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const STRATEGY_GLOB = '**/strategies/**/*.{py,ts,js}';

/**
 * Dependency trees contain `strategies` directories of their own - NautilusTrader ships two
 * dozen example strategies under `site-packages` - and listing those alongside the user's own
 * buries them.
 */
const STRATEGY_EXCLUDE = '{**/node_modules/**,**/.venv/**,**/venv/**,**/site-packages/**,**/.git/**,**/__pycache__/**}';

export class StrategyNode {
	constructor(readonly uri: vscode.Uri) { }
}

/**
 * Lists strategy sources in the workspace. Deliberately thin for now - once the strategy
 * runtime exists this view becomes its status surface (running, backtesting, deployed) and
 * gains the run/backtest entry points.
 */
export class StrategiesProvider implements vscode.TreeDataProvider<StrategyNode>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<StrategyNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly _watcher: vscode.FileSystemWatcher;

	constructor() {
		this._watcher = vscode.workspace.createFileSystemWatcher(STRATEGY_GLOB);
		this._watcher.onDidCreate(() => this._onDidChangeTreeData.fire(undefined));
		this._watcher.onDidDelete(() => this._onDidChangeTreeData.fire(undefined));
	}

	getTreeItem(element: StrategyNode): vscode.TreeItem {
		const item = new vscode.TreeItem(element.uri, vscode.TreeItemCollapsibleState.None);
		item.contextValue = 'quant.strategy';
		item.iconPath = new vscode.ThemeIcon('symbol-event');
		item.command = {
			command: 'vscode.open',
			title: vscode.l10n.t('Open Strategy'),
			arguments: [element.uri]
		};
		return item;
	}

	async getChildren(element?: StrategyNode): Promise<StrategyNode[]> {
		if (element) {
			return [];
		}
		const files = await vscode.workspace.findFiles(STRATEGY_GLOB, STRATEGY_EXCLUDE, 500);
		return files
			.sort((a, b) => a.fsPath.localeCompare(b.fsPath))
			.map(uri => new StrategyNode(uri));
	}

	dispose(): void {
		this._watcher.dispose();
		this._onDidChangeTreeData.dispose();
	}
}
