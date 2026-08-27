/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { BarProvenance, ConnectionState, MarketDataClient } from '../marketData/client';
import { Bar, formatInterval, parseInterval, Tick, Timeframe } from '../protocol';
import { VisualizerRegistry } from '../visualizers/registry';
import { ChartDocumentModel, Drawing, parseModel, writeModel } from './chartModel';

export const CHART_VIEW_TYPE = 'quant.chart';

/** How many of their own intervals one person plausibly wants. Past this it is a runaway write. */
const MAX_CUSTOM_INTERVALS = 32;

/**
 * The user's own intervals, from settings.
 *
 * Read on demand rather than cached, so a chart picks up an interval added from another chart -
 * or hand-edited into settings.json - without being reopened. Re-validated on read because the
 * setting is hand-editable and a malformed entry must not reach the picker.
 */
function customIntervals(): string[] {
	const raw = vscode.workspace.getConfiguration('quant').get<string[]>('chart.customIntervals', []);
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>();
	for (const value of raw) {
		const interval = typeof value === 'string' ? parseInterval(value) : undefined;
		if (interval) {
			seen.add(formatInterval(interval));
		}
	}
	return [...seen].slice(0, MAX_CUSTOM_INTERVALS);
}

function setCustomIntervals(values: readonly string[]): Thenable<void> {
	return vscode.workspace.getConfiguration('quant').update(
		'chart.customIntervals',
		values.slice(0, MAX_CUSTOM_INTERVALS),
		vscode.ConfigurationTarget.Global);
}

/**
 * Live chart panels by document URI, so commands can reach the webview of the chart the user
 * is looking at. Kept here rather than in the command module because the provider is what
 * knows when a panel appears and disappears.
 */
const activePanels = new Map<string, vscode.WebviewPanel>();

/**
 * Which drawing the user has selected in each chart. Lives here rather than in the document:
 * a selection is transient UI state, and writing it would put cursor movement into the undo
 * stack and into version control.
 */
const selectedDrawings = new Map<string, number>();

/**
 * The chart the user last focused.
 *
 * Tracked because a chart is a *custom* editor, so `window.activeTextEditor` is undefined while
 * one has focus - a command that asked the workbench which editor is active would be told
 * "none" and have to guess, which for New Visualizer meant attaching to whichever chart
 * happened to be first in `workspace.textDocuments`.
 */
let focusedChart: vscode.TextDocument | undefined;

/** The chart document in front of the user, for commands that act on "this chart". */
export function activeChartDocument(): vscode.TextDocument | undefined {
	return focusedChart;
}

/** Index of the drawing selected in the chart for `uri`, if any. */
export function selectedDrawingIndex(uri: vscode.Uri): number | undefined {
	return selectedDrawings.get(uri.toString());
}

/** Posts to the chart for `uri`, if one is open. */
export function postToChart(uri: vscode.Uri, message: unknown): boolean {
	const panel = activePanels.get(uri.toString());
	if (!panel) {
		return false;
	}
	void panel.webview.postMessage(message);
	return true;
}

/**
 * Charts are `.chart` files - JSON describing the symbol and timeframe - opened through a
 * `CustomTextEditorProvider`. Backing them with a real text document means layouts get save,
 * undo, diff and version control for free, and a chart is just another editor tab, so splits,
 * editor groups and "Move Editor into New Window" all work without extra code.
 */
export class ChartEditorProvider implements vscode.CustomTextEditorProvider {

	static register(
		context: vscode.ExtensionContext,
		client: MarketDataClient,
		visualizers: VisualizerRegistry,
		log: Logger
	): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			CHART_VIEW_TYPE,
			new ChartEditorProvider(context, client, visualizers, log),
			{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }
		);
	}

	private constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _client: MarketDataClient,
		private readonly _visualizers: VisualizerRegistry,
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
		let historyRequest = 0;
		let visualizerRequest = 0;

		activePanels.set(document.uri.toString(), webviewPanel);
		if (webviewPanel.active) {
			focusedChart = document;
		}
		disposables.push(webviewPanel.onDidChangeViewState(() => {
			if (webviewPanel.active) {
				focusedChart = document;
			}
		}));

		const pushConfig = () => {
			void webviewPanel.webview.postMessage({
				type: 'config',
				symbol: model.symbol,
				timeframe: model.timeframe,
				// Narrowed when no daemon is connected, so the picker offers only what something
				// can actually serve or be aggregated into. Re-pushed on every connection change
				// below, so starting a daemon widens it without reopening the chart.
				timeframes: this._client.timeframesFor(model.symbol, model.timeframe, customIntervals()),
				// Sent apart from the list so the picker can group the user's own intervals and
				// offer to remove them; merged into `timeframes` it would be indistinguishable
				// from a preset, and removing a preset means nothing.
				customIntervals: customIntervals(),
				// Real path: the webview opens this socket itself and reads binary frames.
				dataPlaneUrl: this._client.dataPlaneUrl,
				symbolId: this._client.symbolId(model.symbol),
				style: model.style,
				scale: model.scale,
				styleOptions: model.styleOptions,
				indicators: model.indicators,
				drawings: model.drawings,
				simulated: this._client.state === ConnectionState.Simulated
			});
		};

		const pushHistory = async () => {
			const request = ++historyRequest;
			// Invalidate overlays as soon as a different series is requested. Otherwise a slow
			// visualizer for the old symbol can arrive while the new history request is in flight.
			visualizerRequest++;
			const requestedModel = model;
			// Provenance travels with the bars, and comes from whatever actually served them
			// rather than from connection state: with no daemon, published history and the
			// simulator are both reachable, and only the fetch knows which one answered.
			let source: BarProvenance = this._client.state === ConnectionState.Simulated ? 'simulated' : 'live';
			try {
				const result = await this._client.history(
					requestedModel.symbol, requestedModel.timeframe, requestedModel.bars);
				// Symbol changes and connection changes can overlap. Only the newest request may
				// replace the canvas; a late AAPL response must never overwrite a newer MSFT chart.
				if (request !== historyRequest) {
					return;
				}
				source = result.source;
				void webviewPanel.webview.postMessage({
					type: 'history', symbol: requestedModel.symbol, bars: result.bars, source,
					token: barsToken(result.bars, requestedModel),
					...(result.venue ? { venue: result.venue } : {}),
					// A source that answered and had nothing says so on the chart, rather than
					// leaving "no data" to be read as a fault.
					...(result.reason ? { error: result.reason } : {})
				});
				await pushVisualizers(result.bars, requestedModel);
			} catch (error) {
				if (request !== historyRequest) {
					return;
				}
				this._log.error(`History for ${requestedModel.symbol} failed`, error);
				// Send an empty series so the chart discards whatever it was showing. Keeping
				// stale bars on screen under a new label is how synthetic prices end up
				// captioned as live.
				void webviewPanel.webview.postMessage({
					type: 'history',
					symbol: requestedModel.symbol,
					bars: [],
					source,
					error: error instanceof Error ? error.message : 'History request failed.'
				});
			}
		};

		/**
		 * Runs the chart's visualizers and sends what they drew.
		 *
		 * A separate message from the bars rather than part of them: a visualizer runs in a
		 * worker and can take a moment or fail, and holding the candles back until user code
		 * finishes would make someone else's slow script look like slow market data.
		 */
		/**
		 * Identifies the exact bars an answer was computed against.
		 *
		 * Visualizer output arrives after the bars it describes, so the chart needs to know
		 * whether the two still refer to the same thing. Comparing this instead of clearing on
		 * every history message means a redraw of unchanged bars keeps what is already on screen
		 * rather than blanking it and drawing it again a worker later.
		 */
		const barsToken = (bars: readonly Bar[], chart: ChartDocumentModel) =>
			`${chart.symbol}|${chart.timeframe}|${bars.length}|${bars[bars.length - 1]?.time ?? 0}`;

		const pushVisualizers = async (bars: readonly Bar[], chart: ChartDocumentModel) => {
			const request = ++visualizerRequest;
			const token = barsToken(bars, chart);
			const paths = chart.visualizers ?? [];
			const stillCurrent = () => request === visualizerRequest
				&& chart.symbol === model.symbol
				&& chart.timeframe === model.timeframe
				&& JSON.stringify(chart.visualizers) === JSON.stringify(model.visualizers);
			if (paths.length === 0 || bars.length === 0) {
				if (stillCurrent()) {
					void webviewPanel.webview.postMessage({ type: 'visualizers', token, series: [], background: [], markers: [] });
				}
				return;
			}
			const output = await this._visualizers.run(
				paths, bars, VisualizerRegistry.context(chart.symbol, chart.timeframe));
			if (stillCurrent()) {
				void webviewPanel.webview.postMessage({ type: 'visualizers', token, ...output });
			}
		};

		// A visualizer file changed on disk. Only the drawn lines are stale, so the bars stay.
		disposables.push(this._visualizers.onDidChange(() => {
			const requestedModel = model;
			void this._client.history(requestedModel.symbol, requestedModel.timeframe, requestedModel.bars)
				.then(result => pushVisualizers(result.bars, requestedModel))
				.catch(() => { /* the history path reports its own failures */ });
		}));

		disposables.push(webviewPanel.webview.onDidReceiveMessage(async (message: { type: string; symbol?: string; timeframe?: Timeframe; interval?: string; paneHeights?: number[]; drawings?: Drawing[]; index?: number; hidden?: boolean }) => {
			switch (message.type) {
				case 'ready':
					pushConfig();
					await pushHistory();
					break;

				case 'selectionChanged':
					if (typeof message.index === 'number') {
						selectedDrawings.set(document.uri.toString(), message.index);
					} else {
						selectedDrawings.delete(document.uri.toString());
					}
					break;

				case 'setDrawings':
					if (Array.isArray(message.drawings)) {
						await writeModel(document, { ...model, drawings: message.drawings });
					}
					break;

				case 'setPaneHeights':
					// Written on release rather than per mouse move, so a drag is one undo step
					// and does not flood the document with intermediate states.
					if (Array.isArray(message.paneHeights)) {
						await writeModel(document, { ...model, paneHeights: message.paneHeights });
					}
					break;

				// The legend's controls, which address an indicator by its position in the
				// document. Each writes the document rather than holding state in the chart, so
				// hiding one is undoable and shows up in a diff like any other edit to it.
				case 'setIndicatorHidden': {
					const index = message.index;
					if (typeof index === 'number' && model.indicators[index]) {
						const indicators = model.indicators.map((spec, i) => i === index
							// Cleared rather than written as false: showing an indicator should
							// leave the file as it was before it was ever hidden.
							? { ...spec, hidden: message.hidden === true ? true : undefined }
							: spec);
						await writeModel(document, { ...model, indicators });
					}
					break;
				}

				case 'removeIndicator': {
					const index = message.index;
					if (typeof index === 'number' && model.indicators[index]) {
						await writeModel(document, {
							...model,
							indicators: model.indicators.filter((_, i) => i !== index),
						});
					}
					break;
				}

				case 'editIndicator': {
					if (typeof message.index === 'number' && model.indicators[message.index]) {
						// Through a command rather than a direct call: the prompts live with the
						// other indicator commands, and reaching them from here would make the
						// editor and those commands import each other.
						await vscode.commands.executeCommand(
							'quant.chart.editIndicator', document.uri, message.index);
					}
					break;
				}

				// Custom intervals are a setting rather than part of the document: they are a
				// property of how someone works, not of the chart they are looking at, and one
				// added while reading AAPL should still be there on the next chart opened.
				case 'addCustomInterval': {
					const interval = message.interval ? parseInterval(message.interval) : undefined;
					if (interval) {
						const value = formatInterval(interval);
						const existing = customIntervals();
						if (!existing.includes(value)) {
							await setCustomIntervals([...existing, value]);
						}
						// Selected as well as added. Adding one and then having to find it in the
						// list is a step nobody wants; TradingView switches to it too.
						await writeModel(document, { ...model, timeframe: value });
						// Adding the interval already selected writes nothing, so the document
						// change that normally refreshes the picker never fires and the new entry
						// would not appear until something else moved.
						pushConfig();
					}
					break;
				}

				case 'removeCustomInterval': {
					if (message.interval) {
						await setCustomIntervals(customIntervals().filter(value => value !== message.interval));
						pushConfig();
					}
					break;
				}

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
			const viewChanged =
				JSON.stringify(next.indicators) !== JSON.stringify(model.indicators)
				|| JSON.stringify(next.paneHeights) !== JSON.stringify(model.paneHeights)
				|| next.style !== model.style
				|| next.scale !== model.scale
				|| JSON.stringify(next.drawings) !== JSON.stringify(model.drawings)
				|| JSON.stringify(next.styleOptions) !== JSON.stringify(model.styleOptions);
			if (!symbolChanged && !timeframeChanged) {
				if (viewChanged) {
					// Indicators are derived from bars already loaded, so redraw without refetching.
					model = next;
					pushConfig();
				}
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

		// A feed change invalidates the bars on screen, not just the config: bars fetched from
		// the simulator are not the same instrument as bars from a live venue, even for the
		// same symbol. Refetch rather than relabel.
		disposables.push(this._client.onDidChangeState(() => {
			pushConfig();
			void pushHistory();
		}));
		// The id arrives after the subscribe round-trip, so the chart has to be told again.
		disposables.push(this._client.onDidChangeSymbolMap(() => pushConfig()));

		// Custom intervals are global, so one added on another chart - or typed into settings.json
		// by hand - belongs in this picker too, without reopening it.
		disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('quant.chart.customIntervals')) {
				pushConfig();
			}
		}));

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
			// Only clear the entry if it is still this panel: the same document can be opened
			// again in another group before this one is disposed.
			if (activePanels.get(document.uri.toString()) === webviewPanel) {
				activePanels.delete(document.uri.toString());
				selectedDrawings.delete(document.uri.toString());
			}
			if (focusedChart === document) {
				focusedChart = undefined;
			}
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
		<div class="interval">
			<button id="intervalButton" class="intervalButton" type="button" aria-haspopup="listbox" aria-expanded="false"></button>
			<div id="intervalMenu" class="intervalMenu" role="listbox" hidden></div>
		</div>
		<span id="last" class="last"></span>
		<span id="readout" class="readout"></span>
		<span id="legend" class="legend"></span>
		<span id="status" class="status"></span>
	</header>
	<canvas id="canvas"></canvas>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
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
