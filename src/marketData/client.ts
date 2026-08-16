/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { Bar, ClientMessage, DaemonMessage, PROTOCOL_VERSION, Quote, Timeframe } from '../protocol';
import { SimulatedFeed } from './simulator';

/** Where a set of bars came from. Mirrors `BarSource` in the webview's protocol. */
export type BarSource = 'live' | 'history' | 'simulated';

export interface HistoryResult {
	readonly bars: readonly Bar[];
	readonly source: BarSource;
	/** Why the bars are empty, when the source answered and simply had none. */
	readonly reason?: string;
}

/**
 * What a published bars service had to say.
 *
 * `absent` and `unavailable` are kept apart because they justify opposite responses. A service
 * that cannot be reached is an outage, and falling back to the simulator keeps the workbench
 * usable. A service that answers 404 has told us something true - this symbol or timeframe is
 * not published - and answering that with invented prices would be a worse chart than none.
 */
type Published =
	| { kind: 'bars'; bars: readonly Bar[] }
	/** The service answered and does not carry this series. */
	| { kind: 'absent'; reason: string }
	/**
	 * The service could not be asked at all - unset, unreachable, or erroring.
	 *
	 * Carries a reason because this is the case a user cannot diagnose from the chart. It is
	 * also the only one caused by their configuration rather than by the data, so it is the one
	 * most worth stating plainly.
	 */
	| { kind: 'unavailable'; reason: string };

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

	constructor(private readonly _log: Logger) {
		this._simulator = new SimulatedFeed();
		this._simulator.onDidProduceQuote(quote => this._applyQuote(quote));
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
		// A connected daemon is asked first, because it is the only source with a fresh tail: it
		// composes live trades onto whatever history it holds, so its last bar is the current
		// one rather than the last session's.
		if (this._state === ConnectionState.Connected) {
			try {
				const bars = await this._daemonHistory(symbol, timeframe, count);
				if (bars.length > 0) {
					return { bars, source: 'live' };
				}
				this._log.info(`Daemon holds no ${timeframe} history for ${symbol}; asking published history.`);
			} catch (error) {
				// A daemon that cannot answer must never be worse than no daemon at all, and
				// this is the case where it was. The usual cause is a provider list that does
				// not claim the symbol - the default is coinbase alone, so any equity rejects
				// here - and the old code let that rejection reach the chart as an error, on a
				// symbol the bars service could have filled completely. Running a daemon for
				// crypto would break equities, which is precisely backwards.
				const detail = error instanceof Error ? error.message : String(error);
				this._log.warn(`Daemon history for ${symbol} failed (${detail}); asking published history.`);
			}
		}

		// Published history: the workbench's own dataset, and the reason charts work with no
		// daemon installed at all. Reached whenever the daemon is absent, silent, or does not
		// carry this symbol.
		const published = await this._publishedHistory(symbol, timeframe, count);
		switch (published.kind) {
			case 'bars':
				return { bars: published.bars, source: 'history' };
			case 'absent':
				return { bars: [], source: 'history', reason: published.reason };
			case 'unavailable':
				// Deliberately NOT the simulator. A service that could not be asked is a
				// configuration or network fault, and answering it with invented prices hides
				// the fault behind a chart that looks entirely normal - the failure this file
				// already refuses for a 404, on the grounds that a chart of random numbers is
				// not a better answer than an empty one. It is worse here, because the user has
				// done nothing to suggest they want a demo.
				return { bars: [], source: 'history', reason: published.reason };
		}
	}

	/** Asks a published bars service for one series. Never throws; see `Published`. */
	private async _publishedHistory(symbol: string, timeframe: Timeframe, count: number): Promise<Published> {
		const base = vscode.workspace.getConfiguration('quant').get<string>('bars.url', '').trim().replace(/\/$/, '');
		if (!base) {
			// The packaged default is a live service, so an empty value was set by someone -
			// most often a workspace .vscode/settings.json, which beats the user setting
			// silently. Worth naming the setting: this branch used to return with no log at
			// all, which made a misconfigured workspace indistinguishable from a network fault.
			this._log.warn('quant.bars.url is empty, so no published history can be read.');
			return { kind: 'unavailable', reason: vscode.l10n.t('no bars service configured (quant.bars.url)') };
		}
		const url = `${base}/${timeframe}/${encodeURIComponent(symbol.toUpperCase())}.json`;
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
			if (response.status === 404) {
				// The service is up and says it does not carry this. Reported rather than
				// replaced: a chart of random numbers is not a better answer than an empty one.
				this._log.info(`No published ${timeframe} history for ${symbol}`);
				return { kind: 'absent', reason: vscode.l10n.t('no {0} history published for {1}', timeframe, symbol.toUpperCase()) };
			}
			if (!response.ok) {
				this._log.warn(`Published history for ${symbol} returned ${response.status}`);
				return { kind: 'unavailable', reason: vscode.l10n.t('bars service returned {0}', String(response.status)) };
			}
			const series = await response.json() as { bars?: Bar[] };
			const bars = series.bars ?? [];
			if (bars.length === 0) {
				return { kind: 'absent', reason: vscode.l10n.t('no {0} history published for {1}', timeframe, symbol.toUpperCase()) };
			}
			// Series are stored whole and oldest first, so the most recent `count` is the tail.
			return { kind: 'bars', bars: count < bars.length ? bars.slice(-count) : bars };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// Reaches here when the extension host cannot make the request the shell can: VS
			// Code's host uses Node's fetch, which ignores the OS proxy unless http.proxy is
			// set, so a corporate network fails here while curl succeeds. The message is the
			// only thing that distinguishes that from the service being down.
			this._log.warn(`Published history for ${symbol} unavailable: ${detail}`);
			return { kind: 'unavailable', reason: vscode.l10n.t('bars service unreachable: {0}', detail) };
		}
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
