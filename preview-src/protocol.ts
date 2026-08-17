/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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

/**
 * Where the bars currently on screen came from.
 *
 * `history` is published historical data with no live stream behind it: real prices, but the
 * last bar is the last session's, not this second's. It is a different claim from both `live`
 * and `simulated`, and collapsing it into either would misstate what the user is looking at.
 */
export type BarProvenance = 'live' | 'history' | 'simulated';

/**
 * What a user's visualizers drew, already validated by the extension host.
 *
 * The gaps are typed `null`, not `undefined`, and that is not a detail. Everywhere else in the
 * chart a missing value is `undefined` - a warm-up bar, a bar no regime covers - and every
 * consumer tests for exactly that. This message is the one that crosses `postMessage`, which VS
 * Code serialises as JSON, and `JSON.stringify([undefined])` is `"[null]"`. The host sends holes
 * and the webview receives nulls.
 *
 * Declaring `undefined` here said the opposite and compiled, so `value !== undefined` passed for
 * every hole: a gap became a real value worth zero, which dragged the price axis down to zero,
 * and a null colour reached `themeColor` and threw mid-frame. `chart.ts` converts these back to
 * `undefined` on receipt; the types exist to make anyone who skips that step fail to compile.
 */
export interface VisualizersMessage {
	type: 'visualizers';
	/** The bars this was computed against. Drawn only while it matches what is on screen. */
	token: string;
	series: readonly {
		readonly label: string;
		readonly color: string;
		readonly fill: boolean;
		readonly overlay: boolean;
		readonly lines: readonly (readonly (number | null)[])[];
	}[];
	/** One colour per bar, painted behind everything. Null leaves a bar untinted. */
	background: readonly (string | null)[];
	markers: readonly {
		readonly index: number;
		readonly text: string;
		readonly color: string;
		readonly above: boolean;
	}[];
}

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
	/** The subset of `timeframes` the user added themselves, which are the removable ones. */
	customIntervals?: readonly string[];
	dataPlaneUrl?: string;
	symbolId?: number;
	style?: string;
	scale?: 'linear' | 'log';
	styleOptions?: { brickSize?: number; lineBreakCount?: number; baselineValue?: number };
	indicators?: readonly IndicatorSpec[];
	drawings?: readonly { tool: string; points: { time: number; price: number }[]; color?: string; text?: string }[];
	paneHeights?: readonly number[];
	simulated: boolean;
}

export interface HistoryMessage {
	type: 'history';
	symbol: string;
	bars: readonly Bar[];
	source?: BarProvenance;
	/** Identifies these exact bars, so late-arriving overlays can prove they still match. */
	token?: string;
	/** Which venue's prices these are; two crypto sources are not the same instrument. */
	venue?: string;
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

export interface ArmToolMessage {
	type: 'armTool';
	/** Undefined disarms, returning the chart to panning. */
	tool?: string;
	/** Caption for tools that carry one, collected before arming. */
	text?: string;
}

export type HostMessage = ConfigMessage | HistoryMessage | TicksMessage | StatusMessage | ArmToolMessage | VisualizersMessage;
