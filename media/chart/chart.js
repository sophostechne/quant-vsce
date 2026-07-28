/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	// Mirrors the frame layout in src/protocol.ts. Keep the two in sync.
	const FRAME_HEADER_BYTES = 8;
	const TICK_RECORD_BYTES = 32;
	const FRAME_TYPE_TICK = 1;

	const symbolInput = /** @type {HTMLInputElement} */ (document.getElementById('symbol'));
	const timeframeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('timeframe'));
	const lastLabel = /** @type {HTMLElement} */ (document.getElementById('last'));
	const statusLabel = /** @type {HTMLElement} */ (document.getElementById('status'));
	const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
	const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

	/** @type {{time:number,open:number,high:number,low:number,close:number,volume:number}[]} */
	let bars = [];
	let symbolId = -1;
	let lastPrice = 0;
	let previousClose = 0;
	let socket = null;
	let repaintQueued = false;

	// Ticks arrive far faster than the display refreshes. Coalesce onto rAF and never paint
	// on the message handler itself.
	function requestRepaint() {
		if (repaintQueued) {
			return;
		}
		repaintQueued = true;
		requestAnimationFrame(() => {
			repaintQueued = false;
			render();
		});
	}

	function setStatus(text, isWarning) {
		statusLabel.textContent = text || '';
		statusLabel.classList.toggle('warn', Boolean(isWarning));
	}

	function applyPrice(price) {
		lastPrice = price;
		const bar = bars[bars.length - 1];
		if (bar) {
			bar.close = price;
			bar.high = Math.max(bar.high, price);
			bar.low = Math.min(bar.low, price);
		}
		lastLabel.textContent = price.toFixed(2);
		lastLabel.classList.toggle('up', price >= previousClose);
		lastLabel.classList.toggle('down', price < previousClose);
		requestRepaint();
	}

	/** Reads packed tick records straight out of the frame; allocates nothing per tick. */
	function handleFrame(buffer) {
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

	function connectDataPlane(url) {
		if (socket) {
			socket.close();
			socket = null;
		}
		if (!url) {
			return;
		}
		try {
			socket = new WebSocket(url);
			socket.binaryType = 'arraybuffer';
			socket.onopen = () => setStatus('live');
			socket.onmessage = event => {
				if (event.data instanceof ArrayBuffer) {
					handleFrame(event.data);
				}
			};
			socket.onclose = () => setStatus('data plane disconnected', true);
			socket.onerror = () => setStatus('data plane error', true);
		} catch (error) {
			setStatus('cannot reach data plane', true);
		}
	}

	function render() {
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

		const toY = price => padTop + (max - price) / (max - min) * plotHeight;

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
			const bar = bars[i];
			const x = i * slot + slot / 2;
			const rising = bar.close >= bar.open;
			const color = rising ? upColor : downColor;

			context.strokeStyle = color;
			context.fillStyle = color;

			context.beginPath();
			context.moveTo(Math.round(x) + 0.5, toY(bar.high));
			context.lineTo(Math.round(x) + 0.5, toY(bar.low));
			context.stroke();

			const openY = toY(bar.open);
			const closeY = toY(bar.close);
			const top = Math.min(openY, closeY);
			const bodyHeight = Math.max(1, Math.abs(closeY - openY));
			context.fillRect(x - bodyWidth / 2, top, bodyWidth, bodyHeight);
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

	window.addEventListener('message', event => {
		const message = event.data;
		switch (message.type) {
			case 'config':
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
				} else if (socket) {
					socket.close();
					socket = null;
				}
				if (message.simulated) {
					setStatus('simulated data', true);
				} else if (!message.dataPlaneUrl) {
					setStatus('no data plane', true);
				}
				break;

			case 'history':
				bars = message.bars.map(bar => ({ ...bar }));
				previousClose = bars.length > 1 ? bars[bars.length - 2].close : 0;
				lastPrice = bars.length > 0 ? bars[bars.length - 1].close : 0;
				if (lastPrice > 0) {
					lastLabel.textContent = lastPrice.toFixed(2);
				}
				requestRepaint();
				break;

			// Development relay: used only while the simulated feed is driving the UI.
			case 'ticks':
				if (message.ticks.length > 0) {
					applyPrice(message.ticks[message.ticks.length - 1].price);
				}
				break;

			case 'status':
				setStatus(message.message, true);
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
}());
