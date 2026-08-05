# Changelog

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
