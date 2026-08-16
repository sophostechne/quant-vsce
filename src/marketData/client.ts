/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { Bar, ClientMessage, DaemonMessage, PROTOCOL_VERSION, Quote, Timeframe } from '../protocol';
import { SimulatedFeed } from './simulator';
import {
	availableTimeframes, BarSource, BinanceSource, CoinbaseSource, DaemonSource, HistorySource,
	PublishedBarsSource,
} from './sources';

export type { BarSource };

export interface HistoryResult {
	readonly bars: readonly Bar[];
	readonly source: BarSource;
	/** Why the bars are empty, when every source that claimed the symbol had none. */
	readonly reason?: string;
	/** Which venue answered, when more than one could have. */
	readonly venue?: string;
}

export const enum ConnectionState {
	Disconnected,
	Connecting,
	Connected,
	/** No daemon reachable; a synthetic feed is driving the UI. Development only. */
	Simulated,
}

/**
 * Minimal structural view of the global `WebSocket`, which Node provides natively. Declared
 * locally so the extension does not depend on a lib/@types combination that exposes it.
 */
interface WebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	onopen: ((event: unknown) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

const RECONNECT_DELAY_MS = 3_000;

/**
 * How long a cached close stands before it is refetched.
 *
 * An equity close does not change until the session shuts, so this is really sized for crypto,
 * where the latest daily bar is still forming and its close moves. Five minutes keeps a
 * watchlist of a hundred symbols to a trickle of requests while staying current enough that
 * nobody reads it as stuck.
 */
const CLOSE_TTL_MS = 5 * 60_000;

/**
 * Control-plane client. Handles subscriptions, quotes and history requests only - tick
 * traffic bypasses this entirely and is read by webviews straight from the daemon. See
 * `protocol.ts` for why.
 */
export class MarketDataClient implements vscode.Disposable {

	private _socket: WebSocketLike | undefined;
	private _state = ConnectionState.Disconnected;
	private _dataPort: number | undefined;
	private _reconnectTimer: NodeJS.Timeout | undefined;
	private _nextRequestId = 1;
	private _disposed = false;
	/** A socket attempt is in flight. Tracked separately from state, which stays Simulated across retries. */
	private _connecting = false;
	private _suppressAttemptLogs = false;

	private readonly _subscriptions = new Set<string>();
	private readonly _quotes = new Map<string, Quote>();
	/** Symbol -> interned id, as assigned by the daemon. Empty on the simulated feed. */
	private readonly _symbolIds = new Map<string, number>();
	private readonly _pendingHistory = new Map<number, { resolve(bars: readonly Bar[]): void; reject(error: Error): void }>();
	private readonly _simulator: SimulatedFeed;

	private readonly _onDidChangeState = new vscode.EventEmitter<ConnectionState>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidChangeQuote = new vscode.EventEmitter<Quote>();
	readonly onDidChangeQuote = this._onDidChangeQuote.event;

	private readonly _onDidChangeSymbolMap = new vscode.EventEmitter<void>();
	readonly onDidChangeSymbolMap = this._onDidChangeSymbolMap.event;

	/** A cached close arrived for this symbol. Distinct from a quote, which is live. */
	private readonly _onDidChangeLastClose = new vscode.EventEmitter<string>();
	readonly onDidChangeLastClose = this._onDidChangeLastClose.event;

	private readonly _closes = new Map<string, { readonly quote: Quote; readonly at: number }>();
	/** Symbols with a close request in flight, so a repaint storm cannot multiply requests. */
	private readonly _closeRequests = new Set<string>();

	/**
	 * History sources in precedence order; first to claim a symbol answers.
	 *
	 * The daemon leads because it is the only one with a live tail. Coinbase owns exchange
	 * pairs, the bars service owns tickers, and they do not overlap - the order between them is
	 * for readers rather than routing.
	 */
	private readonly _sources: readonly HistorySource[];

	constructor(private readonly _log: Logger) {
		this._simulator = new SimulatedFeed();
		this._simulator.onDidProduceQuote(quote => this._applyQuote(quote));

		this._sources = [
			new DaemonSource(
				() => this._state === ConnectionState.Connected,
				(symbol, timeframe, count) => this._daemonHistory(symbol, timeframe, count)),
			new CoinbaseSource(this._log),
			new BinanceSource(this._log),
			new PublishedBarsSource(
				() => vscode.workspace.getConfiguration('quant').get<string>('bars.url', '').trim().replace(/\/$/, ''),
				this._log,
				(timeframe, symbol) => vscode.l10n.t('no {0} history published for {1}', timeframe, symbol),
				() => vscode.l10n.t('no bars service configured (quant.bars.url)')),
		];
	}

	/** Timeframes worth offering for a symbol, given who could answer for it right now. */
	timeframesFor(symbol: string, keep?: Timeframe): readonly Timeframe[] {
		return availableTimeframes(this._sources, symbol, keep);
	}

	/**
	 * Last close and its change on the session before, for a symbol with no live quote.
	 *
	 * The watchlist has only ever shown quotes, which arrive from a daemon or from the simulator
	 * and from nowhere else. Turning the simulator off by default therefore left every row
	 * reading "no data" with no daemon installed - beside charts drawing real prices from the
	 * same symbols, which is a poor thing for the workbench to claim about itself.
	 *
	 * Returns whatever is cached immediately and refreshes behind it, because this is called
	 * during a tree repaint that runs on a 250ms timer and must not wait on the network or fire
	 * a request per paint. `onDidChangeLastClose` reports the arrival.
	 *
	 * Never merged into `quotes`. A close is hours or days old for an equity, and a live quote is
	 * current; storing them together would lose the only distinction that matters here.
	 */
	lastClose(symbol: string): Quote | undefined {
		const key = symbol.toUpperCase();
		const cached = this._closes.get(key);
		if (!cached || Date.now() - cached.at > CLOSE_TTL_MS) {
			void this._refreshClose(key);
		}
		return cached?.quote;
	}

	private async _refreshClose(symbol: string): Promise<void> {
		// One request in flight per symbol. Without this a repaint storm would launch a fetch per
		// paint per row, against services that answer in hundreds of milliseconds.
		if (this._closeRequests.has(symbol)) {
			return;
		}
		this._closeRequests.add(symbol);
		try {
			// Two daily bars: the latest close, and the one to measure it against. For crypto the
			// latest daily bar is still forming, so its close is the current price - which is
			// what a watchlist should show for a market that never shuts.
			const result = await this.history(symbol, '1d', 2);
			const last = result.bars[result.bars.length - 1];
			if (!last) {
				return;
			}
			const previous = result.bars.length > 1 ? result.bars[result.bars.length - 2] : undefined;
			const change = previous ? last.close - previous.close : 0;
			this._closes.set(symbol, {
				at: Date.now(),
				quote: {
					symbol,
					last: last.close,
					change,
					changePercent: previous && previous.close !== 0 ? (change / previous.close) * 100 : 0,
					timestamp: last.time,
				},
			});
			this._onDidChangeLastClose.fire(symbol);
		} catch (error) {
			// Sources do not throw, so this is a bug rather than a missing series. Swallowed
			// because a watchlist row is not worth failing a repaint over, but logged so it is
			// not invisible.
			this._log.warn(`Last close for ${symbol} failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this._closeRequests.delete(symbol);
		}
	}

	get state(): ConnectionState {
		return this._state;
	}

	get quotes(): ReadonlyMap<string, Quote> {
		return this._quotes;
	}

	/**
	 * URL a webview should open for binary tick frames, or `undefined` when running on the
	 * simulated feed - in which case the extension host relays synthetic ticks over
	 * `postMessage` instead. That relay is a development affordance, not the real data path.
	 */
	get dataPlaneUrl(): string | undefined {
		if (this._state !== ConnectionState.Connected || this._dataPort === undefined) {
			return undefined;
		}
		const config = vscode.workspace.getConfiguration('quant');
		return `ws://${config.get<string>('daemon.host', '127.0.0.1')}:${this._dataPort}`;
	}

	get simulator(): SimulatedFeed {
		return this._simulator;
	}

	/**
	 * Interned id a chart must match against in binary tick frames. Comes from the daemon's
	 * symbolMap when connected, and from the simulator otherwise - the two id spaces are
	 * unrelated, so this must not be read off the simulator while a daemon is live.
	 */
	symbolId(symbol: string): number | undefined {
		return this._state === ConnectionState.Simulated
			? this._simulator.symbolId(symbol)
			: this._symbolIds.get(symbol.toUpperCase());
	}

	connect(): void {
		if (this._disposed || this._connecting || this._state === ConnectionState.Connected) {
			return;
		}
		this._clearReconnect();

		const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
		if (!ctor) {
			this._log.error('No global WebSocket available in the extension host runtime.');
			this._fallBackToSimulator();
			return;
		}

		const config = vscode.workspace.getConfiguration('quant');
		const host = config.get<string>('daemon.host', '127.0.0.1');
		const port = config.get<number>('daemon.port', 8787);
		const url = `ws://${host}:${port}`;

		this._connecting = true;
		// While the simulator is driving, keep reporting Simulated across retry attempts.
		// Flipping to Connecting every few seconds would make the status bar strobe and would
		// briefly claim the synthetic prices on screen are real.
		if (this._state !== ConnectionState.Simulated) {
			this._setState(ConnectionState.Connecting);
		}
		this._logAttempt(`Connecting to market data daemon at ${url}`);

		let socket: WebSocketLike;
		try {
			socket = new ctor(url);
		} catch (error) {
			this._connecting = false;
			this._log.error('Failed to open control socket', error);
			this._fallBackToSimulator();
			return;
		}

		this._socket = socket;

		socket.onopen = () => {
			this._log.info('Control socket open, sending hello');
			this._send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, client: 'extension-host' });
		};

		socket.onmessage = event => {
			if (typeof event.data !== 'string') {
				return;
			}
			try {
				this._handleMessage(JSON.parse(event.data) as DaemonMessage);
			} catch (error) {
				this._log.error('Malformed control message', error);
			}
		};

		socket.onerror = () => {
			// `onclose` always follows; handle the transition there so it runs once.
		};

		socket.onclose = () => {
			if (this._socket !== socket) {
				return;
			}
			this._socket = undefined;
			this._dataPort = undefined;
			this._connecting = false;
			this._symbolIds.clear();
			if (this._disposed) {
				return;
			}
			if (this._state === ConnectionState.Connected) {
				this._log.warn('Control socket closed, reconnecting.');
				this._setState(ConnectionState.Disconnected);
			} else {
				this._logAttempt('Daemon unreachable.');
			}
			// Always fall back and always keep retrying. The simulator is a stand-in for a
			// daemon that is not there yet, never a terminal state - a daemon restart must not
			// strand the session on synthetic prices until the editor is restarted.
			this._fallBackToSimulator();
		};
	}

	disconnect(): void {
		this._clearReconnect();
		this._simulator.stop();
		const socket = this._socket;
		this._socket = undefined;
		this._dataPort = undefined;
		socket?.close();
		this._setState(ConnectionState.Disconnected);
	}

	subscribe(symbols: readonly string[]): void {
		const added = symbols.filter(symbol => !this._subscriptions.has(symbol));
		for (const symbol of added) {
			this._subscriptions.add(symbol);
		}
		if (added.length === 0) {
			return;
		}
		if (this._state === ConnectionState.Simulated) {
			this._simulator.subscribe(added);
		} else {
			this._send({ type: 'subscribe', symbols: added });
		}
	}

	unsubscribe(symbols: readonly string[]): void {
		const removed = symbols.filter(symbol => this._subscriptions.delete(symbol));
		if (removed.length === 0) {
			return;
		}
		for (const symbol of removed) {
			this._quotes.delete(symbol);
		}
		if (this._state === ConnectionState.Simulated) {
			this._simulator.unsubscribe(removed);
		} else {
			this._send({ type: 'unsubscribe', symbols: removed });
		}
	}

	/**
	 * Bars, and an honest account of where they came from.
	 *
	 * The workbench draws real history with no daemon installed. That is the ordinary case, not
	 * a degraded one: published bars are fetched over HTTPS and need nothing running locally.
	 * A daemon adds a live tail - real-time trades composed onto those bars - so it is asked
	 * first when present, and falling back to published history when it cannot answer keeps a
	 * daemon from ever being worse than none.
	 *
	 * Never the simulator. History is real or it is absent with a stated reason, because a
	 * chart is the last place a fabricated price should be able to hide.
	 *
	 * Provenance is returned rather than inferred from connection state: a user with no daemon
	 * is not necessarily looking at synthetic prices, and a chart that cannot tell the
	 * difference would caption real bars as simulated or, far worse, the reverse.
	 */
	async history(symbol: string, timeframe: Timeframe, count: number): Promise<HistoryResult> {
		// Sources in order, first claim wins, and a source that cannot answer lets the next try.
		// That fall-through is what keeps a connected daemon from ever being worse than none: the
		// daemon claims everything while connected, so an equity against a coinbase-only provider
		// list rejects here and the bars service - which could fill it completely - still answers.
		let reason: string | undefined;
		for (const source of this._sources) {
			if (!source.claims(symbol)) {
				continue;
			}
			const result = await source.history(symbol, timeframe, count);
			if (result.kind === 'bars') {
				return { bars: result.bars, source: source.provenance, venue: source.venue };
			}
			// Keep the first explanation rather than the last. The earliest source to claim the
			// symbol is the one the user most expected to answer, so its reason is the one that
			// describes their situation - a later source's "does not list AAPL" would be true
			// and beside the point.
			reason ??= result.reason;
			this._log.info(`${source.name} could not serve ${symbol} ${timeframe}: ${result.reason}`);
		}

		// Nothing had it. Never the simulator: a chart of random numbers is not a better answer
		// than an empty one, and it is worse when the cause is the user's own configuration,
		// because a normal-looking chart hides the fault behind the one thing they would trust.
		return { bars: [], source: 'history', reason: reason ?? vscode.l10n.t('no source carries {0}', symbol.toUpperCase()) };
	}

	private _daemonHistory(symbol: string, timeframe: Timeframe, count: number): Promise<readonly Bar[]> {
		const requestId = this._nextRequestId++;
		return new Promise<readonly Bar[]>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pendingHistory.delete(requestId);
				reject(new Error(`History request for ${symbol} timed out.`));
			}, 10_000);

			this._pendingHistory.set(requestId, {
				resolve: bars => { clearTimeout(timer); resolve(bars); },
				reject: error => { clearTimeout(timer); reject(error); }
			});
			this._send({ type: 'history', requestId, symbol, timeframe, count });
		});
	}

	private _handleMessage(message: DaemonMessage): void {
		switch (message.type) {
			case 'hello':
				this._dataPort = message.dataPort;
				this._connecting = false;
				this._suppressAttemptLogs = false;
				// A live daemon supersedes the simulator; leaving it running would race real
				// quotes against synthetic ones for the same symbols.
				this._simulator.stop();
				this._quotes.clear();
				this._setState(ConnectionState.Connected);
				this._log.info(`Connected. Data plane on port ${message.dataPort}, venues: ${message.venues.join(', ') || 'none'}`);
				if (this._subscriptions.size > 0) {
					this._send({ type: 'subscribe', symbols: [...this._subscriptions] });
				}
				break;

			case 'quote':
				this._applyQuote({
					symbol: message.symbol,
					last: message.last,
					change: message.change,
					changePercent: message.changePercent,
					timestamp: message.timestamp
				});
				break;

			case 'history': {
				const pending = this._pendingHistory.get(message.requestId);
				this._pendingHistory.delete(message.requestId);
				pending?.resolve(message.bars);
				break;
			}

			case 'error': {
				this._log.error(`Daemon error: ${message.message}`);
				if (message.requestId !== undefined) {
					const pending = this._pendingHistory.get(message.requestId);
					this._pendingHistory.delete(message.requestId);
					pending?.reject(new Error(message.message));
				}
				break;
			}

			case 'symbolMap':
				// Binary tick frames carry the interned id, not the symbol string, so a chart
				// cannot match its instrument until this arrives.
				this._symbolIds.clear();
				for (const entry of message.entries) {
					this._symbolIds.set(entry.symbol, entry.id);
				}
				this._onDidChangeSymbolMap.fire();
				break;
		}
	}

	private _applyQuote(quote: Quote): void {
		this._quotes.set(quote.symbol, quote);
		this._onDidChangeQuote.fire(quote);
	}

	private _fallBackToSimulator(): void {
		// Opt-in. Synthetic ticks are a development aid, and defaulting them on meant the one
		// state where the workbench shows invented numbers was also the state nobody chose.
		// Published history no longer depends on this, so turning it off costs no real data.
		const allowed = vscode.workspace.getConfiguration('quant').get<boolean>('daemon.allowSimulatedFeed', false);
		if (!allowed) {
			this._setState(ConnectionState.Disconnected);
			this._scheduleReconnect();
			return;
		}
		if (this._state !== ConnectionState.Simulated) {
			this._log.warn('Falling back to the simulated feed. Prices are synthetic and must not be traded on.');
			this._setState(ConnectionState.Simulated);
			this._simulator.start();
		}
		if (this._subscriptions.size > 0) {
			this._simulator.subscribe([...this._subscriptions]);
		}
		this._scheduleReconnect();
	}

	/**
	 * Reconnect attempts repeat forever, so log the first of a run and then go quiet. Otherwise
	 * an overnight session with no daemon writes thousands of identical lines.
	 */
	private _logAttempt(message: string): void {
		if (!this._suppressAttemptLogs) {
			this._log.warn(message);
			this._suppressAttemptLogs = true;
		}
	}

	private _scheduleReconnect(): void {
		this._clearReconnect();
		this._reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
	}

	private _clearReconnect(): void {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
	}

	private _send(message: ClientMessage): void {
		const socket = this._socket;
		if (!socket || socket.readyState !== 1 /* OPEN */) {
			return;
		}
		try {
			socket.send(JSON.stringify(message));
		} catch (error) {
			this._log.error('Failed to send control message', error);
		}
	}

	private _setState(state: ConnectionState): void {
		if (this._state === state) {
			return;
		}
		this._state = state;
		this._onDidChangeState.fire(state);
	}

	dispose(): void {
		this._disposed = true;
		this._clearReconnect();
		this._simulator.dispose();
		this._socket?.close();
		this._socket = undefined;
		for (const pending of this._pendingHistory.values()) {
			pending.reject(new Error('Client disposed.'));
		}
		this._pendingHistory.clear();
		this._onDidChangeState.dispose();
		this._onDidChangeQuote.dispose();
		this._onDidChangeSymbolMap.dispose();
	}
}
