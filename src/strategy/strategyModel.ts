/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { NodeType, VOCABULARY } from './vocabulary';

/**
 * A strategy is an expression tree, in the same shape the evolutionary engine reads and writes.
 * Keeping one representation means an evolved strategy can be opened in the designer and a
 * hand-built one can be fed back into the search, without a conversion step where the two
 * definitions could disagree.
 */
export interface StrategyNode {
	op: string;
	params?: Record<string, number>;
	children?: StrategyNode[];
}

export type Direction = 'long' | 'short';

export interface StrategyModel {
	entry: StrategyNode;
	exit: StrategyNode;
	/** Fraction of the account committed per position. */
	size: number;
	/** Protective stop as a multiple of ATR; null means none. */
	stop_atr: number | null;
	direction: Direction;
}

const MIN_SIZE = 0.01;
const MAX_SIZE = 1;

/**
 * Protective stop sizes offered in the designer, as multiples of ATR.
 *
 * Sent to the webview rather than duplicated there, for the same reason the vocabulary is:
 * one list, so the choices cannot drift from what the engine's mutation operator uses.
 */
export const STOP_CHOICES: readonly (number | null)[] = [null, 1.5, 2, 3];

/**
 * A tree that does nothing, used for a new file and for any slot the user has not filled in.
 *
 * Deliberately a real comparison rather than an empty placeholder: every node in the document
 * has to be evaluable, so that a half-finished strategy is still a valid one rather than
 * something the engine would reject.
 */
export function defaultCondition(): StrategyNode {
	return {
		op: 'osc_gt',
		children: [
			{ op: 'stoch', params: { period: 14 } },
			{ op: 'level', params: { value: 50 } }
		]
	};
}

export function defaultStrategy(): StrategyModel {
	return {
		entry: defaultCondition(),
		exit: defaultCondition(),
		size: 0.1,
		stop_atr: 2,
		direction: 'long'
	};
}

export function defaultStrategyContent(): string {
	return JSON.stringify(defaultStrategy(), undefined, '\t') + '\n';
}

/**
 * Reads a strategy from `document`, repairing anything malformed rather than refusing to open.
 *
 * A designer that shows nothing when the file has a typo is worse than one that shows a
 * recoverable strategy, because the file is hand-editable by design and the editor is the most
 * convenient place to notice and fix the problem.
 */
export function parseStrategy(document: vscode.TextDocument, log: Logger): StrategyModel {
	const text = document.getText().trim();
	if (!text) {
		return defaultStrategy();
	}

	try {
		const raw = JSON.parse(text) as Partial<StrategyModel>;
		return {
			entry: parseNode(raw.entry, 'bool'),
			exit: parseNode(raw.exit, 'bool'),
			size: clampSize(raw.size),
			stop_atr: parseStop(raw.stop_atr),
			direction: raw.direction === 'short' ? 'short' : 'long'
		};
	} catch (error) {
		log.warn(`Could not read strategy ${document.uri.fsPath}: ${error}`);
		return defaultStrategy();
	}
}

/**
 * Coerces `value` into a well-typed node returning `want`.
 *
 * The type check is the point. An operation in the wrong slot - an oscillator where a price
 * belongs - would be silently unevaluable, so anything that does not fit is replaced by
 * something that does rather than passed along to fail later.
 */
export function parseNode(value: unknown, want: NodeType): StrategyNode {
	const raw = value as StrategyNode | undefined;
	const signature = raw?.op ? VOCABULARY.ops[raw.op] : undefined;
	if (!raw || !signature || signature.returns !== want) {
		return placeholder(want);
	}

	const node: StrategyNode = { op: raw.op };
	const accepts = signature.accepts;

	if (signature.period) {
		const [low, high] = signature.period;
		node.params = { period: clampInt(raw.params?.period, low, high, low) };
	} else if (raw.op === 'level') {
		node.params = { value: clampInt(raw.params?.value, 0, 100, 50) };
	}

	if (accepts.length) {
		node.children = accepts.map((kind, index) => parseNode(raw.children?.[index], kind));
	}

	return node;
}

/**
 * The simplest well-typed node of the requested type.
 *
 * Recursion terminates because every type either has a terminal or, for conditions, a function
 * whose own children bottom out in terminals - the same property that lets the engine generate
 * random trees without looping.
 */
export function placeholder(want: NodeType): StrategyNode {
	const op = VOCABULARY.terminals[want][0] ?? VOCABULARY.functions[want][0];
	// Conditions have no terminal, since a bare condition has to compare something, so they
	// fall through to a complete comparison rather than to a lone operator.
	return op === undefined || want === 'bool' ? defaultCondition() : withDefaults(op);
}

/** A node for `op` with its parameters and children filled in with defaults. */
export function withDefaults(op: string): StrategyNode {
	const signature = VOCABULARY.ops[op];
	if (!signature) {
		return defaultCondition();
	}
	const node: StrategyNode = { op };

	if (signature.period) {
		node.params = { period: signature.period[0] };
	} else if (op === 'level') {
		node.params = { value: 50 };
	}

	if (signature.accepts.length) {
		node.children = signature.accepts.map((kind: NodeType) => placeholder(kind));
	}

	return node;
}

function parseStop(value: unknown): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const stop = Number(value);
	return Number.isFinite(stop) && stop > 0 ? Math.min(stop, 10) : null;
}

function clampSize(value: unknown): number {
	const size = Number(value);
	if (!Number.isFinite(size)) {
		return 0.1;
	}
	return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size * 1000) / 1000));
}

function clampInt(value: unknown, low: number, high: number, fallback: number): number {
	const parsed = Math.round(Number(value));
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(high, Math.max(low, parsed));
}

/** Writes `model` back to `document`, which is what puts it on the undo stack. */
export async function writeStrategy(document: vscode.TextDocument, model: StrategyModel): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.replace(
		document.uri,
		new vscode.Range(0, 0, document.lineCount, 0),
		JSON.stringify(model, undefined, '\t') + '\n'
	);
	await vscode.workspace.applyEdit(edit);
}
