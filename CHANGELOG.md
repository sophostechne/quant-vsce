# Changelog

## 1.1.1

- A new chart opens on daily bars. It opened on 1-minute bars, which published history does not
  carry, so a fresh install with no daemon fell straight through to the simulated feed - the one
  thing this workbench should not show anyone by default.
- A symbol or timeframe that is not published now reads *no {timeframe} history published*
  rather than being replaced with synthetic prices. An unreachable service still falls back to
  the simulator; a service that answers "I do not have that" is telling the truth, and inventing
  a chart in response is worse than drawing none.

## 1.1.0

- Charts draw real historical prices with nothing else installed. With no daemon reachable the
  extension now reads published bars over HTTPS, and falls back to the simulated feed only when
  that is unreachable too. The badge names whichever source answered.
- The engine can be an installed package rather than a checkout: `quant.engine.pythonPath` alone
  is enough, and the checkout default is now correct on Windows.
- An icon, gallery metadata, and a README that opens with how to install.

## 1.0.0

Split out of the VS Code fork it was built inside, and now packages as an ordinary
extension.

- Charts: 15 styles, indicators in overlay and study panes, crosshair, zoom, linear and
  logarithmic scales, and 35 drawing tools that remain editable after being placed.
- Strategy designer: a no-code editor over `.strategy` files, generated from the engine's
  own type system, so an invalid strategy cannot be represented rather than merely rejected.
- Testing: a strategy is measured against buy-and-hold, against its own resampled trade
  order, and against random strategies on the same bars.
- Search: evolution runs from the designer and reports every candidate twice - on the bars
  it was fitted to and on bars withheld from the search.
- Walk-forward: re-runs the whole search across the series to test the method rather than
  any one strategy.
