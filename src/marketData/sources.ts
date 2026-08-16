/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where a chart's bars come from, as a list rather than a chain of conditions.
 *
 * Three sources answer today - a daemon, Coinbase's public candles, and a published bars service
 * - and each owns a different set of symbols and timeframes. Expressed as branching, adding the
 * fourth means editing the method every source already runs through; expressed as a list, it
 * means adding a file.
 *
 * The vocabulary is deliberately the daemon's: `claims()` decides ownership and order decides
 * precedence, exactly as `CompositeProvider` does in quant-daemon, so the two codebases can be
 * read with one model. The interface is narrower on purpose. This side never subscribes - ticks
 * bypass the extension host entirely - and a source here must never throw, because a source that
 * fails has to let the next one answer rather than take the chart down with it.
 */

import { Logger } from '../logger';
import { Bar, Timeframe, TIMEFRAMES } from '../protocol';

/** Where a set of bars came from. Mirrors `BarSource` in the webview's protocol. */
export type BarSource = 'live' | 'history' | 'simulated';

/**
 * What one source had to say.
 *
 * `absent` and `unavailable` stay apart because they mean opposite things about who is at
 * fault. A source that answers "I do not carry this" has told the truth about the data, and the
 * chart can say so. A source that could not be asked is a fault in configuration or network,
 * which the user can act on and cannot otherwise see. Neither is ever answered with invented
 * prices: a chart is the last place a fabricated number should be able to hide.
 */
export type SourceResult =
	| { kind: 'bars'; bars: readonly Bar[] }
	| { kind: 'absent'; reason: string }
	| { kind: 'unavailable'; reason: string };

export interface HistorySource {
	/** Identifies the source in logs. */
	readonly name: string;

	/** What to caption bars from this source as. */
	readonly provenance: BarSource;

	/**
	 * Which venue's prices these are, shown beside the badge on the chart.
	 *
	 * Named because more than one source can answer for one symbol and they are not the same
	 * instrument. `BTC-USD` from Coinbase and `BTCUSDT` from Binance track closely and are
	 * different markets in a different unit; equity bars are single-venue IEX rather than the
	 * consolidated tape. Leaving that unsaid would let a user compare two charts that do not
	 * mean the same thing.
	 */
	readonly venue?: string;

	/**
	 * Whether this source owns the symbol.
	 *
	 * First match wins and order is significant, so a source that claims broadly belongs last.
	 */
	claims(symbol: string): boolean;

	/**
	 * Timeframes this source can actually serve.
	 *
	 * Drives the chart's picker, which is why it is part of the contract rather than a constant
	 * kept beside it: what is offerable is a property of whoever would have to answer, and a
	 * hardcoded list cannot vary by symbol. Crypto carries 1m and equities do not.
	 */
	timeframes(): readonly Timeframe[];

	/** Never throws. Failure is a `SourceResult`, so the next source still gets its turn. */
	history(symbol: string, timeframe: Timeframe, count: number): Promise<SourceResult>;
}

/**
 * Quote currencies that make a symbol an exchange pair rather than a ticker.
 *
 * `BTC-USD` is a pair; `BF-B` is a share class. The distinction has to be made before a request
 * is sent, because the two go to different services entirely. Kept in step with `QUOTES` in the
 * engine's data.py, which routes the same way for the same reason.
 */
const QUOTES = ['USD', 'USDT', 'USDC', 'EUR', 'GBP', 'BTC', 'ETH'];

export function isExchangeProduct(symbol: string): boolean {
	const upper = symbol.toUpperCase();
	const dash = upper.lastIndexOf('-');
	return dash > 0 && QUOTES.includes(upper.slice(dash + 1));
}

/** The timeframes worth offering for a symbol: what any source claiming it can serve. */
export function availableTimeframes(
	sources: readonly HistorySource[],
	symbol: string,
	keep?: Timeframe
): readonly Timeframe[] {
	const offered = new Set<Timeframe>();
	for (const source of sources) {
		if (source.claims(symbol)) {
			for (const timeframe of source.timeframes()) {
				offered.add(timeframe);
			}
		}
	}
	// `keep` is whatever the chart is already on. A document saved at 1m must still show its own
	// value in the picker, or the control reads as broken rather than as narrowed - and the chart
	// already says plainly that nothing serves that timeframe.
	if (keep) {
		offered.add(keep);
	}
	return TIMEFRAMES.filter(timeframe => offered.has(timeframe));
}

// -- Daemon ------------------------------------------------------------------------------

/**
 * A connected daemon, which is the only source with a fresh tail: it composes live trades onto
 * the bars it holds, so its last candle is the current one rather than a closed session's.
 *
 * Adapted rather than implemented here - the socket, request ids and pending map stay in the
 * client, and this wraps them - because the daemon is the one source that is also a connection.
 */
export class DaemonSource implements HistorySource {
	readonly name = 'daemon';
	readonly provenance: BarSource = 'live';

	constructor(
		private readonly _connected: () => boolean,
		private readonly _fetch: (symbol: string, timeframe: Timeframe, count: number) => Promise<readonly Bar[]>
	) { }

	/** Claims everything while connected, and so must be listed first. */
	claims(): boolean {
		return this._connected();
	}

	/** Whatever its providers carry, including the sub-minute bars nothing publishes. */
	timeframes(): readonly Timeframe[] {
		return TIMEFRAMES;
	}

	async history(symbol: string, timeframe: Timeframe, count: number): Promise<SourceResult> {
		try {
			const bars = await this._fetch(symbol, timeframe, count);
			return bars.length > 0
				? { kind: 'bars', bars }
				: { kind: 'absent', reason: `the daemon holds no ${timeframe} history for ${symbol}` };
		} catch (error) {
			// Usually a provider list that does not claim the symbol - the daemon's default is
			// coinbase alone, so any equity lands here. Reported as unavailable so the next
			// source answers: connecting a daemon must never cost a chart that worked without it.
			const detail = error instanceof Error ? error.message : String(error);
			return { kind: 'unavailable', reason: `daemon: ${detail}` };
		}
	}
}

// -- Coinbase ----------------------------------------------------------------------------

const COINBASE = 'https://api.exchange.coinbase.com';

/** Coinbase's granularities, in seconds. It serves no finer than a minute. */
const GRANULARITY: Partial<Record<Timeframe, number>> = {
	'1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400,
};

/** One request returns at most this many candles, so longer series are paged. */
const PAGE = 300;

/**
 * Coinbase's public candles, which need no credentials and no daemon.
 *
 * Crypto is the one asset class whose history can simply be fetched: the exchange serves it to
 * anyone, where equity feeds are licensed per subscriber. So a crypto chart has no reason to
 * require a local process, and before this it did.
 *
 * These are not live - the newest candle is minutes old and does not move on its own - but
 * crypto trades continuously, so "history only" here means minutes behind rather than a closed
 * session. A daemon is still what makes the chart tick.
 */
export class CoinbaseSource implements HistorySource {
	readonly name = 'coinbase';
	readonly provenance: BarSource = 'history';
	readonly venue = 'coinbase';

	constructor(private readonly _log: Logger) { }

	claims(symbol: string): boolean {
		return isExchangeProduct(symbol);
	}

	timeframes(): readonly Timeframe[] {
		return TIMEFRAMES.filter(timeframe => GRANULARITY[timeframe] !== undefined);
	}

	async history(symbol: string, timeframe: Timeframe, count: number): Promise<SourceResult> {
		const step = GRANULARITY[timeframe];
		if (step === undefined) {
			return { kind: 'absent', reason: `Coinbase serves no ${timeframe} candles` };
		}

		const product = symbol.toUpperCase();
		// Keyed by time rather than concatenated: pages are requested by time window and the
		// boundaries can overlap, and two bars at one timestamp would be silently wrong
		// everywhere downstream.
		const byTime = new Map<number, Bar>();
		let end = new Date();

		try {
			while (byTime.size < count) {
				const take = Math.min(count - byTime.size, PAGE);
				const start = new Date(end.getTime() - step * take * 1000);
				const url = `${COINBASE}/products/${encodeURIComponent(product)}/candles`
					+ `?granularity=${step}&start=${start.toISOString()}&end=${end.toISOString()}`;

				const response = await fetch(url, {
					headers: { 'User-Agent': 'quant-workbench' },
					signal: AbortSignal.timeout(10_000),
				});
				if (response.status === 404) {
					return { kind: 'absent', reason: `Coinbase does not list ${product}` };
				}
				if (!response.ok) {
					return { kind: 'unavailable', reason: `Coinbase returned ${response.status}` };
				}

				// [time, low, high, open, close, volume], newest first, seconds not millis.
				const rows = await response.json() as number[][];
				if (rows.length === 0) {
					break;
				}
				let oldest = Number.POSITIVE_INFINITY;
				for (const row of rows) {
					const [time, low, high, open, close, volume] = row as [number, number, number, number, number, number];
					byTime.set(time * 1000, { time: time * 1000, open, high, low, close, volume });
					oldest = Math.min(oldest, time);
				}
				// Walk backwards from the oldest candle this page returned. Without moving the
				// cursor a short page would request the same window forever.
				const next = new Date(oldest * 1000);
				if (next.getTime() >= end.getTime()) {
					break;
				}
				end = next;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this._log.warn(`Coinbase candles for ${product} unavailable: ${detail}`);
			return { kind: 'unavailable', reason: `Coinbase unreachable: ${detail}` };
		}

		if (byTime.size === 0) {
			return { kind: 'absent', reason: `Coinbase returned no ${timeframe} candles for ${product}` };
		}
		const bars = [...byTime.values()].sort((left, right) => left.time - right.time);
		return { kind: 'bars', bars: bars.slice(-count) };
	}
}

// -- Binance -----------------------------------------------------------------------------

const BINANCE = 'https://api.binance.com/api/v3/klines';

/** Binance's kline intervals, matched to the set Coinbase serves. */
const INTERVALS: Partial<Record<Timeframe, string>> = {
	'1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '1d': '1d',
};

/** One request returns at most this many klines. */
const BINANCE_LIMIT = 1000;

/**
 * Coinbase's symbol in Binance's spelling, or undefined when there is no sensible equivalent.
 *
 * Binance lists no USD pairs, so a USD quote becomes USDT. That is a substitution rather than a
 * translation - USDT is a token that tracks the dollar rather than the dollar - which is why the
 * venue ends up on the chart instead of the two being presented as interchangeable.
 */
export function toBinanceSymbol(symbol: string): string | undefined {
	const upper = symbol.toUpperCase();
	const dash = upper.lastIndexOf('-');
	if (dash <= 0) {
		return undefined;
	}
	const base = upper.slice(0, dash);
	const quote = upper.slice(dash + 1);
	return `${base}${quote === 'USD' ? 'USDT' : quote}`;
}

/**
 * Binance klines, as documented: an array per bar, open time in milliseconds, prices as strings.
 *
 * Pure and exported so the mapping can be tested without reaching Binance at all - which matters
 * here more than usual, because the network this was written on is one Binance refuses.
 * Malformed rows are dropped rather than coerced: a NaN in a bar propagates silently into every
 * indicator downstream, where it is far harder to recognise than a missing candle.
 */
export function parseBinanceKlines(rows: unknown): Bar[] {
	if (!Array.isArray(rows)) {
		return [];
	}
	const bars: Bar[] = [];
	for (const row of rows) {
		if (!Array.isArray(row) || row.length < 6) {
			continue;
		}
		const time = Number(row[0]);
		const open = Number(row[1]);
		const high = Number(row[2]);
		const low = Number(row[3]);
		const close = Number(row[4]);
		const volume = Number(row[5]);
		if (![time, open, high, low, close, volume].every(Number.isFinite)) {
			continue;
		}
		bars.push({ time, open, high, low, close, volume });
	}
	return bars;
}

/**
 * Binance klines, as the crypto source of last resort.
 *
 * Coinbase and Binance are geo-blocked in opposite places - Binance answers 451 from the network
 * this was written on, and Coinbase is the one at risk elsewhere - so listing both means crypto
 * charts resolve by whichever is reachable, per user, with nothing to configure. They are
 * complements rather than redundancy.
 *
 * Second because the pairs are not equivalent: USDT is not USD.
 */
export class BinanceSource implements HistorySource {
	readonly name = 'binance';
	readonly provenance: BarSource = 'history';
	readonly venue = 'binance · USDT';

	constructor(private readonly _log: Logger) { }

	claims(symbol: string): boolean {
		return isExchangeProduct(symbol) && toBinanceSymbol(symbol) !== undefined;
	}

	/**
	 * Deliberately the same set Coinbase offers, though Binance also serves 1s klines. The
	 * picker is a union over sources that *claim* a symbol, and claiming cannot know whether a
	 * venue is reachable - so offering 1s here would put it in front of every user on the
	 * strength of an endpoint most of them cannot reach.
	 */
	timeframes(): readonly Timeframe[] {
		return TIMEFRAMES.filter(timeframe => INTERVALS[timeframe] !== undefined);
	}

	async history(symbol: string, timeframe: Timeframe, count: number): Promise<SourceResult> {
		const interval = INTERVALS[timeframe];
		const product = toBinanceSymbol(symbol);
		if (interval === undefined || product === undefined) {
			return { kind: 'absent', reason: `Binance serves no ${timeframe} klines` };
		}

		const byTime = new Map<number, Bar>();
		let endTime: number | undefined;

		try {
			while (byTime.size < count) {
				const take = Math.min(count - byTime.size, BINANCE_LIMIT);
				const url = `${BINANCE}?symbol=${encodeURIComponent(product)}&interval=${interval}&limit=${take}`
					+ (endTime === undefined ? '' : `&endTime=${endTime}`);

				const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
				if (response.status === 451 || response.status === 403) {
					// Binance states the restriction in the body, and it is worth surfacing
					// verbatim: "unreachable" would send someone hunting a network fault that
					// does not exist.
					return { kind: 'unavailable', reason: `Binance is not available from this location (${response.status})` };
				}
				if (response.status === 400) {
					return { kind: 'absent', reason: `Binance does not list ${product}` };
				}
				if (!response.ok) {
					return { kind: 'unavailable', reason: `Binance returned ${response.status}` };
				}

				const bars = parseBinanceKlines(await response.json());
				if (bars.length === 0) {
					break;
				}
				let oldest = Number.POSITIVE_INFINITY;
				for (const bar of bars) {
					byTime.set(bar.time, bar);
					oldest = Math.min(oldest, bar.time);
				}
				// endTime is inclusive, so step back one millisecond or the next page repeats
				// the oldest bar forever.
				const next = oldest - 1;
				if (endTime !== undefined && next >= endTime) {
					break;
				}
				endTime = next;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this._log.warn(`Binance klines for ${product} unavailable: ${detail}`);
			return { kind: 'unavailable', reason: `Binance unreachable: ${detail}` };
		}

		if (byTime.size === 0) {
			return { kind: 'absent', reason: `Binance returned no ${timeframe} klines for ${product}` };
		}
		const bars = [...byTime.values()].sort((left, right) => left.time - right.time);
		return { kind: 'bars', bars: bars.slice(-count) };
	}
}

// -- Published bars service --------------------------------------------------------------

/**
 * A published bars service, read over HTTPS by the extension itself.
 *
 * This is why charts draw real history with nothing installed, and it is the ordinary way to
 * use the workbench rather than a fallback.
 */
export class PublishedBarsSource implements HistorySource {
	readonly name = 'published-bars';
	readonly provenance: BarSource = 'history';
	/** Named because it is one venue at a few percent of the tape, not the consolidated market. */
	readonly venue = 'iex';

	constructor(
		private readonly _baseUrl: () => string,
		private readonly _log: Logger,
		private readonly _timeframeLabel: (timeframe: Timeframe, symbol: string) => string,
		private readonly _notConfigured: () => string
	) { }

	/** Tickers. Exchange pairs belong to a venue, and this service carries equities only. */
	claims(symbol: string): boolean {
		return !isExchangeProduct(symbol);
	}

	/**
	 * What the ingest publishes. 1m is deliberately absent: these are IEX TOPS bars from one
	 * venue at a few percent of the consolidated tape, and a bucket that fine shows which venue
	 * printed rather than what the instrument did.
	 */
	timeframes(): readonly Timeframe[] {
		return ['5m', '15m', '1h', '1d'];
	}

	async history(symbol: string, timeframe: Timeframe, count: number): Promise<SourceResult> {
		const base = this._baseUrl();
		if (!base) {
			// The packaged default is a live service, so an empty value was set by someone -
			// most often a workspace .vscode/settings.json, which beats the user setting
			// silently. Naming the setting is the difference between a diagnosable problem and
			// a chart that is simply blank.
			this._log.warn('quant.bars.url is empty, so no published history can be read.');
			return { kind: 'unavailable', reason: this._notConfigured() };
		}

		const url = `${base}/${timeframe}/${encodeURIComponent(symbol.toUpperCase())}.json`;
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
			if (response.status === 404) {
				this._log.info(`No published ${timeframe} history for ${symbol}`);
				return { kind: 'absent', reason: this._timeframeLabel(timeframe, symbol.toUpperCase()) };
			}
			if (!response.ok) {
				this._log.warn(`Published history for ${symbol} returned ${response.status}`);
				return { kind: 'unavailable', reason: `bars service returned ${response.status}` };
			}
			const series = await response.json() as { bars?: Bar[] };
			const bars = series.bars ?? [];
			if (bars.length === 0) {
				return { kind: 'absent', reason: this._timeframeLabel(timeframe, symbol.toUpperCase()) };
			}
			// Series are stored whole and oldest first, so the most recent `count` is the tail.
			return { kind: 'bars', bars: count < bars.length ? bars.slice(-count) : bars };
		} catch (error) {
			// Reaches here when the extension host cannot make the request the shell can: VS
			// Code's host uses Node's fetch, which ignores the OS proxy unless http.proxy is
			// set, so a corporate network fails here while curl succeeds. The message is the
			// only thing that distinguishes that from the service being down.
			const detail = error instanceof Error ? error.message : String(error);
			this._log.warn(`Published history for ${symbol} unavailable: ${detail}`);
			return { kind: 'unavailable', reason: `bars service unreachable: ${detail}` };
		}
	}
}
