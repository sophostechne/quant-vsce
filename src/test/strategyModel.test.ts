/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseNode, placeholder, withDefaults } from '../strategy/strategyModel';
import { NodeType, VOCABULARY } from '../strategy/vocabulary';

/**
 * Reading a strategy repairs it rather than refusing to open.
 *
 * These files are hand-editable by design, so the designer is where a typo is most likely to be
 * noticed - and showing nothing is worse than showing something recoverable. What the repair
 * must never do is pass a malformed node through: an operation in the wrong slot is silently
 * unevaluable, and would surface as a strategy that mysteriously never trades.
 */
suite('strategy repair', () => {

	test('an operation of the wrong type is replaced, not passed through', () => {
		// An oscillator where a price series belongs.
		const repaired = parseNode({ op: 'stoch', params: { period: 14 } }, 'price');

		assert.strictEqual(VOCABULARY.ops[repaired.op]?.returns, 'price');
	});

	test('a period outside the operation bounds is clamped to them', () => {
		const repaired = parseNode(
			{ op: 'sma', params: { period: 9999 }, children: [{ op: 'close' }] }, 'price');

		const [low, high] = VOCABULARY.ops['sma']!.period!;
		assert.ok(repaired.params!['period']! <= high, 'above the ceiling');
		assert.ok(repaired.params!['period']! >= low, 'below the floor');
	});

	test('an unknown operation becomes a usable condition', () => {
		const repaired = parseNode({ op: 'nonsense' }, 'bool');

		assert.strictEqual(VOCABULARY.ops[repaired.op]?.returns, 'bool');
	});

	test('missing children are filled in', () => {
		// `osc_gt` takes an oscillator and a threshold, and this supplies neither.
		const repaired = parseNode({ op: 'osc_gt' }, 'bool');

		assert.strictEqual(repaired.children?.length, 2);
		assert.strictEqual(VOCABULARY.ops[repaired.children![0]!.op]?.returns, 'osc');
		assert.strictEqual(VOCABULARY.ops[repaired.children![1]!.op]?.returns, 'level');
	});

	test('every type has a placeholder, and it terminates', () => {
		// Conditions have no terminal - a bare condition must compare something - so this also
		// covers the case where recursion has to bottom out through a function instead.
		for (const type of VOCABULARY.types as NodeType[]) {
			const node = placeholder(type);
			assert.strictEqual(VOCABULARY.ops[node.op]?.returns, type, `placeholder for ${type}`);
		}
	});

	test('defaults produce a fully populated node', () => {
		for (const op of Object.keys(VOCABULARY.ops)) {
			const node = withDefaults(op);
			const signature = VOCABULARY.ops[op]!;

			assert.strictEqual(node.children?.length ?? 0, signature.accepts.length, op);
			if (signature.period) {
				assert.ok(node.params?.['period'] !== undefined, `${op} has no period`);
			}
		}
	});
});

/**
 * The label table must cover the engine's whole vocabulary.
 *
 * The compiler already enforces this through `Record<OpName, string>`, so this is a runtime
 * echo of a compile-time guarantee - worth having because the two could only diverge if the
 * generated union had gone stale, which is exactly the failure the split introduced.
 */
suite('vocabulary coverage', () => {

	test('every operation the engine exports can be rendered', async () => {
		const { resolveLabels } = await import('../strategy/labels');
		const labels = resolveLabels();

		for (const op of Object.keys(VOCABULARY.ops)) {
			assert.ok(labels.ops[op], `no label for ${op}`);
		}
	});

	test('every slot type has a name', async () => {
		const { resolveLabels } = await import('../strategy/labels');
		const labels = resolveLabels();

		for (const type of VOCABULARY.types) {
			assert.ok(labels.types[type], `no label for ${type}`);
		}
	});
});
