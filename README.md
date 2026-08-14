# Quant Workbench

Extension providing market data, watchlists, charts and strategy tooling.

Charts with 35 drawing tools and indicators in overlay and study panes; a no-code strategy
designer generated from the engine's own type system; and an evolutionary search that reports
every candidate twice — on the bars it was fitted to, and on bars withheld from the search.

## Setup

The workbench is the user interface for two other processes, and installs without either. What
each one adds:

### Strategies and backtests — the engine

```sh
pip install sophostechne-quant
```

Then point the extension at the interpreter you installed it into:

```jsonc
{ "quant.engine.pythonPath": "/path/to/venv/bin/python" }   // Scripts\\python.exe on Windows
```

Working from a checkout of the [engine](https://github.com/sophostechne/quant) instead? Set
`quant.engine.projectPath` to it and leave `pythonPath` empty — its `.venv` is found from
there. With the checkout open as your folder, neither setting is needed.

Without this, the designer opens and charts work, but evaluating, searching and walking a
strategy forward all report that no interpreter is configured.

### Historical charts, with nothing installed

```jsonc
{ "quant.bars.url": "https://bars.example.com" }
```

Point this at a published bars service and charts draw real historical prices with no daemon
and no credentials. Bars stop at the last session's close, so the badge reads *history only* —
accurate rather than reassuring.

### Live prices — the daemon

```sh
npx @sophostechne/quant-daemon
```

Defaults to `127.0.0.1:8787`, which is where the extension looks; change that with
`quant.daemon.host` and `quant.daemon.port`. Providers, credentials and tuning are documented
in the [daemon repository](https://github.com/sophostechne/quant-daemon).

### What a chart falls back to

In order: a daemon, then published history, then a synthetic feed. The last is a seeded random
walk that **must not be traded on** — the status bar reads *Simulated* and charts carry a
`simulated data` badge. Turn it off with `quant.daemon.allowSimulatedFeed: false`.

The badge always names the actual source of the bars on screen rather than the state of the
connection, because with no daemon those two stopped meaning the same thing: real published
history and invented prices are both reachable, and only the fetch knows which answered.

## Architecture

The important constraint is that **tick traffic must not flow through the extension host.**

`Webview.postMessage` has no transfer list, so every message costs a structured clone plus
two IPC hops (extension host → main thread → webview iframe). The extension host is also
single threaded and shared with every other extension, so a busy feed there stalls unrelated
work. The design therefore splits into two planes:

```
market data daemon (separate process, see the quant-daemon repository)
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
code --install-extension quant-workbench-1.0.0.vsix
```
