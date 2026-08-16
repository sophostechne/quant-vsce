/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Types for Quant Workbench visualizers.
 *
 * A visualizer is a `.visualizer.mts` file in your workspace that turns bars into lines the
 * chart draws. Reference this file at the top of yours and your editor will check it as you
 * write:
 *
 * ```ts
 * /// <reference path="./quant-visualizer.d.ts" />
 * ```
 *
 * Nothing compiles it. Node strips the type annotations when the file is imported, which is why
 * the extension ships no compiler and why a stack trace points at the line you wrote.
 *
 * Three TypeScript features are unavailable for that reason - `enum`, `namespace` and
 * constructor parameter properties - because erasing them would change what the code does
 * rather than only what it declares. Everything else works.
 */

declare global {

	/** One price bar. `time` is milliseconds since the epoch. */
	interface Bar {
		readonly time: number;
		readonly open: number;
		readonly high: number;
		readonly low: number;
		readonly close: number;
		readonly volume: number;
	}

	/** What the chart is showing, and the colours it would like you to use. */
	interface VisualizerContext {
		/** `AAPL`, `BTC-USD`, whatever the chart is on. */
		readonly symbol: string;
		/** `5m`, `1h`, `1d` and so on. */
		readonly timeframe: string;
		/** Theme colours, in order. Using these keeps a visualizer legible in light and dark. */
		readonly palette: readonly string[];
	}

	/**
	 * One named set of lines.
	 *
	 * A value of `undefined` is a gap rather than a zero, which is what an indicator's warm-up
	 * window should produce: drawing zeros would put a cliff on the chart that no price
	 * supports. Anything that is not a finite number - `NaN`, `Infinity` - is treated as a gap
	 * for the same reason.
	 */
	interface VisualizerSeries {
		/** Shown in the legend. */
		readonly label: string;
		/** Any CSS colour, or a VS Code theme colour id such as `charts.blue`. */
		readonly color?: string;
		/** Fill the area between the first two lines. Useful for bands. */
		readonly fill?: boolean;
		/**
		 * Draw over the price pane. Defaults to `true`.
		 *
		 * Set `false` for anything not measured in the instrument's own units - an oscillator,
		 * a ratio, a count - which would otherwise flatten the price axis it shares.
		 */
		readonly overlay?: boolean;
		/** One array per line, each the same length as `bars`. */
		readonly lines: readonly (readonly (number | undefined)[])[];
	}

	/**
	 * What a visualizer exports.
	 *
	 * ```ts
	 * export default function myVisualizer(bars: readonly Bar[], ctx: VisualizerContext) {
	 *   return { label: 'Close', lines: [bars.map(bar => bar.close)] };
	 * }
	 * ```
	 *
	 * It may be async. It is run in a worker with a two second deadline and a memory cap, so an
	 * accidental infinite loop costs you a message on the chart rather than a frozen editor.
	 */
	type Visualizer = (bars: readonly Bar[], context: VisualizerContext)
		=> VisualizerSeries | VisualizerSeries[] | Promise<VisualizerSeries | VisualizerSeries[]>;
}

export { };
