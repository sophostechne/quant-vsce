/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Python only, because the backtest runner is a NautilusTrader subprocess that imports the file
 * it is given. Listing `.ts` and `.js` offered a Run Backtest action on files the runner can
 * only refuse - and a `strategies` directory of TypeScript is not hypothetical, since this
 * extension has one of its own:
 *
 *     Backtest failed: RuntimeError: Cannot import .../src/strategies/strategiesView.ts
 *
 * This also settles a disagreement between the two entry points: the editor title action was
 * already `.py` only, while the view's inline action offered whatever the glob had matched.
 */
const STRATEGY_GLOB = '**/strategies/**/*.py';

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
