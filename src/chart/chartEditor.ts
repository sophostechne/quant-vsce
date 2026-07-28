/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { ConnectionState, MarketDataClient } from '../marketData/client';
import { Bar, TIMEFRAMES, Tick, Timeframe } from '../protocol';

export const CHART_VIEW_TYPE = 'quant.chart';

interface ChartDocumentModel {
	symbol: string;
	timeframe: Timeframe;
	bars: number;
}

const DEFAULT_MODEL: ChartDocumentModel = { symbol: 'AAPL', timeframe: '1m', bars: 240 };

/**
 * Charts are `.chart` files - JSON describing the symbol and timeframe - opened through a
 * `CustomTextEditorProvider`. Backing them with a real text document means layouts get save,
 * undo, diff and version control for free, and a chart is just another editor tab, so splits,
 * editor groups and "Move Editor into New Window" all work without extra code.
 */
export class ChartEditorProvider implements vscode.CustomTextEditorProvider {

	static register(context: vscode.ExtensionContext, client: MarketDataClient, log: Logger): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			CHART_VIEW_TYPE,
			new ChartEditorProvider(context, client, log),
			{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }
		);
	}

	private constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _client: MarketDataClient,
		private readonly _log: Logger
	) { }

	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		token: vscode.CancellationToken
	): Promise<void> {
		const mediaRoot = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'chart');
		webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
		webviewPanel.webview.html = this._renderHtml(webviewPanel.webview, mediaRoot);

		const disposables: vscode.Disposable[] = [];
		let model = parseModel(document, this._log);

		const pushConfig = () => {
			void webviewPanel.webview.postMessage({
				type: 'config',
				symbol: model.symbol,
				timeframe: model.timeframe,
				timeframes: TIMEFRAMES,
				// Real path: the webview opens this socket itself and reads binary frames.
				dataPlaneUrl: this._client.dataPlaneUrl,
				symbolId: this._client.simulator.symbolId(model.symbol),
				simulated: this._client.state === ConnectionState.Simulated
			});
		};

		const pushHistory = async () => {
			try {
				const bars = await this._client.history(model.symbol, model.timeframe, model.bars);
				void webviewPanel.webview.postMessage({ type: 'history', symbol: model.symbol, bars });
			} catch (error) {
				this._log.error(`History for ${model.symbol} failed`, error);
				void webviewPanel.webview.postMessage({
					type: 'status',
					message: error instanceof Error ? error.message : 'History request failed.'
				});
			}
		};

		disposables.push(webviewPanel.webview.onDidReceiveMessage(async (message: { type: string; symbol?: string; timeframe?: Timeframe }) => {
			switch (message.type) {
				case 'ready':
					pushConfig();
					await pushHistory();
					break;

				case 'setSymbol':
				case 'setTimeframe': {
					const next: ChartDocumentModel = {
						...model,
						...(message.symbol ? { symbol: message.symbol.trim().toUpperCase() } : {}),
						...(message.timeframe ? { timeframe: message.timeframe } : {})
					};
					// Write through the document so the change is undoable and savable.
					await writeModel(document, next);
					break;
				}
			}
		}));

		disposables.push(vscode.workspace.onDidChangeTextDocument(async event => {
			if (event.document.uri.toString() !== document.uri.toString()) {
				return;
			}
			const next = parseModel(document, this._log);
			const symbolChanged = next.symbol !== model.symbol;
			const timeframeChanged = next.timeframe !== model.timeframe;
			if (!symbolChanged && !timeframeChanged) {
				return;
			}
			if (symbolChanged) {
				this._client.unsubscribe([model.symbol]);
				this._client.subscribe([next.symbol]);
			}
			model = next;
			pushConfig();
			await pushHistory();
		}));

		disposables.push(this._client.onDidChangeState(() => pushConfig()));

		// Development relay only. With a daemon present the webview reads ticks from its own
		// socket and nothing here runs.
		disposables.push(this._client.simulator.onDidProduceTicks((ticks: readonly Tick[]) => {
			if (this._client.state !== ConnectionState.Simulated) {
				return;
			}
			const symbolId = this._client.simulator.symbolId(model.symbol);
			if (symbolId === undefined) {
				return;
			}
			const relevant = ticks.filter(tick => tick.symbolId === symbolId);
			if (relevant.length > 0) {
				void webviewPanel.webview.postMessage({ type: 'ticks', ticks: relevant });
			}
		}));

		this._client.subscribe([model.symbol]);

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
		const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chart.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chart.css'));
		const nonce = createNonce();

		// `connect-src ws:` is what lets the webview reach the daemon directly, bypassing the
		// extension host for tick traffic.
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
			`connect-src ws://127.0.0.1:* ws://localhost:*`
		].join('; ');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${style}" rel="stylesheet">
	<title>Chart</title>
</head>
<body>
	<header class="toolbar">
		<input id="symbol" class="symbol" spellcheck="false" autocomplete="off">
		<select id="timeframe" class="timeframe"></select>
		<span id="last" class="last"></span>
		<span id="status" class="status"></span>
	</header>
	<canvas id="canvas"></canvas>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

function parseModel(document: vscode.TextDocument, log: Logger): ChartDocumentModel {
	const text = document.getText().trim();
	if (!text) {
		return { ...DEFAULT_MODEL };
	}
	try {
		const parsed = JSON.parse(text) as Partial<ChartDocumentModel>;
		const timeframe = TIMEFRAMES.includes(parsed.timeframe as Timeframe)
			? parsed.timeframe as Timeframe
			: DEFAULT_MODEL.timeframe;
		return {
			symbol: typeof parsed.symbol === 'string' && parsed.symbol.trim() ? parsed.symbol.trim().toUpperCase() : DEFAULT_MODEL.symbol,
			timeframe,
			bars: typeof parsed.bars === 'number' && parsed.bars > 0 ? Math.min(parsed.bars, 5_000) : DEFAULT_MODEL.bars
		};
	} catch {
		log.warn(`${document.uri.fsPath} is not valid JSON; using defaults.`);
		return { ...DEFAULT_MODEL };
	}
}

async function writeModel(document: vscode.TextDocument, model: ChartDocumentModel): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.replace(
		document.uri,
		new vscode.Range(0, 0, document.lineCount, 0),
		JSON.stringify(model, undefined, '\t') + '\n'
	);
	await vscode.workspace.applyEdit(edit);
}

export function defaultChartContent(symbol: string): string {
	const model: ChartDocumentModel = { ...DEFAULT_MODEL, symbol };
	return JSON.stringify(model, undefined, '\t') + '\n';
}

export type { Bar };

function createNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
