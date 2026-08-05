/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { NodeType, OpName } from './vocabulary';

/**
 * What each operation and slot type is called in the designer.
 *
 * These live here rather than beside the operations they name, because they are the only part
 * of the vocabulary that is user-facing. The engine that defines the operations has no access
 * to the workbench's string bundle, so exporting names from it would put them permanently
 * beyond translation.
 *
 * Typing the table as `Record<OpName, string>` is what keeps the two halves in step: `OpName`
 * is generated from the engine's own vocabulary, so adding an operation there breaks the build
 * here until it has been given a name. The alternative - a lookup with a fallback - degrades
 * silently, and the symptom is a picker offering `price_gt` to a user.
 */
const OPERATION_LABELS: Record<OpName, () => string> = {
	close: () => vscode.l10n.t('Close'),
	open: () => vscode.l10n.t('Open'),
	high: () => vscode.l10n.t('High'),
	low: () => vscode.l10n.t('Low'),
	sma: () => vscode.l10n.t('Moving Average'),
	ema: () => vscode.l10n.t('Exp. Moving Average'),
	highest: () => vscode.l10n.t('Highest'),
	lowest: () => vscode.l10n.t('Lowest'),

	rsi: () => vscode.l10n.t('RSI'),
	stoch: () => vscode.l10n.t('Stochastic'),
	osc_sma: () => vscode.l10n.t('Smoothed'),
	pctrank: () => vscode.l10n.t('Percentile Rank'),
	vol_rank: () => vscode.l10n.t('Volatility Rank'),

	level: () => vscode.l10n.t('Level'),

	// Comparisons read as the verb of a sentence - "RSI is above 70" - so they are phrased as
	// such rather than as symbols. The price and oscillator variants deliberately share wording:
	// the distinction between them is a typing concern, and surfacing it would only invite the
	// question of which one to pick when the slot has already decided.
	price_gt: () => vscode.l10n.t('is above'),
	price_lt: () => vscode.l10n.t('is below'),
	price_cross_above: () => vscode.l10n.t('crosses above'),
	price_cross_below: () => vscode.l10n.t('crosses below'),
	osc_gt: () => vscode.l10n.t('is above'),
	osc_lt: () => vscode.l10n.t('is below'),
	osc_cross_above: () => vscode.l10n.t('crosses above'),
	osc_cross_below: () => vscode.l10n.t('crosses below'),

	and: () => vscode.l10n.t('and'),
	or: () => vscode.l10n.t('or'),
	not: () => vscode.l10n.t('not')
};

/** What a slot is asking for, in the user's terms rather than the type system's. */
const TYPE_LABELS: Record<NodeType, () => string> = {
	price: () => vscode.l10n.t('price'),
	osc: () => vscode.l10n.t('indicator'),
	level: () => vscode.l10n.t('threshold'),
	bool: () => vscode.l10n.t('condition')
};

export interface Labels {
	readonly ops: Record<string, string>;
	readonly types: Record<string, string>;
}

/**
 * Resolves every label for the current locale.
 *
 * Called when a designer opens rather than at module load, so a language change takes effect on
 * the next editor instead of requiring a restart. Each entry is a function for the same reason:
 * a plain string would be captured once, at whatever locale happened to be active first.
 */
export function resolveLabels(): Labels {
	const ops: Record<string, string> = {};
	for (const [op, label] of Object.entries(OPERATION_LABELS)) {
		ops[op] = label();
	}

	const types: Record<string, string> = {};
	for (const [type, label] of Object.entries(TYPE_LABELS)) {
		types[type] = label();
	}

	return { ops, types };
}
