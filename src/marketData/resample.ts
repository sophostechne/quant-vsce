/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Building an interval nobody publishes out of one somebody does.
 *
 * Feeds serve a handful of granularities - Coinbase and Binance both stop at 1m, 5m, 15m, 1h and
 * 1d - so every other interval a chart offers has to be aggregated here. Without this, adding 4h
 * to the picker would list an option that comes back empty, which is worse than not offering it.
 */

import {
	Alignment, Bar, BaseTimeframe, Interval, IntervalUnit, parseInterval, timeframeToMillis,
	TradingSession, Weekday,
} from '../protocol';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** The epoch, 1970-01-01, fell on a Thursday. */
const EPOCH_WEEKDAY = 4;

/** Monday, for a caller that has not said. It is the trading week nearly everywhere. */
const DEFAULT_WEEK_START: Weekday = 1;

/**
 * The instant week buckets are counted from: the first `weekStart` at or before the epoch.
 *
 * Counting from the epoch itself would start every weekly candle on a Thursday. This is also
 * what fixes the phase of a multi-week bucket - `2W` has to alternate against *something*, and an
 * anchor on the right weekday at least makes it alternate against real weeks.
 */
function weekAnchor(weekStart: Weekday): number {
	return -((EPOCH_WEEKDAY - weekStart + 7) % 7) * DAY;
}

/**
 * Wall-clock offset from UTC in `timeZone` at `time`, in milliseconds.
 *
 * Read back out of `Intl` rather than computed, because the offset is a function of the instant -
 * New York is four hours behind in July and five in January - and any fixed number is wrong for
 * half the year. Formatters are cached because building one is far more expensive than using it
 * and this runs once per bar.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zoneOffset(time: number, timeZone: string): number {
	let formatter = FORMATTERS.get(timeZone);
	if (!formatter) {
		try {
			formatter = new Intl.DateTimeFormat('en-US', {
				timeZone, hourCycle: 'h23',
				year: 'numeric', month: '2-digit', day: '2-digit',
				hour: '2-digit', minute: '2-digit', second: '2-digit',
			});
		} catch {
			// An unknown zone must not take the chart down. UTC is the honest fallback: it is
			// what the bars would have been aligned to with no session at all.
			return 0;
		}
		FORMATTERS.set(timeZone, formatter);
	}
	const parts = formatter.formatToParts(new Date(time));
	const part = (type: string) => Number(parts.find(entry => entry.type === type)?.value ?? 0);
	const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
	// Against whole seconds, since the parts carry no milliseconds and the difference would
	// otherwise show up as a sub-second offset.
	return asUtc - Math.floor(time / 1000) * 1000;
}

/**
 * The instant the trading day containing `time` opened.
 *
 * Two passes over the offset, because the offset used to place the open is itself read at a
 * different instant: on a spring-forward day, midnight and 09:30 are not the same distance from
 * UTC, and using the first would put the open an hour out. A bar before the day's open belongs
 * to the session before it, which is what the second iteration finds.
 */
function sessionOpenAt(time: number, session: TradingSession): number {
	for (let back = 0; back < 2; back++) {
		const probe = time - back * DAY;
		const offset = zoneOffset(probe, session.timeZone);
		const localMidnight = Math.floor((probe + offset) / DAY) * DAY;
		let open = localMidnight - offset + session.open * 60_000;
		const atOpen = zoneOffset(open, session.timeZone);
		if (atOpen !== offset) {
			open = localMidnight - atOpen + session.open * 60_000;
		}
		if (open <= time) {
			return open;
		}
	}
	return Math.floor(time / DAY) * DAY;
}

/**
 * The start of the bucket `time` belongs to.
 *
 * Calendar-based for weeks and months rather than arithmetic on a nominal length: months are 28
 * to 31 days, so dividing by "thirty days" would drift a monthly candle off the first of the
 * month and eventually put two months in one bucket.
 *
 * Intraday buckets anchor to the session when there is one. Without it they floor against the
 * epoch, which is correct for a venue that never closes and is why crypto declares no session.
 *
 * Weeks and months are counted in UTC even for an exchange on the other side of the world, and
 * that is not an oversight. A daily bar is stamped midnight UTC on its *trading date*, so the UTC
 * weekday of that stamp already is the weekday the exchange traded - converting it to local time
 * would move it off the date it stands for.
 */
export function bucketStart(time: number, interval: Interval, alignment?: Alignment): number {
	const { count, unit } = interval;

	if (unit === 'M') {
		const date = new Date(time);
		const months = date.getUTCFullYear() * 12 + date.getUTCMonth();
		const bucket = Math.floor(months / count) * count;
		return Date.UTC(Math.floor(bucket / 12), bucket % 12, 1);
	}
	if (unit === 'W') {
		const anchor = weekAnchor(alignment?.weekStart ?? DEFAULT_WEEK_START);
		const weeks = Math.floor((time - anchor) / WEEK);
		return anchor + Math.floor(weeks / count) * count * WEEK;
	}

	const span = timeframeToMillis(`${count}${unit}`);
	const session = alignment?.session;
	if (unit === 'D' || session === undefined) {
		return Math.floor(time / span) * span;
	}

	// Measured from the open rather than from the epoch, so the first bar of the day starts when
	// trading does. Buckets do not run past the open of the next session, which is what keeps a
	// four-hour bar from spanning the overnight gap.
	const open = sessionOpenAt(time, session);
	return open + Math.floor((time - open) / span) * span;
}

/**
 * Aggregates bars into `interval`.
 *
 * Open is the first bar's open and close the last bar's close, which is why this cannot be done
 * by sampling: a bucket's body spans everything inside it, and taking every fourth hourly bar
 * would draw a four-hour candle with an hour's range.
 *
 * Bars are assumed ascending in time, which is what every source returns. A bucket with no bars
 * in it produces no candle rather than a flat one - a market that was closed did not trade at its
 * previous close, and drawing that would invent a session.
 */
export function resample(bars: readonly Bar[], interval: Interval, alignment?: Alignment): Bar[] {
	if (bars.length === 0) {
		return [];
	}

	const out: Bar[] = [];
	let open = 0, high = 0, low = 0, close = 0, volume = 0;
	let current: number | undefined;

	const flush = () => {
		if (current !== undefined) {
			out.push({ time: current, open, high, low, close, volume });
		}
	};

	for (const bar of bars) {
		const bucket = bucketStart(bar.time, interval, alignment);
		if (bucket !== current) {
			flush();
			current = bucket;
			open = bar.open;
			high = bar.high;
			low = bar.low;
			volume = 0;
		}
		high = Math.max(high, bar.high);
		low = Math.min(low, bar.low);
		close = bar.close;
		volume += bar.volume;
	}
	flush();

	return out;
}

/**
 * The granularity to ask a source for, given what it serves.
 *
 * The largest that divides the target evenly, because every base bar fetched is bandwidth spent:
 * 4h from 1h is four requests' worth of candles, from 1m it is two hundred and forty. Evenness
 * matters more than size, though - building 45m out of 1h would put a bucket boundary in the
 * middle of a source candle, and the aggregate would be wrong rather than merely coarse.
 */
export function baseFor(interval: Interval, available: readonly BaseTimeframe[]): BaseTimeframe | undefined {
	if (available.length === 0) {
		return undefined;
	}
	const exact = formatFor(interval);
	if (exact && available.includes(exact)) {
		return exact;
	}

	// Daily and above are only ever built from a daily bar, never from intraday.
	//
	// Arithmetically a day is twenty-four hours and 1h divides it, so this looks like a needless
	// restriction. It is not: a daily candle is one *session*, and stitching one out of intraday
	// bars gets it wrong wherever a session does not fill a UTC day - it would silently drop the
	// pre-market, split a venue whose day crosses midnight UTC, and invent candles on holidays.
	// TradingView draws the same line and refuses to build DWM from intraday for the same reason.
	if (interval.unit === 'D' || interval.unit === 'W' || interval.unit === 'M') {
		return available.includes('1d') ? '1d' : undefined;
	}

	const ceiling = timeframeToMillis(formatInterval(interval));

	let best: BaseTimeframe | undefined;
	let bestMillis = 0;
	for (const candidate of available) {
		const millis = timeframeToMillis(candidate);
		if (millis > ceiling || ceiling % millis !== 0) {
			continue;
		}
		if (millis > bestMillis) {
			best = candidate;
			bestMillis = millis;
		}
	}
	return best;
}

/** How many base bars are needed to fill `count` buckets of `interval`. */
export function baseCountFor(interval: Interval, base: BaseTimeframe, count: number): number {
	const per = Math.max(1, Math.round(timeframeToMillis(formatInterval(interval)) / timeframeToMillis(base)));
	return count * per;
}

function formatInterval(interval: Interval): string {
	return `${interval.count}${interval.unit}`;
}

/** The interval as a base timeframe when it happens to be exactly one, else undefined. */
function formatFor(interval: Interval): BaseTimeframe | undefined {
	const text = formatInterval(interval);
	// `1d` is the spelling a source uses; `1D` is the spelling the picker uses for the same thing.
	const normalised = text === '1D' ? '1d' : text;
	return (['1s', '5s', '1m', '5m', '15m', '1h', '1d'] as const).find(base => base === normalised);
}

/** Whether `interval` can be built at all from what these sources serve. */
export function isDerivable(value: string, available: readonly BaseTimeframe[]): boolean {
	const interval = parseInterval(value);
	return interval !== undefined && baseFor(interval, available) !== undefined;
}

export type { IntervalUnit };
