/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { TIMEFRAMES, Timeframe } from '../protocol';

/**
 * Overlays share the candles' price scale; studies get a pane of their own, because an RSI of
 * 70 and a price of 70 are not the same quantity.
 */
const INDICATOR_TYPES = ['sma', 'ema', 'bbands', 'vwap', 'rsi', 'macd', 'stoch', 'atr', 'volume'] as const;
export type IndicatorType = typeof INDICATOR_TYPES[number];

export interface IndicatorSpec {
	type: IndicatorType;
	period?: number;
	stddev?: number;
	/** MACD only. */
	fast?: number;
	slow?: number;
	signal?: number;
	color?: string;
}

/** Per-bar renderings share the time axis; the last four replace the series. */
const CHART_STYLES = [
	'candles', 'hollow', 'bars', 'volumeCandles', 'highLow',
	'line', 'stepLine', 'area', 'hlcArea', 'baseline', 'columns',
	'heikinAshi', 'renko', 'lineBreak', 'rangeBars',
] as const;
export type ChartStyle = typeof CHART_STYLES[number];

export interface StyleOptions {
	brickSize?: number;
	lineBreakCount?: number;
	baselineValue?: number;
}

export type PriceScale = 'linear' | 'log';

export interface ChartDocumentModel {
	style: ChartStyle;
	/** Price pane only. Study panes stay linear, since they can be zero or negative. */
	scale: PriceScale;
	styleOptions?: StyleOptions;
	symbol: string;
	timeframe: Timeframe;
	bars: number;
	indicators: IndicatorSpec[];
	/**
	 * Fraction of the plot height taken by each study pane, in order. The price pane keeps the
	 * remainder. Absent means "distribute evenly", which is what a chart starts as.
	 */
	paneHeights?: number[];
}

const DEFAULT_MODEL: ChartDocumentModel = { style: 'candles', scale: 'linear', symbol: 'AAPL', timeframe: '1m', bars: 240, indicators: [] };

/**
 * Indicators come from the document, so a malformed entry is user input rather than a bug.
 * Unknown types are dropped rather than rejecting the whole file - one bad line should not
 * blank the chart.
 */
function parseIndicators(value: unknown, log: Logger): IndicatorSpec[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const parsed: IndicatorSpec[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const candidate = entry as Partial<IndicatorSpec>;
		if (!INDICATOR_TYPES.includes(candidate.type as IndicatorType)) {
			log.warn(`Ignoring unknown indicator type: ${JSON.stringify(candidate.type)}`);
			continue;
		}
		const spec: IndicatorSpec = { type: candidate.type as IndicatorType };
		if (typeof candidate.period === 'number' && candidate.period >= 2) {
			spec.period = Math.min(Math.floor(candidate.period), 1000);
		}
		if (typeof candidate.stddev === 'number' && candidate.stddev > 0) {
			spec.stddev = Math.min(candidate.stddev, 10);
		}
		for (const key of ['fast', 'slow', 'signal'] as const) {
			const value = candidate[key];
			if (typeof value === 'number' && value >= 2) {
				spec[key] = Math.min(Math.floor(value), 1000);
			}
		}
		if (typeof candidate.color === 'string') {
			spec.color = candidate.color;
		}
		parsed.push(spec);
	}
	return parsed;
}


/** Style options come from a user-editable file, so they are bounded on read. */
function parseStyleOptions(value: unknown): StyleOptions | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as StyleOptions;
	const out: StyleOptions = {};
	if (typeof candidate.brickSize === 'number' && candidate.brickSize > 0) {
		out.brickSize = candidate.brickSize;
	}
	if (typeof candidate.lineBreakCount === 'number' && candidate.lineBreakCount >= 1) {
		out.lineBreakCount = Math.min(Math.floor(candidate.lineBreakCount), 10);
	}
	if (typeof candidate.baselineValue === 'number' && Number.isFinite(candidate.baselineValue)) {
		out.baselineValue = candidate.baselineValue;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Labels for the style picker, in the order they are offered. */
export const STYLE_LABELS: readonly { style: ChartStyle; label: string; description: string }[] = [
	{ style: 'candles', label: 'Candles', description: '' },
	{ style: 'hollow', label: 'Hollow Candles', description: 'coloured against the previous close' },
	{ style: 'bars', label: 'Bars (OHLC)', description: '' },
	{ style: 'volumeCandles', label: 'Volume Candles', description: 'body width scales with volume' },
	{ style: 'highLow', label: 'High-Low', description: '' },
	{ style: 'line', label: 'Line', description: 'close only' },
	{ style: 'stepLine', label: 'Step Line', description: '' },
	{ style: 'area', label: 'Area', description: '' },
	{ style: 'hlcArea', label: 'HLC Area', description: 'high-low band with close' },
	{ style: 'baseline', label: 'Baseline', description: 'shaded either side of a level' },
	{ style: 'columns', label: 'Columns', description: '' },
	{ style: 'heikinAshi', label: 'Heikin Ashi', description: 'rewrites each bar; opens are not traded prices' },
	{ style: 'renko', label: 'Renko', description: 'bricks by price move — irregular time axis' },
	{ style: 'lineBreak', label: 'Line Break', description: 'irregular time axis' },
	{ style: 'rangeBars', label: 'Range Bars', description: 'irregular time axis' },
];

/**
 * Pane heights are fractions written back by dragging, so they are bounded rather than
 * trusted: a stored zero or a NaN would collapse a pane with no way to drag it back.
 */
function parsePaneHeights(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const heights = value
		.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
		.map(entry => Math.min(Math.max(entry, 0.05), 0.8));
	return heights.length > 0 ? heights : undefined;
}

/** Human-readable label for a spec, used in pickers and logs. */
export function describeIndicator(spec: IndicatorSpec): string {
	switch (spec.type) {
		case 'bbands':
			return `Bollinger ${spec.period ?? 20}/${spec.stddev ?? 2}`;
		case 'macd':
			return `MACD ${spec.fast ?? 12}/${spec.slow ?? 26}/${spec.signal ?? 9}`;
		case 'vwap':
			return 'VWAP';
		case 'volume':
			return 'Volume';
		default:
			return `${spec.type.toUpperCase()} ${spec.period ?? ''}`.trim();
	}
}

export function parseModel(document: vscode.TextDocument, log: Logger): ChartDocumentModel {
	const text = document.getText().trim();
	if (!text) {
		return { ...DEFAULT_MODEL };
	}
	try {
		const parsed = JSON.parse(text) as Partial<ChartDocumentModel>;
		const timeframe = TIMEFRAMES.includes(parsed.timeframe as Timeframe)
			? parsed.timeframe as Timeframe
			: DEFAULT_MODEL.timeframe;
		return {
			style: CHART_STYLES.includes(parsed.style as ChartStyle) ? parsed.style as ChartStyle : DEFAULT_MODEL.style,
			scale: parsed.scale === 'log' ? 'log' : 'linear',
			styleOptions: parseStyleOptions(parsed.styleOptions),
			symbol: typeof parsed.symbol === 'string' && parsed.symbol.trim() ? parsed.symbol.trim().toUpperCase() : DEFAULT_MODEL.symbol,
			timeframe,
			bars: typeof parsed.bars === 'number' && parsed.bars > 0 ? Math.min(parsed.bars, 5_000) : DEFAULT_MODEL.bars,
			indicators: parseIndicators(parsed.indicators, log),
			paneHeights: parsePaneHeights(parsed.paneHeights)
		};
	} catch {
		log.warn(`${document.uri.fsPath} is not valid JSON; using defaults.`);
		return { ...DEFAULT_MODEL };
	}
}

export async function writeModel(document: vscode.TextDocument, model: ChartDocumentModel): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.replace(
		document.uri,
		new vscode.Range(0, 0, document.lineCount, 0),
		JSON.stringify(model, undefined, '\t') + '\n'
	);
	await vscode.workspace.applyEdit(edit);
}


export function defaultChartContent(symbol: string): string {
	const model: ChartDocumentModel = { ...DEFAULT_MODEL, symbol };
	return JSON.stringify(model, undefined, '\t') + '\n';
}
