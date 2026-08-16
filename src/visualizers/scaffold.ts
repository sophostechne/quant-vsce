/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Creates a working visualizer and attaches it to the chart in front of the user.
 *
 * A feature reachable only by knowing a filename convention and a JSON key is a feature nobody
 * finds. This writes a file that already draws something, copies the declarations next to it so
 * the editor checks it immediately, and adds it to the open chart - so the first thing the user
 * sees is their own line on their own chart, which is the point they can start editing from.
 */

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { ChartDocumentModel, parseModel, writeModel } from '../chart/chartModel';

const DECLARATIONS = 'quant-visualizer.d.ts';

const TEMPLATE = `/// <reference path="./${DECLARATIONS}" />

/**
 * A moving-average ribbon. Edit freely - the chart redraws when you save.
 *
 * Types are stripped by Node when this is imported, so there is no build step. \`enum\`,
 * \`namespace\` and constructor parameter properties are the only TypeScript features
 * unavailable here.
 */
export default function ribbon(bars: readonly Bar[], ctx: VisualizerContext): VisualizerSeries[] {
	const closes: number[] = bars.map(bar => bar.close);

	return [10, 20, 50].map((period, index): VisualizerSeries => ({
		label: \`MA \${period}\`,
		color: ctx.palette[index % ctx.palette.length],
		overlay: true,
		lines: [movingAverage(closes, period)],
	}));
}

/** Undefined until the window is full: a partial average is not an average. */
function movingAverage(values: readonly number[], period: number): (number | undefined)[] {
	const out: (number | undefined)[] = new Array(values.length);
	let sum = 0;
	for (let i = 0; i < values.length; i++) {
		sum += values[i]!;
		if (i >= period) {
			sum -= values[i - period]!;
		}
		out[i] = i >= period - 1 ? sum / period : undefined;
	}
	return out;
}
`;

export async function newVisualizer(
	extensionUri: vscode.Uri,
	activeChart: vscode.TextDocument | undefined,
	log: Logger
): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		void vscode.window.showWarningMessage(
			vscode.l10n.t('Open a folder first. A visualizer is a file in your workspace.'));
		return;
	}

	const name = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Name for the visualizer'),
		value: 'ribbon',
		validateInput: value => /^[\w-]+$/.test(value.trim())
			? undefined
			: vscode.l10n.t('Letters, digits, dashes and underscores only.'),
	});
	if (!name) {
		return;
	}

	const relative = `${name.trim()}.visualizer.mts`;
	const target = vscode.Uri.joinPath(folder.uri, relative);
	const encoder = new TextEncoder();

	try {
		// Copied beside the visualizer rather than referenced inside the installed extension: a
		// path into an extensions directory carries a version number and breaks on the next
		// update, and would not survive the workspace being shared.
		const declarations = vscode.Uri.joinPath(extensionUri, 'resources', DECLARATIONS);
		await vscode.workspace.fs.copy(
			declarations,
			vscode.Uri.joinPath(folder.uri, DECLARATIONS),
			{ overwrite: true });

		await vscode.workspace.fs.writeFile(target, encoder.encode(TEMPLATE));
	} catch (error) {
		log.error('Could not create the visualizer', error);
		void vscode.window.showErrorMessage(
			vscode.l10n.t('Could not create {0}: {1}', relative, error instanceof Error ? error.message : String(error)));
		return;
	}

	if (activeChart) {
		const model = parseModel(activeChart, log);
		const existing = model.visualizers ?? [];
		// Listing a visualizer twice runs it twice and draws it twice, so re-running the command
		// for a name already attached must not append. Overwriting a file the user already had
		// is the deliberate part of that: they asked for this name again.
		const attached: ChartDocumentModel = {
			...model,
			visualizers: existing.includes(relative) ? existing : [...existing, relative],
		};
		await writeModel(activeChart, attached);
	}

	const document = await vscode.workspace.openTextDocument(target);
	await vscode.window.showTextDocument(document, { preview: false });

	if (!activeChart) {
		void vscode.window.showInformationMessage(
			vscode.l10n.t('Created {0}. Add it to a chart\'s "visualizers" list to draw it.', relative));
	}
}
