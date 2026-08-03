/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChartStyle, IndicatorSpec, IndicatorType, STYLE_LABELS, describeIndicator, parseModel, writeModel } from './chartModel';
import { Logger } from '../logger';

/** Numeric config keys a picker can prompt for. */
type NumericKey = 'period' | 'stddev' | 'fast' | 'slow' | 'signal';

interface IndicatorChoice extends vscode.QuickPickItem {
	readonly type: IndicatorType;
	/** Prompts shown in order after the type is chosen. */
	readonly parameters: readonly { key: NumericKey; prompt: string; value: number }[];
}

const CHOICES: readonly IndicatorChoice[] = [
	{ label: 'Moving Average (SMA)', description: 'overlay', type: 'sma', parameters: [{ key: 'period', prompt: 'Period', value: 50 }] },
	{ label: 'Exponential Moving Average (EMA)', description: 'overlay', type: 'ema', parameters: [{ key: 'period', prompt: 'Period', value: 20 }] },
	{ label: 'Bollinger Bands', description: 'overlay', type: 'bbands', parameters: [{ key: 'period', prompt: 'Period', value: 20 }, { key: 'stddev', prompt: 'Standard deviations', value: 2 }] },
	{ label: 'VWAP', description: 'overlay — running, not session', type: 'vwap', parameters: [] },
	{ label: 'RSI', description: 'own pane', type: 'rsi', parameters: [{ key: 'period', prompt: 'Period', value: 14 }] },
	{ label: 'MACD', description: 'own pane', type: 'macd', parameters: [{ key: 'fast', prompt: 'Fast period', value: 12 }, { key: 'slow', prompt: 'Slow period', value: 26 }, { key: 'signal', prompt: 'Signal period', value: 9 }] },
	{ label: 'Stochastic', description: 'own pane', type: 'stoch', parameters: [{ key: 'period', prompt: 'Period', value: 14 }] },
	{ label: 'ATR', description: 'own pane', type: 'atr', parameters: [{ key: 'period', prompt: 'Period', value: 14 }] },
	{ label: 'Volume', description: 'own pane', type: 'volume', parameters: [] },
];

/**
 * The `.chart` document is the single source of truth, so every command edits it rather than
 * holding state of its own. That is what gives undo, save, diff and version control for free -
 * and it means a chart configured through the UI and one configured by hand are the same thing.
 */
export function registerIndicatorCommands(log: Logger): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.commands.registerCommand('quant.addIndicator', () => addIndicator(log)),
		vscode.commands.registerCommand('quant.removeIndicator', () => removeIndicator(log)),
		vscode.commands.registerCommand('quant.setChartStyle', () => setChartStyle(log)),
	);
}

async function setChartStyle(log: Logger): Promise<void> {
	const document = await activeChartDocument();
	if (!document) {
		return;
	}
	const model = parseModel(document, log);

	const picked = await vscode.window.showQuickPick(
		STYLE_LABELS.map(entry => ({
			label: entry.label,
			description: entry.description,
			// A tick beside the current style, so the picker reports state as well as setting it.
			picked: entry.style === model.style,
			style: entry.style as ChartStyle,
		})),
		{ title: vscode.l10n.t('Chart Style'), placeHolder: model.style },
	);
	if (!picked || picked.style === model.style) {
		return;
	}

	await writeModel(document, { ...model, style: picked.style });
	log.info(`Chart style set to ${picked.style} for ${document.uri.fsPath}`);
}

/** The `.chart` document behind the active custom editor, if there is one. */
async function activeChartDocument(): Promise<vscode.TextDocument | undefined> {
	const uri = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	const candidate = uri instanceof vscode.TabInputCustom ? uri.uri : undefined;
	if (!candidate || !candidate.path.endsWith('.chart')) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Open a chart first.'));
		return undefined;
	}
	return vscode.workspace.openTextDocument(candidate);
}

async function addIndicator(log: Logger): Promise<void> {
	const document = await activeChartDocument();
	if (!document) {
		return;
	}

	const choice = await vscode.window.showQuickPick(CHOICES, {
		title: vscode.l10n.t('Add Indicator'),
		placeHolder: vscode.l10n.t('Overlays share the price scale; the rest get their own pane'),
	});
	if (!choice) {
		return;
	}

	const spec: IndicatorSpec = { type: choice.type };
	for (const parameter of choice.parameters) {
		const entered = await vscode.window.showInputBox({
			title: `${choice.label} — ${parameter.prompt}`,
			value: String(parameter.value),
			validateInput: text => {
				const parsed = Number(text);
				return Number.isFinite(parsed) && parsed > 0
					? undefined
					: vscode.l10n.t('Enter a positive number.');
			},
		});
		if (entered === undefined) {
			return; // Cancelled part-way: add nothing rather than a half-configured indicator.
		}
		spec[parameter.key] = Number(entered);
	}

	const model = parseModel(document, log);
	await writeModel(document, { ...model, indicators: [...model.indicators, spec] });
	log.info(`Added indicator ${describeIndicator(spec)} to ${document.uri.fsPath}`);
}

async function removeIndicator(log: Logger): Promise<void> {
	const document = await activeChartDocument();
	if (!document) {
		return;
	}

	const model = parseModel(document, log);
	if (model.indicators.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t('This chart has no indicators.'));
		return;
	}

	const picked = await vscode.window.showQuickPick(
		model.indicators.map((spec, index) => ({ label: describeIndicator(spec), index })),
		{ title: vscode.l10n.t('Remove Indicator'), canPickMany: true },
	);
	if (!picked || picked.length === 0) {
		return;
	}

	const removed = new Set(picked.map(item => item.index));
	await writeModel(document, {
		...model,
		indicators: model.indicators.filter((_, index) => !removed.has(index)),
	});
	log.info(`Removed ${removed.size} indicator(s) from ${document.uri.fsPath}`);
}
