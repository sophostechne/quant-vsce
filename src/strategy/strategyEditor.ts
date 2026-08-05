/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { parseStrategy, STOP_CHOICES, StrategyModel, writeStrategy } from './strategyModel';
import { EvolveOptions, StrategyRunner, WalkOptions } from './strategyRunner';
import { VOCABULARY } from './vocabulary';

export const STRATEGY_VIEW_TYPE = 'quant.strategy';

/**
 * Strategies are `.strategy` files - the same JSON the evolutionary engine reads - opened
 * through a `CustomTextEditorProvider`.
 *
 * Backing the designer with a real text document is what makes it a no-code tool rather than a
 * separate application. Undo, save, diff and version control all work without extra code, and
 * because the file is the engine's own format there is no export step: a strategy assembled by
 * hand can be searched from, and one found by evolution can be opened and edited.
 */
export class StrategyEditorProvider implements vscode.CustomTextEditorProvider {

	static register(context: vscode.ExtensionContext, runner: StrategyRunner, log: Logger): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			STRATEGY_VIEW_TYPE,
			new StrategyEditorProvider(context, runner, log),
			{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }
		);
	}

	private constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _runner: StrategyRunner,
		private readonly _log: Logger
	) { }

	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		token: vscode.CancellationToken
	): Promise<void> {
		const mediaRoot = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'designer');
		webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
		webviewPanel.webview.html = this._renderHtml(webviewPanel.webview, mediaRoot);

		const disposables: vscode.Disposable[] = [];

		const push = () => {
			void webviewPanel.webview.postMessage({
				type: 'strategy',
				vocabulary: VOCABULARY,
				stops: STOP_CHOICES,
				model: parseStrategy(document, this._log)
			});
		};

		// One run at a time per editor. A backtest takes seconds, and a user adjusting a
		// threshold can outpace it; without this the panel would show whichever run happened to
		// finish last rather than the one for the strategy on screen.
		let running: vscode.CancellationTokenSource | undefined;
		disposables.push({ dispose: () => running?.dispose() });

		const evaluate = async () => {
			running?.cancel();
			running?.dispose();
			running = new vscode.CancellationTokenSource();
			const token = running.token;

			void webviewPanel.webview.postMessage({ type: 'evaluating' });
			try {
				const evaluation = await this._runner.evaluate(document, this._context.storageUri
					?? this._context.globalStorageUri, token);
				if (!token.isCancellationRequested) {
					void webviewPanel.webview.postMessage({ type: 'evaluation', evaluation });
				}
			} catch (error) {
				if (!token.isCancellationRequested) {
					this._log.error(String(error));
					void webviewPanel.webview.postMessage({ type: 'evaluation-failed', message: String(error) });
				}
			}
		};

		const search = async (options: EvolveOptions) => {
			running?.cancel();
			running?.dispose();
			running = new vscode.CancellationTokenSource();
			const token = running.token;

			try {
				await this._runner.evolve(options, event => {
					if (!token.isCancellationRequested) {
						void webviewPanel.webview.postMessage({ type: 'search', event });
					}
				}, token);
			} catch (error) {
				if (!token.isCancellationRequested) {
					this._log.error(String(error));
					void webviewPanel.webview.postMessage({ type: 'search-failed', message: String(error) });
				}
			}
		};

		const walk = async (options: WalkOptions) => {
			running?.cancel();
			running?.dispose();
			running = new vscode.CancellationTokenSource();
			const token = running.token;

			try {
				await this._runner.walkForward(options, event => {
					if (!token.isCancellationRequested) {
						// Named distinctly from the search's `event`: the two carry different shapes,
						// and a shared field name let a mismatch here go unnoticed until the panel
						// silently stayed empty through an entire run.
						void webviewPanel.webview.postMessage({ type: 'walk', walkEvent: event });
					}
				}, token);
			} catch (error) {
				if (!token.isCancellationRequested) {
					this._log.error(String(error));
					void webviewPanel.webview.postMessage({ type: 'walk-failed', message: String(error) });
				}
			}
		};

		disposables.push(webviewPanel.webview.onDidReceiveMessage(async (message: {
			type: string; model?: StrategyModel; options?: EvolveOptions; walk?: WalkOptions;
		}) => {
			if (message.type === 'ready') {
				push();
				return;
			}
			if (message.type === 'evaluate') {
				await evaluate();
				return;
			}
			if (message.type === 'search' && message.options) {
				await search(message.options);
				return;
			}
			if (message.type === 'walk' && message.walk) {
				await walk(message.walk);
				return;
			}
			if (message.type === 'cancel') {
				running?.cancel();
				return;
			}
			if (message.type === 'adopt' && message.model) {
				// Adopting writes through the document, so replacing the strategy on screen with
				// a discovered one is a single undo away like any other edit.
				await writeStrategy(document, message.model);
				return;
			}
			if (message.type === 'update' && message.model) {
				// The webview sends whole models rather than edits. A strategy is small, and a
				// single replacement keeps the document the one source of truth - the
				// alternative, patching in place, means the webview and the document each hold
				// a version of the tree and can disagree.
				await writeStrategy(document, message.model);
			}
		}));

		disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
			// Reflects edits made to the JSON directly, or by undo, back into the designer.
			if (event.document.uri.toString() === document.uri.toString() && event.contentChanges.length) {
				push();
			}
		}));

		webviewPanel.onDidDispose(() => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
		});

		if (token.isCancellationRequested) {
			webviewPanel.dispose();
		}
	}

	private _renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
		const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'designer.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'designer.css'));
		const nonce = createNonce();

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource}`,
			`style-src ${webview.cspSource}`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${style}" rel="stylesheet">
	<title>Strategy</title>
</head>
<body>
	<main id="designer" class="designer"></main>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

function createNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
