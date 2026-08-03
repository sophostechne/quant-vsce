/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// MIRRORS `preview-src/drawingTools.ts`. The webview bundle cannot import from the extension
// host sources, so the catalogue exists twice and the two must change together - the picker
// offers what this file lists, and the webview places what the other one describes.

/**
 * The drawing catalogue, shared by the webview and the extension host.
 *
 * Tools differ in how they are placed, and that is what the interaction code branches on:
 *
 *   drag       press, move, release - two anchors
 *   sequence   one click per anchor, finishing automatically at the required count
 *   freehand   every mouse position while the button is held
 *   point      a single click
 *
 * Keeping the arity here rather than in the renderer means a half-placed sequence tool is
 * impossible to store: the interaction layer knows exactly how many anchors it still needs.
 */

export type DrawingCategory = 'lines' | 'fibonacci' | 'patterns' | 'forecasting' | 'brushes' | 'text';

export type Placement = 'drag' | 'sequence' | 'freehand' | 'point';

export interface ToolSpec {
	readonly tool: string;
	readonly label: string;
	readonly category: DrawingCategory;
	readonly placement: Placement;
	/** Anchors required. Ignored for freehand, which collects as many as the drag produces. */
	readonly points: number;
	/** Vertex captions, for patterns that name their points. */
	readonly vertexLabels?: readonly string[];
	/** Prompts for a caption when placed. */
	readonly needsText?: boolean;
	readonly description?: string;
}

export const TOOL_SPECS: readonly ToolSpec[] = [
	// -- Lines ---------------------------------------------------------------------------
	{ tool: 'trendline', label: 'Trend Line', category: 'lines', placement: 'drag', points: 2 },
	{ tool: 'ray', label: 'Ray', category: 'lines', placement: 'drag', points: 2, description: 'extends past the second point' },
	{ tool: 'extendedLine', label: 'Extended Line', category: 'lines', placement: 'drag', points: 2, description: 'extends both ways' },
	{ tool: 'horizontal', label: 'Horizontal Line', category: 'lines', placement: 'point', points: 1 },
	{ tool: 'horizontalRay', label: 'Horizontal Ray', category: 'lines', placement: 'point', points: 1, description: 'rightwards from the click' },
	{ tool: 'vertical', label: 'Vertical Line', category: 'lines', placement: 'point', points: 1 },
	{ tool: 'crossLine', label: 'Cross Line', category: 'lines', placement: 'point', points: 1 },
	{ tool: 'arrow', label: 'Arrow', category: 'lines', placement: 'drag', points: 2 },
	{ tool: 'parallelChannel', label: 'Parallel Channel', category: 'lines', placement: 'sequence', points: 3, description: 'two points for the base, a third for the width' },
	{ tool: 'trendAngle', label: 'Trend Angle', category: 'lines', placement: 'drag', points: 2, description: 'annotates the slope' },

	// -- Fibonacci -----------------------------------------------------------------------
	{ tool: 'fib', label: 'Fib Retracement', category: 'fibonacci', placement: 'drag', points: 2 },
	{ tool: 'fibExtension', label: 'Fib Extension', category: 'fibonacci', placement: 'sequence', points: 3 },
	{ tool: 'fibChannel', label: 'Fib Channel', category: 'fibonacci', placement: 'sequence', points: 3 },
	{ tool: 'fibFan', label: 'Fib Speed Fan', category: 'fibonacci', placement: 'drag', points: 2 },
	{ tool: 'fibTimeZones', label: 'Fib Time Zones', category: 'fibonacci', placement: 'drag', points: 2 },

	// -- Chart patterns ------------------------------------------------------------------
	{ tool: 'abcd', label: 'ABCD Pattern', category: 'patterns', placement: 'sequence', points: 4, vertexLabels: ['A', 'B', 'C', 'D'] },
	{ tool: 'xabcd', label: 'XABCD Pattern', category: 'patterns', placement: 'sequence', points: 5, vertexLabels: ['X', 'A', 'B', 'C', 'D'] },
	{ tool: 'headShoulders', label: 'Head and Shoulders', category: 'patterns', placement: 'sequence', points: 7, vertexLabels: ['', 'LS', '', 'H', '', 'RS', ''] },
	{ tool: 'trianglePattern', label: 'Triangle Pattern', category: 'patterns', placement: 'sequence', points: 3, vertexLabels: ['A', 'B', 'C'] },
	{ tool: 'elliottImpulse', label: 'Elliott Impulse (1-5)', category: 'patterns', placement: 'sequence', points: 6, vertexLabels: ['0', '1', '2', '3', '4', '5'] },
	{ tool: 'elliottCorrection', label: 'Elliott Correction (ABC)', category: 'patterns', placement: 'sequence', points: 4, vertexLabels: ['0', 'A', 'B', 'C'] },
	{ tool: 'cycleLines', label: 'Cycle Lines', category: 'patterns', placement: 'drag', points: 2, description: 'repeats the interval across the chart' },

	// -- Forecasting ---------------------------------------------------------------------
	{ tool: 'longPosition', label: 'Long Position', category: 'forecasting', placement: 'sequence', points: 3, description: 'entry, stop, target' },
	{ tool: 'shortPosition', label: 'Short Position', category: 'forecasting', placement: 'sequence', points: 3, description: 'entry, stop, target' },
	{ tool: 'priceRange', label: 'Price Range', category: 'forecasting', placement: 'drag', points: 2 },
	{ tool: 'dateRange', label: 'Date Range', category: 'forecasting', placement: 'drag', points: 2 },
	{ tool: 'datePriceRange', label: 'Date and Price Range', category: 'forecasting', placement: 'drag', points: 2 },
	{ tool: 'forecast', label: 'Forecast', category: 'forecasting', placement: 'sequence', points: 3, description: 'projects the first leg forward' },

	// -- Brushes -------------------------------------------------------------------------
	{ tool: 'brush', label: 'Brush', category: 'brushes', placement: 'freehand', points: 0 },
	{ tool: 'highlighter', label: 'Highlighter', category: 'brushes', placement: 'freehand', points: 0 },

	// -- Text and notes ------------------------------------------------------------------
	{ tool: 'text', label: 'Text', category: 'text', placement: 'point', points: 1, needsText: true },
	{ tool: 'note', label: 'Note', category: 'text', placement: 'point', points: 1, needsText: true, description: 'boxed' },
	{ tool: 'callout', label: 'Callout', category: 'text', placement: 'drag', points: 2, needsText: true, description: 'boxed, with a pointer' },
	{ tool: 'priceLabel', label: 'Price Label', category: 'text', placement: 'point', points: 1, description: 'captions the price at the click' },
	{ tool: 'signpost', label: 'Signpost', category: 'text', placement: 'point', points: 1, needsText: true },
];

export const CATEGORY_LABELS: Record<DrawingCategory, string> = {
	lines: 'Lines',
	fibonacci: 'Fibonacci',
	patterns: 'Chart Patterns',
	forecasting: 'Forecasting',
	brushes: 'Brushes',
	text: 'Text and Notes',
};

const BY_TOOL = new Map(TOOL_SPECS.map(spec => [spec.tool, spec]));

export function specFor(tool: string): ToolSpec | undefined {
	return BY_TOOL.get(tool);
}

export const TOOL_NAMES: readonly string[] = TOOL_SPECS.map(spec => spec.tool);
