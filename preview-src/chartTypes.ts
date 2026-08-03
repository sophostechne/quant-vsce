/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Bar } from './protocol';

/**
 * Chart styles fall into two groups, and the distinction matters more than it looks.
 *
 * Most are *renderings*: candles, bars, line, area and so on draw the same series a different
 * way, so one bar in equals one column out and the time axis is untouched.
 *
 * A few are *re-aggregations*: Heikin Ashi rewrites each bar's OHLC, while Renko, Line Break
 * and Range bars replace the series entirely - a brick is emitted when price moves far enough,
 * not when a period ends. Those produce a different number of bars at irregular intervals.
 * Each synthetic bar keeps the timestamp of the bar that completed it, so the time axis and
 * crosshair still read correctly, but the spacing is no longer uniform. That is inherent to
 * the style, not a defect.
 *
 * Indicators run on the transformed series, which is what other platforms do too - an EMA on a
 * Renko chart is an EMA of the bricks.
 */

export type ChartStyle =
	| 'candles' | 'hollow' | 'bars' | 'volumeCandles' | 'highLow'
	| 'line' | 'stepLine' | 'area' | 'hlcArea' | 'baseline' | 'columns'
	| 'heikinAshi' | 'renko' | 'lineBreak' | 'rangeBars';

export interface StyleOptions {
	/** Brick size for Renko and Range bars, as a percentage of price when not given absolutely. */
	readonly brickSize?: number;
	/** Number of prior lines a reversal must exceed, for Line Break. */
	readonly lineBreakCount?: number;
	/** Reference level for the baseline style; defaults to the midpoint of the series. */
	readonly baselineValue?: number;
}

/** Styles that replace the series rather than just drawing it differently. */
export const TRANSFORM_STYLES: readonly ChartStyle[] = ['heikinAshi', 'renko', 'lineBreak', 'rangeBars'];

export interface Palette {
	readonly up: string;
	readonly down: string;
	readonly text: string;
}

// -- Transforms ---------------------------------------------------------------------------

/**
 * Heikin Ashi. Close is the bar's average price and open is the midpoint of the previous
 * synthetic bar, which is what smooths the series - and what makes its opens and closes not
 * real traded prices. Volume and timestamps pass through unchanged.
 */
export function heikinAshi(bars: readonly Bar[]): Bar[] {
	const out: Bar[] = [];
	for (let i = 0; i < bars.length; i++) {
		const bar = bars[i]!;
		const close = (bar.open + bar.high + bar.low + bar.close) / 4;
		const previous = out[i - 1];
		const open = previous ? (previous.open + previous.close) / 2 : (bar.open + bar.close) / 2;
		out.push({
			time: bar.time,
			open,
			close,
			high: Math.max(bar.high, open, close),
			low: Math.min(bar.low, open, close),
			volume: bar.volume,
		});
	}
	return out;
}

/** Absolute brick size, defaulting to a fraction of the median price so it suits any market. */
function resolveBrickSize(bars: readonly Bar[], options: StyleOptions): number {
	if (options.brickSize && options.brickSize > 0) {
		return options.brickSize;
	}
	const closes = bars.map(bar => bar.close).sort((a, b) => a - b);
	const median = closes[Math.floor(closes.length / 2)] ?? 1;
	return Math.max(median * 0.001, Number.EPSILON);
}

/**
 * Renko. A brick is emitted each time price closes a full brick beyond the last one, so runs
 * produce many bricks and quiet stretches produce none.
 */
export function renko(bars: readonly Bar[], options: StyleOptions): Bar[] {
	if (bars.length === 0) {
		return [];
	}
	const size = resolveBrickSize(bars, options);
	const out: Bar[] = [];
	let anchor = bars[0]!.close;

	for (const bar of bars) {
		let moved = bar.close - anchor;
		// A single period can span several bricks; emit one per full step.
		while (Math.abs(moved) >= size) {
			const direction = moved > 0 ? 1 : -1;
			const open = anchor;
			const close = anchor + direction * size;
			out.push({
				time: bar.time,
				open,
				close,
				high: Math.max(open, close),
				low: Math.min(open, close),
				volume: bar.volume,
			});
			anchor = close;
			moved = bar.close - anchor;
			if (out.length > 5000) {
				return out; // Guard against a pathological brick size flooding the renderer.
			}
		}
	}
	return out;
}

/**
 * Range bars. A bar completes once its own high-to-low span reaches the range, so each bar
 * covers an equal amount of price movement rather than an equal amount of time.
 */
export function rangeBars(bars: readonly Bar[], options: StyleOptions): Bar[] {
	if (bars.length === 0) {
		return [];
	}
	const size = resolveBrickSize(bars, options);
	const out: Bar[] = [];
	let current: Bar | undefined;

	for (const bar of bars) {
		if (!current) {
			current = { ...bar };
		} else {
			current = {
				time: bar.time,
				open: current.open,
				high: Math.max(current.high, bar.high),
				low: Math.min(current.low, bar.low),
				close: bar.close,
				volume: current.volume + bar.volume,
			};
		}
		if (current.high - current.low >= size) {
			out.push(current);
			current = undefined;
		}
	}
	if (current) {
		out.push(current); // The in-progress bar, so the chart reaches the present.
	}
	return out;
}

/**
 * Line Break. A new line is drawn only when the close exceeds the extreme of the previous
 * `count` lines, so noise inside that band produces nothing at all.
 */
export function lineBreak(bars: readonly Bar[], options: StyleOptions): Bar[] {
	const count = Math.max(1, Math.floor(options.lineBreakCount ?? 3));
	const out: Bar[] = [];

	for (const bar of bars) {
		if (out.length === 0) {
			out.push({ ...bar, open: bar.open, close: bar.close });
			continue;
		}
		const recent = out.slice(-count);
		const highest = Math.max(...recent.map(line => Math.max(line.open, line.close)));
		const lowest = Math.min(...recent.map(line => Math.min(line.open, line.close)));
		const previous = out[out.length - 1]!;

		if (bar.close > highest) {
			const open = Math.max(previous.open, previous.close);
			out.push({ time: bar.time, open, close: bar.close, high: bar.close, low: open, volume: bar.volume });
		} else if (bar.close < lowest) {
			const open = Math.min(previous.open, previous.close);
			out.push({ time: bar.time, open, close: bar.close, high: open, low: bar.close, volume: bar.volume });
		}
	}
	return out;
}

/** Applies whichever transform the style implies; identity for pure renderings. */
export function transformBars(style: ChartStyle, bars: readonly Bar[], options: StyleOptions): Bar[] {
	switch (style) {
		case 'heikinAshi': return heikinAshi(bars);
		case 'renko': return renko(bars, options);
		case 'rangeBars': return rangeBars(bars, options);
		case 'lineBreak': return lineBreak(bars, options);
		default: return bars as Bar[];
	}
}

// -- Renderers ----------------------------------------------------------------------------

interface DrawContext {
	readonly context: CanvasRenderingContext2D;
	readonly visible: readonly Bar[];
	readonly slot: number;
	readonly plotWidth: number;
	readonly toY: (price: number) => number;
	readonly palette: Palette;
	/** True when bars are too narrow for a body to be legible. */
	readonly dense: boolean;
	readonly baseY: number;
}

export function drawPriceSeries(style: ChartStyle, draw: DrawContext, options: StyleOptions): void {
	switch (style) {
		case 'line': return drawLine(draw, false);
		case 'stepLine': return drawLine(draw, true);
		case 'area': return drawArea(draw, false);
		case 'hlcArea': return drawHlcArea(draw);
		case 'baseline': return drawBaseline(draw, options);
		case 'columns': return drawColumns(draw);
		case 'bars': return drawOhlcBars(draw);
		case 'highLow': return drawHighLow(draw);
		case 'hollow': return drawCandles(draw, 'hollow');
		case 'volumeCandles': return drawCandles(draw, 'volume');
		default: return drawCandles(draw, 'filled');
	}
}

function colorFor(bar: Bar, previous: Bar | undefined, palette: Palette, byPreviousClose: boolean): string {
	if (byPreviousClose && previous) {
		return bar.close >= previous.close ? palette.up : palette.down;
	}
	return bar.close >= bar.open ? palette.up : palette.down;
}

/**
 * Candles in three variants. Hollow candles colour by direction against the *previous close*
 * and leave rising bodies unfilled, which is the convention - filling them would make the
 * style indistinguishable from ordinary candles.
 */
function drawCandles(draw: DrawContext, variant: 'filled' | 'hollow' | 'volume'): void {
	const { context, visible, slot, toY, palette, dense } = draw;

	let maxVolume = 0;
	if (variant === 'volume') {
		for (const bar of visible) {
			maxVolume = Math.max(maxVolume, bar.volume);
		}
	}

	for (let i = 0; i < visible.length; i++) {
		const bar = visible[i]!;
		const previous = visible[i - 1];
		const color = colorFor(bar, previous, palette, variant === 'hollow');
		const x = i * slot + slot / 2;

		context.strokeStyle = color;
		context.fillStyle = color;

		context.beginPath();
		context.moveTo(Math.round(x) + 0.5, toY(bar.high));
		context.lineTo(Math.round(x) + 0.5, toY(bar.low));
		context.stroke();

		if (dense) {
			continue;
		}

		// Volume candles encode size in width, so a heavy bar reads as heavy at a glance.
		const widthScale = variant === 'volume' && maxVolume > 0
			? 0.25 + 0.75 * (bar.volume / maxVolume)
			: 1;
		const bodyWidth = Math.max(1, Math.min(slot * 0.7, 12) * widthScale);

		const openY = toY(bar.open);
		const closeY = toY(bar.close);
		const top = Math.min(openY, closeY);
		const height = Math.max(1, Math.abs(closeY - openY));

		if (variant === 'hollow' && bar.close >= bar.open) {
			context.lineWidth = 1;
			context.strokeRect(x - bodyWidth / 2 + 0.5, top + 0.5, bodyWidth - 1, height - 1);
		} else {
			context.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
		}
	}
}

/** Open tick left, close tick right, range vertical - the classic OHLC bar. */
function drawOhlcBars(draw: DrawContext): void {
	const { context, visible, slot, toY, palette } = draw;
	const tick = Math.max(1, Math.min(slot * 0.35, 6));

	for (let i = 0; i < visible.length; i++) {
		const bar = visible[i]!;
		const x = Math.round(i * slot + slot / 2) + 0.5;
		context.strokeStyle = colorFor(bar, visible[i - 1], palette, false);
		context.beginPath();
		context.moveTo(x, toY(bar.high));
		context.lineTo(x, toY(bar.low));
		context.moveTo(x - tick, toY(bar.open));
		context.lineTo(x, toY(bar.open));
		context.moveTo(x, toY(bar.close));
		context.lineTo(x + tick, toY(bar.close));
		context.stroke();
	}
}

function drawHighLow(draw: DrawContext): void {
	const { context, visible, slot, toY, palette } = draw;
	for (let i = 0; i < visible.length; i++) {
		const bar = visible[i]!;
		const x = Math.round(i * slot + slot / 2) + 0.5;
		context.strokeStyle = colorFor(bar, visible[i - 1], palette, false);
		context.beginPath();
		context.moveTo(x, toY(bar.high));
		context.lineTo(x, toY(bar.low));
		context.stroke();
	}
}

function drawColumns(draw: DrawContext): void {
	const { context, visible, slot, toY, palette, baseY } = draw;
	const width = Math.max(1, slot * 0.6);
	for (let i = 0; i < visible.length; i++) {
		const bar = visible[i]!;
		const x = i * slot + slot / 2;
		const y = toY(bar.close);
		context.fillStyle = colorFor(bar, visible[i - 1], palette, true);
		context.fillRect(x - width / 2, Math.min(y, baseY), width, Math.max(1, Math.abs(baseY - y)));
	}
}

function closePath(draw: DrawContext, step: boolean): void {
	const { context, visible, slot, toY } = draw;
	context.beginPath();
	for (let i = 0; i < visible.length; i++) {
		const x = i * slot + slot / 2;
		const y = toY(visible[i]!.close);
		if (i === 0) {
			context.moveTo(x, y);
		} else if (step) {
			// Hold the previous level to the new x, then step - a step line must not imply
			// prices it never traded at in between.
			context.lineTo(x, toY(visible[i - 1]!.close));
			context.lineTo(x, y);
		} else {
			context.lineTo(x, y);
		}
	}
}

function drawLine(draw: DrawContext, step: boolean): void {
	const { context, palette } = draw;
	context.strokeStyle = palette.up;
	context.lineWidth = 1.5;
	closePath(draw, step);
	context.stroke();
	context.lineWidth = 1;
}

function drawArea(draw: DrawContext, step: boolean): void {
	const { context, visible, slot, palette, baseY } = draw;
	if (visible.length === 0) {
		return;
	}
	closePath(draw, step);
	context.lineTo((visible.length - 1) * slot + slot / 2, baseY);
	context.lineTo(slot / 2, baseY);
	context.closePath();
	context.fillStyle = palette.up;
	context.globalAlpha = 0.15;
	context.fill();
	context.globalAlpha = 1;

	context.strokeStyle = palette.up;
	context.lineWidth = 1.5;
	closePath(draw, step);
	context.stroke();
	context.lineWidth = 1;
}

/** A high-low band with the close drawn through it. */
function drawHlcArea(draw: DrawContext): void {
	const { context, visible, slot, toY, palette } = draw;
	if (visible.length === 0) {
		return;
	}
	context.beginPath();
	for (let i = 0; i < visible.length; i++) {
		const x = i * slot + slot / 2;
		if (i === 0) { context.moveTo(x, toY(visible[i]!.high)); } else { context.lineTo(x, toY(visible[i]!.high)); }
	}
	for (let i = visible.length - 1; i >= 0; i--) {
		context.lineTo(i * slot + slot / 2, toY(visible[i]!.low));
	}
	context.closePath();
	context.fillStyle = palette.up;
	context.globalAlpha = 0.12;
	context.fill();
	context.globalAlpha = 1;

	context.strokeStyle = palette.text;
	context.lineWidth = 1.25;
	closePath(draw, false);
	context.stroke();
	context.lineWidth = 1;
}

/**
 * Baseline: the close line, coloured and shaded by which side of a reference level it is on.
 * Defaults to the midpoint of what is visible when no level is configured.
 */
function drawBaseline(draw: DrawContext, options: StyleOptions): void {
	const { context, visible, slot, toY, palette, plotWidth } = draw;
	if (visible.length === 0) {
		return;
	}
	const level = options.baselineValue
		?? (Math.max(...visible.map(b => b.close)) + Math.min(...visible.map(b => b.close))) / 2;
	const levelY = toY(level);

	for (const side of ['up', 'down'] as const) {
		context.save();
		context.beginPath();
		if (side === 'up') {
			context.rect(0, 0, plotWidth, levelY);
		} else {
			context.rect(0, levelY, plotWidth, 100000);
		}
		context.clip();

		closePath(draw, false);
		context.lineTo((visible.length - 1) * slot + slot / 2, levelY);
		context.lineTo(slot / 2, levelY);
		context.closePath();
		context.fillStyle = side === 'up' ? palette.up : palette.down;
		context.globalAlpha = 0.15;
		context.fill();
		context.globalAlpha = 1;

		context.strokeStyle = side === 'up' ? palette.up : palette.down;
		context.lineWidth = 1.5;
		closePath(draw, false);
		context.stroke();
		context.restore();
	}

	context.strokeStyle = palette.text;
	context.globalAlpha = 0.5;
	context.setLineDash([3, 3]);
	context.beginPath();
	context.moveTo(0, levelY);
	context.lineTo(plotWidth, levelY);
	context.stroke();
	context.setLineDash([]);
	context.globalAlpha = 1;
	context.lineWidth = 1;
}
