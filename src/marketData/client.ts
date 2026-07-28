/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { Bar, ClientMessage, DaemonMessage, PROTOCOL_VERSION, Quote, Timeframe } from '../protocol';
import { SimulatedFeed } from './simulator';

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
		if (this._disposed || this._state === ConnectionState.Connecting || this._state === ConnectionState.Connected) {
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

		this._setState(ConnectionState.Connecting);
		this._log.info(`Connecting to market data daemon at ${url}`);

		let socket: WebSocketLike;
		try {
			socket = new ctor(url);
		} catch (error) {
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
			if (this._disposed) {
				return;
			}
			if (this._state === ConnectionState.Connecting) {
				this._log.warn('Daemon unreachable.');
				this._fallBackToSimulator();
			} else {
				this._log.warn('Control socket closed, reconnecting.');
				this._setState(ConnectionState.Disconnected);
				this._scheduleReconnect();
			}
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

	async history(symbol: string, timeframe: Timeframe, count: number): Promise<readonly Bar[]> {
		if (this._state === ConnectionState.Simulated) {
			return this._simulator.history(symbol, timeframe, count);
		}
		if (this._state !== ConnectionState.Connected) {
			throw new Error('Not connected to a market data daemon.');
		}
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
		const allowed = vscode.workspace.getConfiguration('quant').get<boolean>('daemon.allowSimulatedFeed', true);
		if (!allowed) {
			this._setState(ConnectionState.Disconnected);
			this._scheduleReconnect();
			return;
		}
		this._log.warn('Falling back to the simulated feed. Prices are synthetic and must not be traded on.');
		this._setState(ConnectionState.Simulated);
		this._simulator.start();
		if (this._subscriptions.size > 0) {
			this._simulator.subscribe([...this._subscriptions]);
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
