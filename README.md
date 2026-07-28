# Quant Workbench

Built-in extension providing market data, watchlists, charts and strategy tooling.

## Architecture

The important constraint is that **tick traffic must not flow through the extension host.**

`Webview.postMessage` has no transfer list, so every message costs a structured clone plus
two IPC hops (extension host → main thread → webview iframe). The extension host is also
single threaded and shared with every other extension, so a busy feed there stalls unrelated
work. The design therefore splits into two planes:

```
market data daemon (separate process, not in this repo)
  ├── control socket  ──── JSON ────▶  extension host   (this extension)
  │      subscribe / unsubscribe / history / symbol interning
  │
  └── data socket  ──── binary ────▶  chart webviews    (direct, bypasses the host)
         packed 32-byte tick records, see src/protocol.ts
```

The extension host holds the control plane only. Chart webviews open their own socket to the
daemon and read packed frames straight out of an `ArrayBuffer` with a `DataView`.

Order routing and strategy execution belong in their own processes for the same reason, plus
one more: the extension host is restartable and any extension can crash it.

### Rate discipline

Ticks arrive far faster than any UI can repaint, so every display surface coalesces:

- the watchlist `TreeView` is DOM backed and repaints on a timer
  (`quant.watchlist.refreshIntervalMs`, default 250ms)
- the chart canvas repaints on `requestAnimationFrame`, never in the message handler

## Surfaces

| Surface | Mechanism |
|---|---|
| Watchlist | `TreeView`, `src/watchlist/watchlistView.ts` |
| Strategies | `TreeView`, `src/strategies/strategiesView.ts` |
| Charts | `CustomTextEditorProvider` over `.chart` files, `src/chart/chartEditor.ts` |
| Connection state | status bar item, `src/extension.ts` |

`.chart` files are JSON (`{ symbol, timeframe, bars }`). Backing charts with real text
documents means layouts get save, undo, diff and version control for free, and a chart is
just another editor tab — splits, editor groups and *Move Editor into New Window* work with
no extra code.

## Running without a daemon

With no daemon reachable the extension falls back to a synthetic feed
(`src/marketData/simulator.ts`) so the workbench renders during development. In that mode the
extension host relays simulated ticks over `postMessage`, which is a development affordance
and **not** the real data path. The status bar shows *Simulated* with a warning background,
and charts show a `simulated data` badge. Disable it with
`quant.daemon.allowSimulatedFeed: false`.

Prices in this mode are a seeded random walk and must not be traded on.

## Build

Compilation is registered in `build/gulpfile.extensions.ts`. The extension has no install step
of its own (it follows the `search-result` pattern), so a root `npm install` is all that is
needed.

```sh
npx gulp compile-extension:quant
npx gulp watch-extension:quant
```

## Proposed API

`editorInsets` is declared in both `package.json` and `product.json#extensionEnabledApiProposals`.
Both must list the same proposals: product.json **overrides** rather than merges, and a
mismatch logs an error at startup (see `extensionsProposedApi.ts`). It is reserved for inline
strategy annotations (signal and P&L markers next to source lines) and is not used yet.
