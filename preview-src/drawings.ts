/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chart annotations.
 *
 * Anchors are (time, price), never pixels. A trendline drawn at one zoom level has to stay on
 * the same two candles at every other zoom level, on either price scale, and after the window
 * is resized - which only holds if the stored coordinates are in data space and the mapping is
 * reapplied on each paint.
 */

export type DrawingTool = 'trendline' | 'ray' | 'horizontal' | 'vertical' | 'rectangle' | 'fib';

export interface DrawingPoint {
	/** Milliseconds since epoch, matched to the nearest bar when drawn. */
	readonly time: number;
	readonly price: number;
}

export interface Drawing {
	readonly tool: DrawingTool;
	readonly points: readonly DrawingPoint[];
	readonly color?: string;
}

/** Fibonacci retracement levels, drawn between the two anchors. */
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** How close the cursor must be, in pixels, to select a drawing. */
const HIT_TOLERANCE = 6;

export interface Projection {
	/** Pixel x for a timestamp, or undefined when it falls outside the loaded series. */
	xForTime(time: number): number | undefined;
	yForPrice(price: number): number;
	timeForX(x: number): number | undefined;
	priceForY(y: number): number;
	readonly plotWidth: number;
	readonly plotTop: number;
	readonly plotBottom: number;
}

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
	const points = resolvePoints(drawing, projection);
	if (!points) {
		return false;
	}
	const [a, b] = points;

	switch (drawing.tool) {
		case 'horizontal':
			return Math.abs(y - a.y) <= HIT_TOLERANCE;
		case 'vertical':
			return Math.abs(x - a.x) <= HIT_TOLERANCE;
		case 'trendline':
		case 'ray':
			return distanceToSegment(x, y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE;
		case 'rectangle':
		case 'fib': {
			// Edges only, so a large box does not swallow every click inside it.
			const left = Math.min(a.x, b.x);
			const right = Math.max(a.x, b.x);
			const top = Math.min(a.y, b.y);
			const bottom = Math.max(a.y, b.y);
			const nearX = x >= left - HIT_TOLERANCE && x <= right + HIT_TOLERANCE;
			const nearY = y >= top - HIT_TOLERANCE && y <= bottom + HIT_TOLERANCE;
			return (nearX && (Math.abs(y - top) <= HIT_TOLERANCE || Math.abs(y - bottom) <= HIT_TOLERANCE))
				|| (nearY && (Math.abs(x - left) <= HIT_TOLERANCE || Math.abs(x - right) <= HIT_TOLERANCE));
		}
		default:
			return false;
	}
}

interface ScreenPoint { x: number; y: number }

/**
 * Projects a drawing's anchors to pixels. Returns undefined when an anchor is outside the
 * loaded series - the drawing then simply is not painted, rather than being clamped to the
 * edge where it would appear to sit on a bar it has nothing to do with.
 */
function resolvePoints(drawing: Drawing, projection: Projection): [ScreenPoint, ScreenPoint] | undefined {
	const first = drawing.points[0];
	if (!first) {
		return undefined;
	}
	const second = drawing.points[1] ?? first;

	const ax = projection.xForTime(first.time);
	const bx = projection.xForTime(second.time);
	if (ax === undefined || bx === undefined) {
		return undefined;
	}
	return [
		{ x: ax, y: projection.yForPrice(first.price) },
		{ x: bx, y: projection.yForPrice(second.price) },
	];
}

export function drawDrawings(
	context: CanvasRenderingContext2D,
	drawings: readonly Drawing[],
	projection: Projection,
	defaultColor: string,
	selectedIndex: number | undefined,
): void {
	context.save();
	context.beginPath();
	context.rect(0, projection.plotTop, projection.plotWidth, projection.plotBottom - projection.plotTop);
	context.clip();

	for (let i = 0; i < drawings.length; i++) {
		const drawing = drawings[i]!;
		const points = resolvePoints(drawing, projection);
		if (!points) {
			continue;
		}
		const selected = i === selectedIndex;
		context.strokeStyle = drawing.color ?? defaultColor;
		context.fillStyle = drawing.color ?? defaultColor;
		context.lineWidth = selected ? 2.5 : 1.5;
		drawOne(context, drawing, points, projection);

		if (selected) {
			drawHandles(context, drawing, points);
		}
	}
	context.lineWidth = 1;
	context.restore();
}

function drawOne(
	context: CanvasRenderingContext2D,
	drawing: Drawing,
	[a, b]: [ScreenPoint, ScreenPoint],
	projection: Projection,
): void {
	switch (drawing.tool) {
		case 'horizontal':
			context.beginPath();
			context.moveTo(0, a.y);
			context.lineTo(projection.plotWidth, a.y);
			context.stroke();
			break;

		case 'vertical':
			context.beginPath();
			context.moveTo(a.x, projection.plotTop);
			context.lineTo(a.x, projection.plotBottom);
			context.stroke();
			break;

		case 'trendline':
			context.beginPath();
			context.moveTo(a.x, a.y);
			context.lineTo(b.x, b.y);
			context.stroke();
			break;

		case 'ray': {
			// Extends past the second anchor to the edge of the plot.
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const scale = dx === 0 ? 1e6 : (projection.plotWidth - a.x) / dx;
			context.beginPath();
			context.moveTo(a.x, a.y);
			context.lineTo(a.x + dx * Math.max(scale, 1), a.y + dy * Math.max(scale, 1));
			context.stroke();
			break;
		}

		case 'rectangle':
			context.beginPath();
			context.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
			context.stroke();
			context.globalAlpha = 0.08;
			context.fill();
			context.globalAlpha = 1;
			break;

		case 'fib': {
			const left = Math.min(a.x, b.x);
			const right = Math.max(a.x, b.x);
			context.font = '10px var(--vscode-font-family)';
			context.textBaseline = 'bottom';
			context.textAlign = 'left';
			for (const level of FIB_LEVELS) {
				// Level 0 sits on the first anchor, 1 on the second, so a retracement drawn
				// high-to-low reads the same way round as one drawn low-to-high.
				const y = a.y + (b.y - a.y) * level;
				context.globalAlpha = level === 0 || level === 1 ? 1 : 0.6;
				context.beginPath();
				context.moveTo(left, y);
				context.lineTo(right, y);
				context.stroke();
				context.fillText(`${(level * 100).toFixed(1)}%`, left + 4, y - 2);
			}
			context.globalAlpha = 1;
			break;
		}
	}
}

function drawHandles(context: CanvasRenderingContext2D, drawing: Drawing, [a, b]: [ScreenPoint, ScreenPoint]): void {
	const anchors = drawing.tool === 'horizontal' || drawing.tool === 'vertical' ? [a] : [a, b];
	for (const point of anchors) {
		context.beginPath();
		context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
		context.fill();
	}
}

/** Tools that need a drag; the rest are placed with a single click. */
export function needsTwoPoints(tool: DrawingTool): boolean {
	return tool !== 'horizontal' && tool !== 'vertical';
}
