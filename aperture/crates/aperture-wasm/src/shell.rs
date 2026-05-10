//! Browser shell. Mounts a minimal multi-pane workspace and exposes `App`
//! to JS.
//!
//! The host (SvelteKit) is responsible for the `postMessage` relay to ruflo's
//! `message-bus.ts`. The shell only:
//!   1. parses command lines via [`aperture_core::parse`],
//!   2. produces an outbound [`Envelope`] for the host to forward,
//!   3. accepts inbound envelopes and turns them into per-pane `View` lines.
//!
//! All routing logic lives in [`crate::shell_routing`] (target-agnostic) so
//! it can be exercised by `cargo test -p aperture-wasm` without the wasm32
//! target installed.

use aperture_core::{parse, Command};
use aperture_swarm::envelope::Envelope;
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::shell_routing::{envelope_for, local_render, render_inbound, ViewLine};

/// Result of [`App::execute`] — designed for `serde_wasm_bindgen::to_value`.
#[derive(Debug, Serialize)]
struct ExecuteOk {
    ast: Command,
    /// Outbound envelope for the host to forward to the swarm bus, if any.
    /// `None` for purely-local verbs like HELP / CLS.
    outbound: Option<Envelope>,
    /// Per-pane lines to render immediately (e.g. echo, HELP body).
    views: Vec<ViewLine>,
}

#[derive(Debug, Serialize)]
struct ExecuteErr {
    err: String,
}

/// Mount the shell into a host element. Phase A keeps this minimal — the
/// SvelteKit page already lays out the panes; this entry point exists so
/// the host can call `start("aperture-mount")` to confirm the binding loaded.
#[wasm_bindgen]
pub fn start(_mount_id: &str) -> Result<(), JsValue> {
    // Phase B: real DOM mounting (ratzilla) lives here. v0.1 leaves DOM to
    // SvelteKit and this crate stays a pure logic core.
    Ok(())
}

/// Browser-side App. Holds the command-bar buffer and the focused symbol.
#[wasm_bindgen]
pub struct App {
    /// Last symbol broadcast via FOCUS, so panes can re-anchor.
    last_symbol: Option<String>,
    /// Monotonic counter for envelope ids until we add a real ULID dep.
    seq: u64,
}

#[wasm_bindgen]
impl App {
    #[wasm_bindgen(constructor)]
    pub fn new() -> App {
        App { last_symbol: None, seq: 0 }
    }

    /// Parse `line` and produce the host-facing result. Shape:
    /// ```ignore
    /// // success
    /// { ok: { ast, outbound: Envelope|null, views: ViewLine[] } }
    /// // failure
    /// { err: string }
    /// ```
    pub fn execute(&mut self, line: &str) -> JsValue {
        match parse(line) {
            Ok(cmd) => {
                let mut views = vec![ViewLine {
                    pane: crate::shell_routing::Pane::System,
                    text: format!("> {}", line.trim()),
                }];
                if let Some(s) = cmd.symbol.clone() {
                    self.last_symbol = Some(s);
                }
                self.seq = self.seq.wrapping_add(1);
                let outbound = envelope_for(&cmd, self.seq, self.last_symbol.as_deref());
                if let Some(local) = local_render(&cmd) {
                    views.extend(local);
                }
                let payload = ExecuteOk { ast: cmd, outbound, views };
                serde_wasm_bindgen::to_value(&serde_json::json!({ "ok": payload }))
                    .unwrap_or(JsValue::NULL)
            }
            Err(e) => {
                let payload = ExecuteErr { err: e.to_string() };
                serde_wasm_bindgen::to_value(&payload).unwrap_or(JsValue::NULL)
            }
        }
    }

    /// Accept a JSON-encoded inbound [`Envelope`] from the host and return
    /// per-pane `ViewLine`s. The host got the envelope from
    /// `message-bus.ts` over `window.postMessage`.
    pub fn handle_inbound(&mut self, envelope_json: &str) -> JsValue {
        let env: Envelope = match serde_json::from_str(envelope_json) {
            Ok(e) => e,
            Err(e) => {
                let v = vec![ViewLine {
                    pane: crate::shell_routing::Pane::System,
                    text: format!("inbound parse error: {e}"),
                }];
                return serde_wasm_bindgen::to_value(&v).unwrap_or(JsValue::NULL);
            }
        };
        let lines = render_inbound(&env);
        serde_wasm_bindgen::to_value(&lines).unwrap_or(JsValue::NULL)
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

// Silence unused-import warnings on the `keymap_web` / fetch_bridge glue;
// those are exercised through `App` once Phase B wires real DOM events.
#[allow(unused_imports)]
use crate::{fetch_bridge, keymap_web};
