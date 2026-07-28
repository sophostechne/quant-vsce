/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Bar, BarSource, FRAME_HEADER_BYTES, FRAME_TYPE_TICK, HostMessage, TICK_RECORD_BYTES
} from './protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

const symbolInput = document.getElementById('symbol') as HTMLInputElement;
const timeframeSelect = document.getElementById('timeframe') as HTMLSelectElement;
const lastLabel = document.getElementById('last') as HTMLElement;
const statusLabel = document.getElementById('status') as HTMLElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
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

	const padTop = 12;
	const padBottom = 20;
	const padRight = 64;
	const plotWidth = width - padRight;
	const plotHeight = height - padTop - padBottom;

	let min = Infinity;
	let max = -Infinity;
	for (const bar of bars) {
		min = Math.min(min, bar.low);
		max = Math.max(max, bar.high);
	}
	if (!isFinite(min) || !isFinite(max) || max === min) {
		return;
	}
	const range = max - min;
	min -= range * 0.05;
	max += range * 0.05;

	const toY = (price: number) => padTop + (max - price) / (max - min) * plotHeight;

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

	const slot = plotWidth / bars.length;
	const bodyWidth = Math.max(1, Math.min(slot * 0.7, 12));

	for (let i = 0; i < bars.length; i++) {
		const bar = bars[i]!;
		const x = i * slot + slot / 2;
		const color = bar.close >= bar.open ? upColor : downColor;

		context.strokeStyle = color;
		context.fillStyle = color;

		context.beginPath();
		context.moveTo(Math.round(x) + 0.5, toY(bar.high));
		context.lineTo(Math.round(x) + 0.5, toY(bar.low));
		context.stroke();

		const openY = toY(bar.open);
		const closeY = toY(bar.close);
		context.fillRect(x - bodyWidth / 2, Math.min(openY, closeY), bodyWidth, Math.max(1, Math.abs(closeY - openY)));
	}

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
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	switch (message.type) {
		case 'config': {
			symbolInput.value = message.symbol;
			symbolId = typeof message.symbolId === 'number' ? message.symbolId : -1;

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

window.addEventListener('resize', requestRepaint);

vscode.postMessage({ type: 'ready' });
