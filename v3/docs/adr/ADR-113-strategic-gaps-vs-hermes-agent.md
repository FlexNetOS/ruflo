# ADR-113 — Strategic capability gaps vs. Nous Research Hermes Agent: prioritize skill synthesis, open-skill interop, messaging gateway; federate rather than compete

**Status**: Proposed (2026-05-11)
**Date**: 2026-05-11
**Authors**: claude (drafted with rUv)
**Related**: tracking issue [#1907](https://github.com/ruvnet/ruflo/issues/1907), gap analysis gist [`8ed2d40`](https://gist.github.com/ruvnet/8ed2d402cc98949cd54a1471113cfa94), [#1669](https://github.com/ruvnet/ruflo/issues/1669) (federation), ADR-098 (plugin capability sync), ADR-099 (recursive research), ADR-112 (MCP tool discoverability)
**Supersedes**: nothing

## Context

[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) ("the agent that grows with you") shipped publicly as a self-contained, self-improving personal agent: it owns its own agent loop (`AIAgent`/`run_agent.py`), runs on a $5 VPS or serverless backends (Modal/Daytona/Vercel Sandbox) with idle hibernation, lives on 20+ messaging platforms (Telegram, Discord, Slack, WhatsApp, Signal, email, SMS) from one gateway, and — its headline feature — runs a **closed learning loop that autonomously writes and refines its own Markdown skill files** against the open `agentskills.io` standard, plus a companion repo (`hermes-agent-self-evolution`, DSPy + GEPA) that optimizes skills/prompts/own-code against benchmarks. Python-first, single MIT repo.

A bidirectional gap analysis was completed (published as the gist above). It found Ruflo and Hermes occupy adjacent-but-distinct niches — *personal self-improving agent* vs. *multi-agent orchestration/governance layer for Claude Code* — but Hermes has eleven capabilities Ruflo lacks or under-delivers:

| ID | Gap | Severity | Notes |
|---|---|---|---|
| **R-1** | No standalone agent runtime — Ruflo cannot operate without Claude Code (`ruvLLM` + web UI only partially close this) | High | Caps the addressable market to Claude Code users |
| **R-2** | No messaging-platform gateway (Telegram/Discord/Slack/WhatsApp/Signal/email/SMS) | High | Hermes meets users where they already chat |
| **R-3** | No autonomous skill *synthesis* loop — Ruflo learns neural patterns (SONA/ReasoningBank) and ships ~30 hand-built skills, but doesn't emit new human-readable, shareable **skill files** from successful trajectories | **High — highest leverage** | Hermes's most-cited differentiator; Ruflo is ~80% there infrastructurally (RETRIEVE→JUDGE→DISTILL→CONSOLIDATE already exists) |
| **R-4** | No open skill-standard interop — Hermes skills are `agentskills.io`-compatible & community-shareable via the Skills Hub; Ruflo has its own IPFS plugin registry (a walled garden vs. an open standard) | Medium-High | Low effort to add an importer/exporter |
| **R-5** | No dialectic user model — Hermes's Honcho integration builds a deepening "who you are" model across sessions; Ruflo has `user`/`feedback` memory types but no dedicated user-modeling layer | Medium | Matters for personal-assistant stickiness |
| **R-6** | No serverless / hibernating deployment — Hermes runs on Modal/Daytona/Vercel-Sandbox; Ruflo's `daemon` + workers assume a persistent host | Medium | Needs a backend-abstraction layer Ruflo doesn't have |
| **R-7** | No RL-trajectory export / fine-tuning pipeline — Hermes ships Atropos RL envs, batch trajectory generation, trajectory compression for training tool-calling models; Ruflo records trajectories but only feeds SONA | Medium | Easy adjacency — the trajectory data already exists |
| **R-8** | No self-evolution / prompt-program optimization (DSPy + GEPA) — Ruflo's "learning" is pattern retrieval + LoRA, not closed-loop optimization against benchmarks | Medium | Research-flavored, high ceiling |
| R-9 | No ACP editor-protocol surface (Zed, VS Code) — partly moot since Claude Code *is* an editor integration | Low-Medium | |
| R-10 | Natural-language scheduling is less direct than Hermes's "set a daily 9am report" NL cron | Low | UX/affordance gap |
| R-11 | No predecessor-migration tooling for *other* frameworks' state (Hermes has `hermes claw migrate` for OpenClaw) | Low | Cheap goodwill/onboarding win |

Conversely, Hermes lacks Ruflo's swarm orchestration + consensus, zero-trust federation, HNSW vector memory, cost-aware tiered routing, enterprise security stack, GOAP planner, and SDLC tooling — so this is not a "Ruflo is behind" situation. It is a "what should Ruflo borrow, and how should it position" situation.

## Decision

1. **Position: federate Hermes-class agents, do not clone Hermes.** Ruflo's center of gravity stays *multi-agent orchestration + zero-trust federation + governance*. We treat a Hermes (or any self-contained personal agent) as a candidate **federation peer** — trust-scored, PII-gated, auditable via the existing federation protocol (#1669). Ruflo's tagline guidance becomes *"the secure nervous system for fleets of agents — across machines, teams, and trust boundaries"*; single-agent learning is table stakes, not the headline.

2. **Prioritize four gaps for near-term work** (the high-leverage, low-to-medium-effort ones):
   - **R-3 — autonomous skill synthesis (P1).** Extend the DISTILL phase to optionally emit a versioned, human-readable skill file (not just an internal neural pattern) from a successful trajectory, surfaced for review/sharing. Owner: intelligence + skill-builder area.
   - **R-4 — `agentskills.io` interop (P1, small).** Ship an importer/exporter so Ruflo can consume Hermes/community skills and publish its own to the Skills Hub. Complements (does not replace) the IPFS plugin registry.
   - **R-2 — messaging-gateway plugin (P2).** A `ruflo-gateway` plugin (Telegram/Discord/Slack first) bridging a chat thread to a Ruflo swarm. The chat is just another front-end onto the swarm — does not require owning the agent loop.
   - **R-5 — dialectic user-model layer (P2, small).** Bolt a Honcho-style user model onto the existing Claude-memory↔AgentDB bridge.

3. **Track but defer R-1, R-6, R-7, R-8, R-9, R-10, R-11.** R-7 (trajectory export) is an easy adjacency to pull forward if research-audience demand appears. R-1 / R-6 (standalone runtime, serverless backends) are a meaningful architecture investment and stay deferred until the position in (1) is validated. The rest are low-severity; they live on the tracking issue.

4. **Build on existing Ruflo-ecosystem packages, not from scratch.** The missing capabilities map onto packages we already own/ship — closing the gaps is integration work, not greenfield:
   - **`agentic-flow` (npm)** — the ONNX agent runtime + Agent Booster layer Ruflo already depends on. It is the path for **R-1 (standalone agent runtime)** — agentic-flow can drive an agent loop without Claude Code — and the substrate for **R-6 (serverless/hibernating deploy)** and **R-8 (closed-loop prompt/program optimization)**.
   - **`agentdb` (`npx agentdb`)** — the vector/graph store + RL backend. It is the home for **R-5 (dialectic user model)** as a user-modeling memory tier, **R-3 (skill synthesis)** as where emitted skill artifacts are stored/versioned/searched, and **R-7 (trajectory export)** — trajectories already live in AgentDB, so export is a read path, not new capture.
   - **`ruvector` (npm)** — HNSW + Graph RAG + SONA/brain + RVF cognitive containers + GNN/attention + hooks routing. It is the engine for the **R-3 DISTILL→skill-file** pipeline (SONA distillation already produces the pattern; ruvector emits the artifact) and backs the **R-8** self-evolution loop.
   - **R-4 (`agentskills.io` interop)** and **R-2 (`ruflo-gateway`)** are net-new but thin: R-4 is a format adapter over `agentdb`-stored skills; R-2 is a plugin shell over the existing swarm + comms layer. No new core engine for either.

5. **No scope creep into ADR-112's lane.** Tool-description discoverability is its own ADR; nothing here changes that.

## Implementation plan

This ADR records the decision and priorities; each prioritized gap gets its own ADR + PR when picked up.

- **Phase 0 (this PR):** land this ADR + open the tracking issue (this issue is the canonical backlog for R-1…R-11). Register in AgentDB at `adr/ADR-113`.
- **Phase 1:** R-3 design ADR — skill-file emission from the `ruvector` DISTILL stage, artifacts stored via `agentdb`; plus R-4 importer/exporter PR (`agentskills.io` ↔ `agentdb`-stored skills).
- **Phase 2:** R-2 `ruflo-gateway` plugin scaffold (shell over existing swarm/comms) + R-5 user-model layer (`agentdb` user-modeling tier on the Claude-memory bridge).
- **Phase 3+:** revisit deferred gaps against the position validation in Decision (1) — R-1/R-6/R-8 land on `agentic-flow`; R-7 is a read-path export from `agentdb`.

No code changes ship in Phase 0 — this is a direction-setting ADR, like ADR-095 and ADR-112.

## Validation

This ADR closes (moves to Accepted) when:
- The tracking issue ([#1907](https://github.com/ruvnet/ruflo/issues/1907)) exists and enumerates R-1…R-11 with the priorities above. ✅
- This file is committed under `v3/docs/adr/` and registered in AgentDB.
- A Phase-1 ADR (R-3) is opened — i.e., the priority list has produced its first concrete follow-up.

## Notes

- Evidence quality, per the gist: Hermes facts are from its public README, docs site, and DeepWiki — the repo was not cloned, so module names and tool/skill counts (~40 vs. ~70 reported in different places) are approximate. Ruflo's own perf numbers ("150×–12,500×", "89% routing accuracy", "75% cost reduction") are vendor-stated, not independently verified here.
- Calling Hermes a "competitor" overstates it; the gap tables are most useful read as *"what could each borrow from the other,"* not *"who wins."* Decision (1) is the operative conclusion.
- This is a point-in-time snapshot (2026-05-11). Both projects move fast.

## References

- Gap-analysis gist — [gist.github.com/ruvnet/8ed2d402cc98949cd54a1471113cfa94](https://gist.github.com/ruvnet/8ed2d402cc98949cd54a1471113cfa94)
- [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) · [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/) · [deepwiki.com/NousResearch/hermes-agent](https://deepwiki.com/NousResearch/hermes-agent) · [github.com/NousResearch/hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution)
- [#1669](https://github.com/ruvnet/ruflo/issues/1669) — agent federation architecture
- ADR-098 (plugin capability sync), ADR-099 (recursive parallel research), ADR-112 (MCP tool discoverability)
- Packages to build on: [`agentic-flow`](https://www.npmjs.com/package/agentic-flow) (npm) · [`agentdb`](https://www.npmjs.com/package/agentdb) (`npx agentdb`) · [`ruvector`](https://www.npmjs.com/package/ruvector) (npm)
