/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Bar, BarSource, FRAME_HEADER_BYTES, FRAME_TYPE_TICK, HostMessage, IndicatorSpec,
	TICK_RECORD_BYTES
} from './protocol';
import { IndicatorSeries, computeIndicator } from './indicators';
import { ChartStyle, StyleOptions, TRANSFORM_STYLES, drawPriceSeries, transformBars } from './chartTypes';
import { Drawing, DrawingTool, Projection, drawDrawings, hitTest, needsTwoPoints } from './drawings';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

const symbolInput = document.getElementById('symbol') as HTMLInputElement;
const timeframeSelect = document.getElementById('timeframe') as HTMLSelectElement;
const lastLabel = document.getElementById('last') as HTMLElement;
const statusLabel = document.getElementById('status') as HTMLElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const readoutLabel = document.getElementById('readout') as HTMLElement;
const legendLabel = document.getElementById('legend') as HTMLElement;
const context = canvas.getContext('2d')!;

/** As received from the host. */
let sourceBars: Bar[] = [];
/**
 * What is drawn and what indicators run on. Equal to `sourceBars` for per-bar styles; a
 * different series entirely for Renko, Line Break, Range and Heikin Ashi.
 */
let bars: Bar[] = [];
let chartStyle: ChartStyle = 'candles';
/** Applies to the price pane only; studies can be zero or negative. */
let priceScale: 'linear' | 'log' = 'linear';
let styleOptions: StyleOptions = {};
let symbolId = -1;
let lastPrice = 0;
let previousClose = 0;
let socket: WebSocket | undefined;
let repaintQueued = false;

// What is actually on screen, as opposed to what the transport is doing. The badge is derived
// from these: a connected socket is not evidence that these bars are real.
let barsSource: BarSource | undefined;
let barsError: string | undefined;
let dataPlaneHealthy = true;

// Indicators are recomputed only when the bars or the specs change, never per frame.
let indicatorSpecs: readonly IndicatorSpec[] = [];
let indicatorSeries: IndicatorSeries[] = [];
let indicatorsDirty = true;

/**
 * Re-derives the drawn series from the source bars. Runs whenever the style, its options or
 * the data change - a transform that re-aggregates cannot be applied at paint time, because
 * the bar count and therefore the whole viewport depend on it.
 */
function rebuildSeries(): void {
	const previousLength = bars.length;
	bars = transformBars(chartStyle, sourceBars, styleOptions);
	indicatorsDirty = true;
	// A transform changes how many bars exist, so a viewport measured in indices is no longer
	// meaningful. Reset to the full range rather than framing an arbitrary window.
	if (bars.length !== previousLength) {
		viewSize = bars.length;
		viewOffset = 0;
		following = true;
	}
	clampView();
}

function rebuildIndicators(): void {
	indicatorsDirty = false;
	indicatorSeries = bars.length === 0
		? []
		: indicatorSpecs
			.map((spec, index) => computeIndicator(spec, bars, index))
			.filter((series): series is IndicatorSeries => series !== undefined);
	renderLegend();
}

function renderLegend(atIndex?: number): void {
	legendLabel.replaceChildren();
	for (const series of indicatorSeries) {
		const chip = document.createElement('span');
		chip.className = 'legend-item';
		let text = series.label;
		if (atIndex !== undefined) {
			const values = series.lines
				.map(line => line[atIndex])
				.filter((value): value is number => value !== undefined)
				.map(value => formatValue(value));
			if (values.length > 0) {
				text += ` ${values.join('/')}`;
			}
		}
		chip.textContent = text;
		chip.style.color = `var(--vscode-${series.color.replace('.', '-')})`;
		legendLabel.appendChild(chip);
	}
}

// -- Viewport --------------------------------------------------------------------------
// The visible window, as an index range into `bars`. Panning and zooming move this rather
// than touching the data, so incoming ticks never fight the user's view.

const MIN_VISIBLE_BARS = 15;
/** Below this many pixels per bar, wicks and bodies stop being distinguishable. */
const MIN_SLOT_PX = 1.2;

let viewSize = 0;
let viewOffset = 0;
/** True while the right edge is pinned, so new bars scroll into view. Panning left releases it. */
let following = true;

interface Pointer { x: number; y: number }
let pointer: Pointer | undefined;
let dragOrigin: { x: number; offset: number } | undefined;

// -- Pane sizing -----------------------------------------------------------------------
// Fraction of the plot height per study pane; the price pane keeps the remainder. Empty
// means "even split", which is what an unconfigured chart uses.

const MIN_STUDY_FRACTION = 0.06;
const MIN_PRICE_FRACTION = 0.20;
/** Pixels either side of a boundary that count as grabbing it. */
const DIVIDER_HIT_PX = 6;

let paneFractions: number[] = [];
/** Boundaries from the last paint, so hit-testing matches what is on screen. */
let dividerYs: number[] = [];
let dividerDrag: { index: number; startY: number; before: number[] } | undefined;

// -- Drawings --------------------------------------------------------------------------

let drawings: Drawing[] = [];
let armedTool: DrawingTool | undefined;
/** In-progress drag; rendered as a preview until released. */
let pendingDrawing: Drawing | undefined;
let selectedDrawing: number | undefined;
/** Projection from the last paint, so hit-testing matches what is on screen. */
let projection: Projection | undefined;

function commitDrawings(): void {
	vscode.postMessage({ type: 'setDrawings', drawings });
}

/** Nearest bar to a timestamp, so an anchor always lands on a real bar. */
function indexForTime(time: number): number | undefined {
	if (bars.length === 0) {
		return undefined;
	}
	let best = 0;
	let bestDelta = Infinity;
	for (let i = 0; i < bars.length; i++) {
		const delta = Math.abs(bars[i]!.time - time);
		if (delta < bestDelta) {
			bestDelta = delta;
			best = i;
		}
	}
	return best;
}

/** Even split when unset, and always the right length for the current study count. */
function resolvedFractions(studyCount: number): number[] {
	if (studyCount === 0) {
		return [];
	}
	const fallback = Math.min(0.18, 0.55 / studyCount);
	const out: number[] = [];
	for (let i = 0; i < studyCount; i++) {
		const value = paneFractions[i];
		out.push(value !== undefined && value > 0 ? value : fallback);
	}
	// Studies must never crowd the candles out entirely.
	const total = out.reduce((sum, value) => sum + value, 0);
	const ceiling = 1 - MIN_PRICE_FRACTION;
	if (total > ceiling) {
		const scale = ceiling / total;
		for (let i = 0; i < out.length; i++) {
			out[i] = out[i]! * scale;
		}
	}
	return out;
}

const PAD_TOP = 12;
const PAD_BOTTOM = 22;
const PAD_RIGHT = 64;

function clampView(): void {
	if (bars.length === 0) {
		viewSize = 0;
		viewOffset = 0;
		return;
	}
	viewSize = Math.max(MIN_VISIBLE_BARS, Math.min(viewSize || bars.length, bars.length));
	viewOffset = Math.max(0, Math.min(viewOffset, bars.length - viewSize));
	if (following) {
		viewOffset = bars.length - viewSize;
	}
}

/** Index of the divider under a y coordinate, or undefined when not on one. */
function dividerAt(y: number): number | undefined {
	for (let i = 0; i < dividerYs.length; i++) {
		if (Math.abs(y - dividerYs[i]!) <= DIVIDER_HIT_PX) {
			return i;
		}
	}
	return undefined;
}

/**
 * Moves divider `index` by `dy` pixels. The pane above it grows and the study below shrinks;
 * for the topmost divider the pane above is the price pane, which simply absorbs whatever the
 * studies do not take.
 */
function dragDivider(index: number, dy: number, plotHeight: number, before: readonly number[]): void {
	if (plotHeight <= 0) {
		return;
	}
	const delta = dy / plotHeight;
	const next = [...before];

	const below = next[index];
	if (below === undefined) {
		return;
	}
	const shrunk = below - delta;
	if (shrunk < MIN_STUDY_FRACTION) {
		return;
	}

	if (index > 0) {
		const above = next[index - 1]!;
		const grown = above + delta;
		if (grown < MIN_STUDY_FRACTION) {
			return;
		}
		next[index - 1] = grown;
	} else {
		// Price pane absorbs the change; refuse if it would fall below its floor.
		const studiesTotal = next.reduce((sum, value) => sum + value, 0) - below + shrunk;
		if (1 - studiesTotal < MIN_PRICE_FRACTION) {
			return;
		}
	}
	next[index] = shrunk;
	paneFractions = next;
}

/** Index of the bar under an x coordinate, or undefined when outside the plot. */
function barIndexAt(x: number, plotWidth: number): number | undefined {
	if (viewSize === 0 || x < 0 || x > plotWidth) {
		return undefined;
	}
	const index = viewOffset + Math.floor((x / plotWidth) * viewSize);
	return index >= 0 && index < bars.length ? index : undefined;
}

// Ticks arrive far faster than the display refreshes. Coalesce onto rAF and never paint from
// the message handler itself.
function requestRepaint(): void {
	if (repaintQueued) {
		return;
	}
	repaintQueued = true;
	requestAnimationFrame(() => {
		repaintQueued = false;
		render();
	});
}

/**
 * Single place the badge is decided, in strict precedence. Every branch that could put a
 * misleading word next to synthetic or absent data has to lose to one that cannot, so an error
 * beats "no data" beats "simulated" beats "live".
 */
function renderStatus(): void {
	let text: string;
	let warn = true;

	if (barsError) {
		text = barsError;
	} else if (bars.length === 0) {
		text = 'no data';
	} else if (barsSource === 'simulated') {
		text = 'simulated data';
	} else if (barsSource === 'live') {
		text = dataPlaneHealthy ? 'live' : 'live (stream disconnected)';
		warn = !dataPlaneHealthy;
	} else {
		text = 'no data';
	}

	statusLabel.textContent = text;
	statusLabel.classList.toggle('warn', warn);
	statusLabel.title = text;
}

/** OHLC of the hovered bar, or the live price when nothing is hovered. */
function updateReadout(bar: Bar | undefined, absoluteIndex?: number): void {
	if (!bar) {
		readoutLabel.textContent = '';
		lastLabel.classList.remove('hidden');
		renderLegend();
		return;
	}
	// Hide the live price while hovering: two different numbers in the same row, one of them
	// historical, is a good way to misread a chart.
	lastLabel.classList.add('hidden');
	const change = bar.close - bar.open;
	const sign = change >= 0 ? '+' : '';
	readoutLabel.textContent =
		`O ${bar.open.toFixed(2)}  H ${bar.high.toFixed(2)}  ` +
		`L ${bar.low.toFixed(2)}  C ${bar.close.toFixed(2)}  ${sign}${change.toFixed(2)}`;
	readoutLabel.classList.toggle('up', change >= 0);
	readoutLabel.classList.toggle('down', change < 0);

	// The legend doubles as an indicator readout while hovering, so values can be read off the
	// same bar as the OHLC rather than estimated against the axis.
	if (absoluteIndex !== undefined) {
		renderLegend(absoluteIndex);
	}
}

/** Compact enough for an axis chip: time of day, with a date when the span crosses days. */
function formatTime(ms: number): string {
	const date = new Date(ms);
	const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	return viewSize > 300
		? `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
		: time;
}

function applyPrice(price: number): void {
	// A tick for a series we could not load has nowhere to go. Showing it as a lone price
	// beside an empty chart implies data we do not have.
	const source = sourceBars[sourceBars.length - 1];
	if (!source) {
		return;
	}
	lastPrice = price;
	source.close = price;
	source.high = Math.max(source.high, price);
	source.low = Math.min(source.low, price);
	// Re-derive: on a Renko or Range chart a tick can complete a brick, which is a new bar
	// rather than an edit to the last one.
	if (TRANSFORM_STYLES.includes(chartStyle)) {
		const wasFollowing = following;
		bars = transformBars(chartStyle, sourceBars, styleOptions);
		if (wasFollowing) {
			viewSize = Math.min(viewSize || bars.length, bars.length);
			following = true;
		}
		clampView();
	} else {
		const bar = bars[bars.length - 1];
		if (bar) {
			bar.close = price;
			bar.high = Math.max(bar.high, price);
			bar.low = Math.min(bar.low, price);
		}
	}
	lastLabel.textContent = price.toFixed(2);
	lastLabel.classList.toggle('up', price >= previousClose);
	lastLabel.classList.toggle('down', price < previousClose);
	// The live bar's close moved, so trailing averages ending on it are stale.
	indicatorsDirty = true;
	requestRepaint();
}

/** Reads packed tick records straight out of the frame; allocates nothing per tick. */
function handleFrame(buffer: ArrayBuffer): void {
	const view = new DataView(buffer);
	if (view.getUint8(0) !== FRAME_TYPE_TICK) {
		return;
	}
	const count = view.getUint16(2, true);
	let offset = FRAME_HEADER_BYTES;
	let price = 0;
	for (let i = 0; i < count; i++) {
		if (view.getUint16(offset, true) === symbolId) {
			price = view.getFloat64(offset + 16, true);
		}
		offset += TICK_RECORD_BYTES;
	}
	if (price > 0) {
		applyPrice(price);
	}
}

function connectDataPlane(url: string | undefined): void {
	socket?.close();
	socket = undefined;
	if (!url) {
		return;
	}
	try {
		const next = new WebSocket(url);
		next.binaryType = 'arraybuffer';
		// Transport health only ever qualifies the badge - it can never assert that the bars on
		// screen are live.
		next.onopen = () => { dataPlaneHealthy = true; renderStatus(); };
		next.onmessage = event => {
			if (event.data instanceof ArrayBuffer) {
				handleFrame(event.data);
			}
		};
		next.onclose = () => { dataPlaneHealthy = false; renderStatus(); };
		next.onerror = () => { dataPlaneHealthy = false; renderStatus(); };
		socket = next;
	} catch {
		dataPlaneHealthy = false;
		renderStatus();
	}
}

interface Pane {
	readonly top: number;
	readonly height: number;
	readonly min: number;
	readonly max: number;
	readonly series: readonly IndicatorSeries[];
	readonly isPrice: boolean;
	readonly log: boolean;
	toY(value: number): number;
	/** Inverse of `toY`. The crosshair and the axis both read values back from pixels. */
	fromY(y: number): number;
}

/**
 * Splits the canvas vertically: the price pane keeps whatever the studies do not take.
 * Studies are capped so a chart with several of them still shows candles.
 */
function layoutPanes(visible: readonly Bar[], plotHeight: number): Pane[] {
	const studies = indicatorSeries.filter(series => !series.overlay);
	const overlays = indicatorSeries.filter(series => series.overlay);

	const fractions = resolvedFractions(studies.length);
	const studyHeights = fractions.map(fraction => plotHeight * fraction);
	const priceHeight = plotHeight - studyHeights.reduce((sum, value) => sum + value, 0);

	const panes: Pane[] = [];
	dividerYs = [];

	// Price pane: scaled to the visible candles and any overlay running through them, so a
	// band that pushes outside the price range is not clipped.
	let min = Infinity;
	let max = -Infinity;
	for (const bar of visible) {
		min = Math.min(min, bar.low);
		max = Math.max(max, bar.high);
	}
	for (const series of overlays) {
		for (const line of series.lines) {
			for (let i = 0; i < viewSize; i++) {
				const value = line[viewOffset + i];
				if (value !== undefined) {
					min = Math.min(min, value);
					max = Math.max(max, value);
				}
			}
		}
	}
	if (!isFinite(min) || !isFinite(max) || max === min) {
		return panes;
	}
	// Padding is multiplicative on a log scale: a fixed offset would be a large fraction of a
	// low price and a negligible one of a high price.
	const useLog = priceScale === 'log' && min > 0;
	let paddedMin: number;
	let paddedMax: number;
	if (useLog) {
		paddedMin = min / 1.02;
		paddedMax = max * 1.02;
	} else {
		const pad = (max - min) * 0.05;
		paddedMin = min - pad;
		paddedMax = max + pad;
	}
	panes.push(makePane(PAD_TOP, priceHeight, paddedMin, paddedMax, overlays, true, useLog));

	let top = PAD_TOP + priceHeight;
	for (let i = 0; i < studies.length; i++) {
		const series = studies[i]!;
		const bounds = series.range ?? visibleBounds(series);
		dividerYs.push(top);
		panes.push(makePane(top, studyHeights[i]!, bounds.min, bounds.max, [series], false));
		top += studyHeights[i]!;
	}
	return panes;
}

function makePane(
	top: number, height: number, min: number, max: number,
	series: readonly IndicatorSeries[], isPrice: boolean, log = false,
): Pane {
	// Log needs strictly positive bounds. Rather than clamp and draw something subtly wrong,
	// fall back to linear - a price series that reaches zero has no logarithmic scale.
	if (log && min > 0 && max > 0) {
		const lower = Math.log10(min);
		const upper = Math.log10(max);
		const span = upper - lower || 1;
		return {
			top, height, min, max, series, isPrice, log: true,
			toY: (value: number) => value <= 0
				? top + height
				: top + (upper - Math.log10(value)) / span * height,
			fromY: (y: number) => Math.pow(10, upper - ((y - top) / height) * span),
		};
	}
	const span = max - min || 1;
	return {
		top, height, min, max, series, isPrice, log: false,
		toY: (value: number) => top + (max - value) / span * height,
		fromY: (y: number) => max - ((y - top) / height) * span,
	};
}

/** Scale a study to what is visible, including its histogram, with zero kept in view. */
function visibleBounds(series: IndicatorSeries): { min: number; max: number } {
	let min = Infinity;
	let max = -Infinity;
	const consider = (value: number | undefined) => {
		if (value === undefined) { return; }
		min = Math.min(min, value);
		max = Math.max(max, value);
	};
	for (const line of series.lines) {
		for (let i = 0; i < viewSize; i++) { consider(line[viewOffset + i]); }
	}
	if (series.histogram) {
		for (let i = 0; i < viewSize; i++) { consider(series.histogram[viewOffset + i]); }
		// A histogram is read against zero; hiding the baseline makes the bars meaningless.
		consider(0);
	}
	if (!isFinite(min) || !isFinite(max) || max === min) {
		return { min: 0, max: 1 };
	}
	const pad = (max - min) * 0.08;
	// Padding below zero on a strictly positive series (volume) prints a negative axis label
	// for a quantity that cannot be negative.
	const lower = min >= 0 ? Math.max(0, min - pad) : min - pad;
	return { min: lower, max: max + pad };
}

function render(): void {
	const ratio = window.devicePixelRatio || 1;
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	if (width === 0 || height === 0) {
		return;
	}
	if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
		canvas.width = width * ratio;
		canvas.height = height * ratio;
	}
	context.setTransform(ratio, 0, 0, ratio, 0, 0);
	context.clearRect(0, 0, width, height);

	if (bars.length === 0) {
		return;
	}

	const styles = getComputedStyle(document.body);
	const upColor = styles.getPropertyValue('--vscode-charts-green').trim() || '#89d185';
	const downColor = styles.getPropertyValue('--vscode-charts-red').trim() || '#f14c4c';
	const gridColor = styles.getPropertyValue('--vscode-panel-border').trim() || '#3c3c3c';
	const textColor = styles.getPropertyValue('--vscode-descriptionForeground').trim() || '#999';

	const plotWidth = width - PAD_RIGHT;
	const plotHeight = height - PAD_TOP - PAD_BOTTOM;

	clampView();
	const visible = bars.slice(viewOffset, viewOffset + viewSize);
	if (visible.length === 0) {
		return;
	}

	if (indicatorsDirty) {
		rebuildIndicators();
	}

	const panes = layoutPanes(visible, plotHeight);
	if (panes.length === 0) {
		return;
	}
	const price = panes[0]!;

	const slot = plotWidth / visible.length;
	// Below roughly a pixel per bar the wick and body collapse onto each other; draw a single
	// hairline per bar instead of pretending there is a candle there.
	const dense = slot < MIN_SLOT_PX;

	context.font = '10px var(--vscode-font-family)';

	for (const pane of panes) {
		drawPaneAxis(pane, plotWidth, gridColor, textColor);
	}

	// The price series, drawn in whatever style the document asks for.
	drawPriceSeries(chartStyle, {
		context,
		visible,
		slot,
		plotWidth,
		toY: price.toY,
		palette: { up: upColor, down: downColor, text: textColor },
		dense,
		baseY: price.top + price.height,
	}, styleOptions);

	for (const pane of panes) {
		drawPaneSeries(pane, visible, slot, upColor, downColor);
	}

	// Rebuilt each paint: it closes over the current viewport, scale and pane geometry.
	projection = {
		plotWidth,
		plotTop: price.top,
		plotBottom: price.top + price.height,
		yForPrice: (value: number) => price.toY(value),
		priceForY: (y: number) => price.fromY(y),
		xForTime: (time: number) => {
			const index = indexForTime(time);
			if (index === undefined || index < viewOffset || index >= viewOffset + viewSize) {
				return undefined;
			}
			return (index - viewOffset) * slot + slot / 2;
		},
		timeForX: (x: number) => {
			const index = viewOffset + Math.floor(x / slot);
			return bars[Math.max(0, Math.min(bars.length - 1, index))]?.time;
		},
	};

	const annotations = pendingDrawing ? [...drawings, pendingDrawing] : drawings;
	drawDrawings(context, annotations, projection, textColor, selectedDrawing);

	drawTimeAxis(visible, slot, plotWidth, height, gridColor, textColor);

	// Last price marker, on the price pane.
	if (lastPrice > 0) {
		const y = Math.round(price.toY(lastPrice)) + 0.5;
		context.strokeStyle = textColor;
		context.setLineDash([3, 3]);
		context.beginPath();
		context.moveTo(0, y);
		context.lineTo(plotWidth, y);
		context.stroke();
		context.setLineDash([]);
	}

	drawCrosshair(visible, slot, plotWidth, height, panes, textColor);
}

/** Horizontal gridlines, edge separator and value labels for one pane. */
function drawPaneAxis(pane: Pane, plotWidth: number, gridColor: string, textColor: string): void {
	context.textBaseline = 'middle';
	context.textAlign = 'left';

	const steps = pane.isPrice ? 4 : 2;
	for (let i = 0; i <= steps; i++) {
		// Gridlines are evenly spaced in pixels and their labels read back through the pane's
		// own mapping, so a log pane gets logarithmically spaced values for free.
		const y = Math.round(pane.top + pane.height * (1 - i / steps)) + 0.5;
		const value = pane.fromY(y);
		context.strokeStyle = gridColor;
		context.globalAlpha = 0.4;
		context.beginPath();
		context.moveTo(0, y);
		context.lineTo(plotWidth, y);
		context.stroke();
		context.globalAlpha = 1;

		// A study pane's top edge sits on the previous pane's bottom edge, so labelling both
		// prints two numbers on the same line. The lower pane yields.
		if (!pane.isPrice && i === steps) {
			continue;
		}
		context.fillStyle = textColor;
		context.fillText(formatValue(value), plotWidth + 6, y);
	}

	// A firmer line where one pane ends and the next begins.
	if (!pane.isPrice) {
		context.strokeStyle = gridColor;
		context.beginPath();
		context.moveTo(0, Math.round(pane.top) + 0.5);
		context.lineTo(plotWidth, Math.round(pane.top) + 0.5);
		context.stroke();
	}

	for (const guide of pane.series[0]?.guides ?? []) {
		const y = Math.round(pane.toY(guide)) + 0.5;
		context.strokeStyle = textColor;
		context.globalAlpha = 0.35;
		context.setLineDash([2, 4]);
		context.beginPath();
		context.moveTo(0, y);
		context.lineTo(plotWidth, y);
		context.stroke();
		context.setLineDash([]);
		context.globalAlpha = 1;
	}
}

/**
 * Lines and histograms for a pane. Values are index-aligned with the full series, so the
 * viewport is applied by offsetting the read rather than by recomputing over the slice - an
 * average recomputed per viewport would change as you scroll.
 */
function drawPaneSeries(pane: Pane, visible: readonly Bar[], slot: number, upColor: string, downColor: string): void {
	const styles = getComputedStyle(document.body);

	for (const series of pane.series) {
		const color = styles.getPropertyValue(`--vscode-${series.color.replace('.', '-')}`).trim()
			|| styles.getPropertyValue('--vscode-charts-blue').trim() || '#4e94ce';

		if (series.histogram) {
			const zeroY = pane.toY(Math.max(pane.min, Math.min(0, pane.max)));
			const barWidth = Math.max(1, slot * 0.6);
			for (let i = 0; i < viewSize; i++) {
				const value = series.histogram[viewOffset + i];
				if (value === undefined) { continue; }
				const x = i * slot + slot / 2;
				const y = pane.toY(value);
				if (series.histogramByBar) {
					const bar = visible[i];
					context.fillStyle = bar && bar.close >= bar.open ? upColor : downColor;
				} else {
					context.fillStyle = value >= 0 ? upColor : downColor;
				}
				context.globalAlpha = 0.55;
				context.fillRect(x - barWidth / 2, Math.min(y, zeroY), barWidth, Math.max(1, Math.abs(zeroY - y)));
				context.globalAlpha = 1;
			}
		}

		if (series.fill && series.lines.length >= 2) {
			const upper = series.lines[0]!;
			const lower = series.lines[series.lines.length - 1]!;
			context.fillStyle = color;
			context.globalAlpha = 0.08;
			context.beginPath();
			let started = false;
			for (let i = 0; i < viewSize; i++) {
				const value = upper[viewOffset + i];
				if (value === undefined) { continue; }
				const x = i * slot + slot / 2;
				if (started) { context.lineTo(x, pane.toY(value)); } else { context.moveTo(x, pane.toY(value)); started = true; }
			}
			for (let i = viewSize - 1; i >= 0; i--) {
				const value = lower[viewOffset + i];
				if (value === undefined) { continue; }
				context.lineTo(i * slot + slot / 2, pane.toY(value));
			}
			if (started) { context.closePath(); context.fill(); }
			context.globalAlpha = 1;
		}

		context.strokeStyle = color;
		context.lineWidth = 1.25;
		for (let lineIndex = 0; lineIndex < series.lines.length; lineIndex++) {
			// A second line in the same series (MACD signal, Stochastic %D) is drawn lighter so
			// the pair is distinguishable without inventing a second colour.
			context.globalAlpha = lineIndex === 0 ? 1 : 0.55;
			context.beginPath();
			let started = false;
			for (let i = 0; i < viewSize; i++) {
				const value = series.lines[lineIndex]![viewOffset + i];
				if (value === undefined) {
					// A gap in the series is a genuine gap - break the path rather than
					// interpolating across bars where the indicator was not defined.
					started = false;
					continue;
				}
				const x = i * slot + slot / 2;
				const y = pane.toY(value);
				if (started) { context.lineTo(x, y); } else { context.moveTo(x, y); started = true; }
			}
			context.stroke();
		}
		context.globalAlpha = 1;
		context.lineWidth = 1;
	}
}

/** Axis labels shrink to something readable regardless of the value's magnitude. */
function formatValue(value: number): string {
	const magnitude = Math.abs(value);
	if (magnitude >= 1_000_000) { return `${(value / 1_000_000).toFixed(2)}M`; }
	if (magnitude >= 10_000) { return `${(value / 1_000).toFixed(1)}k`; }
	if (magnitude >= 1) { return value.toFixed(2); }
	return value.toFixed(4);
}

/** Time labels along the bottom, spaced so they never collide regardless of zoom. */
function drawTimeAxis(
	visible: readonly Bar[], slot: number, plotWidth: number, height: number,
	gridColor: string, textColor: string,
): void {
	const labelWidth = 62;
	const step = Math.max(1, Math.ceil(labelWidth / slot));
	const baseline = height - PAD_BOTTOM;

	context.font = '10px var(--vscode-font-family)';
	context.textBaseline = 'top';
	context.textAlign = 'center';

	for (let i = 0; i < visible.length; i += step) {
		const x = i * slot + slot / 2;
		if (x > plotWidth - 8) {
			break;
		}
		context.strokeStyle = gridColor;
		context.globalAlpha = 0.4;
		context.beginPath();
		context.moveTo(Math.round(x) + 0.5, PAD_TOP);
		context.lineTo(Math.round(x) + 0.5, baseline);
		context.stroke();
		context.globalAlpha = 1;

		context.fillStyle = textColor;
		context.fillText(formatTime(visible[i]!.time), x, baseline + 5);
	}
	context.textAlign = 'left';
}

/**
 * Crosshair plus its axis labels. Snaps horizontally to the nearest bar rather than tracking
 * the raw cursor, so the readout always names a bar that exists. The vertical line spans every
 * pane; the value chip reads from whichever pane the cursor is actually in, because an RSI of
 * 70 and a price of 70 are not the same quantity.
 */
function drawCrosshair(
	visible: readonly Bar[], slot: number, plotWidth: number, height: number,
	panes: readonly Pane[], textColor: string,
): void {
	if (!pointer || pointer.x > plotWidth || visible.length === 0) {
		updateReadout(undefined);
		return;
	}

	const localIndex = Math.max(0, Math.min(visible.length - 1, Math.floor(pointer.x / slot)));
	const bar = visible[localIndex]!;
	const snapX = Math.round(localIndex * slot + slot / 2) + 0.5;

	const last = panes[panes.length - 1]!;
	const bottom = last.top + last.height;
	const y = Math.round(Math.max(PAD_TOP, Math.min(pointer.y, bottom))) + 0.5;

	const pane = panes.find(p => y >= p.top && y <= p.top + p.height) ?? panes[0]!;
	const value = pane.fromY(y);

	context.strokeStyle = textColor;
	context.globalAlpha = 0.7;
	context.setLineDash([2, 3]);
	context.beginPath();
	context.moveTo(snapX, PAD_TOP);
	context.lineTo(snapX, bottom);
	context.moveTo(0, y);
	context.lineTo(plotWidth, y);
	context.stroke();
	context.setLineDash([]);
	context.globalAlpha = 1;

	const chipBackground = getComputedStyle(document.body)
		.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';

	context.font = '10px var(--vscode-font-family)';
	context.textBaseline = 'middle';
	context.textAlign = 'left';
	const valueText = formatValue(value);
	context.fillStyle = chipBackground;
	context.fillRect(plotWidth + 2, y - 8, PAD_RIGHT - 4, 16);
	context.strokeStyle = textColor;
	context.strokeRect(plotWidth + 2.5, y - 7.5, PAD_RIGHT - 5, 15);
	context.fillStyle = textColor;
	context.fillText(valueText, plotWidth + 6, y);

	const timeText = formatTime(bar.time);
	context.textAlign = 'center';
	const chipWidth = context.measureText(timeText).width + 10;
	const chipX = Math.max(0, Math.min(snapX - chipWidth / 2, plotWidth - chipWidth));
	context.fillStyle = chipBackground;
	context.fillRect(chipX, height - PAD_BOTTOM + 2, chipWidth, 15);
	context.strokeStyle = textColor;
	context.strokeRect(chipX + 0.5, height - PAD_BOTTOM + 2.5, chipWidth - 1, 14);
	context.fillStyle = textColor;
	context.textBaseline = 'top';
	context.fillText(timeText, chipX + chipWidth / 2, height - PAD_BOTTOM + 5);
	context.textAlign = 'left';

	updateReadout(bar, viewOffset + localIndex);
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	switch (message.type) {
		case 'config': {
			symbolInput.value = message.symbol;
			symbolId = typeof message.symbolId === 'number' ? message.symbolId : -1;

			if (JSON.stringify(message.indicators ?? []) !== JSON.stringify(indicatorSpecs)) {
				indicatorSpecs = message.indicators ?? [];
				indicatorsDirty = true;
			}
			paneFractions = [...(message.paneHeights ?? [])];
			drawings = (message.drawings ?? []).map(entry => ({
				tool: entry.tool as DrawingTool,
				points: entry.points.map(point => ({ ...point })),
				color: entry.color,
			}));
			selectedDrawing = undefined;

			priceScale = message.scale === 'log' ? 'log' : 'linear';

			const nextStyle = (message.style ?? 'candles') as ChartStyle;
			const nextOptions = message.styleOptions ?? {};
			if (nextStyle !== chartStyle || JSON.stringify(nextOptions) !== JSON.stringify(styleOptions)) {
				chartStyle = nextStyle;
				styleOptions = nextOptions;
				rebuildSeries();
			}

			timeframeSelect.replaceChildren();
			for (const timeframe of message.timeframes) {
				const option = document.createElement('option');
				option.value = timeframe;
				option.textContent = timeframe;
				option.selected = timeframe === message.timeframe;
				timeframeSelect.appendChild(option);
			}

			if (message.dataPlaneUrl) {
				connectDataPlane(message.dataPlaneUrl);
			} else {
				socket?.close();
				socket = undefined;
				dataPlaneHealthy = false;
			}
			// Config deliberately does not touch the badge. It describes the connection, and
			// the badge describes the bars; history is what changes those.
			renderStatus();
			break;
		}

		case 'history':
			sourceBars = message.bars.map(bar => ({ ...bar }));
			bars = transformBars(chartStyle, sourceBars, styleOptions);
			indicatorsDirty = true;
			// A new series invalidates any zoom the user had; keeping an index range across a
			// symbol or timeframe change would frame an arbitrary window of different data.
			viewSize = bars.length;
			viewOffset = 0;
			following = true;
			pointer = undefined;
			updateReadout(undefined);
			barsSource = bars.length > 0 ? message.source : undefined;
			barsError = message.error;
			previousClose = bars.length > 1 ? bars[bars.length - 2]!.close : 0;
			lastPrice = bars.length > 0 ? bars[bars.length - 1]!.close : 0;
			lastLabel.textContent = lastPrice > 0 ? lastPrice.toFixed(2) : '';
			lastLabel.classList.remove('up', 'down');
			renderStatus();
			requestRepaint();
			break;

		// Development relay: used only while the simulated feed is driving the UI.
		case 'ticks': {
			const tick = message.ticks[message.ticks.length - 1];
			if (tick) {
				applyPrice(tick.price);
			}
			break;
		}

		case 'status':
			barsError = message.message;
			renderStatus();
			break;

		case 'armTool':
			armedTool = message.tool as DrawingTool | undefined;
			pendingDrawing = undefined;
			canvas.classList.toggle('drawing', armedTool !== undefined);
			break;
	}
});

symbolInput.addEventListener('change', () => {
	const value = symbolInput.value.trim().toUpperCase();
	if (value) {
		vscode.postMessage({ type: 'setSymbol', symbol: value });
	}
});

timeframeSelect.addEventListener('change', () => {
	vscode.postMessage({ type: 'setTimeframe', timeframe: timeframeSelect.value });
});

// -- Interaction -----------------------------------------------------------------------

/** Zoom anchored on the bar under the cursor, so that bar stays put as the scale changes. */
canvas.addEventListener('wheel', event => {
	if (bars.length === 0) {
		return;
	}
	event.preventDefault();

	const plotWidth = canvas.clientWidth - PAD_RIGHT;
	const anchor = barIndexAt(event.offsetX, plotWidth) ?? viewOffset + Math.floor(viewSize / 2);
	const fraction = plotWidth > 0 ? Math.min(Math.max(event.offsetX / plotWidth, 0), 1) : 0.5;

	const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
	const previous = viewSize;
	viewSize = Math.round(Math.max(MIN_VISIBLE_BARS, Math.min(bars.length, viewSize * factor)));
	if (viewSize === previous) {
		return;
	}

	viewOffset = Math.round(anchor - fraction * viewSize);
	// Zooming out at the right edge should re-pin rather than drift away from live bars.
	following = viewOffset + viewSize >= bars.length;
	clampView();
	requestRepaint();
}, { passive: false });

canvas.addEventListener('mousedown', event => {
	const divider = dividerAt(event.offsetY);
	if (divider !== undefined) {
		// Grabbing a boundary resizes; it must not also scroll the series sideways.
		dividerDrag = {
			index: divider,
			startY: event.offsetY,
			before: resolvedFractions(indicatorSeries.filter(series => !series.overlay).length),
		};
		return;
	}
	if (armedTool && projection) {
		const time = projection.timeForX(event.offsetX);
		if (time !== undefined) {
			const point = { time, price: projection.priceForY(event.offsetY) };
			if (needsTwoPoints(armedTool)) {
				// Start a drag; the second anchor follows the cursor until release.
				pendingDrawing = { tool: armedTool, points: [point, point] };
			} else {
				drawings = [...drawings, { tool: armedTool, points: [point] }];
				armedTool = undefined;
				canvas.classList.remove('drawing');
				commitDrawings();
			}
			requestRepaint();
		}
		return;
	}

	// Clicking an existing drawing selects it; clicking empty space clears the selection.
	if (projection) {
		const hit = hitTest(drawings, event.offsetX, event.offsetY, projection);
		if (hit !== undefined) {
			selectedDrawing = hit;
			requestRepaint();
			return;
		}
		if (selectedDrawing !== undefined) {
			selectedDrawing = undefined;
			requestRepaint();
		}
	}

	dragOrigin = { x: event.offsetX, offset: viewOffset };
	canvas.classList.add('dragging');
});

window.addEventListener('mouseup', () => {
	if (pendingDrawing) {
		const [start, end] = pendingDrawing.points;
		// A click without a drag is not a two-point shape; discard rather than storing a
		// zero-length line that cannot be seen or selected.
		if (start && end && (start.time !== end.time || start.price !== end.price)) {
			drawings = [...drawings, pendingDrawing];
			commitDrawings();
		}
		pendingDrawing = undefined;
		armedTool = undefined;
		canvas.classList.remove('drawing');
		requestRepaint();
		return;
	}
	if (dividerDrag) {
		dividerDrag = undefined;
		// Persist on release, so a drag is a single undo step rather than hundreds.
		vscode.postMessage({ type: 'setPaneHeights', paneHeights: paneFractions });
	}
	dragOrigin = undefined;
	canvas.classList.remove('dragging');
});

canvas.addEventListener('mousemove', event => {
	pointer = { x: event.offsetX, y: event.offsetY };

	if (dividerDrag) {
		const plotHeight = canvas.clientHeight - PAD_TOP - PAD_BOTTOM;
		dragDivider(dividerDrag.index, event.offsetY - dividerDrag.startY, plotHeight, dividerDrag.before);
		requestRepaint();
		return;
	}

	if (pendingDrawing && projection) {
		const time = projection.timeForX(event.offsetX);
		if (time !== undefined) {
			pendingDrawing = {
				...pendingDrawing,
				points: [pendingDrawing.points[0]!, { time, price: projection.priceForY(event.offsetY) }],
			};
			requestRepaint();
		}
		return;
	}

	// Cursor is the only affordance telling you a boundary is grabbable.
	canvas.classList.toggle('resizing', dividerAt(event.offsetY) !== undefined);

	if (dragOrigin && bars.length > 0) {
		const plotWidth = canvas.clientWidth - PAD_RIGHT;
		const barsPerPixel = viewSize / Math.max(plotWidth, 1);
		viewOffset = Math.round(dragOrigin.offset - (event.offsetX - dragOrigin.x) * barsPerPixel);
		// Dragging left to inspect history detaches from the live edge; dragging back re-pins.
		following = viewOffset + viewSize >= bars.length;
		clampView();
	}
	requestRepaint();
});

canvas.addEventListener('mouseleave', () => {
	pointer = undefined;
	requestRepaint();
});

/** Double click restores the full series and resumes following. */
canvas.addEventListener('dblclick', () => {
	viewSize = bars.length;
	following = true;
	clampView();
	if (dividerAt(pointer?.y ?? -1) !== undefined) {
		// Double-clicking a boundary restores the even split rather than resetting the zoom.
		paneFractions = [];
		vscode.postMessage({ type: 'setPaneHeights', paneHeights: [] });
	}
	requestRepaint();
});

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		if (armedTool || pendingDrawing) {
			armedTool = undefined;
			pendingDrawing = undefined;
			canvas.classList.remove('drawing');
			requestRepaint();
		} else if (selectedDrawing !== undefined) {
			selectedDrawing = undefined;
			requestRepaint();
		}
		return;
	}
	if ((event.key === 'Delete' || event.key === 'Backspace') && selectedDrawing !== undefined) {
		drawings = drawings.filter((_, index) => index !== selectedDrawing);
		selectedDrawing = undefined;
		commitDrawings();
		requestRepaint();
	}
});

window.addEventListener('resize', requestRepaint);

vscode.postMessage({ type: 'ready' });
