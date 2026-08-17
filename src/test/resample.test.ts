/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Alignment, Bar, formatInterval, parseInterval, timeframeToMillis, Weekday } from '../protocol';
import { baseCountFor, baseFor, bucketStart, isDerivable, resample } from '../marketData/resample';
import { alignmentFor, availableTimeframes, HistorySource } from '../marketData/sources';

/**
 * Intervals are a vocabulary before they are a feature, and the grammar has one trap in it: `m`
 * is minutes and `M` is months. Folding case anywhere in the chain turns a minute chart into a
 * month chart, which looks like data loss rather than a parsing bug.
 */
suite('interval parsing', () => {

	test('a bare number is minutes, as anyone typing 15 into a box means', () => {
		assert.deepStrictEqual(parseInterval('15'), { count: 15, unit: 'm' });
	});

	test('case separates minutes from months', () => {
		assert.deepStrictEqual(parseInterval('1m'), { count: 1, unit: 'm' });
		assert.deepStrictEqual(parseInterval('1M'), { count: 1, unit: 'M' });
		assert.notStrictEqual(timeframeToMillis('1m'), timeframeToMillis('1M'));
	});

	test('the lowercase spelling already in documents still reads', () => {
		assert.deepStrictEqual(parseInterval('1d'), { count: 1, unit: 'D' });
		assert.strictEqual(formatInterval(parseInterval('1d')!), '1D');
	});

	test('nonsense is rejected rather than coerced', () => {
		for (const value of ['', 'abc', '0m', '-5m', '5x', '9999h', '1.5h']) {
			assert.strictEqual(parseInterval(value), undefined, `expected ${JSON.stringify(value)} to be rejected`);
		}
	});
});

/**
 * Weeks and months are calendar buckets, not multiples of a nominal length. Arithmetic on "thirty
 * days" drifts off the first of the month and eventually puts two months in one candle, so the
 * cases that matter are the ones far from the epoch and either side of a boundary.
 */
suite('interval bucketing', () => {

	const at = (iso: string) => Date.parse(iso);
	const isoOf = (time: number) => new Date(time).toISOString();

	test('a week bucket starts on the Monday by default', () => {
		// 2024-03-14 is a Thursday.
		assert.strictEqual(isoOf(bucketStart(at('2024-03-14T17:23:00Z'), { count: 1, unit: 'W' })), '2024-03-11T00:00:00.000Z');
	});

	test('Sunday belongs to the week that began before it', () => {
		assert.strictEqual(isoOf(bucketStart(at('2024-03-17T23:59:00Z'), { count: 1, unit: 'W' })), '2024-03-11T00:00:00.000Z');
		assert.strictEqual(isoOf(bucketStart(at('2024-03-18T00:00:00Z'), { count: 1, unit: 'W' })), '2024-03-18T00:00:00.000Z');
	});

	test('a market whose week starts on Sunday buckets a day earlier', () => {
		// The Gulf exchanges trade Sunday to Thursday, so their weekly candle opens on the Sunday
		// - the same Thursday belongs to a week that began on the 10th, not the 11th.
		const gulf: Alignment = { weekStart: 0 };
		assert.strictEqual(isoOf(bucketStart(at('2024-03-14T17:23:00Z'), { count: 1, unit: 'W' }, gulf)), '2024-03-10T00:00:00.000Z');
		// And the Sunday that Monday-weeks put at the end of a week starts one here.
		assert.strictEqual(isoOf(bucketStart(at('2024-03-17T23:59:00Z'), { count: 1, unit: 'W' }, gulf)), '2024-03-17T00:00:00.000Z');
	});

	test('every week start lands on the weekday it names', () => {
		// The anchor is derived, not tabulated, so this is the property worth asserting: whatever
		// day is asked for is the day every bucket opens on, for every count.
		for (let weekday = 0; weekday <= 6; weekday++) {
			for (const count of [1, 2, 3]) {
				const bucket = bucketStart(at('2024-03-14T17:23:00Z'), { count, unit: 'W' }, { weekStart: weekday as Weekday });
				assert.strictEqual(new Date(bucket).getUTCDay(), weekday,
					`${count}W starting ${weekday} opened on ${new Date(bucket).getUTCDay()}`);
				assert.ok(bucket <= at('2024-03-14T17:23:00Z'), 'a bucket never starts after the bar in it');
			}
		}
	});

	test('a multi-week bucket is a whole number of weeks wide', () => {
		const two = { count: 2, unit: 'W' as const };
		const first = bucketStart(at('2024-03-14T00:00:00Z'), two);
		const later = bucketStart(at('2024-04-14T00:00:00Z'), two);
		assert.strictEqual((later - first) % (14 * 86_400_000), 0, 'buckets are two weeks apart');
		assert.strictEqual(new Date(first).getUTCDay(), 1, 'and still open on a Monday');
	});

	test('weekly bucketing works before the epoch', () => {
		// Math.floor rounds toward negative infinity, which is what makes this hold; a truncating
		// divide would pull pre-1970 bars forward into the wrong week.
		const bucket = bucketStart(at('1969-07-20T20:17:00Z'), { count: 1, unit: 'W' });
		assert.strictEqual(new Date(bucket).getUTCDay(), 1);
		assert.ok(bucket <= at('1969-07-20T20:17:00Z'));
	});

	test('a month bucket starts on the first, including a leap February', () => {
		assert.strictEqual(isoOf(bucketStart(at('2024-03-31T23:59:59Z'), { count: 1, unit: 'M' })), '2024-03-01T00:00:00.000Z');
		assert.strictEqual(isoOf(bucketStart(at('2024-02-29T12:00:00Z'), { count: 1, unit: 'M' })), '2024-02-01T00:00:00.000Z');
	});

	test('months do not drift decades from the epoch', () => {
		assert.strictEqual(isoOf(bucketStart(at('2031-11-17T00:00:00Z'), { count: 1, unit: 'M' })), '2031-11-01T00:00:00.000Z');
	});

	test('a three-month bucket lands on the quarter', () => {
		assert.strictEqual(isoOf(bucketStart(at('2024-05-02T00:00:00Z'), { count: 3, unit: 'M' })), '2024-04-01T00:00:00.000Z');
	});

	test('a six-month bucket lands on January or July', () => {
		assert.strictEqual(isoOf(bucketStart(at('2024-05-02T00:00:00Z'), { count: 6, unit: 'M' })), '2024-01-01T00:00:00.000Z');
		assert.strictEqual(isoOf(bucketStart(at('2024-08-19T00:00:00Z'), { count: 6, unit: 'M' })), '2024-07-01T00:00:00.000Z');
	});

	test('a twelve-month bucket is the calendar year', () => {
		// Not "360 days from wherever the data starts": the count divides a year-aligned month
		// index, so every yearly candle opens on the 1st of January whatever the series contains.
		assert.strictEqual(isoOf(bucketStart(at('2024-08-19T00:00:00Z'), { count: 12, unit: 'M' })), '2024-01-01T00:00:00.000Z');
		assert.strictEqual(isoOf(bucketStart(at('2024-12-31T23:59:59Z'), { count: 12, unit: 'M' })), '2024-01-01T00:00:00.000Z');
		assert.strictEqual(isoOf(bucketStart(at('2025-01-01T00:00:00Z'), { count: 12, unit: 'M' })), '2025-01-01T00:00:00.000Z');
	});
});

suite('resampling', () => {

	/** Twelve hourly bars from midnight, walking upward one unit an hour. */
	const hourly: Bar[] = Array.from({ length: 12 }, (_, i) => ({
		time: Date.parse('2024-03-14T00:00:00Z') + i * 3_600_000,
		open: 100 + i, high: 100 + i + 0.5, low: 100 + i - 0.5, close: 100 + i + 0.25, volume: 1,
	}));

	test('a bucket spans its members rather than sampling one of them', () => {
		const [first] = resample(hourly, { count: 4, unit: 'h' });
		assert.ok(first);
		assert.strictEqual(first.open, 100, 'opens at the first bar of the bucket');
		assert.strictEqual(first.close, 103.25, 'closes at the last bar of the bucket');
		assert.strictEqual(first.high, 103.5, 'high spans the whole bucket');
		assert.strictEqual(first.low, 99.5, 'low spans the whole bucket');
		assert.strictEqual(first.volume, 4, 'volume sums');
	});

	test('a bar is stamped with the start of its bucket', () => {
		assert.strictEqual(
			new Date(resample(hourly, { count: 4, unit: 'h' })[0]!.time).toISOString(),
			'2024-03-14T00:00:00.000Z');
	});

	test('twelve hourly bars make three four-hour bars', () => {
		assert.strictEqual(resample(hourly, { count: 4, unit: 'h' }).length, 3);
	});

	test('a gap produces no candle rather than a flat one', () => {
		// A market that was closed did not trade at its previous close, and drawing that would
		// invent a session that never happened.
		const gapped = [hourly[0]!, hourly[1]!, hourly[10]!, hourly[11]!];
		assert.strictEqual(resample(gapped, { count: 4, unit: 'h' }).length, 2);
	});

	test('nothing in, nothing out', () => {
		assert.deepStrictEqual(resample([], { count: 4, unit: 'h' }), []);
	});
});

/**
 * Intraday bars belong to a session, not to the epoch.
 *
 * A venue opening at 09:30 New York does not start its four-hour bars at midnight UTC. Getting
 * this wrong is invisible on crypto - which has no session - and quietly wrong on every equity,
 * which is the worst combination to leave untested.
 */
suite('session alignment', () => {

	const NYSE: Alignment = { session: { open: 570, timeZone: 'America/New_York' }, weekStart: 1 };
	const at = (iso: string) => Date.parse(iso);
	const isoOf = (time: number) => new Date(time).toISOString();

	test('an intraday bucket starts when trading does, not at midnight UTC', () => {
		// 2024-04-10 is EDT, so 09:30 New York is 13:30 UTC - the example in TradingView's own docs.
		assert.strictEqual(
			isoOf(bucketStart(at('2024-04-10T13:30:00Z'), { count: 5, unit: 'm' }, NYSE)),
			'2024-04-10T13:30:00.000Z');
		assert.strictEqual(
			isoOf(bucketStart(at('2024-04-10T15:45:00Z'), { count: 4, unit: 'h' }, NYSE)),
			'2024-04-10T13:30:00.000Z');
	});

	test('the offset follows daylight saving rather than being fixed', () => {
		// January is EST, so the same 09:30 open is 14:30 UTC.
		assert.strictEqual(
			isoOf(bucketStart(at('2024-01-10T15:45:00Z'), { count: 4, unit: 'h' }, NYSE)),
			'2024-01-10T14:30:00.000Z');
	});

	test('a four-hour bar does not span the overnight gap', () => {
		// 18:00 UTC is inside 2024-04-10's second bucket; 13:35 the next day is a new session,
		// not a continuation of it.
		const evening = bucketStart(at('2024-04-10T18:00:00Z'), { count: 4, unit: 'h' }, NYSE);
		const nextMorning = bucketStart(at('2024-04-11T13:35:00Z'), { count: 4, unit: 'h' }, NYSE);
		assert.notStrictEqual(evening, nextMorning);
		assert.strictEqual(isoOf(nextMorning), '2024-04-11T13:30:00.000Z');
	});

	test('a bar before the open belongs to the session before it', () => {
		const preMarket = bucketStart(at('2024-04-10T11:00:00Z'), { count: 1, unit: 'h' }, NYSE);
		assert.ok(preMarket < at('2024-04-10T13:30:00Z'), 'not pulled forward into the coming session');
	});

	test('daily and above ignore the session, as the convention requires', () => {
		// A daily bar is stamped midnight UTC on its trading date whatever timezone the exchange
		// is in, so passing a session must not shift it.
		for (const interval of [{ count: 1, unit: 'D' as const }, { count: 1, unit: 'W' as const }, { count: 1, unit: 'M' as const }]) {
			assert.strictEqual(
				bucketStart(at('2024-04-10T13:30:00Z'), interval, NYSE),
				bucketStart(at('2024-04-10T13:30:00Z'), interval),
				`${interval.count}${interval.unit} should not move with a session`);
		}
	});

	test('a continuous venue is unaffected, which is why crypto passes no session', () => {
		assert.strictEqual(
			isoOf(bucketStart(at('2024-04-10T15:45:00Z'), { count: 4, unit: 'h' })),
			'2024-04-10T12:00:00.000Z');
	});

	test('an unknown timezone falls back to UTC rather than throwing', () => {
		const nonsense: Alignment = { session: { open: 570, timeZone: 'Mars/Olympus_Mons' }, weekStart: 1 };
		assert.doesNotThrow(() => bucketStart(at('2024-04-10T15:45:00Z'), { count: 4, unit: 'h' }, nonsense));
	});

	test('exchange pairs get no session and tickers get New York', () => {
		assert.strictEqual(alignmentFor('BTC-USD').session, undefined);
		assert.strictEqual(alignmentFor('AAPL').session?.timeZone, 'America/New_York');
	});

	test('both markets declare a week start rather than inheriting one', () => {
		assert.strictEqual(alignmentFor('BTC-USD').weekStart, 1);
		assert.strictEqual(alignmentFor('AAPL').weekStart, 1);
	});
});

suite('choosing a base granularity', () => {

	const AVAILABLE = ['1m', '5m', '15m', '1h', '1d'] as const;

	test('the largest base that divides the target evenly', () => {
		assert.strictEqual(baseFor({ count: 4, unit: 'h' }, AVAILABLE), '1h');
		assert.strictEqual(baseFor({ count: 30, unit: 'm' }, AVAILABLE), '15m');
		assert.strictEqual(baseFor({ count: 10, unit: 'm' }, AVAILABLE), '5m');
	});

	test('evenness beats size, or a bucket boundary falls inside a source candle', () => {
		// 45m from 1h would split an hourly bar, so 15m is correct despite being smaller.
		assert.strictEqual(baseFor({ count: 45, unit: 'm' }, AVAILABLE), '15m');
	});

	test('calendar intervals build from days', () => {
		assert.strictEqual(baseFor({ count: 1, unit: 'W' }, AVAILABLE), '1d');
		assert.strictEqual(baseFor({ count: 1, unit: 'M' }, AVAILABLE), '1d');
	});

	test('an interval a source serves outright needs no aggregation', () => {
		assert.strictEqual(baseFor({ count: 5, unit: 'm' }, AVAILABLE), '5m');
		assert.strictEqual(baseFor({ count: 1, unit: 'D' }, AVAILABLE), '1d', 'the picker says 1D where a feed says 1d');
	});

	test('nothing is invented when no base divides the target', () => {
		assert.strictEqual(baseFor({ count: 7, unit: 'm' }, ['5m', '15m']), undefined);
		assert.strictEqual(baseFor({ count: 30, unit: 's' }, AVAILABLE), undefined);
		assert.strictEqual(baseFor({ count: 1, unit: 'h' }, []), undefined);
	});

	test('daily and above are never stitched out of intraday bars', () => {
		// Arithmetically 1h divides a day, but a daily candle is one session - building it from
		// intraday would drop the pre-market and invent candles on holidays.
		for (const unit of ['D', 'W', 'M'] as const) {
			assert.strictEqual(baseFor({ count: 1, unit }, ['1m', '5m', '15m', '1h']), undefined,
				`${unit} must not be built from intraday data`);
			assert.strictEqual(baseFor({ count: 1, unit }, ['1h', '1d']), '1d');
		}
	});

	test('enough base bars are asked for to fill the buckets', () => {
		assert.strictEqual(baseCountFor({ count: 4, unit: 'h' }, '1h', 240), 960);
		assert.strictEqual(baseCountFor({ count: 1, unit: 'W' }, '1d', 240), 1680);
	});

	test('derivability is parsing and base selection together', () => {
		assert.strictEqual(isDerivable('4h', AVAILABLE), true);
		assert.strictEqual(isDerivable('30s', AVAILABLE), false);
		assert.strictEqual(isDerivable('not-an-interval', AVAILABLE), false);
	});
});

/**
 * The picker offers what can be *built*, not what is published - which is the whole point of the
 * resampler. A feed stopping at 1h still supports 2h, 3h and 4h.
 */
suite('offered intervals', () => {

	const source = (name: string, timeframes: readonly string[], claims = () => true) =>
		({ name, provenance: 'history', claims, timeframes: () => timeframes, history: async () => ({ kind: 'absent', reason: '' }) }) as unknown as HistorySource;

	const coinbase = source('coinbase', ['1m', '5m', '15m', '1h', '1d']);
	const equities = source('bars', ['5m', '15m', '1h', '1d']);
	const daemon = source('daemon', ['1s', '5s', '1m', '5m', '15m', '1h', '1d']);

	test('broader intervals appear even though no source publishes them', () => {
		const offered = availableTimeframes([coinbase], 'BTC-USD', '5m');
		for (const value of ['2m', '3m', '10m', '30m', '45m', '2h', '3h', '4h', '1D', '1W', '1M', '3M', '6M', '12M']) {
			assert.ok(offered.includes(value), `expected ${value} to be offered`);
		}
	});

	test('the month group runs to a year', () => {
		const offered = availableTimeframes([coinbase], 'BTC-USD', '5m');
		assert.strictEqual(offered[offered.length - 1], '12M', 'the longest interval sorts last');
	});

	test('nothing finer than the finest base is offered', () => {
		const offered = availableTimeframes([equities], 'AAPL', '5m');
		for (const value of ['1m', '2m', '3m']) {
			assert.ok(!offered.includes(value), `${value} cannot be built from 5m bars`);
		}
	});

	test('seconds appear only when something serves them', () => {
		assert.ok(!availableTimeframes([coinbase], 'BTC-USD', '5m').includes('15s'));
		assert.ok(availableTimeframes([daemon], 'BTC-USD', '5m').includes('15s'));
	});

	test('the list is ordered by duration', () => {
		const offered = availableTimeframes([coinbase], 'BTC-USD', '5m');
		const spans = offered.map(timeframeToMillis);
		assert.deepStrictEqual(spans, [...spans].sort((a, b) => a - b));
	});

	test('a custom interval is offered when it can be built, and not when it cannot', () => {
		assert.ok(availableTimeframes([coinbase], 'BTC-USD', '5m', ['90m']).includes('90m'));
		assert.ok(!availableTimeframes([equities], 'AAPL', '5m', ['7m']).includes('7m'));
	});

	test('the interval a document is already on is always listed', () => {
		// Otherwise the picker reads as broken rather than as narrowed, and the chart already
		// says plainly that no source can fill it.
		assert.ok(availableTimeframes([equities], 'AAPL', '1m').includes('1m'));
	});

	test('one interval spelled two ways is one entry', () => {
		const offered = availableTimeframes([coinbase], 'BTC-USD', '1d');
		assert.strictEqual(offered.filter(value => value.toLowerCase() === '1d').length, 1);
		assert.ok(offered.includes('1D'), 'the canonical spelling is the one kept');
	});
});
