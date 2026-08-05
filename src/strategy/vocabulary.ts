/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generated from quant/genome/vocabulary.py - do not edit by hand.
// Regenerate with: python -m quant.genome.vocabulary > <this file>
//
// Structure only. Display names live in labels.ts, where they can be localized - see OpName.

/** What a slot in the strategy tree evaluates to. */
export type NodeType = 'price' | 'osc' | 'level' | 'bool';

/**
 * Every operation the engine can evaluate.
 *
 * Exported as a union so the editor's label table can be typed `Record<OpName, string>`: adding
 * an operation to the engine then fails to compile here until it has been given a name, rather
 * than reaching a picker as a raw identifier like `price_gt`.
 */
export type OpName = 'and' | 'close' | 'ema' | 'high' | 'highest' | 'level' | 'low' | 'lowest' | 'not' | 'open' | 'or' | 'osc_cross_above' | 'osc_cross_below' | 'osc_gt' | 'osc_lt' | 'osc_sma' | 'pctrank' | 'price_cross_above' | 'price_cross_below' | 'price_gt' | 'price_lt' | 'rsi' | 'sma' | 'stoch' | 'vol_rank';

export interface OpSignature {
	readonly returns: NodeType;
	/** The type of each child slot, in order. */
	readonly accepts: readonly NodeType[];
	/** Inclusive bounds for the period parameter, or null where the operation has none. */
	readonly period: readonly [number, number] | null;
}

export interface Vocabulary {
	readonly types: readonly NodeType[];
	readonly ops: Readonly<Record<string, OpSignature>>;
	/** Operations usable as leaves, per type. */
	readonly terminals: Readonly<Record<NodeType, readonly string[]>>;
	/** Operations taking children, per return type. */
	readonly functions: Readonly<Record<NodeType, readonly string[]>>;
	readonly levels: readonly number[];
	readonly directions: readonly string[];
}

// Annotated rather than `as const`, so operations can be looked up by name. A literal
// type would make every lookup a compile error at exactly the call sites that need one.
export const VOCABULARY: Vocabulary = {
	directions: [
		'long',
		'short'
	],
	functions: {
		bool: [
			'price_gt',
			'price_lt',
			'price_cross_above',
			'price_cross_below',
			'osc_gt',
			'osc_lt',
			'osc_cross_above',
			'osc_cross_below',
			'and',
			'or',
			'not'
		],
		level: [],
		osc: [
			'rsi',
			'osc_sma',
			'pctrank'
		],
		price: [
			'sma',
			'ema',
			'highest',
			'lowest'
		]
	},
	levels: [
		10.0,
		20.0,
		25.0,
		30.0,
		35.0,
		40.0,
		50.0,
		60.0,
		65.0,
		70.0,
		75.0,
		80.0,
		90.0
	],
	ops: {
		and: {
			accepts: [
				'bool',
				'bool'
			],
			period: null,
			returns: 'bool'
		},
		close: {
			accepts: [],
			period: null,
			returns: 'price'
		},
		ema: {
			accepts: [
				'price'
			],
			period: [
				2,
				200
			],
			returns: 'price'
		},
		high: {
			accepts: [],
			period: null,
			returns: 'price'
		},
		highest: {
			accepts: [
				'price'
			],
			period: [
				2,
				100
			],
			returns: 'price'
		},
		level: {
			accepts: [],
			period: null,
			returns: 'level'
		},
		low: {
			accepts: [],
			period: null,
			returns: 'price'
		},
		lowest: {
			accepts: [
				'price'
			],
			period: [
				2,
				100
			],
			returns: 'price'
		},
		not: {
			accepts: [
				'bool'
			],
			period: null,
			returns: 'bool'
		},
		open: {
			accepts: [],
			period: null,
			returns: 'price'
		},
		or: {
			accepts: [
				'bool',
				'bool'
			],
			period: null,
			returns: 'bool'
		},
		osc_cross_above: {
			accepts: [
				'osc',
				'level'
			],
			period: null,
			returns: 'bool'
		},
		osc_cross_below: {
			accepts: [
				'osc',
				'level'
			],
			period: null,
			returns: 'bool'
		},
		osc_gt: {
			accepts: [
				'osc',
				'level'
			],
			period: null,
			returns: 'bool'
		},
		osc_lt: {
			accepts: [
				'osc',
				'level'
			],
			period: null,
			returns: 'bool'
		},
		osc_sma: {
			accepts: [
				'osc'
			],
			period: [
				2,
				50
			],
			returns: 'osc'
		},
		pctrank: {
			accepts: [
				'price'
			],
			period: [
				10,
				200
			],
			returns: 'osc'
		},
		price_cross_above: {
			accepts: [
				'price',
				'price'
			],
			period: null,
			returns: 'bool'
		},
		price_cross_below: {
			accepts: [
				'price',
				'price'
			],
			period: null,
			returns: 'bool'
		},
		price_gt: {
			accepts: [
				'price',
				'price'
			],
			period: null,
			returns: 'bool'
		},
		price_lt: {
			accepts: [
				'price',
				'price'
			],
			period: null,
			returns: 'bool'
		},
		rsi: {
			accepts: [
				'price'
			],
			period: [
				2,
				50
			],
			returns: 'osc'
		},
		sma: {
			accepts: [
				'price'
			],
			period: [
				2,
				200
			],
			returns: 'price'
		},
		stoch: {
			accepts: [],
			period: [
				5,
				50
			],
			returns: 'osc'
		},
		vol_rank: {
			accepts: [],
			period: [
				20,
				200
			],
			returns: 'osc'
		}
	},
	terminals: {
		bool: [],
		level: [
			'level'
		],
		osc: [
			'stoch',
			'vol_rank'
		],
		price: [
			'close',
			'open',
			'high',
			'low'
		]
	},
	types: [
		'price',
		'osc',
		'level',
		'bool'
	]
};
