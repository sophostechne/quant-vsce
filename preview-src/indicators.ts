/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Bar } from './protocol';

/**
 * Indicators split into two kinds, and the difference is structural rather than cosmetic.
 *
 * Overlays (SMA, EMA, Bollinger, VWAP) are prices, so they share the candles' scale. Studies
 * (RSI, MACD, Stochastic, ATR, Volume) are not prices - an RSI of 70 and a price of 70 have
 * nothing to do with each other - so each gets its own pane with an independent scale.
 *
 * Every series is computed over the *whole* bar array and sliced for drawing afterwards.
 * Computing over the visible window instead would restart the average at the left edge of the
 * viewport, so scrolling would silently change the values.
 */

export type IndicatorType =
	| 'sma' | 'ema' | 'bbands' | 'vwap'
	| 'rsi' | 'macd' | 'stoch' | 'atr' | 'volume';

export const OVERLAY_TYPES: readonly IndicatorType[] = ['sma', 'ema', 'bbands', 'vwap'];

export interface IndicatorSpec {
	readonly type: IndicatorType;
	readonly period?: number;
	readonly stddev?: number;
	/** MACD only: fast, slow and signal periods. */
	readonly fast?: number;
	readonly slow?: number;
	readonly signal?: number;
	/** A `charts.*` colour token, resolved against the theme at draw time. */
	readonly color?: string;
}

/** A value per bar, index-aligned with the source series. `undefined` where undefined. */
export type Line = readonly (number | undefined)[];

export interface IndicatorSeries {
	readonly label: string;
	readonly color: string;
	readonly lines: readonly Line[];
	/** Shade between the first and last line, as Bollinger bands do. */
	readonly fill: boolean;
	/** Overlays share the price scale; studies get a pane of their own. */
	readonly overlay: boolean;
	/** Fixed pane bounds, for indicators with a natural range such as RSI. */
	readonly range?: { readonly min: number; readonly max: number };
	/** Reference levels drawn across the pane, e.g. RSI 30/70. */
	readonly guides?: readonly number[];
	/** Drawn as columns rather than a line. Volume and the MACD histogram use this. */
	readonly histogram?: Line;
	/** Colour histogram columns by bar direction rather than the series colour. */
	readonly histogramByBar?: boolean;
}

const DEFAULT_COLORS = ['charts.blue', 'charts.yellow', 'charts.purple', 'charts.orange'];

// -- Primitives --------------------------------------------------------------------------

export function simpleMovingAverage(values: readonly number[], period: number): Line {
	const out: (number | undefined)[] = new Array(values.length);
	let sum = 0;
	for (let i = 0; i < values.length; i++) {
		sum += values[i]!;
		if (i >= period) {
			sum -= values[i - period]!;
		}
		out[i] = i >= period - 1 ? sum / period : undefined;
	}
	return out;
}

/**
 * Seeded with the SMA of the first `period` values rather than the first value alone, so the
 * curve does not spend its first hundred bars converging from an arbitrary starting point.
 */
export function exponentialMovingAverage(values: readonly number[], period: number): Line {
	const out: (number | undefined)[] = new Array(values.length);
	if (values.length < period) {
		return out;
	}
	const multiplier = 2 / (period + 1);
	let seed = 0;
	for (let i = 0; i < period; i++) {
		seed += values[i]!;
	}
	let previous = seed / period;
	out[period - 1] = previous;
	for (let i = period; i < values.length; i++) {
		previous = (values[i]! - previous) * multiplier + previous;
		out[i] = previous;
	}
	return out;
}

/** Population standard deviation over a trailing window, matching the usual band convention. */
function rollingStdDev(values: readonly number[], period: number, means: Line): Line {
	const out: (number | undefined)[] = new Array(values.length);
	for (let i = period - 1; i < values.length; i++) {
		const mean = means[i];
		if (mean === undefined) {
			continue;
		}
		let sum = 0;
		for (let j = i - period + 1; j <= i; j++) {
			const delta = values[j]! - mean;
			sum += delta * delta;
		}
		out[i] = Math.sqrt(sum / period);
	}
	return out;
}

/**
 * Volume-weighted average price across the whole loaded series.
 *
 * Real VWAP resets each session; the chart has no session boundaries, so this is a running
 * average over whatever range is loaded. Useful as a reference line, not equivalent to a
 * venue's session VWAP.
 */
export function volumeWeightedAverage(bars: readonly Bar[]): Line {
	const out: (number | undefined)[] = new Array(bars.length);
	let cumulativePV = 0;
	let cumulativeVolume = 0;
	for (let i = 0; i < bars.length; i++) {
		const bar = bars[i]!;
		const typical = (bar.high + bar.low + bar.close) / 3;
		cumulativePV += typical * bar.volume;
		cumulativeVolume += bar.volume;
		out[i] = cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : undefined;
	}
	return out;
}

/**
 * Wilder's RSI. Uses his smoothing (a running average with 1/period weight), not a simple
 * mean of gains and losses - the two diverge noticeably and every charting package uses his.
 */
export function relativeStrengthIndex(closes: readonly number[], period: number): Line {
	const out: (number | undefined)[] = new Array(closes.length);
	if (closes.length <= period) {
		return out;
	}
	let gains = 0;
	let losses = 0;
	for (let i = 1; i <= period; i++) {
		const delta = closes[i]! - closes[i - 1]!;
		if (delta >= 0) { gains += delta; } else { losses -= delta; }
	}
	let averageGain = gains / period;
	let averageLoss = losses / period;
	out[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);

	for (let i = period + 1; i < closes.length; i++) {
		const delta = closes[i]! - closes[i - 1]!;
		const gain = delta > 0 ? delta : 0;
		const loss = delta < 0 ? -delta : 0;
		averageGain = (averageGain * (period - 1) + gain) / period;
		averageLoss = (averageLoss * (period - 1) + loss) / period;
		out[i] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
	}
	return out;
}

/** Wilder's ATR: true range smoothed the same way RSI's averages are. */
export function averageTrueRange(bars: readonly Bar[], period: number): Line {
	const out: (number | undefined)[] = new Array(bars.length);
	if (bars.length <= period) {
		return out;
	}
	const trueRanges: number[] = new Array(bars.length);
	trueRanges[0] = bars[0]!.high - bars[0]!.low;
	for (let i = 1; i < bars.length; i++) {
		const bar = bars[i]!;
		const previousClose = bars[i - 1]!.close;
		trueRanges[i] = Math.max(
			bar.high - bar.low,
			Math.abs(bar.high - previousClose),
			Math.abs(bar.low - previousClose),
		);
	}
	let sum = 0;
	for (let i = 1; i <= period; i++) {
		sum += trueRanges[i]!;
	}
	let previous = sum / period;
	out[period] = previous;
	for (let i = period + 1; i < bars.length; i++) {
		previous = (previous * (period - 1) + trueRanges[i]!) / period;
		out[i] = previous;
	}
	return out;
}

/** Stochastic %K over `period`, with %D as its 3-period simple average. */
export function stochastic(bars: readonly Bar[], period: number): { k: Line; d: Line } {
	const k: (number | undefined)[] = new Array(bars.length);
	for (let i = period - 1; i < bars.length; i++) {
		let highest = -Infinity;
		let lowest = Infinity;
		for (let j = i - period + 1; j <= i; j++) {
			highest = Math.max(highest, bars[j]!.high);
			lowest = Math.min(lowest, bars[j]!.low);
		}
		const span = highest - lowest;
		k[i] = span === 0 ? 50 : ((bars[i]!.close - lowest) / span) * 100;
	}
	// %D smooths %K, so it must average the defined values only.
	const d: (number | undefined)[] = new Array(bars.length);
	for (let i = 0; i < bars.length; i++) {
		const a = k[i]; const b = k[i - 1]; const c = k[i - 2];
		if (a !== undefined && b !== undefined && c !== undefined) {
			d[i] = (a + b + c) / 3;
		}
	}
	return { k, d };
}

// -- Assembly ----------------------------------------------------------------------------

export function computeIndicator(spec: IndicatorSpec, bars: readonly Bar[], index: number): IndicatorSeries | undefined {
	const color = spec.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]!;
	const closes = bars.map(bar => bar.close);
	const period = Math.max(2, Math.floor(spec.period ?? defaultPeriod(spec.type)));

	switch (spec.type) {
		case 'sma':
			return { label: `SMA ${period}`, color, fill: false, overlay: true, lines: [simpleMovingAverage(closes, period)] };

		case 'ema':
			return { label: `EMA ${period}`, color, fill: false, overlay: true, lines: [exponentialMovingAverage(closes, period)] };

		case 'vwap':
			return { label: 'VWAP', color, fill: false, overlay: true, lines: [volumeWeightedAverage(bars)] };

		case 'bbands': {
			const deviations = spec.stddev ?? 2;
			const middle = simpleMovingAverage(closes, period);
			const sigma = rollingStdDev(closes, period, middle);
			const upper = middle.map((mean, i) => {
				const s = sigma[i];
				return mean === undefined || s === undefined ? undefined : mean + deviations * s;
			});
			const lower = middle.map((mean, i) => {
				const s = sigma[i];
				return mean === undefined || s === undefined ? undefined : mean - deviations * s;
			});
			return { label: `BB ${period}/${deviations}`, color, fill: true, overlay: true, lines: [upper, middle, lower] };
		}

		case 'rsi':
			return {
				label: `RSI ${period}`, color, fill: false, overlay: false,
				lines: [relativeStrengthIndex(closes, period)],
				range: { min: 0, max: 100 },
				guides: [30, 70],
			};

		case 'stoch': {
			const { k, d } = stochastic(bars, period);
			return {
				label: `Stoch ${period}`, color, fill: false, overlay: false,
				lines: [k, d],
				range: { min: 0, max: 100 },
				guides: [20, 80],
			};
		}

		case 'atr':
			return { label: `ATR ${period}`, color, fill: false, overlay: false, lines: [averageTrueRange(bars, period)] };

		case 'macd': {
			const fast = Math.max(2, Math.floor(spec.fast ?? 12));
			const slow = Math.max(fast + 1, Math.floor(spec.slow ?? 26));
			const signalPeriod = Math.max(2, Math.floor(spec.signal ?? 9));
			const fastLine = exponentialMovingAverage(closes, fast);
			const slowLine = exponentialMovingAverage(closes, slow);
			const macd = fastLine.map((f, i) => {
				const s = slowLine[i];
				return f === undefined || s === undefined ? undefined : f - s;
			});
			// The signal line is an EMA of the MACD, which only exists once the slow EMA does.
			const defined = macd.filter((value): value is number => value !== undefined);
			const signalDefined = exponentialMovingAverage(defined, signalPeriod);
			const firstDefined = macd.findIndex(value => value !== undefined);
			const signal: (number | undefined)[] = new Array(macd.length);
			for (let i = 0; i < signalDefined.length; i++) {
				signal[firstDefined + i] = signalDefined[i];
			}
			const histogram = macd.map((value, i) => {
				const s = signal[i];
				return value === undefined || s === undefined ? undefined : value - s;
			});
			return {
				label: `MACD ${fast}/${slow}/${signalPeriod}`, color, fill: false, overlay: false,
				lines: [macd, signal],
				histogram,
			};
		}

		case 'volume':
			return {
				label: 'Volume', color, fill: false, overlay: false,
				lines: [],
				histogram: bars.map(bar => bar.volume),
				histogramByBar: true,
			};

		default:
			return undefined;
	}
}

export function defaultPeriod(type: IndicatorType): number {
	switch (type) {
		case 'rsi': return 14;
		case 'atr': return 14;
		case 'stoch': return 14;
		case 'sma': return 50;
		case 'ema': return 20;
		case 'bbands': return 20;
		default: return 20;
	}
}
