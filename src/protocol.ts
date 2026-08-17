/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire contract between the market data daemon, the extension host and chart webviews.
 *
 * The split matters: the *control plane* (subscribe, resolve, history) is low rate and
 * flows through the extension host, which is single threaded and shared with every other
 * extension. The *data plane* (ticks) never touches the extension host at all - webviews
 * open their own socket to the daemon and receive packed binary frames. Routing ticks
 * through the extension host would cost a structured clone and two IPC hops per message,
 * because `Webview.postMessage` has no transfer list.
 */

export const PROTOCOL_VERSION = 1;

// -- Control plane (JSON, extension host <-> daemon) ------------------------------------

export interface HelloRequest {
	readonly type: 'hello';
	readonly protocolVersion: number;
	readonly client: 'extension-host';
}

export interface HelloResponse {
	readonly type: 'hello';
	readonly protocolVersion: number;
	/** Port serving binary tick frames. Webviews connect here directly. */
	readonly dataPort: number;
	readonly venues: readonly string[];
}

export interface SubscribeRequest {
	readonly type: 'subscribe';
	readonly symbols: readonly string[];
}

export interface UnsubscribeRequest {
	readonly type: 'unsubscribe';
	readonly symbols: readonly string[];
}

/**
 * Symbols are interned to a numeric id by the daemon. Tick frames carry the id, not the
 * string, which is what keeps a tick to a fixed 32 bytes.
 */
export interface SymbolMapNotification {
	readonly type: 'symbolMap';
	readonly entries: readonly { readonly id: number; readonly symbol: string }[];
}

export interface QuoteNotification {
	readonly type: 'quote';
	readonly symbol: string;
	readonly last: number;
	readonly change: number;
	readonly changePercent: number;
	readonly timestamp: number;
}

export interface HistoryRequest {
	readonly type: 'history';
	readonly requestId: number;
	readonly symbol: string;
	readonly timeframe: Timeframe;
	readonly count: number;
}

export interface HistoryResponse {
	readonly type: 'history';
	readonly requestId: number;
	readonly bars: readonly Bar[];
}

export interface ErrorNotification {
	readonly type: 'error';
	readonly message: string;
	readonly requestId?: number;
}

export type ClientMessage = HelloRequest | SubscribeRequest | UnsubscribeRequest | HistoryRequest;
export type DaemonMessage = HelloResponse | SymbolMapNotification | QuoteNotification | HistoryResponse | ErrorNotification;

// -- Domain types ----------------------------------------------------------------------

/**
 * An interval, as the string a user types and a document stores: `5m`, `4h`, `1D`, `3M`.
 *
 * Deliberately a plain string rather than a union. It was a union of the seven a source happened
 * to serve, which made every broader interval unrepresentable rather than merely unavailable -
 * the type said 4h could not exist, when the truth is that nobody publishes it and it has to be
 * built from 1h. What a feed serves and what a chart can show are different questions, and only
 * the first is a closed set.
 */
export type Timeframe = string;

/** The granularities a source can be asked for directly. Everything else is built from these. */
export type BaseTimeframe = '1s' | '5s' | '1m' | '5m' | '15m' | '1h' | '1d';

export const TIMEFRAMES: readonly BaseTimeframe[] = ['1s', '5s', '1m', '5m', '15m', '1h', '1d'];

/**
 * Interval units, in the spelling TradingView uses.
 *
 * Case carries meaning here and cannot be normalised away: `m` is minutes and `M` is months, so
 * `1m` and `1M` are four orders of magnitude apart. Seconds, minutes and hours are lowercase;
 * days, weeks and months are uppercase.
 */
export type IntervalUnit = 's' | 'm' | 'h' | 'D' | 'W' | 'M';

export interface Interval {
	readonly count: number;
	readonly unit: IntervalUnit;
}

/**
 * When an instrument's trading day begins.
 *
 * Intraday buckets are anchored to this rather than to the epoch. A venue opening at 09:30 New
 * York time does not start its four-hour bars at midnight UTC, and flooring by the interval
 * would put a boundary in the middle of the session and merge the tail of one day into the head
 * of the next.
 *
 * Only the open is needed. The close ends the last bucket by running out of bars, which is
 * already how a gap is handled, so carrying it would add a second way to say the same thing.
 *
 * Daily, weekly and monthly bars deliberately ignore this: the convention - TradingView's, and
 * what every feed here already emits - is that a daily bar is stamped midnight UTC on its trading
 * date whatever timezone the exchange is in.
 */
export interface TradingSession {
	/** Minutes from local midnight, so 09:30 is 570. */
	readonly open: number;
	/** IANA zone the open is stated in, e.g. `America/New_York`. */
	readonly timeZone: string;
}

/** Sunday is 0, matching `Date.getUTCDay`, so the two never need translating between. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * How an instrument's bars line up with the clock and the calendar.
 *
 * Both halves are properties of the market rather than of the feed, which is why they are looked
 * up from the symbol and not taken from whichever source happened to answer.
 */
export interface Alignment {
	/** When the trading day opens. Absent for a venue that never closes. */
	readonly session?: TradingSession;
	/**
	 * The day the trading week begins.
	 *
	 * Monday nearly everywhere, and deliberately not assumed: the Gulf exchanges run Sunday to
	 * Thursday, and FX opens on a Sunday evening. A weekly candle that starts on the wrong day is
	 * not visibly broken - it just quietly disagrees with every other chart of the same series.
	 */
	readonly weekStart: Weekday;
}

/** Largest interval worth offering per unit, past which the count is a typo rather than a chart. */
const UNIT_LIMIT: Record<IntervalUnit, number> = { s: 3_600, m: 1_440, h: 24, D: 365, W: 52, M: 120 };

/**
 * Parses an interval string, or undefined when it is not one.
 *
 * A bare number means minutes, which is what TradingView does and what anyone typing `15` into an
 * interval box means. `1d` and `1w` are accepted as well as `1D` and `1W` because both spellings
 * are already in the wild - existing documents say `1d` - but `m` is never folded into `M`, since
 * that would silently turn a minute chart into a month chart.
 */
export function parseInterval(value: string): Interval | undefined {
	const match = /^\s*(\d+)\s*([smhdwSHDWM]?)\s*$/.exec(value);
	if (!match) {
		return undefined;
	}
	const count = Number(match[1]);
	const letter = match[2] ?? '';
	// Only the ambiguous-by-case pair is left alone; d/w have no lowercase meaning of their own.
	const unit: IntervalUnit | undefined = letter === '' ? 'm'
		: letter === 'd' || letter === 'D' ? 'D'
			: letter === 'w' || letter === 'W' ? 'W'
				: letter === 'M' ? 'M'
					: letter === 's' || letter === 'S' ? 's'
						: letter === 'h' || letter === 'H' ? 'h'
							: letter === 'm' ? 'm' : undefined;
	if (unit === undefined || !Number.isInteger(count) || count < 1 || count > UNIT_LIMIT[unit]) {
		return undefined;
	}
	return { count, unit };
}

/** The canonical spelling, so two ways of typing one interval do not become two list entries. */
export function formatInterval(interval: Interval): string {
	return `${interval.count}${interval.unit}`;
}

/**
 * The intervals offered before anyone adds their own, in the order they are shown.
 *
 * The set TradingView presents, minus the ones no feed here could ever fill. It is a list of what
 * is worth offering rather than of what is available: which of these actually appear depends on
 * what the sources claiming the symbol can be aggregated from, so a chart on a feed with no
 * sub-minute data simply never shows the seconds group.
 */
export const PRESET_INTERVALS: readonly string[] = [
	'1s', '5s', '15s', '30s',
	'1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m',
	'1h', '2h', '3h', '4h',
	'1D', '1W', '1M', '3M', '6M', '12M',
];

/** Milliseconds in one unit. Months are absent: they are not a fixed length. */
const UNIT_MILLIS: Record<Exclude<IntervalUnit, 'M'>, number> = {
	s: 1_000, m: 60_000, h: 3_600_000, D: 86_400_000, W: 604_800_000,
};

/**
 * Nominal length of an interval.
 *
 * A month is not a fixed span, so this reports 30 days for one. That is the right answer for the
 * questions this is asked - how many base bars to fetch, roughly how wide a bucket is - and the
 * wrong one for deciding which bucket a bar belongs to, which is why bucketing is calendar-based
 * and does not use this.
 */
export function timeframeToMillis(timeframe: Timeframe): number {
	const interval = parseInterval(timeframe);
	if (!interval) {
		return 60_000;
	}
	return interval.unit === 'M'
		? interval.count * 30 * UNIT_MILLIS.D
		: interval.count * UNIT_MILLIS[interval.unit];
}

export interface Bar {
	readonly time: number;
	readonly open: number;
	readonly high: number;
	readonly low: number;
	readonly close: number;
	readonly volume: number;
}

export interface Quote {
	readonly symbol: string;
	readonly last: number;
	readonly change: number;
	readonly changePercent: number;
	readonly timestamp: number;
}

// -- Data plane (binary, daemon -> webview) --------------------------------------------

/**
 * Frame layout. All little endian.
 *
 *   header (8 bytes)
 *     0  uint8   frameType
 *     1  uint8   protocolVersion
 *     2  uint16  recordCount
 *     4  uint32  reserved
 *
 *   then `recordCount` fixed-width records of TICK_RECORD_BYTES:
 *     0  uint16  symbolId
 *     2  uint8   side      0 = unknown, 1 = bid, 2 = ask
 *     3  uint8   flags
 *     4  uint32  sequence
 *     8  float64 timestamp   ms since epoch
 *    16  float64 price
 *    24  float32 size
 *    28  uint32  reserved
 *
 * Fixed width means the webview reads straight out of the ArrayBuffer with a DataView and
 * never allocates per tick.
 */
export const FRAME_HEADER_BYTES = 8;
export const TICK_RECORD_BYTES = 32;

export const enum FrameType {
	Tick = 1,
	Snapshot = 2,
	Heartbeat = 3,
}

export const enum TickSide {
	Unknown = 0,
	Bid = 1,
	Ask = 2,
}

export interface Tick {
	symbolId: number;
	side: TickSide;
	sequence: number;
	timestamp: number;
	price: number;
	size: number;
}

export function encodeTickFrame(ticks: readonly Tick[]): ArrayBuffer {
	const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + ticks.length * TICK_RECORD_BYTES);
	const view = new DataView(buffer);
	view.setUint8(0, FrameType.Tick);
	view.setUint8(1, PROTOCOL_VERSION);
	view.setUint16(2, ticks.length, true);

	let offset = FRAME_HEADER_BYTES;
	for (const tick of ticks) {
		view.setUint16(offset, tick.symbolId, true);
		view.setUint8(offset + 2, tick.side);
		view.setUint8(offset + 3, 0);
		view.setUint32(offset + 4, tick.sequence, true);
		view.setFloat64(offset + 8, tick.timestamp, true);
		view.setFloat64(offset + 16, tick.price, true);
		view.setFloat32(offset + 24, tick.size, true);
		view.setUint32(offset + 28, 0, true);
		offset += TICK_RECORD_BYTES;
	}
	return buffer;
}

/** Decodes in place into `out` so the hot path allocates nothing. */
export function decodeTickFrame(buffer: ArrayBuffer, out: Tick[]): number {
	const view = new DataView(buffer);
	if (view.getUint8(0) !== FrameType.Tick) {
		return 0;
	}
	const count = view.getUint16(2, true);
	let offset = FRAME_HEADER_BYTES;
	for (let i = 0; i < count; i++) {
		let tick = out[i];
		if (!tick) {
			tick = { symbolId: 0, side: TickSide.Unknown, sequence: 0, timestamp: 0, price: 0, size: 0 };
			out[i] = tick;
		}
		tick.symbolId = view.getUint16(offset, true);
		tick.side = view.getUint8(offset + 2);
		tick.sequence = view.getUint32(offset + 4, true);
		tick.timestamp = view.getFloat64(offset + 8, true);
		tick.price = view.getFloat64(offset + 16, true);
		tick.size = view.getFloat32(offset + 24, true);
		offset += TICK_RECORD_BYTES;
	}
	return count;
}
