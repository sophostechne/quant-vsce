/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Frame layout shared with `src/protocol.ts` and the daemon. Duplicated rather than imported
 * because the webview bundle cannot reach the extension host sources; the three must change
 * together.
 */

export const FRAME_HEADER_BYTES = 8;
export const TICK_RECORD_BYTES = 32;
export const FRAME_TYPE_TICK = 1;

export interface Bar {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

/** Where the bars currently on screen came from. */
export type BarSource = 'live' | 'simulated';

export interface IndicatorSpec {
	type: 'sma' | 'ema' | 'bbands' | 'vwap' | 'rsi' | 'macd' | 'stoch' | 'atr' | 'volume';
	period?: number;
	stddev?: number;
	fast?: number;
	slow?: number;
	signal?: number;
	color?: string;
}

export interface ConfigMessage {
	type: 'config';
	symbol: string;
	timeframe: string;
	timeframes: readonly string[];
	dataPlaneUrl?: string;
	symbolId?: number;
	style?: string;
	scale?: 'linear' | 'log';
	styleOptions?: { brickSize?: number; lineBreakCount?: number; baselineValue?: number };
	indicators?: readonly IndicatorSpec[];
	paneHeights?: readonly number[];
	simulated: boolean;
}

export interface HistoryMessage {
	type: 'history';
	symbol: string;
	bars: readonly Bar[];
	source?: BarSource;
	error?: string;
}

export interface TicksMessage {
	type: 'ticks';
	ticks: readonly { price: number }[];
}

export interface StatusMessage {
	type: 'status';
	message: string;
}

export type HostMessage = ConfigMessage | HistoryMessage | TicksMessage | StatusMessage;
