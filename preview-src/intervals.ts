/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sophos Techne. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading interval strings in the webview.
 *
 * A deliberate second copy of the host's parser rather than a shared import: the webview is a
 * separate bundle with no access to `src/`, and the alternative - shipping the host's module into
 * it - would drag the daemon protocol along with it. What must not drift is the grammar, which is
 * a handful of lines and is covered on both sides.
 */

export type IntervalUnit = 's' | 'm' | 'h' | 'D' | 'W' | 'M';

export interface Interval {
	readonly count: number;
	readonly unit: IntervalUnit;
}

const UNIT_LIMIT: Record<IntervalUnit, number> = { s: 3_600, m: 1_440, h: 24, D: 365, W: 52, M: 120 };

/**
 * Parses an interval, or undefined when it is not one.
 *
 * Case is load-bearing and is never folded: `m` is minutes and `M` is months. A bare number means
 * minutes, so typing `15` into the custom box does what anyone means by it.
 */
export function parseInterval(value: string): Interval | undefined {
	const match = /^\s*(\d+)\s*([smhdwSHDWM]?)\s*$/.exec(value);
	if (!match) {
		return undefined;
	}
	const count = Number(match[1]);
	const letter = match[2] ?? '';
	const unit: IntervalUnit | undefined = letter === '' ? 'm'
		: letter === 'd' || letter === 'D' ? 'D'
			: letter === 'w' || letter === 'W' ? 'W'
				: letter === 'M' ? 'M'
					: letter === 's' || letter === 'S' ? 's'
						: letter === 'h' || letter === 'H' ? 'h'
							: letter === 'm' ? 'm' : undefined;
	if (unit === undefined || !Number.isInteger(count) || count < 1 || count > UNIT_LIMIT[unit]) {
		return undefined;
	}
	return { count, unit };
}

export function formatInterval(interval: Interval): string {
	return `${interval.count}${interval.unit}`;
}

const UNIT_NAME: Record<IntervalUnit, string> = {
	s: 'second', m: 'minute', h: 'hour', D: 'day', W: 'week', M: 'month',
};

/** `5 minutes`, `1 hour` - the descriptor beside the short form, so `1M` is unambiguous. */
export function describeInterval(interval: Interval): string {
	const name = UNIT_NAME[interval.unit];
	return `${interval.count} ${interval.count === 1 ? name : `${name}s`}`;
}

/** Groups in the order they are shown, matching how the presets are laid out. */
export const UNIT_GROUPS: readonly { unit: IntervalUnit; title: string }[] = [
	{ unit: 's', title: 'Seconds' },
	{ unit: 'm', title: 'Minutes' },
	{ unit: 'h', title: 'Hours' },
	{ unit: 'D', title: 'Days' },
	{ unit: 'W', title: 'Weeks' },
	{ unit: 'M', title: 'Months' },
];
