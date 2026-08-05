/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Checks that the committed vocabulary still matches the engine that generates it.
 *
 * `src/strategy/vocabulary.ts` is generated from the quant engine's own operation table, and the
 * label table is typed against the `OpName` union it exports. That check is what stops an
 * operation reaching a picker unnamed - but it only compares the extension against a *committed
 * copy*. Add an operation to the engine and this repository keeps compiling happily until
 * someone remembers to regenerate.
 *
 * That gap did not exist while the extension lived in the same tree as the engine, and it is
 * the price of the split. This closes it: regenerate, diff, fail on a difference.
 *
 * Skipped rather than failed when the engine is not checked out, because most work here does
 * not touch the vocabulary and a missing sibling repository should not block it. The skip is
 * loud, and CI - where both are present - treats a difference as an error.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const generated = path.join(root, 'src', 'strategy', 'vocabulary.ts');

const engine = process.env.QUANT_ENGINE
	?? path.join(root, '..', 'quant');
const python = process.env.QUANT_PYTHON
	?? path.join(engine, '.venv', 'bin', 'python');

if (!fs.existsSync(python)) {
	console.warn(`skipped: no engine interpreter at ${python}`);
	console.warn('set QUANT_ENGINE or QUANT_PYTHON to check the vocabulary is current');
	process.exit(0);
}

let regenerated;
try {
	regenerated = execFileSync(python, ['-m', 'quant.genome.vocabulary'], {
		cwd: engine,
		env: { ...process.env, PYTHONPATH: path.join(engine, 'python') },
		encoding: 'utf8'
	});
} catch (error) {
	console.error(`could not run the engine's generator: ${error.message}`);
	process.exit(1);
}

const committed = fs.readFileSync(generated, 'utf8');
if (committed === regenerated) {
	console.log('vocabulary is current');
	process.exit(0);
}

console.error('vocabulary.ts is out of date with the engine.');
console.error('Regenerate it with:');
console.error(`  cd ${engine} && PYTHONPATH=python .venv/bin/python -m quant.genome.vocabulary \\`);
console.error(`    > ${generated}`);

// A unified diff of the first difference, since the whole file is large and the interesting
// change is almost always a single added or removed operation.
const before = committed.split('\n');
const after = regenerated.split('\n');
for (let i = 0; i < Math.max(before.length, after.length); i++) {
	if (before[i] !== after[i]) {
		console.error(`\nfirst difference at line ${i + 1}:`);
		console.error(`  committed: ${before[i] ?? '(end of file)'}`);
		console.error(`  engine:    ${after[i] ?? '(end of file)'}`);
		break;
	}
}
process.exit(1);
