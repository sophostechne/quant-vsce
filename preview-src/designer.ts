/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The no-code strategy designer.
 *
 * The strategy is a typed expression tree, and every editing control here is generated from
 * that type. A slot expecting an oscillator offers only oscillators; one expecting a threshold
 * offers only thresholds. The result is that an invalid strategy is not something the designer
 * validates and rejects - it is something it cannot represent, so there is no error state to
 * report and no way to reach one by clicking.
 *
 * The vocabulary arrives from the extension rather than being hard-coded, so adding an
 * indicator to the engine adds it to every picker without touching this file.
 */

type NodeType = 'price' | 'osc' | 'level' | 'bool';

interface OpSignature {
	label: string;
	returns: NodeType;
	accepts: NodeType[];
	period: [number, number] | null;
}

interface Vocabulary {
	types: Record<NodeType, string>;
	ops: Record<string, OpSignature>;
	terminals: Record<NodeType, string[]>;
	functions: Record<NodeType, string[]>;
	levels: number[];
	directions: string[];
}

interface StrategyNode {
	op: string;
	params?: Record<string, number>;
	children?: StrategyNode[];
}

interface StrategyModel {
	entry: StrategyNode;
	exit: StrategyNode;
	size: number;
	stop_atr: number | null;
	direction: string;
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('designer')!;

let vocabulary: Vocabulary | undefined;
let model: StrategyModel | undefined;
let stops: (number | null)[] = [];

/** Path from the model root to a node: which tree, then child indices. */
type Path = { tree: 'entry' | 'exit'; indices: number[] };

window.addEventListener('message', event => {
	const message = event.data as {
		type: string; vocabulary?: Vocabulary; model?: StrategyModel; stops?: (number | null)[];
	};
	if (message.type === 'strategy' && message.vocabulary && message.model) {
		vocabulary = message.vocabulary;
		model = message.model;
		stops = message.stops ?? [];
		render();
	}
});

vscode.postMessage({ type: 'ready' });

/** Sends the whole model back, which is what puts the change on the document's undo stack. */
function commit(): void {
	vscode.postMessage({ type: 'update', model });
	render();
}

function nodeAt(path: Path): StrategyNode {
	let node = model![path.tree];
	for (const index of path.indices) {
		node = node.children![index];
	}
	return node;
}

/**
 * The simplest well-typed node of `want`, with parameters at their lowest valid value.
 *
 * Mirrors the engine's own generator: types with a terminal bottom out immediately, and
 * conditions - which have none, since a bare condition must compare something - use the
 * shallowest available function.
 */
function placeholder(want: NodeType): StrategyNode {
	const terminals = vocabulary!.terminals[want];
	return withDefaults(terminals.length ? terminals[0] : vocabulary!.functions[want][0]);
}

function withDefaults(op: string): StrategyNode {
	const signature = vocabulary!.ops[op];
	const node: StrategyNode = { op };

	if (signature.period) {
		node.params = { period: signature.period[0] };
	} else if (op === 'level') {
		node.params = { value: 50 };
	}
	if (signature.accepts.length) {
		node.children = signature.accepts.map(placeholder);
	}
	return node;
}

/**
 * Replaces the node at `path` with `op`, keeping whatever still fits.
 *
 * Children of matching type are carried across, so swapping a moving average for an
 * exponential one does not discard the series underneath it. Rebuilding from scratch on every
 * change is simpler but loses work the user has done for no reason a user would recognise.
 */
function changeOp(path: Path, op: string): void {
	const existing = nodeAt(path);
	const replacement = withDefaults(op);

	if (replacement.children && existing.children) {
		replacement.children = replacement.children.map((child, index) => {
			const previous = existing.children![index];
			const fits = previous && vocabulary!.ops[previous.op].returns === vocabulary!.ops[child.op].returns;
			return fits ? previous : child;
		});
	}
	if (replacement.params?.period !== undefined && existing.params?.period !== undefined) {
		const [low, high] = vocabulary!.ops[op].period!;
		replacement.params.period = Math.min(high, Math.max(low, existing.params.period));
	}

	assign(path, replacement);
}

function assign(path: Path, replacement: StrategyNode): void {
	if (!path.indices.length) {
		model![path.tree] = replacement;
		return;
	}
	const parent = nodeAt({ tree: path.tree, indices: path.indices.slice(0, -1) });
	parent.children![path.indices[path.indices.length - 1]] = replacement;
}

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K, className?: string, text?: string
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

/** A picker listing every operation legal in a slot of type `want`, and nothing else. */
function opPicker(path: Path, want: NodeType, current: string): HTMLSelectElement {
	const select = element('select', 'op');
	const terminals = vocabulary!.terminals[want];
	const functions = vocabulary!.functions[want];

	for (const [groupLabel, ops] of [['Values', terminals], ['Built from', functions]] as const) {
		if (!ops.length) {
			continue;
		}
		const group = element('optgroup');
		group.label = groupLabel;
		for (const op of ops) {
			const option = element('option');
			option.value = op;
			option.textContent = vocabulary!.ops[op].label;
			option.selected = op === current;
			group.appendChild(option);
		}
		select.appendChild(group);
	}

	select.addEventListener('change', () => {
		changeOp(path, select.value);
		commit();
	});
	return select;
}

function numberInput(value: number, low: number, high: number, onChange: (value: number) => void): HTMLInputElement {
	const input = element('input', 'number');
	input.type = 'number';
	input.value = String(value);
	input.min = String(low);
	input.max = String(high);
	input.addEventListener('change', () => {
		const parsed = Math.round(Number(input.value));
		onChange(Number.isFinite(parsed) ? Math.min(high, Math.max(low, parsed)) : low);
		commit();
	});
	return input;
}

/**
 * Renders one node and its children.
 *
 * Binary conditions read left-to-right as a sentence - `RSI(14) is above 70` - because that is
 * how a trader states a rule. Nesting is shown by indentation only where a condition contains
 * other conditions, so a simple rule looks like one line rather than a tree.
 */
function renderNode(path: Path, want: NodeType): HTMLElement {
	const node = nodeAt(path);
	const signature = vocabulary!.ops[node.op];
	const row = element('div', signature.returns === 'bool' ? 'node condition' : 'node value');

	const child = (index: number) => renderNode(
		{ tree: path.tree, indices: [...path.indices, index] },
		signature.accepts[index]
	);

	if (node.op === 'not') {
		row.appendChild(opPicker(path, want, node.op));
		row.appendChild(child(0));
		return row;
	}

	// A comparison or a boolean join: operand, operator, operand.
	if (signature.returns === 'bool' && signature.accepts.length === 2) {
		row.appendChild(child(0));
		row.appendChild(opPicker(path, want, node.op));
		row.appendChild(child(1));
		return row;
	}

	row.appendChild(opPicker(path, want, node.op));

	if (signature.period) {
		const [low, high] = signature.period;
		row.appendChild(numberInput(node.params!.period, low, high, value => {
			nodeAt(path).params!.period = value;
		}));
	} else if (node.op === 'level') {
		row.appendChild(numberInput(node.params!.value, 0, 100, value => {
			nodeAt(path).params!.value = value;
		}));
	}

	for (let index = 0; index < signature.accepts.length; index++) {
		row.appendChild(child(index));
	}
	return row;
}

function section(title: string, hint: string, tree: 'entry' | 'exit'): HTMLElement {
	const container = element('section', 'rule');
	const heading = element('h2', 'rule-title', title);
	heading.appendChild(element('span', 'hint', hint));
	container.appendChild(heading);
	container.appendChild(renderNode({ tree, indices: [] }, 'bool'));
	return container;
}

/** Direction, size and stop: the settings that are not part of either condition tree. */
function renderSettings(): HTMLElement {
	const container = element('section', 'settings');

	const direction = element('select', 'direction');
	for (const option of vocabulary!.directions) {
		const item = element('option');
		item.value = option;
		item.textContent = option === 'long' ? 'Buy (long)' : 'Sell short';
		item.selected = option === model!.direction;
		direction.appendChild(item);
	}
	direction.addEventListener('change', () => {
		model!.direction = direction.value;
		commit();
	});

	const size = element('input', 'number');
	size.type = 'number';
	size.step = '0.05';
	size.min = '0.01';
	size.max = '1';
	size.value = String(model!.size);
	size.addEventListener('change', () => {
		const parsed = Number(size.value);
		model!.size = Number.isFinite(parsed) ? Math.min(1, Math.max(0.01, parsed)) : 0.1;
		commit();
	});

	const stop = element('select', 'stop');
	for (const option of stops) {
		const item = element('option');
		item.value = option === null ? '' : String(option);
		item.textContent = option === null ? 'No stop' : `${option} x ATR`;
		item.selected = option === model!.stop_atr;
		stop.appendChild(item);
	}
	stop.addEventListener('change', () => {
		model!.stop_atr = stop.value ? Number(stop.value) : null;
		commit();
	});

	container.appendChild(labelled('Direction', direction));
	container.appendChild(labelled('Size of account', size));
	container.appendChild(labelled('Protective stop', stop));
	return container;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
	const field = element('label', 'field');
	field.appendChild(element('span', 'field-label', text));
	field.appendChild(control);
	return field;
}

function render(): void {
	if (!vocabulary || !model) {
		return;
	}
	root.replaceChildren(
		renderSettings(),
		section('Enter when', 'the position is opened on the next bar', 'entry'),
		section('Exit when', 'the position is closed on the next bar', 'exit')
	);
}
