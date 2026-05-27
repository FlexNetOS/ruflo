# ADR-136 — Research-Level Innovation: Beat-HAL via Novel Agent Architecture

**Status**: Proposed
**Date**: 2026-05-27
**Authors**: claude (post-/loop horizon-tracker, Option 3 directive)
**Related**: ADR-132 (SimulativePlanningRouter, gate −78.2%), ADR-133 (vanilla harness, iter 23 Sonnet 20.8%), ADR-134 (parity track), ADR-135 (best-harness via ruflo stack), #2156

---

## Directive

User directive on 2026-05-27: **"Option 3 — Pursue genuine research-level innovation. All of ADR-135 + some not-yet-conceived breakthrough. 3-6 weeks of focused research. 15-25% probability of beating HAL. Real risk of nothing landing."**

This ADR scopes the research-level tracks that go beyond ADR-135's engineering integration. **Implement only after ADR-135's Phase 1-2 lift Sonnet to ≥40% on L1.** If ADR-135 stalls below that floor, this ADR pauses.

---

## Calibration anchor

Measured reality as of iter 23:
- Iter 15 baseline: Sonnet 9.4% on full 53-Q L1
- Iter 23 (post-SOTA-pursuit): Sonnet 20.8% (+11.4pp from infrastructure work)
- HAL reference: Sonnet 4.5 @ 74.6% on 300-Q L1
- My projections ran 1.5-2x optimistic vs measured

Applying calibration discount: realistic compound from ADR-135 alone = +7-20pp → Sonnet 28-41%. **Beating HAL requires ADR-136 work on top of ADR-135.**

---

## Honest probability stack

| Outcome | Probability |
|---|---|
| Sonnet ≥40% (ADR-135 alone) | 60-70% |
| Sonnet ≥50% (ADR-135 + one ADR-136 track lands) | 35-50% |
| Sonnet ≥60% (ADR-135 + multiple ADR-136 tracks) | 20-35% |
| **Sonnet ≥74.6% (matches HAL)** | **15-25%** |
| Sonnet >74.6% (beats HAL) | 10-20% |
| Nothing lands above ADR-135 baseline | 30-45% |

The 30-45% "nothing lands" bucket is real. Research-grade ideas often produce 0 lift.

---

## Track K — Multi-provider model ensemble (lowest-risk research track)

### Hypothesis

Different LLM providers have systematically different failure modes on GAIA. Ensemble voting across providers captures complementary strengths.

### Implementation

1. Add provider abstraction in `gaia-agent.ts` to route the same question to multiple providers in parallel
2. Wrap existing Anthropic adapter; add OpenAI + Google Gemini adapters using their respective tool-use protocols
3. Each provider runs the full agent loop independently with the same tool catalogue
4. Majority-vote on final answers (Track A's voting logic, generalized)

### Cost projection

- Each provider per question: $0.005-0.025 depending on model
- 3 providers × 53 Q = $1-4 per full L1 run
- Total benchmark cost over development: ~$30-50

### Expected lift

+5-12pp (research literature on cross-model ensembles suggests 5-15% accuracy gain on benchmarks)

### Effort

3-5 days. Provider abstractions are the bulk; voting logic reused from Track A.

### Risk

**Low**. Engineering work primarily. Cross-provider tool-use protocol differences (Anthropic's `tool_use` blocks vs OpenAI's `function_calling` vs Gemini's `functionCall`) are well-documented.

---

## Track L — Learned routing via RL bandit (medium-risk)

### Hypothesis

The Q-Learning router (ruflo's existing 9-RL-algorithm stack) can learn which tool sequence works best for which question type, given enough labeled trajectories.

### Implementation

1. Accumulate ≥500 GAIA trajectories via Track C (SONA cross-run learning) — needs ADR-135 Track C running first
2. Train a per-question-type policy using `mcp__claude-flow__agentdb_learn-task` with Decision Transformer or Actor-Critic
3. At inference time, query the policy: "given this question embedding, what tool sequence?"
4. Compare against rule-based routing (Track G MoE)

### Data requirement

500+ labeled trajectories. At ~$0.04 per L1 question × 500 = $20-40 in trajectory generation cost alone.

### Expected lift

+3-10pp on top of MoE routing. Compounds with Track C SONA learning.

### Effort

2-3 days implementation + 1-2 weeks of trajectory accumulation

### Risk

**Medium**. Trajectory volume may be insufficient for stable learning. Could overfit to validation split.

---

## Track M — Verifier-aided RL (RLAIF for agents) ⭐ THE BIG BET

### Hypothesis

The critic agent (ADR-135 Track D) outputs a verdict per attempt. If we train an RL policy where the critic's verdict is the reward signal, the policy learns to **anticipate** critic objections and avoid them.

This is RLAIF (Reinforcement Learning from AI Feedback) applied to **agent tool use**, not chat. Published RLHF/RLAIF work focuses on chat responses; tool use is a less-explored regime.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Question                                                        │
└─────────────────────────────────┬───────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Policy (Sonnet w/ learned tool-use prompt prefix)              │
│  - Picks tool sequence + reasoning                              │
│  - Produces candidate answer + trajectory                       │
└─────────────────────────────────┬───────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Critic (Sonnet, separate)                                      │
│  - Reviews candidate + trajectory                               │
│  - Outputs verdict: pass / fail / borderline                    │
│  - Provides reasoning for the verdict                           │
└─────────────────────────────────┬───────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Reward signal generation                                        │
│  - verdict 'pass' + ground-truth match    → +1.0                │
│  - verdict 'pass' + ground-truth miss     → -0.5 (critic wrong) │
│  - verdict 'fail' + correct answer        → -0.5 (critic miss)  │
│  - verdict 'fail' + wrong answer          → +0.5 (critic right) │
│  - verdict 'borderline'                   → 0.0                 │
└─────────────────────────────────┬───────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Policy update (LoRA fine-tuning over learned prompt)            │
│  - MicroLoRA adapter (ruflo has this in RuVLLM)                 │
│  - PPO-style policy gradient (one of ruflo's 9 RL algos)        │
│  - Update happens offline, not during single-question loop      │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation

1. Generate ~200 trajectories with current policy (ADR-135 baseline)
2. Run critic on each, collect verdicts
3. Compute reward signal using ground truth + verdict
4. Train MicroLoRA adapter (RuVLLM) with PPO over the policy's tool-use prompt
5. Re-evaluate on held-out L1 subset
6. Iterate: 3-5 training rounds

### Expected lift

**+5-15pp** on Sonnet L1, possibly more. Highly uncertain because:
- RLAIF for chat is well-validated (+5-15% on instruction-following)
- RLAIF for agent tool use is mostly unpublished — possibility of nothing landing

### Effort

7-10 days

### Cost

~$50-100 in trajectory generation + critic calls + held-out validation

### Risk

**High**. This is the actual research bet. Could produce a publishable result (positive or negative). Could also produce nothing.

### Why this is the genuine research move

- Tool-use RLAIF is undercovered in the literature
- ruflo has the infrastructure for it (RuVLLM MicroLoRA, AgentDB pattern store, 9 RL algorithms) — no other public agent system has this stack assembled
- A positive result here is a paper-grade contribution
- Even a negative result tells the community something useful

---

## Track N — Test-time compute scaling (medium-risk)

### Hypothesis

OpenAI o1's central insight applied to agents: more test-time compute per question > a smarter base model. For agents, this means **beam-search over tool-call sequences** + look-ahead pruning.

### Implementation

1. At each agent turn, generate K candidate tool calls (instead of 1)
2. Use cheap value estimator (Haiku) to score each candidate's expected progress
3. Branch and bound: prune low-EV branches, expand high-EV
4. After M turns of beam search, commit to the best path

### Expected lift

+3-8pp, capped by exponentially-growing cost

### Effort

3-5 days

### Cost

5-10x normal Sonnet cost per question. Full L1 ≈ $10-20 per run.

### Risk

Medium. Beam search on agent trajectories is novel-ish (some prior work exists for code-gen agents).

---

## Track O — Tool composition learning (medium-risk)

### Hypothesis

Individual tools have ~30-50% solo success rates. Compositions of tools (e.g., `web_search → python_exec → file_read`) might be much higher for specific question patterns.

### Implementation

1. Mine SONA trajectories for tool-sequence patterns
2. Score patterns by (success_rate × usage_count)
3. At inference, retrieve top-K matching patterns; bias agent toward proven compositions

### Expected lift

+2-7pp (smaller than Track L because it's a subset of routing)

### Effort

2-3 days

---

## Track P — Adversarial training (high-risk, high-reward)

### Hypothesis

A small adversarial agent generates harder questions that the main agent fails on. Main agent learns from these adversarial examples. Distribution shifts toward harder questions over training, agent improves.

### Implementation

1. Adversarial agent: prompted to generate L1-style questions designed to trip the main agent
2. Main agent runs the adversarial questions, gets verdicts via critic
3. Successful adversaries (questions main agent failed) get higher weight in next round
4. Main agent's MicroLoRA adapter retrained on adversarial examples
5. Repeat

### Expected lift

+5-15pp if it works; -5pp if adversaries find pathological corners and the agent overfits

### Effort

10-14 days

### Cost

~$100-200 for trajectory generation across rounds

### Risk

**High**. AlphaGo Zero's pattern; less proven in language. Could spiral into useless adversaries.

---

## Track Q — Active learning + hardness prediction (low-risk)

### Hypothesis

Predict question difficulty before running it. Allocate compute (more turns, voting attempts, tool budget) per predicted difficulty.

### Implementation

1. Train hardness predictor on labeled trajectories: (question_embedding, turns_used, was_correct) → difficulty_score
2. At inference, predict difficulty
3. Easy questions: 1 attempt, Haiku, 4 max turns
4. Hard questions: 3 attempts, Sonnet, 12 max turns, critic + voting

### Expected lift

+3-5pp on overall pass rate (mostly by saving budget on easy questions to spend on hard)

### Effort

2-3 days

### Risk

Low. Hardness prediction is well-studied.

---

## Sequencing strategy

| Phase | Tracks | Why first | Expected cumulative lift |
|---|---|---|---|
| **Phase 0 — ADR-135 must land first** | A, D, J (Phase 1 of ADR-135) | Need ≥40% Sonnet baseline before research has meaningful signal | +5-15pp on top of iter 23's 20.8% |
| **Phase 1 — Research engineering (low-risk)** | K (multi-provider), Q (hardness prediction), L (learned routing) | Engineering primarily; high probability of lifting | +5-12pp |
| **Phase 2 — Genuine research bet** | M (verifier-aided RL) | The actual novel contribution | +5-15pp (high variance) |
| **Phase 3 — Research stretch** | N (beam search), O (tool composition), P (adversarial) | Higher cost, higher variance | +5-15pp combined |

Total path: 4-6 weeks if all phases land.

---

## Stop conditions

- **After Phase 1**: if Sonnet hasn't crossed 35%, pause and reassess. Tracks K-L-Q didn't land enough; Phase 2 won't either.
- **After Phase 2**: if Track M (verifier-aided RL) shows clear non-effect after 5 training rounds, abandon it. Document the negative result.
- **After Phase 3**: if Sonnet hasn't crossed 60%, beating HAL's 74.6% is no longer realistic. Pivot to "differentiated contender" framing per the strategic positioning.

---

## Cost ceiling

Total benchmark + research cost across all phases: **~$300-500**. Acceptable for a 4-6 week research push.

Budget breakdown:
- Phase 0 measurements: ~$50
- Phase 1 implementations + measurements: ~$80
- Phase 2 (Track M) trajectory gen + training + held-out: ~$150
- Phase 3 (if pursued): ~$150-200
- Buffer for re-runs after bug fixes: ~$50

---

## Honest framing for publication

### If Sonnet exceeds 74.6%

> *"ruflo's intelligence stack — verifier-aided RL on tool-use sequences, multi-provider ensemble voting, learned tool routing over accumulated trajectories, knowledge-graph multi-hop reasoning, cryptographically attestable answers — achieves [X]% on GAIA Level-1, exceeding the published Sonnet 4.5 baseline of 74.6%."*

That's the dream outcome. Publishable. **Real "best in the world" claim, backed by measurement.**

### If Sonnet lands at 40-65% (most likely)

> *"ruflo achieves [X]% on GAIA Level-1 using a novel architecture combining persistent cross-run memory, verifier-aided RL on tool selection, and multi-provider ensemble. While below the Sonnet 4.5 baseline of 74.6%, this represents the only published agent system exercising stateful learning, multi-hop graph reasoning, and cryptographic attestation. The gap analysis decomposes into [N] specific architectural questions, each independently addressable in future work."*

Honest. Differentiated. Not "best in the world by score" but **defensibly novel and measured**.

### If verifier-aided RL specifically lands

Even if overall L1 doesn't reach 74.6%, a positive Track M result is a **paper-grade contribution**:

> *"We apply Reinforcement Learning from AI Feedback (RLAIF) to agent tool-use trajectories on the GAIA benchmark, demonstrating [X]pp improvement over the base policy. To our knowledge, this is the first published application of RLAIF to multi-turn tool-using agents, distinct from chat-response RLAIF work."*

Even a negative result (Track M doesn't lift) is publishable.

---

## Decision: this ADR proposes commitment to Phase 0 (ADR-135) + Phase 1 (Tracks K, L, Q) immediately

- Phase 0: already in progress via iter 28 (Track A) and the queued bug fix
- Phase 1: greenlit; ADR-135 needs to land tracks A + D first for measurement clarity
- Phase 2 (Track M): gated on Phase 0+1 success — only proceed if Sonnet crosses 35%
- Phase 3: gated on Phase 2 success

Status moves to **Accepted** when Phase 1 lifts Sonnet ≥5pp above ADR-135's Phase 1 baseline.

---

## References

- ADR-132 (SimulativePlanningRouter — gate measured −78.2%)
- ADR-133 (vanilla GAIA harness — iter 23 measured Sonnet 20.8%)
- ADR-134 (parity track — PR #2174)
- ADR-135 (best-harness via ruflo stack — PR #2175)
- Princeton HAL GAIA leaderboard: Sonnet 4.5 @ 74.6% on full L1
- #2156 (Dream Cycle 2026-05-27 root issue)
- RLAIF original work: arXiv:2204.05862 (Anthropic, 2022) and follow-ups
- Tool-use RLAIF specifically: under-explored in literature as of 2026-05
