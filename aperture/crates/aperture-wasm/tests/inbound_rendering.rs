//! Integration tests for `render_inbound` covering every Wave-1 pane.
//!
//! Lives outside the crate root so `shell_renderers.rs` stays under the
//! 500-line cap.

use aperture_swarm::envelope::{Envelope, MessageType, Priority};
use aperture_wasm::{render_inbound, Pane};
use serde_json::{json, Value};

fn inbound(verb: &str, payload: Value, from: &str) -> Envelope {
    let mut p = payload;
    if let Some(map) = p.as_object_mut() {
        map.insert("verb".into(), json!(verb));
    } else {
        p = json!({"verb": verb});
    }
    Envelope {
        id: "test".into(),
        message_type: MessageType::Direct,
        from: from.into(),
        to: "aperture:cmdbar".into(),
        payload: p,
        timestamp: "2026-05-10T00:00:00.000Z".into(),
        priority: Priority::Normal,
        requires_ack: false,
        ttl_ms: 5000,
        correlation_id: None,
    }
}

#[test]
fn news_result_renders_headlines_in_news_pane() {
    let env = inbound(
        "NEWS.RESULT",
        json!({
            "scope": "AAPL",
            "data": {"headlines": [{"title": "Apple beats earnings"}]},
        }),
        "aperture:pane.news",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::News));
    assert!(lines.iter().any(|l| l.text.contains("Apple beats earnings")));
}

#[test]
fn yields_result_renders_curve_in_yields_pane() {
    let env = inbound(
        "YIELDS.RESULT",
        json!({"curve": [{"tenor": "10Y", "yield_pct": 4.25}]}),
        "aperture:pane.yields",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Yields));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("10Y") && l.text.contains("4.25")));
}

#[test]
fn fx_result_renders_pairs_in_fx_pane() {
    let env = inbound(
        "FX.RESULT",
        json!({"data": {"base": "USD", "rates": [{"pair": "EUR", "rate": 1.0823, "change_pct": 0.12}]}}),
        "aperture:pane.fx",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Fx));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("EUR") && l.text.contains("1.0823")));
}

#[test]
fn export_result_truncates_body_to_three_lines() {
    let env = inbound(
        "EXPORT.RESULT",
        json!({
            "format": "csv",
            "body": "a,b\n1,2\n3,4\n5,6\n7,8",
        }),
        "aperture:pane.export",
    );
    let lines = render_inbound(&env);
    // Header + 3 body lines == 4 total.
    assert_eq!(lines.iter().filter(|l| l.pane == Pane::Export).count(), 4);
}

#[test]
fn inbox_result_renders_messages_in_inbox_pane() {
    let env = inbound(
        "INBOX.RESULT",
        json!({"messages": [{"from": "aperture:cmdbar", "body": "ping", "ts": "now"}]}),
        "aperture:pane.inbox",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Inbox));
    assert!(lines.iter().any(|l| l.text.contains("ping")));
}

#[test]
fn risk_result_renders_rows_in_risk_pane() {
    let env = inbound(
        "RISK.RESULT",
        json!({"data": {"rows": [{"symbol": "AAPL", "beta": 1.2, "volatility": 0.3}]}}),
        "aperture:pane.risk",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Risk));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("AAPL") && l.text.contains("1.20")));
}

#[test]
fn options_result_renders_chain_in_options_pane() {
    let env = inbound(
        "OPTIONS.RESULT",
        json!({"symbol": "AAPL", "chain": {"rows": [{"type": "C", "strike": 200.0, "iv": 0.35, "oi": 1234}]}}),
        "aperture:pane.options",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Options));
    assert!(lines.iter().any(|l| l.text.contains("K=200.00")));
}

#[test]
fn financials_result_renders_three_statements() {
    let env = inbound(
        "FINANCIALS.RESULT",
        json!({"symbol": "AAPL", "data": {
            "income_ttm": {"revenue": 400_000.0, "net_income": 100_000.0},
            "balance_mrq": {"total_assets": 350_000.0},
            "cashflow_ttm": {"free_cashflow": 90_000.0},
        }}),
        "aperture:pane.financials",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.text.contains("revenue")));
    assert!(lines.iter().any(|l| l.text.contains("total assets")));
    assert!(lines.iter().any(|l| l.text.contains("free cashflow")));
}

#[test]
fn crypto_result_renders_in_crypto_pane() {
    let env = inbound(
        "CRYPTO.RESULT",
        json!({"symbol": "BTC", "data": {"last": 50000.0, "vol_24h": 1e9, "market_cap": 1e12}}),
        "aperture:pane.crypto",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Crypto));
    assert!(lines.iter().any(|l| l.text.contains("last=50000.00")));
}

#[test]
fn corpact_result_renders_events_in_corpact_pane() {
    let env = inbound(
        "CORPACT.RESULT",
        json!({"symbol": "AAPL", "data": {"events": [{"type": "split", "date": "2026-01-15", "detail": "4-for-1"}]}}),
        "aperture:pane.corpact",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Corpact));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("split") && l.text.contains("4-for-1")));
}

#[test]
fn macro_result_renders_in_macro_pane() {
    let env = inbound(
        "MACRO.RESULT",
        json!({"rows": [{"name": "CPI", "value": "3.1%"}, {"name": "GDP", "value": "2.5%"}]}),
        "aperture:pane.macro",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Macro));
    assert!(lines.iter().any(|l| l.text.contains("CPI = 3.1%")));
}

#[test]
fn insider_result_renders_in_insider_pane() {
    let env = inbound(
        "INSIDER.RESULT",
        json!({"symbol": "AAPL", "data": {"trades": [{"name": "Tim", "role": "CEO", "shares": 100}]}}),
        "aperture:pane.insider",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Insider));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("Tim") && l.text.contains("CEO")));
}

#[test]
fn error_payload_renders_in_target_pane() {
    let env = inbound(
        "MACRO.RESULT",
        json!({"error": "upstream down"}),
        "aperture:pane.macro",
    );
    let lines = render_inbound(&env);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].pane, Pane::Macro);
    assert!(lines[0].text.contains("upstream down"));
}

#[test]
fn unknown_verb_falls_back_to_address_pane() {
    let env = inbound("MYSTERY", json!({}), "aperture:pane.options");
    let lines = render_inbound(&env);
    assert_eq!(lines[0].pane, Pane::Options);
}

#[test]
fn agent_data_address_falls_back_to_chart_pane() {
    let env = inbound("OHLCV", json!({}), "aperture:agent.data");
    let lines = render_inbound(&env);
    assert_eq!(lines[0].pane, Pane::Chart);
}
