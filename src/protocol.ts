/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire contract between the market data daemon, the extension host and chart webviews.
 *
 * The split matters: the *control plane* (subscribe, resolve, history) is low rate and
 * flows through the extension host, which is single threaded and shared with every other
 * extension. The *data plane* (ticks) never touches the extension host at all - webviews
 * open their own socket to the daemon and receive packed binary frames. Routing ticks
 * through the extension host would cost a structured clone and two IPC hops per message,
 * because `Webview.postMessage` has no transfer list.
 */

export const PROTOCOL_VERSION = 1;

// -- Control plane (JSON, extension host <-> daemon) ------------------------------------

export interface HelloRequest {
	readonly type: 'hello';
	readonly protocolVersion: number;
	readonly client: 'extension-host';
}

export interface HelloResponse {
	readonly type: 'hello';
	readonly protocolVersion: number;
	/** Port serving binary tick frames. Webviews connect here directly. */
	readonly dataPort: number;
	readonly venues: readonly string[];
}

export interface SubscribeRequest {
	readonly type: 'subscribe';
	readonly symbols: readonly string[];
}

export interface UnsubscribeRequest {
	readonly type: 'unsubscribe';
	readonly symbols: readonly string[];
}

/**
 * Symbols are interned to a numeric id by the daemon. Tick frames carry the id, not the
 * string, which is what keeps a tick to a fixed 32 bytes.
 */
export interface SymbolMapNotification {
	readonly type: 'symbolMap';
	readonly entries: readonly { readonly id: number; readonly symbol: string }[];
}

export interface QuoteNotification {
	readonly type: 'quote';
	readonly symbol: string;
	readonly last: number;
	readonly change: number;
	readonly changePercent: number;
	readonly timestamp: number;
}

export interface HistoryRequest {
	readonly type: 'history';
	readonly requestId: number;
	readonly symbol: string;
	readonly timeframe: Timeframe;
	readonly count: number;
}

export interface HistoryResponse {
	readonly type: 'history';
	readonly requestId: number;
	readonly bars: readonly Bar[];
}

export interface ErrorNotification {
	readonly type: 'error';
	readonly message: string;
	readonly requestId?: number;
}

export type ClientMessage = HelloRequest | SubscribeRequest | UnsubscribeRequest | HistoryRequest;
export type DaemonMessage = HelloResponse | SymbolMapNotification | QuoteNotification | HistoryResponse | ErrorNotification;

// -- Domain types ----------------------------------------------------------------------

export type Timeframe = '1s' | '5s' | '1m' | '5m' | '15m' | '1h' | '1d';

export const TIMEFRAMES: readonly Timeframe[] = ['1s', '5s', '1m', '5m', '15m', '1h', '1d'];

export function timeframeToMillis(timeframe: Timeframe): number {
	switch (timeframe) {
		case '1s': return 1_000;
		case '5s': return 5_000;
		case '1m': return 60_000;
		case '5m': return 300_000;
		case '15m': return 900_000;
		case '1h': return 3_600_000;
		case '1d': return 86_400_000;
	}
}

export interface Bar {
	readonly time: number;
	readonly open: number;
	readonly high: number;
	readonly low: number;
	readonly close: number;
	readonly volume: number;
}

export interface Quote {
	readonly symbol: string;
	readonly last: number;
	readonly change: number;
	readonly changePercent: number;
	readonly timestamp: number;
}

// -- Data plane (binary, daemon -> webview) --------------------------------------------

/**
 * Frame layout. All little endian.
 *
 *   header (8 bytes)
 *     0  uint8   frameType
 *     1  uint8   protocolVersion
 *     2  uint16  recordCount
 *     4  uint32  reserved
 *
 *   then `recordCount` fixed-width records of TICK_RECORD_BYTES:
 *     0  uint16  symbolId
 *     2  uint8   side      0 = unknown, 1 = bid, 2 = ask
 *     3  uint8   flags
 *     4  uint32  sequence
 *     8  float64 timestamp   ms since epoch
 *    16  float64 price
 *    24  float32 size
 *    28  uint32  reserved
 *
 * Fixed width means the webview reads straight out of the ArrayBuffer with a DataView and
 * never allocates per tick.
 */
export const FRAME_HEADER_BYTES = 8;
export const TICK_RECORD_BYTES = 32;

export const enum FrameType {
	Tick = 1,
	Snapshot = 2,
	Heartbeat = 3,
}

export const enum TickSide {
	Unknown = 0,
	Bid = 1,
	Ask = 2,
}

export interface Tick {
	symbolId: number;
	side: TickSide;
	sequence: number;
	timestamp: number;
	price: number;
	size: number;
}

export function encodeTickFrame(ticks: readonly Tick[]): ArrayBuffer {
	const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + ticks.length * TICK_RECORD_BYTES);
	const view = new DataView(buffer);
	view.setUint8(0, FrameType.Tick);
	view.setUint8(1, PROTOCOL_VERSION);
	view.setUint16(2, ticks.length, true);

	let offset = FRAME_HEADER_BYTES;
	for (const tick of ticks) {
		view.setUint16(offset, tick.symbolId, true);
		view.setUint8(offset + 2, tick.side);
		view.setUint8(offset + 3, 0);
		view.setUint32(offset + 4, tick.sequence, true);
		view.setFloat64(offset + 8, tick.timestamp, true);
		view.setFloat64(offset + 16, tick.price, true);
		view.setFloat32(offset + 24, tick.size, true);
		view.setUint32(offset + 28, 0, true);
		offset += TICK_RECORD_BYTES;
	}
	return buffer;
}

/** Decodes in place into `out` so the hot path allocates nothing. */
export function decodeTickFrame(buffer: ArrayBuffer, out: Tick[]): number {
	const view = new DataView(buffer);
	if (view.getUint8(0) !== FrameType.Tick) {
		return 0;
	}
	const count = view.getUint16(2, true);
	let offset = FRAME_HEADER_BYTES;
	for (let i = 0; i < count; i++) {
		let tick = out[i];
		if (!tick) {
			tick = { symbolId: 0, side: TickSide.Unknown, sequence: 0, timestamp: 0, price: 0, size: 0 };
			out[i] = tick;
		}
		tick.symbolId = view.getUint16(offset, true);
		tick.side = view.getUint8(offset + 2);
		tick.sequence = view.getUint32(offset + 4, true);
		tick.timestamp = view.getFloat64(offset + 8, true);
		tick.price = view.getFloat64(offset + 16, true);
		tick.size = view.getFloat32(offset + 24, true);
		offset += TICK_RECORD_BYTES;
	}
	return count;
}
