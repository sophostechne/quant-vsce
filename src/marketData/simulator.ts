/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Bar, Quote, Tick, TickSide, Timeframe, timeframeToMillis } from '../protocol';

const TICK_INTERVAL_MS = 100;
const QUOTE_INTERVAL_MS = 250;

interface SimulatedInstrument {
	readonly symbol: string;
	readonly id: number;
	readonly open: number;
	price: number;
	sequence: number;
}

/**
 * Synthetic feed used when no daemon is reachable, so the workbench has something to render
 * during development. It is deliberately obvious: a geometric random walk seeded from the
 * symbol name, never a real market.
 */
export class SimulatedFeed implements vscode.Disposable {

	private readonly _instruments = new Map<string, SimulatedInstrument>();
	private _tickTimer: NodeJS.Timeout | undefined;
	private _quoteTimer: NodeJS.Timeout | undefined;
	private _nextId = 1;
	private _running = false;

	private readonly _onDidProduceQuote = new vscode.EventEmitter<Quote>();
	readonly onDidProduceQuote = this._onDidProduceQuote.event;

	private readonly _onDidProduceTicks = new vscode.EventEmitter<readonly Tick[]>();
	readonly onDidProduceTicks = this._onDidProduceTicks.event;

	get isRunning(): boolean {
		return this._running;
	}

	start(): void {
		if (this._running) {
			return;
		}
		this._running = true;
		this._tickTimer = setInterval(() => this._emitTicks(), TICK_INTERVAL_MS);
		this._quoteTimer = setInterval(() => this._emitQuotes(), QUOTE_INTERVAL_MS);
	}

	stop(): void {
		this._running = false;
		if (this._tickTimer) {
			clearInterval(this._tickTimer);
			this._tickTimer = undefined;
		}
		if (this._quoteTimer) {
			clearInterval(this._quoteTimer);
			this._quoteTimer = undefined;
		}
	}

	subscribe(symbols: readonly string[]): void {
		for (const symbol of symbols) {
			if (this._instruments.has(symbol)) {
				continue;
			}
			const open = seedPrice(symbol);
			this._instruments.set(symbol, { symbol, id: this._nextId++, open, price: open, sequence: 0 });
		}
	}

	unsubscribe(symbols: readonly string[]): void {
		for (const symbol of symbols) {
			this._instruments.delete(symbol);
		}
	}

	symbolId(symbol: string): number | undefined {
		return this._instruments.get(symbol)?.id;
	}

	history(symbol: string, timeframe: Timeframe, count: number): readonly Bar[] {
		const step = timeframeToMillis(timeframe);
		const now = Date.now();
		const bars: Bar[] = [];
		let price = seedPrice(symbol);
		let random = hash(symbol);

		for (let i = count - 1; i >= 0; i--) {
			const open = price;
			let high = open;
			let low = open;
			// A handful of intra-bar steps so the wicks are not degenerate.
			for (let j = 0; j < 8; j++) {
				random = nextRandom(random);
				price *= 1 + (random / 0xffffffff - 0.5) * 0.004;
				high = Math.max(high, price);
				low = Math.min(low, price);
			}
			random = nextRandom(random);
			bars.push({
				time: now - i * step,
				open: round(open),
				high: round(high),
				low: round(low),
				close: round(price),
				volume: Math.floor((random / 0xffffffff) * 5_000) + 100
			});
		}
		return bars;
	}

	private _emitTicks(): void {
		if (this._instruments.size === 0) {
			return;
		}
		const now = Date.now();
		const ticks: Tick[] = [];
		for (const instrument of this._instruments.values()) {
			instrument.price *= 1 + (Math.random() - 0.5) * 0.0015;
			instrument.sequence++;
			ticks.push({
				symbolId: instrument.id,
				side: Math.random() > 0.5 ? TickSide.Bid : TickSide.Ask,
				sequence: instrument.sequence,
				timestamp: now,
				price: round(instrument.price),
				size: Math.floor(Math.random() * 50) + 1
			});
		}
		this._onDidProduceTicks.fire(ticks);
	}

	private _emitQuotes(): void {
		for (const instrument of this._instruments.values()) {
			const last = round(instrument.price);
			const change = round(last - instrument.open);
			this._onDidProduceQuote.fire({
				symbol: instrument.symbol,
				last,
				change,
				changePercent: instrument.open === 0 ? 0 : round((change / instrument.open) * 100),
				timestamp: Date.now()
			});
		}
	}

	dispose(): void {
		this.stop();
		this._instruments.clear();
		this._onDidProduceQuote.dispose();
		this._onDidProduceTicks.dispose();
	}
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function hash(text: string): number {
	let value = 2166136261;
	for (let i = 0; i < text.length; i++) {
		value ^= text.charCodeAt(i);
		value = Math.imul(value, 16777619);
	}
	return value >>> 0;
}

function nextRandom(state: number): number {
	let value = state;
	value ^= value << 13;
	value ^= value >>> 17;
	value ^= value << 5;
	return value >>> 0;
}

function seedPrice(symbol: string): number {
	return round(20 + (hash(symbol) % 48000) / 100);
}
