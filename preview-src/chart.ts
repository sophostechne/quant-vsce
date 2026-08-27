/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Bar, BarProvenance, FRAME_HEADER_BYTES, FRAME_TYPE_TICK, HostMessage, IndicatorSpec,
	TICK_RECORD_BYTES
} from './protocol';
import { IndicatorSeries, computeIndicator } from './indicators';
import { Interval, UNIT_GROUPS, describeInterval, formatInterval, parseInterval } from './intervals';
import { ChartStyle, StyleOptions, TRANSFORM_STYLES, drawPriceSeries, transformBars } from './chartTypes';
import { Drawing, Projection, drawDrawings, handleAt, hitTest } from './drawings';
import { specFor } from './drawingTools';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

const symbolInput = document.getElementById('symbol') as HTMLInputElement;
const intervalButton = document.getElementById('intervalButton') as HTMLButtonElement;
const intervalMenu = document.getElementById('intervalMenu') as HTMLElement;
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
let barsSource: BarProvenance | undefined;
let barsVenue: string | undefined;
let barsError: string | undefined;
let dataPlaneHealthy = true;

// Indicators are recomputed only when the bars or the specs change, never per frame.
let indicatorSpecs: readonly IndicatorSpec[] = [];
/**
 * Lines from the user's visualizers, kept apart from `indicatorSeries` because they arrive on
 * their own message and outlive a redraw of the built-in indicators.
 */
let visualizerSeries: IndicatorSeries[] = [];

/** Used when a visualizer names no colour, so several lines do not all come out blue. */
const VISUALIZER_COLORS = ['charts.blue', 'charts.yellow', 'charts.purple', 'charts.orange'];

/** Per-bar tint from a visualizer, indexed like `sourceBars`. */
let visualizerBackground: readonly (string | undefined)[] = [];
/** Notes pinned to bars by a visualizer, indexed like `sourceBars`. */
let visualizerMarkers: readonly { index: number; text: string; color: string; above: boolean }[] = [];
/** The bars the visualizer output was computed against. */
let visualizerToken: string | undefined;
/** The bars currently on screen. */
let barsToken: string | undefined;

/**
 * Whether visualizer output still describes what is drawn.
 *
 * Two ways it stops doing so. The bars can be replaced - a new symbol, timeframe or refresh -
 * which the token catches. And the *style* can aggregate: renko, range and line-break bars
 * collapse many bars into one, so an array indexed against raw bars no longer lines up with what
 * is on the canvas. Built-in indicators are computed after the transform and are unaffected;
 * visualizers run on the host, before it. Drawing anyway would put a regime under the wrong
 * candles, which is worse than not drawing it.
 */
function visualizerOutputApplies(): boolean {
	return visualizerToken !== undefined
		&& visualizerToken === barsToken
		&& bars.length === sourceBars.length;
}
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
		: [
			...indicatorSpecs
				.map((spec, index) => computeIndicator(spec, bars, index))
				.filter((series): series is IndicatorSeries => series !== undefined),
			// After the built-ins so a visualizer's lines sit on top of them, which is what a
			// user adding one is usually trying to see.
			...(visualizerOutputApplies() ? visualizerSeries : []),
		];
	renderLegend();
}

/**
 * A theme colour id like `charts.blue`, matched strictly.
 *
 * "Contains a dot" was the first attempt and was wrong in the worst way: `rgba(132, 187, 161,
 * 0.13)` has a dot in its alpha, so every translucent colour a visualizer produced was looked up
 * as a theme id, missed, and fell back to solid blue - painting over the chart instead of
 * tinting behind it. A theme id is dotted identifiers and nothing else.
 */
const THEME_COLOR_ID = /^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/;

/**
 * A theme colour id such as `charts.blue`, or any literal CSS colour.
 *
 * Built-in indicators name theme ids so they stay legible when the theme changes. A visualizer
 * is user code and may simply want `#c0ffee` or an rgba tint, so anything that is not a theme id
 * is passed through as written rather than looked up and lost.
 */
function themeColor(styles: CSSStyleDeclaration, color: string): string {
	if (color && !THEME_COLOR_ID.test(color)) {
		return color;
	}
	// Nothing to look up, and `color.replace` on a non-string throws. Worth guarding rather than
	// trusting the type: this runs inside `render`, after the canvas has been cleared and before
	// the candles are drawn, so anything that throws here does not lose a tint - it leaves the
	// whole chart blank until something changes, which is how a colour bug becomes a missing chart.
	const fallback = () => styles.getPropertyValue('--vscode-charts-blue').trim() || '#4e94ce';
	if (typeof color !== 'string' || !color) {
		return fallback();
	}
	return styles.getPropertyValue(`--vscode-${color.replace('.', '-')}`).trim() || fallback();
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
		chip.style.color = THEME_COLOR_ID.test(series.color)
			? `var(--vscode-${series.color.replace('.', '-')})`
			: series.color;
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

/** Pixels per bar from the last paint, used by edit maths outside the render pass. */
let slotWidth = 1;
let paneFractions: number[] = [];
/** Boundaries from the last paint, so hit-testing matches what is on screen. */
let dividerYs: number[] = [];
let dividerDrag: { index: number; startY: number; before: number[] } | undefined;

// -- Drawings --------------------------------------------------------------------------

let drawings: Drawing[] = [];
let armedTool: string | undefined;
/** Anchors clicked so far for a sequence tool. */
let sequencePoints: { time: number; price: number }[] = [];
/** Caption supplied by the host when the armed tool needs one. */
let armedText: string | undefined;

/**
 * An in-progress edit of an existing drawing. `pointIndex` set means one anchor is being
 * dragged; unset means the whole shape is moving. Anchors are stored as bar indices rather
 * than timestamps so a move shifts by whole bars and always lands on real ones.
 */
let editDrag: {
	readonly index: number;
	readonly pointIndex?: number;
	readonly startX: number;
	readonly startY: number;
	readonly origin: readonly { barIndex: number; price: number }[];
} | undefined;

function beginEdit(index: number, pointIndex: number | undefined, x: number, y: number): void {
	const drawing = drawings[index];
	if (!drawing) {
		return;
	}
	editDrag = {
		index,
		pointIndex,
		startX: x,
		startY: y,
		origin: drawing.points.map(point => ({
			barIndex: indexForTime(point.time) ?? 0,
			price: point.price,
		})),
	};
}

/** Applies the current drag to the edited drawing, in data space. */
function applyEdit(x: number, y: number): void {
	if (!editDrag || !projection) {
		return;
	}
	const drawing = drawings[editDrag.index];
	if (!drawing) {
		return;
	}
	const priceDelta = projection.priceForY(y) - projection.priceForY(editDrag.startY);
	const barDelta = Math.round((x - editDrag.startX) / Math.max(slotWidth, 0.0001));

	const points = editDrag.origin.map((origin, i) => {
		// A single-anchor drag moves only that anchor; otherwise every anchor shifts together.
		if (editDrag!.pointIndex !== undefined && editDrag!.pointIndex !== i) {
			return drawing.points[i]!;
		}
		const barIndex = Math.max(0, Math.min(bars.length - 1, origin.barIndex + barDelta));
		return { time: bars[barIndex]?.time ?? drawing.points[i]!.time, price: origin.price + priceDelta };
	});

	drawings = drawings.map((entry, i) => i === editDrag!.index ? { ...entry, points } : entry);
}
/** In-progress drag; rendered as a preview until released. */
let pendingDrawing: Drawing | undefined;
let selectedDrawing: number | undefined;
/** Projection from the last paint, so hit-testing matches what is on screen. */
let projection: Projection | undefined;

/** Stores a completed drawing and disarms, which is the only path that writes to the document. */
function finishDrawing(drawing: Drawing): void {
	drawings = [...drawings, drawing];
	pendingDrawing = undefined;
	armedTool = undefined;
	armedText = undefined;
	sequencePoints = [];
	canvas.classList.remove('drawing');
	commitDrawings();
}

/** Lets host-side commands act on whatever is selected here. */
function postSelection(): void {
	vscode.postMessage({ type: 'selectionChanged', index: selectedDrawing });
}

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
	} else if (barsSource === 'history') {
		// Real prices, but the last bar closed with the last session rather than a moment ago.
		// Not a warning: nothing here is wrong or invented, it simply is not streaming.
		//
		// The venue is named because more than one source can answer for one symbol and they are
		// not the same instrument - BTC-USD on Coinbase against BTCUSDT on Binance, or IEX
		// against the consolidated tape. Two charts that do not mean the same thing should not
		// look identical.
		text = barsVenue ? `history only · ${barsVenue}` : 'history only';
		warn = false;
	} else if (barsSource === 'live') {
		text = dataPlaneHealthy ? 'live' : 'live (stream disconnected)';
		warn = !dataPlaneHealthy;
	} else {
		text = 'no data';
	}

	// An aggregating style collapses bars, so host-computed overlays no longer line up with what
	// is drawn. Saying so beats a chart that quietly omits what the user asked it to show.
	if (visualizerToken !== undefined && visualizerToken === barsToken && bars.length !== sourceBars.length) {
		text += ' · overlays off (aggregated bars)';
		warn = true;
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

const DAY_MS = 86_400_000;
/** A month is not a fixed length; this is short enough that any real month clears it. */
const MONTH_MS = 27 * DAY_MS;

/**
 * How long one bar covers, read off the bars themselves.
 *
 * The smallest gap on screen rather than the average, because sessions close: a daily series
 * carries three-day gaps over every weekend and a longer one over every holiday, so a mean would
 * report an interval no bar actually has. The smallest gap is the interval, whatever the calendar
 * did around it. Zero when there is nothing to measure - a single visible bar.
 */
function barSpacing(visible: readonly Bar[]): number {
	let smallest = Infinity;
	for (let i = 1; i < visible.length; i++) {
		const gap = visible[i]!.time - visible[i - 1]!.time;
		if (gap > 0 && gap < smallest) {
			smallest = gap;
		}
	}
	return Number.isFinite(smallest) ? smallest : 0;
}

/**
 * The axis label format for what is currently on screen.
 *
 * Derived from the interval the bars are on and the span they cover, not from how many of them
 * there are. Bar count was the first attempt and is only a proxy for the span at one interval:
 * a daily chart is almost never 300 bars wide, so every label on it printed the time - and every
 * daily bar opens at the same time, which is a whole axis reading `00:00`. What a label needs to
 * say is whatever distinguishes one tick from the next, and that is set by the interval.
 */
function axisTimeFormat(visible: readonly Bar[]): (ms: number) => string {
	const spacing = barSpacing(visible);
	const first = visible[0]?.time ?? 0;
	const last = visible[visible.length - 1]?.time ?? 0;
	// Years are only worth the width when the window actually crosses one.
	const years = new Date(first).getFullYear() !== new Date(last).getFullYear();

	if (spacing >= MONTH_MS) {
		return ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
	}
	if (spacing >= DAY_MS) {
		return ms => new Date(ms).toLocaleDateString(undefined, years
			? { year: 'numeric', month: 'short', day: 'numeric' }
			: { month: 'short', day: 'numeric' });
	}
	const time = (ms: number) =>
		new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	if (last - first > DAY_MS) {
		return ms => `${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time(ms)}`;
	}
	return time;
}

/**
 * The crosshair's own label, which names a single bar rather than spacing out an axis.
 *
 * More detail than the axis carries: the axis omits whatever repeats across its ticks, but the
 * chip is answering "which bar is this", and a date with no year is only an answer if you already
 * know where you are in the series.
 */
function formatCrosshairTime(visible: readonly Bar[], ms: number): string {
	const spacing = barSpacing(visible);
	const date = new Date(ms);
	if (spacing >= MONTH_MS) {
		return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
	}
	const day = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	return spacing >= DAY_MS
		? day
		: `${day} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
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
		if (Number.isFinite(bar.low)) { min = Math.min(min, bar.low); }
		if (Number.isFinite(bar.high)) { max = Math.max(max, bar.high); }
	}
	for (const series of overlays) {
		for (const line of series.lines) {
			for (let i = 0; i < viewSize; i++) {
				const value = line[viewOffset + i];
				// Finite rather than merely defined. A single NaN admitted here poisons both
				// bounds through Math.min/max, and the pane that cannot then be built used to
				// take the whole chart with it - candles, axes and all.
				if (value !== undefined && Number.isFinite(value)) {
					min = Math.min(min, value);
					max = Math.max(max, value);
				}
			}
		}
	}
	// A degenerate range is not a reason to draw nothing. Returning no panes blanks the entire
	// canvas, which reads as a broken extension; a flat window - one bar, an untraded stretch,
	// a series whose highs and lows coincide - is ordinary data that still deserves candles.
	// Give it a range to sit in the middle of and carry on.
	if (!isFinite(min) || !isFinite(max)) {
		const fallback = visible[visible.length - 1]?.close;
		if (fallback === undefined || !Number.isFinite(fallback)) {
			return panes;
		}
		min = max = fallback;
	}
	if (max === min) {
		// Proportional so it works at any price, with an absolute floor for a series at zero.
		const margin = Math.max(Math.abs(min) * 0.01, 1e-6);
		min -= margin;
		max += margin;
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
		// Same reason as the price pane: one NaN would otherwise collapse the study to its
		// fallback 0..1 range and flatten a perfectly good line against the axis.
		if (value === undefined || !Number.isFinite(value)) { return; }
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
	slotWidth = slot;
	// Below roughly a pixel per bar the wick and body collapse onto each other; draw a single
	// hairline per bar instead of pretending there is a candle there.
	const dense = slot < MIN_SLOT_PX;

	context.font = '10px var(--vscode-font-family)';

	// Beneath the axes and the candles: a tint is context for the price, never a thing in front
	// of it.
	drawVisualizerBackground(slot, plotWidth, price.top, price.height);

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

	drawVisualizerMarkers(visible, slot, price, textColor);

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
		// Forecasts, time zones and cycle lines deliberately reach past the last bar, so they
		// need a mapping that keeps going rather than one that gives up at the edge.
		xForTimeUnclamped: (time: number) => {
			const index = indexForTime(time);
			return index === undefined ? 0 : (index - viewOffset) * slot + slot / 2;
		},
		timeForX: (x: number) => {
			const index = viewOffset + Math.floor(x / slot);
			return bars[Math.max(0, Math.min(bars.length - 1, index))]?.time;
		},
	};

	const annotations = pendingDrawing ? [...drawings, pendingDrawing] : drawings;
	drawDrawings(context, annotations, projection, { text: textColor, up: upColor, down: downColor }, selectedDrawing);

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
/**
 * Per-bar tint behind the chart.
 *
 * Drawn as one rectangle per run of equal colour rather than per bar: a regime holds for dozens
 * of bars at a time, and abutting fills at fractional pixel boundaries leave seams that read as
 * stripes.
 */
function drawVisualizerBackground(slot: number, plotWidth: number, top: number, height: number): void {
	if (visualizerBackground.length === 0 || !visualizerOutputApplies()) {
		return;
	}
	const styles = getComputedStyle(document.body);
	let runStart = 0;
	let runColor: string | undefined;

	const flush = (end: number) => {
		if (runColor === undefined || end <= runStart) {
			return;
		}
		const x = runStart * slot;
		context.fillStyle = themeColor(styles, runColor);
		context.fillRect(x, top, Math.min((end - runStart) * slot, plotWidth - x), height);
	};

	for (let i = 0; i <= viewSize; i++) {
		const color = visualizerBackground[viewOffset + i];
		if (color !== runColor || i === viewSize) {
			flush(i);
			runStart = i;
			runColor = color;
		}
	}
}

/** Chip geometry for a marker label: 10px text needs 13px of chip not to touch its edges. */
const CHIP_HEIGHT = 13;
const CHIP_PAD_X = 4;
const CHIP_RADIUS = 3;
/** Pixels between the chip and the high or low it is pinned to. */
const CHIP_GAP = 3;

/**
 * Notes pinned to bars.
 *
 * Only what is on screen, and only one per bar: markers exist to mark the few moments worth
 * looking at, and a visualizer that emits one per bar would otherwise paint a wall of text over
 * its own chart.
 */
function drawVisualizerMarkers(visible: readonly Bar[], slot: number, price: Pane, textColor: string): void {
	if (visualizerMarkers.length === 0 || !visualizerOutputApplies()) {
		return;
	}
	const styles = getComputedStyle(document.body);
	const drawn = new Set<number>();
	context.save();
	context.font = '10px var(--vscode-font-family)';
	context.textAlign = 'center';
	context.textBaseline = 'alphabetic';
	// Centred on the capitals, not on the em box and not on the label's own ink. The em box - what
	// a 'middle' baseline centres - reserves the room a descender would need, so a label without
	// one rides high in the chip by half that descent. The label's own ink centres perfectly but
	// moves with whichever glyphs it happens to contain, which would leave two chips on the same
	// chart sitting at different heights. One reference measurement holds every chip to the same
	// line.
	const capHeight = context.measureText('H').actualBoundingBoxAscent;
	const baseline = (CHIP_HEIGHT + capHeight) / 2;

	for (const marker of visualizerMarkers) {
		const i = marker.index - viewOffset;
		if (i < 0 || i >= visible.length || drawn.has(i)) {
			continue;
		}
		drawn.add(i);
		const bar = visible[i]!;
		const x = i * slot + slot / 2;
		const top = marker.above
			? price.toY(bar.high) - CHIP_GAP - CHIP_HEIGHT
			: price.toY(bar.low) + CHIP_GAP;

		const color = marker.color ? themeColor(styles, marker.color) : textColor;
		const width = context.measureText(marker.text).width;
		// A chip behind the text, because a bare label over candles is unreadable exactly where
		// it matters - at a turn, which is busy.
		context.fillStyle = color;
		context.globalAlpha = 0.85;
		context.beginPath();
		context.roundRect(x - width / 2 - CHIP_PAD_X, top, width + CHIP_PAD_X * 2, CHIP_HEIGHT, CHIP_RADIUS);
		context.fill();
		context.globalAlpha = 1;
		context.fillStyle = styles.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
		context.fillText(marker.text, x, top + baseline);
	}
	context.restore();
}

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
		const color = themeColor(styles, series.color);

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
	const baseline = height - PAD_BOTTOM;

	context.font = '10px var(--vscode-font-family)';
	context.textBaseline = 'top';
	context.textAlign = 'center';

	// Measured rather than assumed: the format now varies with the interval, and the fixed 62px
	// that fit `09:30` would let `Jan 5, 2024` run into its neighbour. Measuring the widest of the
	// two ends covers the year rolling over inside the window, which is where the format grows.
	const format = axisTimeFormat(visible);
	const labelWidth = Math.max(
		context.measureText(format(visible[0]!.time)).width,
		context.measureText(format(visible[visible.length - 1]!.time)).width,
	) + 14;
	const step = Math.max(1, Math.ceil(labelWidth / slot));

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
		context.fillText(format(visible[i]!.time), x, baseline + 5);
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

	const timeText = formatCrosshairTime(visible, bar.time);
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
				tool: entry.tool,
				points: entry.points.map(point => ({ ...point })),
				color: entry.color,
				text: entry.text,
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

			offeredIntervals = message.timeframes;
			customIntervals = message.customIntervals ?? [];
			currentInterval = message.timeframe;
			renderIntervalButton();
			if (!intervalMenu.hidden) {
				// Open while the host answered - a symbol change narrows the list underneath the
				// cursor, and leaving the old rows up would offer intervals that just went away.
				renderIntervalMenu();
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

		case 'visualizers':
			// Palette ids resolve to a real colour here, where the theme is; the host only knows
			// the name. A visualizer that chose its own colour keeps it.
			//
			// The nulls become undefined in the same pass. They are holes the host sent as
			// undefined and JSON turned into null, and everything downstream - the axis bounds,
			// the line breaks, the tint runs - asks `=== undefined`. Restoring the invariant here,
			// at the one boundary that loses it, is what keeps every one of those checks honest.
			visualizerSeries = message.series.map((series, index) => ({
				label: series.label,
				color: series.color || VISUALIZER_COLORS[index % VISUALIZER_COLORS.length]!,
				fill: series.fill,
				overlay: series.overlay,
				lines: series.lines.map(line => line.map(value => value ?? undefined)),
			}));
			visualizerBackground = message.background.map(color => color ?? undefined);
			visualizerMarkers = message.markers;
			visualizerToken = message.token;
			indicatorsDirty = true;
			renderStatus();
			render();
			break;

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
			// Not cleared here. The token decides whether what is held still describes these
			// bars, which keeps a redraw of unchanged bars from blanking the overlay and
			// redrawing it a worker later - visible as a blink on every refresh.
			barsToken = message.token;
			barsSource = bars.length > 0 ? message.source : undefined;
			barsVenue = bars.length > 0 ? message.venue : undefined;
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
			armedTool = message.tool;
			armedText = message.text;
			sequencePoints = [];
			pendingDrawing = undefined;
			canvas.classList.toggle('drawing', armedTool !== undefined);
			requestRepaint();
			break;
	}
});

symbolInput.addEventListener('change', () => {
	const value = symbolInput.value.trim().toUpperCase();
	if (value) {
		vscode.postMessage({ type: 'setSymbol', symbol: value });
	}
});

// -- Interval picker -------------------------------------------------------------------
// A menu rather than a <select>, because the list is grouped by unit, marks which entries are
// the user's own, and carries a form for adding one - none of which an <option> can hold.

let offeredIntervals: readonly string[] = [];
let customIntervals: readonly string[] = [];
let currentInterval = '';

function renderIntervalButton(): void {
	const parsed = parseInterval(currentInterval);
	intervalButton.textContent = parsed ? formatInterval(parsed) : currentInterval;
	intervalButton.title = parsed
		? describeInterval(parsed)
		// Kept selectable and labelled rather than blanked: the document says this, and a picker
		// showing nothing would look broken where the chart already explains the problem.
		: `${currentInterval} — no source can fill this`;
}

function chooseInterval(value: string): void {
	closeIntervalMenu();
	if (value !== currentInterval) {
		vscode.postMessage({ type: 'setTimeframe', timeframe: value });
	}
}

function renderIntervalMenu(): void {
	intervalMenu.replaceChildren();

	const custom = new Set(customIntervals);
	const parsed = offeredIntervals
		.map(value => ({ value, interval: parseInterval(value) }))
		.filter((entry): entry is { value: string; interval: Interval } => entry.interval !== undefined);

	for (const group of UNIT_GROUPS) {
		const rows = parsed.filter(entry => entry.interval.unit === group.unit);
		if (rows.length === 0) {
			// Whole groups are absent rather than empty: a feed with no sub-minute data should
			// not show a Seconds heading with nothing under it.
			continue;
		}

		const heading = document.createElement('div');
		heading.className = 'intervalGroup';
		heading.textContent = group.title;
		intervalMenu.appendChild(heading);

		for (const { value, interval } of rows) {
			intervalMenu.appendChild(intervalRow(value, interval, custom.has(value)));
		}
	}

	intervalMenu.appendChild(customIntervalForm());
}

function intervalRow(value: string, interval: Interval, isCustom: boolean): HTMLElement {
	const row = document.createElement('div');
	row.className = 'intervalRow';

	const option = document.createElement('button');
	option.type = 'button';
	option.className = 'intervalOption';
	option.setAttribute('role', 'option');
	option.setAttribute('aria-selected', String(value === currentInterval));
	if (value === currentInterval) {
		option.classList.add('selected');
	}

	const name = document.createElement('span');
	name.className = 'intervalName';
	name.textContent = value;

	// The long form is what separates `1m` from `1M` at a glance, which is the one mistake this
	// vocabulary invites.
	const detail = document.createElement('span');
	detail.className = 'intervalDetail';
	detail.textContent = describeInterval(interval);

	option.append(name, detail);
	option.addEventListener('click', () => chooseInterval(value));
	row.appendChild(option);

	if (isCustom) {
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'intervalRemove';
		remove.title = `Remove ${value}`;
		remove.setAttribute('aria-label', `Remove ${value}`);
		remove.textContent = '×';
		remove.addEventListener('click', event => {
			// Without this the click reaches the row behind it and selects the interval being
			// removed, which then cannot be removed because it is the one in use.
			event.stopPropagation();
			vscode.postMessage({ type: 'removeCustomInterval', interval: value });
		});
		row.appendChild(remove);
	}

	return row;
}

function customIntervalForm(): HTMLElement {
	const form = document.createElement('form');
	form.className = 'intervalCustom';

	const label = document.createElement('label');
	label.className = 'intervalGroup';
	label.textContent = 'Add custom interval';
	label.htmlFor = 'intervalCount';

	const count = document.createElement('input');
	count.id = 'intervalCount';
	count.className = 'intervalCount';
	count.type = 'number';
	count.min = '1';
	count.step = '1';
	count.placeholder = '90';

	const unit = document.createElement('select');
	unit.className = 'intervalUnit';
	for (const group of UNIT_GROUPS) {
		const option = document.createElement('option');
		option.value = group.unit;
		option.textContent = group.title;
		unit.appendChild(option);
	}
	unit.value = 'm';

	const add = document.createElement('button');
	add.type = 'submit';
	add.className = 'intervalAdd';
	add.textContent = 'Add';

	const error = document.createElement('div');
	error.className = 'intervalError';
	error.hidden = true;

	form.addEventListener('submit', event => {
		event.preventDefault();
		const value = `${count.value.trim()}${unit.value}`;
		const interval = parseInterval(value);
		if (!interval) {
			error.textContent = count.value.trim()
				? `${value} is not an interval this chart can use.`
				: 'Enter how many.';
			error.hidden = false;
			count.focus();
			return;
		}
		closeIntervalMenu();
		vscode.postMessage({ type: 'addCustomInterval', interval: formatInterval(interval) });
	});

	const row = document.createElement('div');
	row.className = 'intervalCustomRow';
	row.append(count, unit, add);
	form.append(label, row, error);
	return form;
}

function openIntervalMenu(): void {
	renderIntervalMenu();
	intervalMenu.hidden = false;
	intervalButton.setAttribute('aria-expanded', 'true');

	// Placed after unhiding, because a hidden element measures zero and the menu would be pinned
	// to the top left. Flipped above the button when there is no room below, and pulled back from
	// the right edge, so a chart in a narrow panel does not put half the menu off screen.
	const anchor = intervalButton.getBoundingClientRect();
	const menu = intervalMenu.getBoundingClientRect();
	const below = window.innerHeight - anchor.bottom;
	intervalMenu.style.top = below < menu.height && anchor.top > below
		? `${Math.max(4, anchor.top - menu.height - 2)}px`
		: `${anchor.bottom + 2}px`;
	intervalMenu.style.left = `${Math.max(4, Math.min(anchor.left, window.innerWidth - menu.width - 4))}px`;

	intervalMenu.querySelector<HTMLElement>('.intervalOption.selected')?.focus();
}

function closeIntervalMenu(): void {
	intervalMenu.hidden = true;
	intervalButton.setAttribute('aria-expanded', 'false');
}

intervalButton.addEventListener('click', () => {
	if (intervalMenu.hidden) {
		openIntervalMenu();
	} else {
		closeIntervalMenu();
	}
});

// Anywhere outside dismisses, which is what a menu is expected to do. Capture, so it still fires
// when the click lands on the canvas and is stopped there.
document.addEventListener('pointerdown', event => {
	const target = event.target as Node | null;
	if (!intervalMenu.hidden && target && !intervalMenu.contains(target) && !intervalButton.contains(target)) {
		closeIntervalMenu();
	}
}, true);

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
		const spec = specFor(armedTool);
		if (time === undefined || !spec) {
			return;
		}
		const point = { time, price: projection.priceForY(event.offsetY) };

		switch (spec.placement) {
			case 'point':
				finishDrawing({ tool: armedTool, points: [point], text: armedText });
				break;

			case 'drag':
				// The second anchor follows the cursor until release.
				pendingDrawing = { tool: armedTool, points: [point, point], text: armedText };
				break;

			case 'freehand':
				pendingDrawing = { tool: armedTool, points: [point], text: armedText };
				break;

			case 'sequence': {
				sequencePoints = [...sequencePoints, point];
				if (sequencePoints.length >= spec.points) {
					finishDrawing({ tool: armedTool, points: sequencePoints, text: armedText });
					sequencePoints = [];
				} else {
					// Preview the anchors placed so far, plus one that tracks the cursor.
					pendingDrawing = { tool: armedTool, points: [...sequencePoints, point], text: armedText };
				}
				break;
			}
		}
		requestRepaint();
		return;
	}

	if (projection) {
		// A handle of the selected drawing reshapes it. Checked first, because a handle sits
		// on top of the line it belongs to.
		if (selectedDrawing !== undefined) {
			const selected = drawings[selectedDrawing];
			const handle = selected && handleAt(selected, event.offsetX, event.offsetY, projection);
			if (handle !== undefined) {
				beginEdit(selectedDrawing, handle, event.offsetX, event.offsetY);
				canvas.classList.add('dragging');
				return;
			}
		}

		// Clicking a drawing selects it and begins a move; clicking empty space deselects.
		const hit = hitTest(drawings, event.offsetX, event.offsetY, projection);
		if (hit !== undefined) {
			selectedDrawing = hit;
			postSelection();
			beginEdit(hit, undefined, event.offsetX, event.offsetY);
			canvas.classList.add('dragging');
			requestRepaint();
			return;
		}
		if (selectedDrawing !== undefined) {
			selectedDrawing = undefined;
			postSelection();
			requestRepaint();
		}
	}

	dragOrigin = { x: event.offsetX, offset: viewOffset };
	canvas.classList.add('dragging');
});

window.addEventListener('mouseup', () => {
	if (editDrag) {
		editDrag = undefined;
		canvas.classList.remove('dragging');
		// Written on release, so a reshape is one undo step rather than one per mouse move.
		commitDrawings();
		return;
	}

	if (pendingDrawing && armedTool) {
		const spec = specFor(armedTool);
		if (spec?.placement === 'drag') {
			const [start, end] = pendingDrawing.points;
			// A click without a drag is not a two-point shape; discard rather than storing a
			// zero-length line that cannot be seen or selected.
			if (start && end && (start.time !== end.time || start.price !== end.price)) {
				finishDrawing(pendingDrawing);
			} else {
				pendingDrawing = undefined;
			}
			requestRepaint();
			return;
		}
		if (spec?.placement === 'freehand') {
			// Two anchors is the shortest stroke worth keeping.
			if (pendingDrawing.points.length > 1) {
				finishDrawing(pendingDrawing);
			} else {
				pendingDrawing = undefined;
			}
			requestRepaint();
			return;
		}
		// Sequence tools stay armed between clicks.
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

	if (editDrag) {
		applyEdit(event.offsetX, event.offsetY);
		requestRepaint();
		return;
	}

	if (dividerDrag) {
		const plotHeight = canvas.clientHeight - PAD_TOP - PAD_BOTTOM;
		dragDivider(dividerDrag.index, event.offsetY - dividerDrag.startY, plotHeight, dividerDrag.before);
		requestRepaint();
		return;
	}

	if (armedTool && projection) {
		const spec = specFor(armedTool);
		const time = projection.timeForX(event.offsetX);
		if (spec && time !== undefined) {
			const point = { time, price: projection.priceForY(event.offsetY) };
			if (pendingDrawing && spec.placement === 'freehand') {
				// Every sampled position becomes an anchor, which is what makes it freehand.
				pendingDrawing = { ...pendingDrawing, points: [...pendingDrawing.points, point] };
				requestRepaint();
				return;
			}
			if (pendingDrawing && spec.placement === 'drag') {
				pendingDrawing = { ...pendingDrawing, points: [pendingDrawing.points[0]!, point] };
				requestRepaint();
				return;
			}
			if (spec.placement === 'sequence' && sequencePoints.length > 0) {
				pendingDrawing = { tool: armedTool, points: [...sequencePoints, point], text: armedText };
				requestRepaint();
				return;
			}
		}
	}

	// Cursor is the only affordance telling you a boundary or handle is grabbable.
	canvas.classList.toggle('resizing', dividerAt(event.offsetY) !== undefined);
	if (selectedDrawing !== undefined && projection) {
		const selected = drawings[selectedDrawing];
		const overHandle = selected !== undefined
			&& handleAt(selected, event.offsetX, event.offsetY, projection) !== undefined;
		canvas.classList.toggle('grabbing', overHandle);
	} else {
		canvas.classList.remove('grabbing');
	}

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

/** Double click restores either the grabbed pane split or the full horizontal series. */
canvas.addEventListener('dblclick', () => {
	if (dividerAt(pointer?.y ?? -1) !== undefined) {
		// Double-clicking a boundary restores the even split rather than resetting the zoom.
		paneFractions = [];
		vscode.postMessage({ type: 'setPaneHeights', paneHeights: [] });
	} else {
		viewSize = bars.length;
		following = true;
		clampView();
	}
	requestRepaint();
});

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		// Before the tools: the menu is the thing most recently opened, so it is what Escape
		// should dismiss, and cancelling a drawing out from under an open menu is a surprise.
		if (!intervalMenu.hidden) {
			closeIntervalMenu();
			intervalButton.focus();
			return;
		}
		if (armedTool || pendingDrawing) {
			armedTool = undefined;
			pendingDrawing = undefined;
			sequencePoints = [];
			armedText = undefined;
			canvas.classList.remove('drawing');
			requestRepaint();
		} else if (selectedDrawing !== undefined) {
			selectedDrawing = undefined;
			postSelection();
			requestRepaint();
		}
		return;
	}
	if ((event.key === 'Delete' || event.key === 'Backspace') && selectedDrawing !== undefined) {
		drawings = drawings.filter((_, index) => index !== selectedDrawing);
		selectedDrawing = undefined;
		postSelection();
		commitDrawings();
		requestRepaint();
	}
});

window.addEventListener('resize', requestRepaint);

vscode.postMessage({ type: 'ready' });
