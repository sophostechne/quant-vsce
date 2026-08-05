/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { parseStrategy, STOP_CHOICES, StrategyModel, writeStrategy } from './strategyModel';
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

	static register(context: vscode.ExtensionContext, log: Logger): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			STRATEGY_VIEW_TYPE,
			new StrategyEditorProvider(context, log),
			{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }
		);
	}

	private constructor(
		private readonly _context: vscode.ExtensionContext,
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

		disposables.push(webviewPanel.webview.onDidReceiveMessage(async (message: { type: string; model?: StrategyModel }) => {
			if (message.type === 'ready') {
				push();
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
