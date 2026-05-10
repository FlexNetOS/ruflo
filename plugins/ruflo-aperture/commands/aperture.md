---
name: aperture
description: Open Aperture market workspace. Form `/aperture [SYMBOL VERB [ARG...] [GO]]`.
---

Examples:
- `/aperture` — empty workspace
- `/aperture AAPL DESC GO` — Quote pane on AAPL
- `/aperture BTC CRYPTO` — crypto quote
- `/aperture ASK "what moved NVDA today"` — Oracle pane
- `/aperture AAPL OPTIONS GO` — Options pane on AAPL
- `/aperture MACRO GO` — econ indicators
- `/aperture YIELDS GO` — treasury yield curve
- `/aperture AAPL FINANCIALS GO` — income/balance/cashflow

Native: `cargo run -p aperture-tui`. Browser: `pnpm --filter ruvocal dev` → `/aperture`.
