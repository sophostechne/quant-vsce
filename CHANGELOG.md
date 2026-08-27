# Changelog

## 1.10.5

- A visualizer's marker label sits in the middle of the chip drawn behind it. The chip was
  positioned around one text baseline and the label drawn on another - whichever the previous
  drawing pass had left set - so the text rode high in its own background.

## 1.10.4

- Rapid symbol, timeframe and feed changes no longer allow an older history or visualizer
  response to replace the newer chart.
- Double-clicking a study divider restores pane heights without also resetting horizontal zoom.

## 1.10.3

- No functional changes. The extension is republished from the same source as 1.10.2;
  the version number is the only difference between the two builds.

## 1.10.2

- Hollow candles no longer have a line down the middle of them. The wick was drawn as one stroke
  from high to low and the body drawn over it, which works for every filled style because the
  body hides the middle of the line - but a hollow body is an outline, so the wick ran straight
  through the inside of it. It is now drawn as two segments, above the body and below it.
- The chart's title buttons keep their pairs together. Two of them shared an order number with
  two others, and a tie there is broken by comparing titles, so Add Indicator sorted in between
  Chart Style and Price Scale and Draw did the same to Remove Indicator - separating the two
  settings that describe how the chart is drawn with a command that adds a series to it.

## 1.10.1

- The time axis follows the interval. Its labels were chosen by how many bars were on screen,
  which is only a proxy for the span they cover at one interval: a daily chart is rarely three
  hundred bars wide, so it printed the time of day - and every daily bar opens at the same time,
  which is an axis of identical labels. Labels now carry whatever distinguishes one tick from the
  next at the interval in front of you, down to the month on a yearly chart and up to the date on
  an intraday one that runs past a day. The crosshair names the bar in full.

## 1.10.0

- Intervals the feed does not publish. The picker offered the seven granularities a source
  happens to serve; everything between them - 2m, 30m, 4h, a week, a quarter, a year - was
  unreachable. Broader intervals are now built by aggregating a granularity that is served, so a
  feed stopping at 1h supports 2h, 3h and 4h, and daily supports weekly through yearly. An
  interval only appears when it can actually be filled.
- Your own intervals, from the picker or from `quant.chart.customIntervals`. They are a setting
  rather than part of the document: they describe how you work, not the chart in front of you, so
  one added while reading AAPL is still there on the next chart opened.
- Intraday bars line up with the trading session rather than with the epoch. A venue opening at
  09:30 New York does not start its four-hour bars at midnight UTC, and the offset follows
  daylight saving rather than being fixed. Weeks and months bucket by calendar, so a monthly
  candle stays on the first of the month instead of drifting off it.
- A chart no longer goes blank when it cannot measure a price range. One non-finite value in an
  overlay, or a window where every bar has the same high and low, emptied the whole canvas -
  candles, axes, gridlines and every study - rather than the one pane that could not be scaled.

## 1.9.4

- A gap in a visualizer's output no longer blanks the chart. Everywhere in the chart a missing
  value is `undefined`, and every consumer tests for exactly that; visualizer output is the one
  series that crosses `postMessage`, which serialises it as JSON and turns those holes into
  `null`. The chart went blank on a timeframe change, on a pan, or at a particular zoom - wherever
  a hole first came into view.
- Add point-in-time market forecasts from the quant engine, including baseline, cycle, pattern,
  and cross-market flow models.
- Record forecasts append-only, resolve matured outcomes, report calibration and performance by
  immutable model version, and audit registry chronology and links.
- Preserve the current visualizer workflow while sharing one engine runner across strategy and
  forecast commands.

## 1.9.3

- A visualizer listed twice on one chart runs once. New Visualizer appended without checking what
  was already there, so one chart had accumulated four copies of a single ribbon: four workers
  spawned per refresh, four identical lines on the legend, and nothing to suggest why.

## 1.9.2

- Visualizer tints and markers survive a refresh. Every history message cleared them and the
  replacement only arrived once a worker had spawned and run, so any redraw of unchanged bars
  blinked the overlay out and back.
- When output cannot be drawn - because a style like Renko collapses many bars into one, and an
  array indexed against raw bars no longer lines up - the chart says so instead of quietly
  putting a regime under the wrong candles.

## 1.9.1

- Translucent colours from a visualizer are drawn as written. Theme ids were detected by
  "contains a dot", which is also true of `rgba(132, 187, 161, 0.13)`, so every transparent colour
  was looked up as a theme variable, missed, and fell back to solid blue - painting over the chart
  rather than tinting behind it.

## 1.9.0

- Visualizers can tint bars and pin notes to them, not only draw lines. A regime indicator's
  reading is its background ribbon and its labels at each durable change; those are the indicator
  rather than decoration on it, and previously had nowhere to go.

## 1.8.1

- New Visualizer attaches to the chart you are looking at. A chart is a custom editor, so the
  workbench reports no active *text* editor while one has focus, and the command fell back to the
  first `.chart` in the workspace - with two charts open it silently changed the other one.

## 1.8.0

- Custom overlays, written as TypeScript in the workspace. A `.visualizer.mts` file turns bars
  into lines the chart draws; the indicator set was a closed list of nine, which is fine until
  someone wants the tenth. Nothing compiles it - Node strips the types - so the extension ships no
  compiler and a stack trace points at the line you wrote.

## 1.7.4

- Internal: the last-close cache moved out of the market data client, which had grown to own a
  socket lifecycle, a reconnect policy, a quote store, a source list and a cache with a refresh
  policy.

## 1.7.3

- Internal: `BarSource` renamed to `BarProvenance`, which is what it holds.

## 1.7.2

- Crypto rows no longer say "close". BTC-USD trades every hour of every day, so there is no close
  to report - the latest daily bar is still forming and the number shown is the current price.
  Sources now declare whether their venue keeps sessions, so the label follows the market.

## 1.7.1

- The watchlist stopped flashing a progress bar every three seconds. With no daemon the client
  retries forever, and each attempt moved through Connecting and back; the view answered every
  state change with a refresh, which the workbench draws a progress bar for.

## 1.7.0

- Binance sits beneath Coinbase, and the chart names which venue answered. One crypto source made
  charts work or not depending on where the user happened to be - Binance answers 451 on some
  networks and Coinbase is the one at risk on others. They are complements rather than
  redundancy, blocked in opposite places.

## 1.6.0

- The watchlist shows the last published close when nothing is streaming. Quotes arrive only from
  a daemon or the simulator, so turning the simulator off by default left every row reading "no
  data" beside charts drawing real prices for those same symbols.

## 1.5.0

- History goes through a list of sources rather than a chain of conditions. Each declares what it
  claims, what it can serve and what to caption its bars as, and the first to answer wins - so
  crypto now reads straight from Coinbase with no daemon and no configuration.

## 1.4.0

- The timeframe picker offers 1s, 5s and 1m only when a daemon can serve them. All three were
  listed regardless and none can be filled without one, so the first thing a new user was likely
  to try produced an empty chart that read as the workbench being broken.

## 1.3.2

- Documentation stopped promising a simulated fallback that had been removed. Three places still
  said that emptying `quant.bars.url` falls back to synthetic prices, so following the settings
  description got you an empty chart - a worse outcome for having read it.

## 1.3.1

- A daemon that cannot answer for a symbol falls back instead of failing. Connecting one replaced
  published history rather than adding to it, so running a daemon for crypto broke every equity
  chart on the same machine.

## 1.3.0

- The synthetic feed is off unless asked for. It is a development aid, and the one state in which
  the workbench shows invented numbers was also the state nobody chose. Published history no
  longer depends on it either - reading a public HTTPS service had been tied to whether a
  synthetic feed was enabled.

## 1.2.1

- An unreachable bars service is never answered with invented prices. A chart drew synthetic
  candles captioned "simulated data", which is true and useless: the badge names what happened,
  not why, and the causes need different fixes. An empty `quant.bars.url` returned without logging
  at all, so a workspace setting silently overriding the user setting was indistinguishable from a
  network fault.

## 1.2.0

- New charts and backtests both open on 5m. A fresh chart on daily drew about 21 candles where it
  asked for 240 - the service carries a month of history - and a chart that short reads as broken
  rather than as short. Backtests opened on 1h, which at that depth fell under the engine's
  200-bar floor and was refused outright.
