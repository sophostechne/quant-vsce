/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Prices for symbols with nothing streaming them.
 *
 * The watchlist has only ever shown quotes, which arrive from a daemon or the simulator and from
 * nowhere else. Making the simulator opt-in left every row reading "no data" with no daemon
 * installed - beside charts drawing real prices for the same symbols, which is a poor thing for
 * the workbench to claim about itself. This fills that gap from the same sources the charts use.
 *
 * Separate from the client because it is a cache with a refresh policy, which has nothing to do
 * with sockets, reconnection or subscriptions. Its only tie to the client is a function that
 * fetches history.
 */

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { Bar, Quote, Timeframe } from '../protocol';

/** A price for a symbol with nothing streaming it. */
export interface LastClose {
	readonly quote: Quote;
	/**
	 * True when the venue never closes, which changes what this price *is* rather than how fresh
	 * it is: a still-forming daily bar's close is the current price, where a finished session's
	 * is the last one traded before the bell. The watchlist says "delayed" for one and "close"
	 * for the other, and calling a market that trades at three in the morning closed is wrong.
	 */
	readonly continuous: boolean;
	readonly venue?: string;
}

/**
 * The history lookup this cache needs, stated structurally rather than imported.
 *
 * Declaring the three fields it actually reads, instead of taking the client's `HistoryResult`,
 * keeps the dependency pointing one way - the client knows about the cache, not the reverse -
 * and makes the requirement legible without opening another file.
 */
export type HistoryLookup = (symbol: string, timeframe: Timeframe, count: number) => Promise<{
	readonly bars: readonly Bar[];
	readonly venue?: string;
	readonly continuous?: boolean;
}>;

/**
 * How long a cached close stands before it is refetched.
 *
 * An equity close does not change until the session shuts, so this is really sized for crypto,
 * where the latest daily bar is still forming and its close moves. Five minutes keeps a watchlist
 * of a hundred symbols to a trickle of requests while staying current enough that nobody reads it
 * as stuck.
 */
const TTL_MS = 5 * 60_000;

export class LastCloseCache implements vscode.Disposable {

	private readonly _entries = new Map<string, { readonly value: LastClose; readonly at: number }>();
	/** Symbols with a request in flight, so a repaint storm cannot multiply requests. */
	private readonly _inFlight = new Set<string>();

	private readonly _onDidChange = new vscode.EventEmitter<string>();
	/** A close arrived for this symbol. Distinct from a quote, which is live. */
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly _history: HistoryLookup,
		private readonly _log: Logger
	) { }

	/**
	 * The cached close, refreshing behind the answer when it is missing or stale.
	 *
	 * Deliberately synchronous. This is called during a tree repaint that runs on a 250ms timer,
	 * so it must not wait on the network - it returns what it has and reports the arrival through
	 * `onDidChange`, which the view turns into a repaint of that one row.
	 */
	get(symbol: string): LastClose | undefined {
		const key = symbol.toUpperCase();
		const cached = this._entries.get(key);
		if (!cached || Date.now() - cached.at > TTL_MS) {
			void this._refresh(key);
		}
		return cached?.value;
	}

	private async _refresh(symbol: string): Promise<void> {
		// Without this, a repaint storm would launch a fetch per row per paint against services
		// that answer in hundreds of milliseconds.
		if (this._inFlight.has(symbol)) {
			return;
		}
		this._inFlight.add(symbol);
		try {
			// Two daily bars: the latest close, and the one to measure it against. For crypto the
			// latest daily bar is still forming, so its close is the current price - which is what
			// a watchlist should show for a market that never shuts.
			const result = await this._history(symbol, '1d', 2);
			const last = result.bars[result.bars.length - 1];
			if (!last) {
				return;
			}
			const previous = result.bars.length > 1 ? result.bars[result.bars.length - 2] : undefined;
			const change = previous ? last.close - previous.close : 0;
			this._entries.set(symbol, {
				at: Date.now(),
				value: {
					continuous: result.continuous === true,
					venue: result.venue,
					quote: {
						symbol,
						last: last.close,
						change,
						changePercent: previous && previous.close !== 0 ? (change / previous.close) * 100 : 0,
						timestamp: last.time,
					},
				},
			});
			this._onDidChange.fire(symbol);
		} catch (error) {
			// Sources do not throw, so this is a bug rather than a missing series. Swallowed
			// because a watchlist row is not worth failing a repaint over, but logged so it is
			// not invisible.
			this._log.warn(`Last close for ${symbol} failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this._inFlight.delete(symbol);
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._entries.clear();
		this._inFlight.clear();
	}
}
