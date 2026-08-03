/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolSpec, specFor } from './drawingTools';

/**
 * Chart annotations.
 *
 * Anchors are (time, price), never pixels. A trendline drawn at one zoom level has to stay on
 * the same candles at every other zoom level, on either price scale, and after the window is
 * resized - which only holds if the stored coordinates are in data space and the mapping is
 * reapplied on each paint.
 */

export interface DrawingPoint {
	/** Milliseconds since epoch, matched to the nearest bar when drawn. */
	readonly time: number;
	readonly price: number;
}

export interface Drawing {
	readonly tool: string;
	readonly points: readonly DrawingPoint[];
	readonly color?: string;
	readonly text?: string;
}

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXTENSIONS = [0, 0.618, 1, 1.618, 2.618, 4.236];
const FAN_LEVELS = [0.382, 0.5, 0.618];
const HIT_TOLERANCE = 6;

export interface Projection {
	/** Pixel x for a timestamp, or undefined when it falls outside the loaded series. */
	xForTime(time: number): number | undefined;
	/** Pixel x allowing positions beyond the loaded series, for projections into the future. */
	xForTimeUnclamped(time: number): number;
	yForPrice(price: number): number;
	timeForX(x: number): number | undefined;
	priceForY(y: number): number;
	readonly plotWidth: number;
	readonly plotTop: number;
	readonly plotBottom: number;
}

interface ScreenPoint { x: number; y: number }

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) {
		return Math.hypot(px - ax, py - ay);
	}
	const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Projects anchors to pixels. Uses the unclamped mapping so tools that deliberately extend
 * past the last bar - forecasts, time zones, cycle lines - still resolve.
 */
function project(drawing: Drawing, projection: Projection): ScreenPoint[] {
	return drawing.points.map(point => ({
		x: projection.xForTimeUnclamped(point.time),
		y: projection.yForPrice(point.price),
	}));
}

/** Index of the topmost drawing under the cursor, or undefined. */
export function hitTest(drawings: readonly Drawing[], x: number, y: number, projection: Projection): number | undefined {
	// Reverse order so the most recently drawn wins, matching what is painted on top.
	for (let i = drawings.length - 1; i >= 0; i--) {
		if (isHit(drawings[i]!, x, y, projection)) {
			return i;
		}
	}
	return undefined;
}

function isHit(drawing: Drawing, x: number, y: number, projection: Projection): boolean {
	const points = project(drawing, projection);
	const first = points[0];
	if (!first) {
		return false;
	}
	const second = points[1] ?? first;

	switch (drawing.tool) {
		case 'horizontal':
		case 'horizontalRay':
			return Math.abs(y - first.y) <= HIT_TOLERANCE;
		case 'vertical':
			return Math.abs(x - first.x) <= HIT_TOLERANCE;
		case 'crossLine':
			return Math.abs(y - first.y) <= HIT_TOLERANCE || Math.abs(x - first.x) <= HIT_TOLERANCE;
		case 'text':
		case 'note':
		case 'signpost':
		case 'priceLabel':
			// A caption is a small target, so allow a generous box around its anchor.
			return Math.abs(x - first.x) <= 60 && Math.abs(y - first.y) <= 14;
		case 'rectangle':
		case 'fib':
		case 'priceRange':
		case 'dateRange':
		case 'datePriceRange': {
			// Edges only, so a large box does not swallow every click inside it.
			const left = Math.min(first.x, second.x);
			const right = Math.max(first.x, second.x);
			const top = Math.min(first.y, second.y);
			const bottom = Math.max(first.y, second.y);
			const nearX = x >= left - HIT_TOLERANCE && x <= right + HIT_TOLERANCE;
			const nearY = y >= top - HIT_TOLERANCE && y <= bottom + HIT_TOLERANCE;
			return (nearX && (Math.abs(y - top) <= HIT_TOLERANCE || Math.abs(y - bottom) <= HIT_TOLERANCE))
				|| (nearY && (Math.abs(x - left) <= HIT_TOLERANCE || Math.abs(x - right) <= HIT_TOLERANCE));
		}
		default: {
			// Everything else is a polyline through its anchors, which covers patterns,
			// channels, positions and brush strokes without a case each.
			for (let i = 0; i + 1 < points.length; i++) {
				if (distanceToSegment(x, y, points[i]!.x, points[i]!.y, points[i + 1]!.x, points[i + 1]!.y) <= HIT_TOLERANCE) {
					return true;
				}
			}
			return points.length === 1 && Math.hypot(x - first.x, y - first.y) <= HIT_TOLERANCE * 2;
		}
	}
}

export function drawDrawings(
	context: CanvasRenderingContext2D,
	drawings: readonly Drawing[],
	projection: Projection,
	palette: { text: string; up: string; down: string },
	selectedIndex: number | undefined,
): void {
	context.save();
	context.beginPath();
	context.rect(0, projection.plotTop, projection.plotWidth, projection.plotBottom - projection.plotTop);
	context.clip();

	for (let i = 0; i < drawings.length; i++) {
		const drawing = drawings[i]!;
		const points = project(drawing, projection);
		if (points.length === 0) {
			continue;
		}
		const selected = i === selectedIndex;
		const color = drawing.color ?? palette.text;
		context.strokeStyle = color;
		context.fillStyle = color;
		context.lineWidth = selected ? 2.5 : 1.5;
		context.font = '10px var(--vscode-font-family)';
		context.textBaseline = 'bottom';
		context.textAlign = 'left';

		drawOne(context, drawing, points, projection, palette);

		if (selected) {
			for (const point of points) {
				context.beginPath();
				context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
				context.fill();
			}
		}
	}
	context.lineWidth = 1;
	context.globalAlpha = 1;
	context.restore();
}

function polyline(context: CanvasRenderingContext2D, points: readonly ScreenPoint[]): void {
	context.beginPath();
	points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
	context.stroke();
}

function labelVertices(context: CanvasRenderingContext2D, points: readonly ScreenPoint[], spec: ToolSpec | undefined): void {
	if (!spec?.vertexLabels) {
		return;
	}
	for (let i = 0; i < points.length; i++) {
		const label = spec.vertexLabels[i];
		if (label) {
			context.fillText(label, points[i]!.x + 4, points[i]!.y - 3);
		}
	}
}

function drawOne(
	context: CanvasRenderingContext2D,
	drawing: Drawing,
	points: ScreenPoint[],
	projection: Projection,
	palette: { text: string; up: string; down: string },
): void {
	const a = points[0]!;
	const b = points[1] ?? a;
	const spec = specFor(drawing.tool);
	const { plotWidth, plotTop, plotBottom } = projection;

	switch (drawing.tool) {
		// -- Lines -----------------------------------------------------------------------
		case 'horizontal':
			line(context, 0, a.y, plotWidth, a.y);
			return;
		case 'horizontalRay':
			line(context, a.x, a.y, plotWidth, a.y);
			return;
		case 'vertical':
			line(context, a.x, plotTop, a.x, plotBottom);
			return;
		case 'crossLine':
			line(context, 0, a.y, plotWidth, a.y);
			line(context, a.x, plotTop, a.x, plotBottom);
			return;
		case 'trendline':
			line(context, a.x, a.y, b.x, b.y);
			return;
		case 'ray':
			line(context, a.x, a.y, ...extend(a, b, plotWidth));
			return;
		case 'extendedLine': {
			const [fx, fy] = extend(a, b, plotWidth);
			const [rx, ry] = extend(b, a, plotWidth);
			line(context, rx, ry, fx, fy);
			return;
		}
		case 'arrow':
			line(context, a.x, a.y, b.x, b.y);
			arrowHead(context, a, b);
			return;
		case 'trendAngle': {
			line(context, a.x, a.y, b.x, b.y);
			line(context, a.x, a.y, b.x, a.y);
			const degrees = (Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI;
			context.fillText(`${degrees.toFixed(1)}\u00B0`, a.x + 6, a.y - 4);
			return;
		}
		case 'parallelChannel': {
			const c = points[2] ?? b;
			// The third anchor sets the offset; the parallel is the base line shifted by it.
			const offset = c.y - (a.y + (b.y - a.y) * ((c.x - a.x) / (b.x - a.x || 1)));
			line(context, a.x, a.y, b.x, b.y);
			line(context, a.x, a.y + offset, b.x, b.y + offset);
			shade(context, [a, b, { x: b.x, y: b.y + offset }, { x: a.x, y: a.y + offset }]);
			return;
		}
		case 'cycleLines': {
			const interval = Math.abs(b.x - a.x) || 1;
			for (let x = Math.min(a.x, b.x); x <= plotWidth; x += interval) {
				line(context, x, plotTop, x, plotBottom);
			}
			return;
		}

		// -- Fibonacci -------------------------------------------------------------------
		case 'fib':
			fibLevels(context, a, b, FIB_LEVELS, Math.min(a.x, b.x), Math.max(a.x, b.x));
			return;
		case 'fibExtension': {
			const c = points[2] ?? b;
			// Levels project the A-B leg from C, which is what an extension measures.
			const span = b.y - a.y;
			for (const level of FIB_EXTENSIONS) {
				const y = c.y + span * level;
				context.globalAlpha = level === 0 || level === 1 ? 1 : 0.6;
				line(context, Math.min(a.x, c.x), y, plotWidth, y);
				context.fillText(`${(level * 100).toFixed(1)}%`, Math.min(a.x, c.x) + 4, y - 2);
			}
			context.globalAlpha = 1;
			polyline(context, [a, b, c]);
			return;
		}
		case 'fibChannel': {
			const c = points[2] ?? b;
			const offset = c.y - a.y;
			for (const level of FIB_LEVELS) {
				context.globalAlpha = level === 0 || level === 1 ? 1 : 0.6;
				const shift = offset * level;
				line(context, a.x, a.y + shift, plotWidth, b.y + shift);
				context.fillText(`${(level * 100).toFixed(1)}%`, a.x + 4, a.y + shift - 2);
			}
			context.globalAlpha = 1;
			return;
		}
		case 'fibFan':
			for (const level of FAN_LEVELS) {
				const y = a.y + (b.y - a.y) * level;
				line(context, a.x, a.y, ...extend(a, { x: b.x, y }, plotWidth));
			}
			line(context, a.x, a.y, b.x, b.y);
			return;
		case 'fibTimeZones': {
			const unit = b.x - a.x || 1;
			let previous = 0;
			let current = 1;
			for (let i = 0; i < 10; i++) {
				const x = a.x + unit * current;
				if (x > plotWidth) {
					break;
				}
				line(context, x, plotTop, x, plotBottom);
				context.fillText(String(current), x + 3, plotTop + 12);
				[previous, current] = [current, previous + current];
			}
			return;
		}

		// -- Patterns --------------------------------------------------------------------
		case 'abcd':
		case 'xabcd':
		case 'headShoulders':
		case 'trianglePattern':
		case 'elliottImpulse':
		case 'elliottCorrection':
			polyline(context, points);
			if (drawing.tool === 'trianglePattern' && points.length >= 3) {
				line(context, points[2]!.x, points[2]!.y, a.x, a.y);
			}
			labelVertices(context, points, spec);
			return;

		// -- Forecasting -----------------------------------------------------------------
		case 'longPosition':
		case 'shortPosition': {
			const stop = points[1] ?? a;
			const target = points[2] ?? a;
			const left = a.x;
			const right = Math.max(stop.x, target.x, a.x + 40);
			// Reward green, risk red, regardless of direction - the colours describe the
			// outcome, not the side.
			band(context, left, right, a.y, target.y, palette.up);
			band(context, left, right, a.y, stop.y, palette.down);
			context.strokeStyle = palette.text;
			line(context, left, a.y, right, a.y);
			const risk = Math.abs(a.y - stop.y);
			const reward = Math.abs(a.y - target.y);
			context.fillStyle = palette.text;
			context.fillText(`R:R ${(reward / (risk || 1)).toFixed(2)}`, left + 4, a.y - 4);
			return;
		}
		case 'priceRange':
		case 'dateRange':
		case 'datePriceRange': {
			context.setLineDash([4, 3]);
			context.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
			context.setLineDash([]);
			const priceDelta = projection.priceForY(b.y) - projection.priceForY(a.y);
			const percent = (priceDelta / (projection.priceForY(a.y) || 1)) * 100;
			const barsSpan = Math.abs(b.x - a.x);
			const caption = drawing.tool === 'dateRange'
				? `${Math.round(barsSpan)} px`
				: `${priceDelta >= 0 ? '+' : ''}${priceDelta.toFixed(2)} (${percent.toFixed(2)}%)`;
			context.fillText(caption, Math.min(a.x, b.x) + 4, Math.min(a.y, b.y) - 3);
			return;
		}
		case 'forecast': {
			const c = points[2] ?? b;
			polyline(context, [a, b]);
			context.setLineDash([4, 4]);
			polyline(context, [b, c]);
			context.setLineDash([]);
			arrowHead(context, b, c);
			return;
		}

		// -- Brushes ---------------------------------------------------------------------
		case 'highlighter':
			context.save();
			context.lineWidth = 12;
			context.globalAlpha = 0.25;
			context.lineCap = 'round';
			context.lineJoin = 'round';
			polyline(context, points);
			context.restore();
			return;
		case 'brush':
			context.save();
			context.lineCap = 'round';
			context.lineJoin = 'round';
			polyline(context, points);
			context.restore();
			return;

		// -- Text ------------------------------------------------------------------------
		case 'text':
			context.fillText(drawing.text ?? '', a.x + 4, a.y - 3);
			return;
		case 'priceLabel':
			boxedText(context, a, projection.priceForY(a.y).toFixed(2));
			return;
		case 'note':
			boxedText(context, a, drawing.text ?? '');
			return;
		case 'signpost':
			line(context, a.x, a.y, a.x, a.y - 24);
			boxedText(context, { x: a.x, y: a.y - 24 }, drawing.text ?? '');
			return;
		case 'callout':
			line(context, a.x, a.y, b.x, b.y);
			boxedText(context, b, drawing.text ?? '');
			return;

		default:
			polyline(context, points);
	}
}

function line(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
	context.beginPath();
	context.moveTo(x1, y1);
	context.lineTo(x2, y2);
	context.stroke();
}

/** Extends a→b to the right edge, returned as a tuple for `line`. */
function extend(a: ScreenPoint, b: ScreenPoint, plotWidth: number): [number, number] {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (dx === 0) {
		return [b.x, dy >= 0 ? 1e5 : -1e5];
	}
	const scale = Math.max((plotWidth - a.x) / dx, 1);
	return [a.x + dx * scale, a.y + dy * scale];
}

function arrowHead(context: CanvasRenderingContext2D, from: ScreenPoint, to: ScreenPoint): void {
	const angle = Math.atan2(to.y - from.y, to.x - from.x);
	const size = 8;
	context.beginPath();
	context.moveTo(to.x, to.y);
	context.lineTo(to.x - size * Math.cos(angle - Math.PI / 6), to.y - size * Math.sin(angle - Math.PI / 6));
	context.lineTo(to.x - size * Math.cos(angle + Math.PI / 6), to.y - size * Math.sin(angle + Math.PI / 6));
	context.closePath();
	context.fill();
}

function shade(context: CanvasRenderingContext2D, points: readonly ScreenPoint[]): void {
	context.save();
	context.globalAlpha = 0.08;
	context.beginPath();
	points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
	context.closePath();
	context.fill();
	context.restore();
}

function band(context: CanvasRenderingContext2D, left: number, right: number, fromY: number, toY: number, color: string): void {
	context.save();
	context.fillStyle = color;
	context.globalAlpha = 0.15;
	context.fillRect(left, Math.min(fromY, toY), right - left, Math.abs(toY - fromY));
	context.restore();
}

function fibLevels(
	context: CanvasRenderingContext2D,
	a: ScreenPoint, b: ScreenPoint,
	levels: readonly number[], left: number, right: number,
): void {
	for (const level of levels) {
		// Level 0 sits on the first anchor and 1 on the second, so a retracement drawn
		// high-to-low reads the same way round as one drawn low-to-high.
		const y = a.y + (b.y - a.y) * level;
		context.globalAlpha = level === 0 || level === 1 ? 1 : 0.6;
		line(context, left, y, right, y);
		context.fillText(`${(level * 100).toFixed(1)}%`, left + 4, y - 2);
	}
	context.globalAlpha = 1;
}

function boxedText(context: CanvasRenderingContext2D, at: ScreenPoint, text: string): void {
	const padding = 4;
	const width = context.measureText(text).width + padding * 2;
	const height = 16;
	context.save();
	context.globalAlpha = 0.85;
	context.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
	context.fillRect(at.x, at.y - height, width, height);
	context.restore();
	context.strokeRect(at.x + 0.5, at.y - height + 0.5, width - 1, height - 1);
	context.fillText(text, at.x + padding, at.y - padding);
}
