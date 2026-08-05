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

interface Evaluation {
	product: string;
	timeframe: string;
	bars: number;
	buy_hold: number;
	result: {
		trades: number; net_return: number; max_drawdown: number;
		profit_factor: number; win_rate: number;
	};
	meets_criteria: boolean;
	reason: string;
	monte_carlo: { drawdown_p95: number; profitable_share: number; return_p05: number } | null;
	noise_floor: { beats: number; verdict: string; profitable_share: number } | null;
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('designer')!;

let vocabulary: Vocabulary | undefined;
let model: StrategyModel | undefined;
let stops: (number | null)[] = [];
let evaluation: Evaluation | undefined;
let evaluationError: string | undefined;
let evaluating = false;

interface Metrics { trades: number; net_return: number; max_drawdown: number; profit_factor: number; win_rate: number }
interface Survivor { strategy: StrategyModel; render: string; train: Metrics; test: Metrics | null }
type SearchEvent =
	| { type: 'start'; train_bars: number; test_bars: number; train_buy_hold: number; test_buy_hold: number; generations: number }
	| { type: 'generation'; index: number; viable: number; fitness: number; net_return: number; trades: number }
	| { type: 'done'; survivors: Survivor[] }
	| { type: 'error'; error: string };

let searching = false;
let searchStart: Extract<SearchEvent, { type: 'start' }> | undefined;
let searchProgress: Extract<SearchEvent, { type: 'generation' }> | undefined;
let survivors: Survivor[] | undefined;
let searchError: string | undefined;

/** Path from the model root to a node: which tree, then child indices. */
type Path = { tree: 'entry' | 'exit'; indices: number[] };

window.addEventListener('message', event => {
	const message = event.data as {
		type: string; vocabulary?: Vocabulary; model?: StrategyModel; stops?: (number | null)[];
		evaluation?: Evaluation; message?: string; event?: SearchEvent;
	};
	if (message.type === 'strategy' && message.vocabulary && message.model) {
		vocabulary = message.vocabulary;
		model = message.model;
		stops = message.stops ?? [];
		render();
		return;
	}
	if (message.type === 'evaluating') {
		evaluating = true;
		evaluationError = undefined;
		render();
		return;
	}
	if (message.type === 'evaluation') {
		evaluating = false;
		evaluation = message.evaluation;
		evaluationError = undefined;
		render();
		return;
	}
	if (message.type === 'evaluation-failed') {
		evaluating = false;
		evaluationError = message.message;
		render();
		return;
	}
	if (message.type === 'search' && message.event) {
		const event = message.event;
		if (event.type === 'start') {
			searchStart = event;
			searchProgress = undefined;
			survivors = undefined;
		} else if (event.type === 'generation') {
			searchProgress = event;
		} else if (event.type === 'done') {
			survivors = event.survivors;
			searching = false;
		} else if (event.type === 'error') {
			searchError = event.error;
			searching = false;
		}
		render();
		return;
	}
	if (message.type === 'search-failed') {
		searching = false;
		searchError = message.message;
		render();
	}
});

vscode.postMessage({ type: 'ready' });

/** Sends the whole model back, which is what puts the change on the document's undo stack. */
function commit(): void {
	vscode.postMessage({ type: 'update', model });
	// Any edit invalidates the last result. Leaving it on screen next to changed rules is how
	// a number gets attributed to a strategy that never produced it.
	evaluation = undefined;
	evaluationError = undefined;
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

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const signed = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;

function metric(label: string, value: string, tone?: string): HTMLElement {
	const cell = element('div', tone ? `metric ${tone}` : 'metric');
	cell.appendChild(element('span', 'metric-value', value));
	cell.appendChild(element('span', 'metric-label', label));
	return cell;
}

/**
 * The result panel.
 *
 * Return is never shown alone. A backtest return with no distribution around it and nothing to
 * compare it against reads as a finding when it is usually a coincidence, so the resampled
 * drawdown, the share of resampled runs that made money, and the standing against random
 * strategies are given the same weight as the headline. Buy-and-hold sits beside the return
 * for the same reason: a strategy that made 8% where holding made 40% has not found an edge.
 */
function renderResults(): HTMLElement {
	const container = element('section', 'results');

	const header = element('div', 'results-header');
	const button = element('button', 'run');
	button.textContent = evaluating ? 'Testing...' : 'Test strategy';
	button.disabled = evaluating;
	button.addEventListener('click', () => vscode.postMessage({ type: 'evaluate' }));
	header.appendChild(button);

	if (evaluation) {
		header.appendChild(element('span', 'results-scope',
			`${evaluation.product} ${evaluation.timeframe}, ${evaluation.bars} bars`));
	}
	container.appendChild(header);

	if (evaluationError) {
		container.appendChild(element('p', 'error', evaluationError));
		return container;
	}
	if (!evaluation) {
		return container;
	}

	const { result, monte_carlo: mc, noise_floor: floor } = evaluation;
	const beatsHolding = result.net_return > evaluation.buy_hold;

	const grid = element('div', 'metrics');
	grid.appendChild(metric('return', signed(result.net_return),
		result.net_return > 0 ? 'good' : 'bad'));
	grid.appendChild(metric('buy and hold', signed(evaluation.buy_hold),
		beatsHolding ? 'good' : 'bad'));
	grid.appendChild(metric('max drawdown', percent(result.max_drawdown)));
	grid.appendChild(metric('trades', String(result.trades)));
	grid.appendChild(metric('win rate', percent(result.win_rate)));
	grid.appendChild(metric('profit factor', result.profit_factor.toFixed(2)));
	container.appendChild(grid);

	const notes = element('ul', 'notes');
	if (!beatsHolding) {
		notes.appendChild(element('li', 'warn',
			`Holding ${evaluation.product} over the same bars returned ${signed(evaluation.buy_hold)}. `
			+ 'This strategy did worse than doing nothing.'));
	}
	if (mc) {
		notes.appendChild(element('li', undefined,
			`Resampling the trades: drawdown reaches ${percent(mc.drawdown_p95)} in the worst 5% of `
			+ `orderings, against ${percent(result.max_drawdown)} observed. `
			+ `${Math.round(mc.profitable_share * 100)}% of resampled runs made money.`));
	}
	if (floor) {
		notes.appendChild(element('li', floor.beats >= 0.95 ? undefined : 'warn',
			`Against random strategies on the same bars this beats ${Math.round(floor.beats * 100)}% `
			+ `- ${floor.verdict}.`));
	}
	if (!evaluation.meets_criteria) {
		notes.appendChild(element('li', 'warn', `Does not meet the stated criteria: ${evaluation.reason}.`));
	}
	container.appendChild(notes);
	return container;
}

/**
 * The search panel.
 *
 * Every discovered strategy is shown with two returns: the one it achieved on the bars the
 * search fitted it to, and the one it achieved on bars withheld from the search entirely. Only
 * the second carries information. Showing the first alone - which is what an evolutionary
 * strategy finder naturally produces, and what makes them look miraculous - would present the
 * search's own effort back to the user as a discovery.
 */
function renderSearch(): HTMLElement {
	const container = element('section', 'search');

	const header = element('div', 'results-header');
	const button = element('button', 'run');
	button.textContent = searching ? 'Searching...' : 'Find strategies';
	button.disabled = searching;
	button.addEventListener('click', () => {
		searching = true;
		searchError = undefined;
		survivors = undefined;
		searchProgress = undefined;
		vscode.postMessage({
			type: 'search',
			options: { population: 250, generations: 20, survivors: 5, regimes: true }
		});
		render();
	});
	header.appendChild(button);

	if (searching) {
		const cancel = element('button', 'run secondary', 'Stop');
		cancel.addEventListener('click', () => {
			searching = false;
			vscode.postMessage({ type: 'cancel' });
			render();
		});
		header.appendChild(cancel);
	}

	if (searchStart) {
		header.appendChild(element('span', 'results-scope',
			`fitted on ${searchStart.train_bars} bars, judged on ${searchStart.test_bars} held back`));
	}
	container.appendChild(header);

	if (searchError) {
		container.appendChild(element('p', 'error', searchError));
		return container;
	}

	if (searching && searchProgress && searchStart) {
		container.appendChild(element('p', 'progress',
			`Generation ${searchProgress.index + 1} of ${searchStart.generations} - `
			+ `${searchProgress.viable} of the population meet the criteria, `
			+ `best ${signed(searchProgress.net_return)} on ${searchProgress.trades} trades.`));
	}

	if (!survivors) {
		return container;
	}
	if (!survivors.length) {
		container.appendChild(element('p', 'warn', 'The search found nothing meeting the criteria.'));
		return container;
	}

	for (const survivor of survivors) {
		container.appendChild(renderSurvivor(survivor));
	}
	if (searchStart) {
		container.appendChild(element('p', 'note-block',
			`Holding the instrument returned ${signed(searchStart.train_buy_hold)} over the fitted bars `
			+ `and ${signed(searchStart.test_buy_hold)} over the held-back ones. A strategy is only `
			+ 'worth adopting if the held-back column stands up on its own.'));
	}
	return container;
}

function renderSurvivor(survivor: Survivor): HTMLElement {
	const card = element('div', 'survivor');

	const rule = element('pre', 'survivor-rule', survivor.render);
	card.appendChild(rule);

	const columns = element('div', 'survivor-columns');
	const held = survivor.test;
	columns.appendChild(metric('fitted to these bars', signed(survivor.train.net_return)));
	columns.appendChild(metric('held back from the search',
		held ? signed(held.net_return) : 'no trades',
		held && held.net_return > 0 ? 'good' : 'bad'));
	columns.appendChild(metric('trades held back', held ? String(held.trades) : '0'));
	card.appendChild(columns);

	const adopt = element('button', 'run secondary', 'Edit this strategy');
	adopt.addEventListener('click', () => {
		model = survivor.strategy;
		evaluation = undefined;
		vscode.postMessage({ type: 'adopt', model: survivor.strategy });
		render();
	});
	card.appendChild(adopt);
	return card;
}

function render(): void {
	if (!vocabulary || !model) {
		return;
	}
	root.replaceChildren(
		renderSettings(),
		section('Enter when', 'the position is opened on the next bar', 'entry'),
		section('Exit when', 'the position is closed on the next bar', 'exit'),
		renderResults(),
		renderSearch()
	);
}
