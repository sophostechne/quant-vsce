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

export interface ChartDocumentModel {
	symbol: string;
	timeframe: Timeframe;
	bars: number;
	indicators: IndicatorSpec[];
}

const DEFAULT_MODEL: ChartDocumentModel = { symbol: 'AAPL', timeframe: '1m', bars: 240, indicators: [] };

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
			symbol: typeof parsed.symbol === 'string' && parsed.symbol.trim() ? parsed.symbol.trim().toUpperCase() : DEFAULT_MODEL.symbol,
			timeframe,
			bars: typeof parsed.bars === 'number' && parsed.bars > 0 ? Math.min(parsed.bars, 5_000) : DEFAULT_MODEL.bars,
			indicators: parseIndicators(parsed.indicators, log)
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
