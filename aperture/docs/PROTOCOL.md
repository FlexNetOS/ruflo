# Aperture wire protocol (v0.1)

Each pane and the data agent run as a headless process invoked with
`--agent=<id>`. Inbound/outbound traffic is **newline-delimited JSON**, one
`Envelope` per line, over stdin/stdout; EOF terminates cleanly. The envelope
is field-identical to `v3/@claude-flow/swarm/src/types.ts` `Message`, so JSON
round-trips between TypeScript and Rust with no remap.

## Envelope

Example: `{"id":"01HXY...","type":"direct","from":"aperture:cmdbar","to":"aperture:pane.chart","payload":{"verb":"CHART","symbol":"AAPL","range":"6M"},"timestamp":"2026-05-10T15:04:05.123Z","priority":"high","requiresAck":false,"ttlMs":5000,"correlationId":"chart-load-7"}`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Sortable, process-unique (`<millis36>-<pid36>-<ctr36>` in Rust; ULID in TS). |
| `type` | enum | `direct`, `broadcast`, `task_*`, `heartbeat`, `status_update`, `consensus_*`, `topology_update`, `agent_join`/`leave`. |
| `from` / `to` | string | `aperture:<role>` (e.g. `aperture:pane.quote`, `aperture:cmdbar`); broadcasts target literal `broadcast`. |
| `payload` | object | Verb-specific. `payload.verb` is mandatory for Aperture traffic. |
| `timestamp` | string | ISO-8601 UTC, ms precision, trailing `Z`. |
| `priority` | enum | `urgent`/`high`/`normal`/`low`. Replies inherit the request's priority. |
| `requiresAck` | bool | If `true`, recipients must reply (even an empty `*.ACK`). |
| `ttlMs` | number | Soft deadline (ms). Replies inherit. |
| `correlationId` | string? | Copied verbatim to the reply; omitted when unset. |

`aperture_swarm::reply(&req, payload)` swaps `from`/`to`, carries
`correlationId` (falling back to `req.id`), and inherits `priority`/`ttlMs`.

## Verb table

`payload.verb` selects the operation. Replies always end in `.RESULT`
(or `.ACK` when the inbound was a `requiresAck` broadcast).

| Verb | From → To | Payload (in) | Reply verb | Owner |
|---|---|---|---|---|
| `DESC` | cmdbar → `pane.quote` | `{symbol}` | `QUOTE.RESULT` | quote pane |
| `CHART` | cmdbar → `pane.chart` | `{symbol, range?}` | `CHART.RESULT` | chart pane |
| `WATCH` | cmdbar → `pane.watchlist` | `{symbol}` | `WATCH.RESULT` | watchlist pane |
| `UNWATCH` | cmdbar → `pane.watchlist` | `{symbol}` | `UNWATCH.RESULT` | watchlist pane |
| `LIST` | cmdbar → `pane.watchlist` | `{}` | `LIST.RESULT` | watchlist pane |
| `ASK` | cmdbar → `pane.oracle` | `{prompt}` | `ASK.RESULT` | oracle pane |
| `NEWS` | cmdbar → `pane.news` | `{symbol?}` | `NEWS.RESULT` | news pane |
| `MACRO` | cmdbar → `pane.macro` | `{}` | `MACRO.RESULT` | macro pane |
| `YIELDS` | cmdbar → `pane.yields` | `{}` | `YIELDS.RESULT` | yields pane |
| `FX` | cmdbar → `pane.fx` | `{base?}` | `FX.RESULT` | fx pane |
| `OPTIONS` | cmdbar → `pane.options` | `{symbol}` | `OPTIONS.RESULT` | options pane |
| `INSIDER` | cmdbar → `pane.insider` | `{symbol}` | `INSIDER.RESULT` | insider pane |
| `FINANCIALS` | cmdbar → `pane.financials` | `{symbol}` | `FINANCIALS.RESULT` | financials pane |
| `CRYPTO` | cmdbar → `pane.crypto` | `{symbol}` | `CRYPTO.RESULT` | crypto pane |
| `RISK` | cmdbar → `pane.risk` | `{symbols?: string[]}` | `RISK.RESULT` | risk pane |
| `CORPACT` | cmdbar → `pane.corpact` | `{symbol}` | `CORPACT.RESULT` | corpact pane |
| `INBOX` / `INBOX.POST` / `INBOX.CLEAR` | cmdbar → `pane.inbox` | `{}` / `{body}` / `{}` | `INBOX.RESULT` | inbox pane |
| `EXPORT` | host → `pane.export` | `{snapshot, format}` | `EXPORT.RESULT` | export pane |
| `QUOTE` | (any) → `agent.data` | `{symbol}` | `QUOTE.RESULT` | data agent |
| `OHLCV` | `pane.chart` → `agent.data` | `{symbol, range?}` | `OHLCV.RESULT` | data agent |
| `FOCUS` | cmdbar → `broadcast` | `{symbol}` | `FOCUS.ACK` (only if `requiresAck`) | every pane |

### Reply payload shapes

| Reply verb | Fields |
|---|---|
| `QUOTE.RESULT` | `{symbol, last, changePct, bid?, ask?, timestamp}` or `{symbol, error}` |
| `CHART.RESULT` | `{symbol, range, lines: string[], candleCount}` or `{symbol, error}` |
| `WATCH.RESULT` | `{symbol, items: string[]}` |
| `UNWATCH.RESULT` | `{symbol, items: string[]}` |
| `LIST.RESULT` | `{items: string[]}` |
| `ASK.RESULT` | `{prompt, answer, focus?}` |
| `NEWS.RESULT` | `{scope, data: {headlines}}` or `{error}` |
| `MACRO.RESULT` | `{rows}` or `{error}` |
| `YIELDS.RESULT` | `{curve}` or `{error}` |
| `FX.RESULT` | `{data: {base, rates}}` or `{error}` |
| `OPTIONS.RESULT` | `{symbol, chain: {rows}}` or `{symbol, error}` |
| `INSIDER.RESULT` | `{symbol, data: {trades}}` or `{symbol, error}` |
| `FINANCIALS.RESULT` | `{symbol, data: {income_ttm, balance_mrq, cashflow_ttm}}` or `{symbol, error}` |
| `CRYPTO.RESULT` | `{symbol, data: {last, vol_24h, market_cap, dominance}}` or `{symbol, error}` |
| `RISK.RESULT` | `{data: {rows}}` or `{error}` |
| `CORPACT.RESULT` | `{symbol, data: {events}}` or `{symbol, error}` |
| `INBOX.RESULT` | `{messages: [{from, body, ts}]}` |
| `EXPORT.RESULT` | `{format, body}` or `{error}` |
| `OHLCV.RESULT` | `{symbol, range, candles: [{t,o,h,l,c,v}]}` or `{symbol, error}` |
| `FOCUS.ACK` | `{symbol}` |

## Agent ids

| Id | Process invocation | Verbs handled |
|---|---|---|
| `aperture:pane.quote` | `aperture --agent=pane.quote` | `DESC`, `FOCUS` |
| `aperture:pane.chart` | `aperture --agent=pane.chart` | `CHART`, `FOCUS` |
| `aperture:pane.watchlist` | `aperture --agent=pane.watchlist` | `WATCH`, `UNWATCH`, `LIST` |
| `aperture:pane.oracle` | `aperture --agent=pane.oracle` | `ASK`, `FOCUS` |
| `aperture:pane.news` | `aperture --agent=pane.news` | `NEWS`, `FOCUS` |
| `aperture:pane.macro` | `aperture --agent=pane.macro` | `MACRO` |
| `aperture:pane.yields` | `aperture --agent=pane.yields` | `YIELDS` |
| `aperture:pane.fx` | `aperture --agent=pane.fx` | `FX` |
| `aperture:pane.options` | `aperture --agent=pane.options` | `OPTIONS`, `FOCUS` |
| `aperture:pane.insider` | `aperture --agent=pane.insider` | `INSIDER`, `FOCUS` |
| `aperture:pane.financials` | `aperture --agent=pane.financials` | `FINANCIALS`, `FOCUS` |
| `aperture:pane.crypto` | `aperture --agent=pane.crypto` | `CRYPTO`, `FOCUS` |
| `aperture:pane.risk` | `aperture --agent=pane.risk` | `RISK` |
| `aperture:pane.corpact` | `aperture --agent=pane.corpact` | `CORPACT`, `FOCUS` |
| `aperture:pane.inbox` | `aperture --agent=pane.inbox` | `INBOX`, `INBOX.POST`, `INBOX.CLEAR` |
| `aperture:pane.export` | `aperture --agent=pane.export` | `EXPORT` |
| `aperture:agent.data` | `aperture --agent=agent.data` | `QUOTE`, `OHLCV` |

## Topology

- **v0.1 — centralised.** The command bar (`aperture:cmdbar`) parses
  `SYMBOL VERB GO`, routes the resulting `Envelope` to the owning pane, and
  broadcasts `FOCUS <symbol>` on every successful command.
- **v0.2 — mesh.** Panes message peers (and `agent.data`) directly without
  bouncing through the cmdbar; the topology becomes peer-to-peer with the
  cmdbar reduced to an input router.

## Phase boundaries

- **Phase B (current).** All pane agents back onto
  `aperture_data::StubDataSource` (deterministic, offline) so the round-trip
  test in `crates/aperture-tui/tests/roundtrip_stdio.rs` is reproducible.
- **Phase C.** `pane.oracle` forwards `ASK` to `plugins/ruflo-neural-trader`
  via the swarm bus; `agent.data` swaps `StubDataSource` for the real
  provider mux (yahoo / fred / coingecko / sec / alphavantage).
