/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generated from quant/genome/vocabulary.py - do not edit by hand.
// Regenerate with: python -m quant.genome.vocabulary > <this file>
//
// The `label` fields are shown in the designer and are not localized. They originate in the
// engine, which has no access to the extension's string bundle, so translating them needs a
// decision about where the vocabulary's display names should live - see the strategy designer
// notes. Until then they are English, which is a real gap rather than an oversight.

/** What a slot in the strategy tree evaluates to. */
export type NodeType = 'price' | 'osc' | 'level' | 'bool';

export interface OpSignature {
	/** How the operation is written in the designer. */
	readonly label: string;
	readonly returns: NodeType;
	/** The type of each child slot, in order. */
	readonly accepts: readonly NodeType[];
	/** Inclusive bounds for the period parameter, or null where the operation has none. */
	readonly period: readonly [number, number] | null;
}

export interface Vocabulary {
	readonly types: Readonly<Record<NodeType, string>>;
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
			label: 'and',
			period: null,
			returns: 'bool'
		},
		close: {
			accepts: [],
			label: 'Close',
			period: null,
			returns: 'price'
		},
		ema: {
			accepts: [
				'price'
			],
			label: 'Exp. Moving Average',
			period: [
				2,
				200
			],
			returns: 'price'
		},
		high: {
			accepts: [],
			label: 'High',
			period: null,
			returns: 'price'
		},
		highest: {
			accepts: [
				'price'
			],
			label: 'Highest',
			period: [
				2,
				100
			],
			returns: 'price'
		},
		level: {
			accepts: [],
			label: 'Level',
			period: null,
			returns: 'level'
		},
		low: {
			accepts: [],
			label: 'Low',
			period: null,
			returns: 'price'
		},
		lowest: {
			accepts: [
				'price'
			],
			label: 'Lowest',
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
			label: 'not',
			period: null,
			returns: 'bool'
		},
		open: {
			accepts: [],
			label: 'Open',
			period: null,
			returns: 'price'
		},
		or: {
			accepts: [
				'bool',
				'bool'
			],
			label: 'or',
			period: null,
			returns: 'bool'
		},
		osc_cross_above: {
			accepts: [
				'osc',
				'level'
			],
			label: 'crosses above',
			period: null,
			returns: 'bool'
		},
		osc_cross_below: {
			accepts: [
				'osc',
				'level'
			],
			label: 'crosses below',
			period: null,
			returns: 'bool'
		},
		osc_gt: {
			accepts: [
				'osc',
				'level'
			],
			label: 'is above',
			period: null,
			returns: 'bool'
		},
		osc_lt: {
			accepts: [
				'osc',
				'level'
			],
			label: 'is below',
			period: null,
			returns: 'bool'
		},
		osc_sma: {
			accepts: [
				'osc'
			],
			label: 'Smoothed',
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
			label: 'Percentile Rank',
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
			label: 'crosses above',
			period: null,
			returns: 'bool'
		},
		price_cross_below: {
			accepts: [
				'price',
				'price'
			],
			label: 'crosses below',
			period: null,
			returns: 'bool'
		},
		price_gt: {
			accepts: [
				'price',
				'price'
			],
			label: 'is above',
			period: null,
			returns: 'bool'
		},
		price_lt: {
			accepts: [
				'price',
				'price'
			],
			label: 'is below',
			period: null,
			returns: 'bool'
		},
		rsi: {
			accepts: [
				'price'
			],
			label: 'RSI',
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
			label: 'Moving Average',
			period: [
				2,
				200
			],
			returns: 'price'
		},
		stoch: {
			accepts: [],
			label: 'Stochastic',
			period: [
				5,
				50
			],
			returns: 'osc'
		},
		vol_rank: {
			accepts: [],
			label: 'Volatility Rank',
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
	types: {
		bool: 'condition',
		level: 'threshold',
		osc: 'indicator',
		price: 'price'
	}
};
