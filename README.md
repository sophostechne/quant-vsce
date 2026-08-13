# Quant Workbench

Extension providing market data, watchlists, charts and strategy tooling.

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

Charts and designer strategies live in `~/.quant`, not in the open workspace: the same layout
is the one you want from any window, and it does not end up committed to whatever repository
happened to be open when you drew it.

## Running without a daemon

With no daemon reachable the extension falls back to a synthetic feed
(`src/marketData/simulator.ts`) so the workbench renders during development. In that mode the
extension host relays simulated ticks over `postMessage`, which is a development affordance
and **not** the real data path. The status bar shows *Simulated* with a warning background,
and charts show a `simulated data` badge. Disable it with
`quant.daemon.allowSimulatedFeed: false`.

Prices in this mode are a seeded random walk and must not be traded on.

## Build

```sh
npm run compile     # extension host bundle to out/, webview bundles to media/
npm run watch       # the same, rebuilt on change
npm run typecheck   # tsc --noEmit over both tsconfigs, plus the vocabulary check
npm test            # unit tests, in a VS Code downloaded on demand
npm run package     # .vsix
```

esbuild produces what runs; `tsc` only typechecks, since two emitters writing the same
directory is a race rather than a build.

For a running workbench, press F5 (*Run Extension* in `.vscode/launch.json`) to open a second
window with the extension loaded from source. To install the packaged build into an ordinary
VS Code:

```sh
code --install-extension quant-1.0.0.vsix
```
