/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Bar } from './protocol';

/**
 * Overlay indicators - those drawn on the price scale. Oscillators such as RSI or MACD need
 * their own pane with an independent scale and are not handled here.
 *
 * Every series is computed over the *whole* bar array and sliced for drawing afterwards.
 * Computing over the visible window instead would restart the average at the left edge of the
 * viewport, so scrolling would silently change the values.
 */

export type IndicatorType = 'sma' | 'ema' | 'bbands' | 'vwap';

export interface IndicatorSpec {
	readonly type: IndicatorType;
	readonly period?: number;
	readonly stddev?: number;
	/** A `charts.*` colour token, resolved against the theme at draw time. */
	readonly color?: string;
}

/** A value per bar, index-aligned with the source series. `undefined` where undefined. */
export type Line = readonly (number | undefined)[];

export interface IndicatorSeries {
	readonly label: string;
	readonly color: string;
	readonly lines: readonly Line[];
	/** Bollinger bands shade between their outer lines; single-line indicators do not. */
	readonly fill: boolean;
}

const DEFAULT_COLORS = ['charts.blue', 'charts.yellow', 'charts.purple', 'charts.orange'];

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

export function computeIndicator(spec: IndicatorSpec, bars: readonly Bar[], index: number): IndicatorSeries | undefined {
	const color = spec.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]!;
	const closes = bars.map(bar => bar.close);
	const period = Math.max(2, Math.floor(spec.period ?? 20));

	switch (spec.type) {
		case 'sma':
			return { label: `SMA ${period}`, color, fill: false, lines: [simpleMovingAverage(closes, period)] };

		case 'ema':
			return { label: `EMA ${period}`, color, fill: false, lines: [exponentialMovingAverage(closes, period)] };

		case 'vwap':
			return { label: 'VWAP', color, fill: false, lines: [volumeWeightedAverage(bars)] };

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
			return {
				label: `BB ${period}/${deviations}`,
				color,
				fill: true,
				lines: [upper, middle, lower],
			};
		}

		default:
			return undefined;
	}
}
