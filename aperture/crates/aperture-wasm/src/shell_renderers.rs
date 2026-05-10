//! Inbound envelope renderers. Split out of `shell_routing` to keep both
//! files under the 500-line cap.
//!
//! For each `<VERB>.RESULT` we know about, [`render_inbound`] produces one
//! or more [`ViewLine`]s targeted at the right [`Pane`]. Unknown verbs fall
//! back to address-based pane detection so the host still sees something.

use aperture_swarm::envelope::Envelope;
use serde_json::Value;

use crate::shell_routing::{Pane, ViewLine};

/// Decide which pane an inbound envelope belongs to and produce display
/// lines. Dispatch is on `payload.verb` first (so `*.RESULT` replies route
/// deterministically); we fall back to the address only if the verb is
/// missing or unknown. Errors short-circuit to a single line.
pub fn render_inbound(env: &Envelope) -> Vec<ViewLine> {
    let verb = env
        .payload
        .get("verb")
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string();

    if let Some(err) = env.payload.get("error").and_then(Value::as_str) {
        let pane = pane_from_verb(&verb).unwrap_or_else(|| pane_from_address(&env.from));
        return vec![line(pane, format!("{verb}  error: {err}"))];
    }

    match verb.as_str() {
        "QUOTE.RESULT" => render_quote(&env.payload),
        "CHART.RESULT" => render_chart(&env.payload),
        "WATCH.RESULT" | "UNWATCH.RESULT" | "LIST.RESULT" => render_watch(&env.payload, &verb),
        "ASK.RESULT" => render_ask(&env.payload),
        "NEWS.RESULT" => render_news(&env.payload),
        "MACRO.RESULT" => render_macro(&env.payload),
        "YIELDS.RESULT" => render_yields(&env.payload),
        "FX.RESULT" => render_fx(&env.payload),
        "OPTIONS.RESULT" => render_options(&env.payload),
        "INSIDER.RESULT" => render_insider(&env.payload),
        "FINANCIALS.RESULT" => render_financials(&env.payload),
        "CRYPTO.RESULT" => render_crypto(&env.payload),
        "RISK.RESULT" => render_risk(&env.payload),
        "CORPACT.RESULT" => render_corpact(&env.payload),
        "INBOX.RESULT" => render_inbox(&env.payload),
        "EXPORT.RESULT" => render_export(&env.payload),
        _ => {
            let pane = pane_from_address(&env.from);
            let payload_str = serde_json::to_string(&env.payload).unwrap_or_default();
            vec![line(pane, format!("{verb}  {payload_str}"))]
        }
    }
}

fn pane_from_verb(verb: &str) -> Option<Pane> {
    match verb {
        "QUOTE.RESULT" => Some(Pane::Quote),
        "CHART.RESULT" => Some(Pane::Chart),
        "WATCH.RESULT" | "UNWATCH.RESULT" | "LIST.RESULT" => Some(Pane::Watch),
        "ASK.RESULT" => Some(Pane::Oracle),
        "NEWS.RESULT" => Some(Pane::News),
        "MACRO.RESULT" => Some(Pane::Macro),
        "YIELDS.RESULT" => Some(Pane::Yields),
        "FX.RESULT" => Some(Pane::Fx),
        "OPTIONS.RESULT" => Some(Pane::Options),
        "INSIDER.RESULT" => Some(Pane::Insider),
        "FINANCIALS.RESULT" => Some(Pane::Financials),
        "CRYPTO.RESULT" => Some(Pane::Crypto),
        "RISK.RESULT" => Some(Pane::Risk),
        "CORPACT.RESULT" => Some(Pane::Corpact),
        "INBOX.RESULT" => Some(Pane::Inbox),
        "EXPORT.RESULT" => Some(Pane::Export),
        _ => None,
    }
}

fn pane_from_address(addr: &str) -> Pane {
    let lower = addr.to_ascii_lowercase();
    // Check pane.<id> first so the longest match wins.
    let table = [
        ("pane.quote", Pane::Quote),
        ("pane.chart", Pane::Chart),
        ("pane.watch", Pane::Watch),
        ("pane.oracle", Pane::Oracle),
        ("pane.news", Pane::News),
        ("pane.macro", Pane::Macro),
        ("pane.yields", Pane::Yields),
        ("pane.fx", Pane::Fx),
        ("pane.options", Pane::Options),
        ("pane.insider", Pane::Insider),
        ("pane.financials", Pane::Financials),
        ("pane.crypto", Pane::Crypto),
        ("pane.risk", Pane::Risk),
        ("pane.corpact", Pane::Corpact),
        ("pane.inbox", Pane::Inbox),
        ("pane.export", Pane::Export),
        ("agent.quote", Pane::Quote),
        ("agent.watch", Pane::Watch),
        ("agent.oracle", Pane::Oracle),
        ("agent.data", Pane::Chart),
    ];
    for (needle, pane) in table {
        if lower.contains(needle) {
            return pane;
        }
    }
    Pane::System
}

fn line(pane: Pane, text: String) -> ViewLine {
    ViewLine { pane, text }
}

fn value_to_compact_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// --- per-verb renderers ----------------------------------------------------

fn render_quote(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let last = p.get("last").and_then(Value::as_f64).unwrap_or(0.0);
    let chg = p.get("change_pct").and_then(Value::as_f64).unwrap_or(0.0);
    vec![line(Pane::Quote, format!("{sym}  {last:.2}  {chg:+.2}%"))]
}

fn render_chart(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Chart, format!("CHART {sym}"))];
    if let Some(rows) = p.get("ascii").and_then(Value::as_array) {
        for r in rows {
            if let Some(s) = r.as_str() {
                out.push(line(Pane::Chart, s.to_string()));
            }
        }
    }
    out
}

fn render_watch(p: &Value, verb: &str) -> Vec<ViewLine> {
    let symbols = p
        .get("symbols")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if symbols.is_empty() {
        return vec![line(Pane::Watch, format!("{verb}  (empty)"))];
    }
    let names: Vec<String> = symbols
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    vec![line(Pane::Watch, names.join(" "))]
}

fn render_ask(p: &Value) -> Vec<ViewLine> {
    let answer = p.get("answer").and_then(Value::as_str).unwrap_or("(no answer)");
    vec![line(Pane::Oracle, answer.to_string())]
}

fn render_news(p: &Value) -> Vec<ViewLine> {
    let scope = p.get("scope").and_then(Value::as_str).unwrap_or("GLOBAL");
    let mut out = vec![line(Pane::News, format!("NEWS {scope}"))];
    let headlines = p
        .pointer("/data/headlines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for h in headlines.iter().take(10) {
        let title = h.get("title").and_then(Value::as_str).unwrap_or("(untitled)");
        out.push(line(Pane::News, format!("• {title}")));
    }
    out
}

fn render_macro(p: &Value) -> Vec<ViewLine> {
    let mut out = vec![line(Pane::Macro, "MACRO".to_string())];
    let rows = p.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
    for r in rows.iter().take(20) {
        let name = r.get("name").and_then(Value::as_str).unwrap_or("?");
        let value = r
            .get("value")
            .map(value_to_compact_string)
            .unwrap_or_default();
        out.push(line(Pane::Macro, format!("{name} = {value}")));
    }
    out
}

fn render_yields(p: &Value) -> Vec<ViewLine> {
    let mut out = vec![line(Pane::Yields, "YIELDS".to_string())];
    let curve = p.get("curve").and_then(Value::as_array).cloned().unwrap_or_default();
    for r in curve.iter().take(20) {
        let tenor = r.get("tenor").and_then(Value::as_str).unwrap_or("?");
        let yld = r.get("yield_pct").and_then(Value::as_f64).unwrap_or(0.0);
        out.push(line(Pane::Yields, format!("{tenor} = {yld:.2}%")));
    }
    out
}

fn render_fx(p: &Value) -> Vec<ViewLine> {
    let base = p
        .pointer("/data/base")
        .and_then(Value::as_str)
        .unwrap_or("USD");
    let mut out = vec![line(Pane::Fx, format!("FX base={base}"))];
    let rates = p
        .pointer("/data/rates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in rates.iter().take(20) {
        let pair = r.get("pair").and_then(Value::as_str).unwrap_or("?");
        let rate = r.get("rate").and_then(Value::as_f64).unwrap_or(0.0);
        let chg = r.get("change_pct").and_then(Value::as_f64).unwrap_or(0.0);
        out.push(line(Pane::Fx, format!("{pair} = {rate:.4} ({chg:+.2}%)")));
    }
    out
}

fn render_options(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Options, format!("OPTIONS {sym}"))];
    let rows = p
        .pointer("/chain/rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in rows.iter().take(10) {
        let strike = r.get("strike").and_then(Value::as_f64).unwrap_or(0.0);
        let iv = r.get("iv").and_then(Value::as_f64).unwrap_or(0.0);
        let oi = r.get("oi").and_then(Value::as_i64).unwrap_or(0);
        let kind = r.get("type").and_then(Value::as_str).unwrap_or("?");
        out.push(line(
            Pane::Options,
            format!("{kind} K={strike:.2}  IV={iv:.2}  OI={oi}"),
        ));
    }
    out
}

fn render_insider(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Insider, format!("INSIDER {sym}"))];
    let trades = p
        .pointer("/data/trades")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for t in trades.iter().take(10) {
        let name = t.get("name").and_then(Value::as_str).unwrap_or("?");
        let role = t.get("role").and_then(Value::as_str).unwrap_or("?");
        let shares = t.get("shares").and_then(Value::as_i64).unwrap_or(0);
        out.push(line(
            Pane::Insider,
            format!("{name} ({role})  shares={shares}"),
        ));
    }
    out
}

fn render_financials(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Financials, format!("FINANCIALS {sym}"))];
    if let Some(rev) = p.pointer("/data/income_ttm/revenue").and_then(Value::as_f64) {
        out.push(line(Pane::Financials, format!("revenue (ttm)  {rev:.0}")));
    }
    if let Some(ni) = p.pointer("/data/income_ttm/net_income").and_then(Value::as_f64) {
        out.push(line(Pane::Financials, format!("net income (ttm)  {ni:.0}")));
    }
    if let Some(a) = p
        .pointer("/data/balance_mrq/total_assets")
        .and_then(Value::as_f64)
    {
        out.push(line(Pane::Financials, format!("total assets (mrq)  {a:.0}")));
    }
    if let Some(fcf) = p
        .pointer("/data/cashflow_ttm/free_cashflow")
        .and_then(Value::as_f64)
    {
        out.push(line(Pane::Financials, format!("free cashflow (ttm)  {fcf:.0}")));
    }
    out
}

fn render_crypto(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let last = p.pointer("/data/last").and_then(Value::as_f64).unwrap_or(0.0);
    let vol = p.pointer("/data/vol_24h").and_then(Value::as_f64).unwrap_or(0.0);
    let cap = p.pointer("/data/market_cap").and_then(Value::as_f64).unwrap_or(0.0);
    vec![
        line(Pane::Crypto, format!("CRYPTO {sym}")),
        line(
            Pane::Crypto,
            format!("last={last:.2}  vol24h={vol:.0}  cap={cap:.0}"),
        ),
    ]
}

fn render_risk(p: &Value) -> Vec<ViewLine> {
    let mut out = vec![line(Pane::Risk, "RISK".to_string())];
    let rows = p
        .pointer("/data/rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in rows.iter().take(20) {
        let sym = r.get("symbol").and_then(Value::as_str).unwrap_or("?");
        let beta = r.get("beta").and_then(Value::as_f64).unwrap_or(0.0);
        let vol = r.get("volatility").and_then(Value::as_f64).unwrap_or(0.0);
        out.push(line(
            Pane::Risk,
            format!("{sym}  beta={beta:.2}  vol={vol:.2}"),
        ));
    }
    out
}

fn render_corpact(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Corpact, format!("CORPACT {sym}"))];
    let events = p
        .pointer("/data/events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for e in events.iter().take(10) {
        let kind = e.get("type").and_then(Value::as_str).unwrap_or("?");
        let date = e.get("date").and_then(Value::as_str).unwrap_or("?");
        let detail = e.get("detail").and_then(Value::as_str).unwrap_or("");
        out.push(line(Pane::Corpact, format!("{date}  {kind}  {detail}")));
    }
    out
}

fn render_inbox(p: &Value) -> Vec<ViewLine> {
    let mut out = vec![line(Pane::Inbox, "INBOX".to_string())];
    let messages = p
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if messages.is_empty() {
        out.push(line(Pane::Inbox, "(empty)".into()));
        return out;
    }
    for m in messages.iter().take(20) {
        let from = m.get("from").and_then(Value::as_str).unwrap_or("?");
        let body = m
            .get("body")
            .map(value_to_compact_string)
            .unwrap_or_default();
        out.push(line(Pane::Inbox, format!("{from}: {body}")));
    }
    out
}

fn render_export(p: &Value) -> Vec<ViewLine> {
    let format = p.get("format").and_then(Value::as_str).unwrap_or("?");
    let body = p.get("body").and_then(Value::as_str).unwrap_or("");
    let mut out = vec![line(Pane::Export, format!("EXPORT format={format}"))];
    for ln in body.lines().take(3) {
        out.push(line(Pane::Export, ln.to_string()));
    }
    out
}

// Tests for `render_inbound` live in `tests/inbound_rendering.rs` so this
// file stays under the 500-line cap.
