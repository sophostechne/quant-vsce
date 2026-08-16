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

Charts draw real historical prices out of the box, with no daemon and no credentials — bars come
from `https://bars.sophostechne.com`, which serves IEX data derived from published captures. The
extension fetches them over HTTPS itself, so this is the ordinary way to use the workbench, not
a degraded mode. Point `quant.bars.url` at your own service to use different data.

Bars stop at the last session's close, so the badge reads *history only* — accurate rather than
reassuring.

Crypto needs no daemon either. `BTC-USD` and other exchange pairs come from Coinbase's public
candles, which need no credentials — `1m` through `1d`. Because crypto trades continuously the
newest candle is minutes old rather than a closed session away, so *history only* here means
nearly current.

Symbols route by shape: a pair ending in a quote currency is an exchange product, anything else
is a ticker. That is what keeps `BTC-USD` apart from share classes like `BF-B`.

### Live prices — the daemon

```sh
npx @sophostechne/quant-daemon
```

Defaults to `127.0.0.1:8787`, which is where the extension looks; change that with
`quant.daemon.host` and `quant.daemon.port`. Providers, credentials and tuning are documented
in the [daemon repository](https://github.com/sophostechne/quant-daemon).

Install this only when you want prices that move. What it costs depends on the asset:

| | Real-time needs |
|---|---|
| **Crypto** | nothing — Coinbase is the default provider and needs no account |
| **US equities** | your own broker credentials, e.g. an Alpaca account: `--provider coinbase,alpaca,bars` |

Equity ticks are the part that cannot be given away: every real-time US equity feed is licensed
per subscriber, which is why the workbench ships history rather than a live tape. Bars derived
from IEX captures may be redistributed, so the service carries those and leaves live prices to
a provider you hold credentials for.

Put `bars` last in the provider list so it claims only what the live feed did not.

The daemon also unlocks the sub-5m timeframes. `1s` and `5s` are not stored anywhere — they
exist only as live trades aggregated as they arrive — and `1m` is deliberately not published,
because these are single-venue IEX bars and a bucket that fine shows which venue printed rather
than what the instrument did. The chart's timeframe picker hides all three until a daemon is
connected, rather than offering a guaranteed empty chart, and widens as soon as one is.

### Custom overlays

**Quant: New Visualizer** writes a `.visualizer.mts` into your workspace, copies the type
declarations beside it, and attaches it to the chart in front of you. Save the file and the
chart redraws.

```ts
export default function ribbon(bars: readonly Bar[], ctx: VisualizerContext): VisualizerItem[] {
  return [{ label: 'Close', lines: [bars.map(bar => bar.close)] }];
}
```

Three kinds of thing can come back: **series** (lines, optionally filled, on the price pane or
their own), **background** (one colour per bar, painted behind the candles — for a state such as
a regime or a session rather than a value), and **markers** (a note pinned to a bar, for the few
moments worth looking at).

No build step: Node strips the types when the file is imported, so nothing is compiled and a
stack trace points at the line you wrote. That is also why `enum`, `namespace` and constructor
parameter properties are unavailable — erasing them would change behaviour rather than only
declarations. Errors land in the Problems panel.

It runs in a worker with a two second deadline and a memory cap, so an accidental infinite loop
costs a message on the chart rather than a frozen editor. Return `undefined` rather than `0` for
a warm-up window: zeros draw a cliff no price supports, and `NaN`/`Infinity` are converted to
gaps for the same reason.

Visualizers draw. They are not strategy inputs — backtests run on the engine's genome.

### Where a chart's bars come from

Three sources, tried in order, each owning the symbols it claims:

| Source | Owns | Timeframes | Needs |
|---|---|---|---|
| daemon | everything, while connected | all | the daemon running |
| Coinbase | exchange pairs — `BTC-USD` | `1m`–`1d` | nothing |
| Binance | the same pairs, as `BTCUSDT` | `1m`–`1d` | nothing |
| published bars | tickers — `AAPL` | `5m`–`1d` | nothing |

Coinbase and Binance are listed together because they are geo-blocked in opposite places —
Binance answers `451 Unavailable For Legal Reasons` from the US, and Coinbase is the one at risk
elsewhere. Crypto therefore resolves to whichever is reachable from where you are, with nothing
to configure. They are complements, not redundancy.

They are not the same instrument, so the chart names which answered: `history only · coinbase`
against `history only · binance · USDT`. Binance lists no USD pairs, so `BTC-USD` becomes
`BTCUSDT` — a token that tracks the dollar rather than the dollar. Equity bars are labelled
`iex` for the same reason: one venue at a few percent of the consolidated tape.

A source that cannot answer lets the next one try, so adding a daemon can only gain you a live
tail and never cost you a chart — an equity against a `coinbase`-only provider list falls
through to published bars rather than failing.

Adding a fourth source is a file implementing `HistorySource` in `src/marketData/sources.ts`;
the routing and the timeframe picker both derive from the list.

**Never a synthetic feed.** History is real or it is absent with a stated reason, because a
chart is the last place a fabricated price should be able to hide. A service that cannot be
reached says `bars service unreachable: …`; one that is not configured says `no bars service
configured (quant.bars.url)`. Neither draws anything.

`quant.daemon.allowSimulatedFeed` is off by default and, when enabled, produces synthetic
**ticks** only — never bars. It is a development aid and **must not be traded on**.

The badge names the actual source of the bars on screen rather than the state of the connection,
because with no daemon those two stopped meaning the same thing: only the fetch knows which
source answered.

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

With no daemon reachable the extension draws published history, and falls back to a synthetic
feed (`src/marketData/simulator.ts`) only when that is unreachable too. In that mode the
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
code --install-extension quant-workbench-1.1.0.vsix
```
