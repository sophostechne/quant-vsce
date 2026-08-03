/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Bar, BarSource, FRAME_HEADER_BYTES, FRAME_TYPE_TICK, HostMessage, IndicatorSpec,
	TICK_RECORD_BYTES
} from './protocol';
import { IndicatorSeries, computeIndicator } from './indicators';

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

let bars: Bar[] = [];
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

function rebuildIndicators(): void {
	indicatorsDirty = false;
	indicatorSeries = bars.length === 0
		? []
		: indicatorSpecs
			.map((spec, index) => computeIndicator(spec, bars, index))
			.filter((series): series is IndicatorSeries => series !== undefined);
	renderLegend();
}

function renderLegend(): void {
	legendLabel.replaceChildren();
	for (const series of indicatorSeries) {
		const chip = document.createElement('span');
		chip.className = 'legend-item';
		chip.textContent = series.label;
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
function updateReadout(bar: Bar | undefined): void {
	if (!bar) {
		readoutLabel.textContent = '';
		lastLabel.classList.remove('hidden');
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
	const bar = bars[bars.length - 1];
	if (!bar) {
		return;
	}
	lastPrice = price;
	bar.close = price;
	bar.high = Math.max(bar.high, price);
	bar.low = Math.min(bar.low, price);
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

	// Scale to what is on screen, not to the whole series - otherwise zooming into a quiet
	// stretch leaves the candles as a flat line against a range set by bars you cannot see.
	let min = Infinity;
	let max = -Infinity;
	for (const bar of visible) {
		min = Math.min(min, bar.low);
		max = Math.max(max, bar.high);
	}
	if (!isFinite(min) || !isFinite(max) || max === min) {
		return;
	}
	const range = max - min;
	min -= range * 0.05;
	max += range * 0.05;

	const toY = (price: number) => PAD_TOP + (max - price) / (max - min) * plotHeight;

	// Grid and price axis.
	context.strokeStyle = gridColor;
	context.fillStyle = textColor;
	context.lineWidth = 1;
	context.font = '10px var(--vscode-font-family)';
	context.textBaseline = 'middle';
	for (let i = 0; i <= 4; i++) {
		const price = min + (max - min) * (i / 4);
		const y = Math.round(toY(price)) + 0.5;
		context.globalAlpha = 0.4;
		context.beginPath();
		context.moveTo(0, y);
		context.lineTo(plotWidth, y);
		context.stroke();
		context.globalAlpha = 1;
		context.fillText(price.toFixed(2), plotWidth + 6, y);
	}

	const slot = plotWidth / visible.length;
	const bodyWidth = Math.max(1, Math.min(slot * 0.7, 12));
	// Below roughly a pixel per bar the wick and body collapse onto each other; draw a single
	// hairline per bar instead of pretending there is a candle there.
	const dense = slot < MIN_SLOT_PX;

	for (let i = 0; i < visible.length; i++) {
		const bar = visible[i]!;
		const x = i * slot + slot / 2;
		const color = bar.close >= bar.open ? upColor : downColor;

		context.strokeStyle = color;
		context.fillStyle = color;

		context.beginPath();
		context.moveTo(Math.round(x) + 0.5, toY(bar.high));
		context.lineTo(Math.round(x) + 0.5, toY(bar.low));
		context.stroke();

		if (!dense) {
			const openY = toY(bar.open);
			const closeY = toY(bar.close);
			context.fillRect(x - bodyWidth / 2, Math.min(openY, closeY), bodyWidth, Math.max(1, Math.abs(closeY - openY)));
		}
	}

	if (indicatorsDirty) {
		rebuildIndicators();
	}
	drawIndicators(slot, toY);

	drawTimeAxis(visible, slot, plotWidth, height, gridColor, textColor);

	// Last price marker.
	if (lastPrice > 0) {
		const y = Math.round(toY(lastPrice)) + 0.5;
		context.strokeStyle = textColor;
		context.setLineDash([3, 3]);
		context.beginPath();
		context.moveTo(0, y);
		context.lineTo(plotWidth, y);
		context.stroke();
		context.setLineDash([]);
	}

	drawCrosshair(visible, slot, plotWidth, plotHeight, height, min, max, textColor);
}

/**
 * Overlay lines on the price scale. Values are index-aligned with the full series, so the
 * viewport is applied by offsetting the read rather than by recomputing over the slice - an
 * average recomputed per viewport would change as you scroll.
 */
function drawIndicators(slot: number, toY: (price: number) => number): void {
	const styles = getComputedStyle(document.body);

	for (const series of indicatorSeries) {
		const color = styles.getPropertyValue(`--vscode-${series.color.replace('.', '-')}`).trim()
			|| styles.getPropertyValue('--vscode-charts-blue').trim() || '#4e94ce';

		// Bollinger-style bands shade between their first and last line.
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
				if (started) { context.lineTo(x, toY(value)); } else { context.moveTo(x, toY(value)); started = true; }
			}
			for (let i = viewSize - 1; i >= 0; i--) {
				const value = lower[viewOffset + i];
				if (value === undefined) { continue; }
				context.lineTo(i * slot + slot / 2, toY(value));
			}
			if (started) { context.closePath(); context.fill(); }
			context.globalAlpha = 1;
		}

		context.strokeStyle = color;
		context.lineWidth = 1.25;
		for (const line of series.lines) {
			context.beginPath();
			let started = false;
			for (let i = 0; i < viewSize; i++) {
				const value = line[viewOffset + i];
				if (value === undefined) {
					// A gap in the series is a genuine gap - break the path rather than
					// interpolating across bars where the indicator was not defined.
					started = false;
					continue;
				}
				const x = i * slot + slot / 2;
				const y = toY(value);
				if (started) { context.lineTo(x, y); } else { context.moveTo(x, y); started = true; }
			}
			context.stroke();
		}
		context.lineWidth = 1;
	}
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
 * the raw cursor, so the readout always names a bar that exists.
 */
function drawCrosshair(
	visible: readonly Bar[], slot: number, plotWidth: number, plotHeight: number, height: number,
	min: number, max: number, textColor: string,
): void {
	if (!pointer || pointer.x > plotWidth || visible.length === 0) {
		updateReadout(undefined);
		return;
	}

	const localIndex = Math.max(0, Math.min(visible.length - 1, Math.floor(pointer.x / slot)));
	const bar = visible[localIndex]!;
	const snapX = Math.round(localIndex * slot + slot / 2) + 0.5;
	const y = Math.round(Math.max(PAD_TOP, Math.min(pointer.y, PAD_TOP + plotHeight))) + 0.5;
	const price = max - ((y - PAD_TOP) / plotHeight) * (max - min);

	context.strokeStyle = textColor;
	context.globalAlpha = 0.7;
	context.setLineDash([2, 3]);
	context.beginPath();
	context.moveTo(snapX, PAD_TOP);
	context.lineTo(snapX, PAD_TOP + plotHeight);
	context.moveTo(0, y);
	context.lineTo(plotWidth, y);
	context.stroke();
	context.setLineDash([]);
	context.globalAlpha = 1;

	const chipBackground = getComputedStyle(document.body)
		.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';

	// Price chip on the right axis.
	context.font = '10px var(--vscode-font-family)';
	context.textBaseline = 'middle';
	const priceText = price.toFixed(2);
	context.fillStyle = chipBackground;
	context.fillRect(plotWidth + 2, y - 8, PAD_RIGHT - 4, 16);
	context.strokeStyle = textColor;
	context.strokeRect(plotWidth + 2.5, y - 7.5, PAD_RIGHT - 5, 15);
	context.fillStyle = textColor;
	context.fillText(priceText, plotWidth + 6, y);

	// Time chip on the bottom axis.
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

	updateReadout(bar);
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
			bars = message.bars.map(bar => ({ ...bar }));
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
	dragOrigin = { x: event.offsetX, offset: viewOffset };
	canvas.classList.add('dragging');
});

window.addEventListener('mouseup', () => {
	dragOrigin = undefined;
	canvas.classList.remove('dragging');
});

canvas.addEventListener('mousemove', event => {
	pointer = { x: event.offsetX, y: event.offsetY };

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
	requestRepaint();
});

window.addEventListener('resize', requestRepaint);

vscode.postMessage({ type: 'ready' });
