# ADR-091: Deep Integration of Claude Code Native Capabilities (/loop, Monitor, Cron, Agent Teams)

**Status:** Proposed  
**Date:** 2026-04-27  
**Author:** ruflo team  
**Relates to:** ADR-020 (Headless Workers), ADR-026 (3-Tier Routing), ADR-037 (Autopilot), ADR-085 (Comprehensive Remediation)

## Context

Ruflo runs as an MCP server inside Claude Code, providing 314 tools across 26 CLI commands. However, Ruflo's current architecture was designed before Claude Code exposed several powerful native capabilities. As a result, Ruflo reimplements functionality that the host runtime already provides — often with worse ergonomics, higher overhead, and reliability gaps.

### The Impedance Mismatch

Claude Code provides these native tools that Ruflo currently duplicates or ignores:

| Claude Code Native | Ruflo Equivalent | Gap |
|---|---|---|
| `ScheduleWakeup` (/loop) | `daemon start` + setTimeout timers | Ruflo daemon uses Node.js timers in a detached process; /loop uses Claude Code's own scheduler with cache-aware pacing |
| `Monitor` | Polling loops in Bash | Ruflo instructs users to poll with `swarm status`; Monitor streams events natively |
| `CronCreate/Delete/List` | `daemon start --background` | Ruflo's daemon is a detached Node process with PID files; Cron is native to Claude Code |
| Agent tool (subagents) | `agent spawn` MCP tool | Ruflo spawns agents via MCP; Claude Code can spawn them directly with isolation, worktrees, and messaging |
| `TaskCreate/Update/List` | `task create` MCP tool | Ruflo has its own task system; Claude Code has a native shared task list |
| `SendMessage` | Memory namespace coordination | Ruflo agents coordinate via shared memory; SendMessage provides direct inter-agent messaging |
| `TeamCreate/Delete` | `swarm init` + topology | Ruflo manages swarm topology via MCP; Claude Code has native team management |
| `EnterPlanMode/ExitPlanMode` | SPARC methodology prompts | Ruflo uses long system prompts; Claude Code has structured planning mode |
| `PushNotification/RemoteTrigger` | No equivalent | Cross-session communication not available in Ruflo today |

### Why This Matters

1. **Reliability**: Ruflo's daemon process (`daemon start`) spawns a detached Node.js process that writes PID files, manages timers, and can become orphaned (#1117). Claude Code's native Cron and /loop are managed by the host runtime — no orphan processes.

2. **Ergonomics**: Teaching Claude Code to use `/loop` for periodic tasks requires one CLAUDE.md instruction. Teaching it to run `npx @claude-flow/cli daemon start --background` and then check PID files requires a multi-page protocol.

3. **Cache Efficiency**: ScheduleWakeup is cache-aware (delays <300s keep prompt cache warm). Ruflo's daemon has no awareness of the LLM cache at all.

4. **Isolation**: Claude Code's Agent tool supports `isolation: "worktree"` for safe parallel git operations. Ruflo's `agent spawn` runs in the same worktree, risking conflicts.

5. **Cost**: The 3-Tier routing system (ADR-026) routes by complexity, but doesn't leverage Agent tool's native model selection. Spawning a Haiku agent via Claude Code's Task tool costs $0.0002; spawning one via `claude -p` (headless-worker-executor.ts) requires a full process with its own context window.

### Current Architecture Problems

**Problem 1: Fake Daemon Workers**

`worker-daemon.ts` schedules workers with `setInterval` timers. The "headless" workers in `headless-worker-executor.ts` shell out to `claude -p` (Claude Code in print mode). This means:
- Each worker invocation pays full cold-start cost (~$0.01-0.05)
- Workers have no shared context (each is a fresh Claude session)
- The daemon process itself can crash/orphan without recovery
- Workers run sequentially within concurrency limits (default: 2)

**Problem 2: MCP Tool Responses Don't Teach Native Patterns**

When a user asks Ruflo to "monitor my swarm" or "run periodic security audits," the MCP tool responses tell Claude Code to use `daemon start` and `swarm status`. They never suggest `/loop` or `Monitor` — the Claude Code tools designed for exactly this purpose.

**Problem 3: CLAUDE.md Doesn't Know About /loop**

The existing CLAUDE.md instructions describe an elaborate "Auto-Start Swarm Protocol" with background Task calls and "spawn and wait" patterns. These instructions predate `/loop` and don't mention `ScheduleWakeup`, `Monitor`, `CronCreate`, or `PushNotification`.

**Problem 4: Skills Don't Leverage Agent Teams**

The 30+ skills in `.claude/skills/` use MCP tools for coordination. None use Claude Code's native `TeamCreate`, `TaskCreate`, or `SendMessage` tools.

### State of the Art (April 2026)

The AI agent orchestration landscape has converged on several patterns:

1. **Event-Driven over Polling**: Modern agent systems (CrewAI, AutoGen, LangGraph) use event loops, not timer-based polling. Claude Code's Monitor tool provides this natively.

2. **Host-Native Scheduling**: Agents should use the host runtime's scheduler rather than implementing their own. This is analogous to web apps using the browser's `requestAnimationFrame` instead of `setTimeout`.

3. **Structured Planning**: Plan-then-execute with explicit plan mode (like Claude Code's `EnterPlanMode`) produces more reliable results than inline planning.

4. **Worktree Isolation**: Git worktree-based isolation for parallel agent work is becoming standard. Claude Code supports this natively via `isolation: "worktree"`.

5. **Cache-Aware Scheduling**: LLM cache has a TTL (5 min for Anthropic). Scheduling that's aware of cache windows (keep delays <270s to stay warm, or go 1200s+ to amortize the miss) dramatically reduces costs.

6. **Cross-Session Persistence**: PushNotification + RemoteTrigger enable agents that span multiple Claude Code sessions — a form of durable execution.

7. **Capability-Based Security**: Rather than blanket permissions, agents should declare capabilities. Claude Code's `allowedTools` per-agent is an example.

## Decision

Deeply integrate Claude Code's native capabilities into Ruflo across 5 workstreams, deprecating Ruflo's reimplementations where the native equivalent is strictly superior.

### Workstream 1: /loop as the Primary Worker Scheduler

**Replace `daemon start` with `/loop`-based workers for all in-session work.**

Current flow:
```
User → npx daemon start → detached Node.js process → setInterval timers → claude -p worker
```

New flow:
```
User → /loop "Run audit worker" → ScheduleWakeup(270s) → in-context worker execution
```

#### Design

MCP tool responses should detect when a periodic task is requested and emit a `/loop` suggestion:

```
[LOOP_SUGGESTION] This task would benefit from /loop for periodic execution.
Recommended: /loop "npx @claude-flow/cli hooks worker dispatch --trigger audit"
Interval: 270s (stays within cache window)
```

The `hooks worker dispatch` MCP tool should return `ScheduleWakeup`-compatible metadata:

```json
{
  "success": true,
  "workerType": "audit",
  "suggestedDelay": 270,
  "reason": "security audit completed, schedule next in 270s to stay in cache window",
  "loopPrompt": "Run audit worker and check results"
}
```

#### Worker Migration

| Worker | Current | New (In-Session) | New (Background) |
|--------|---------|-------------------|-------------------|
| map | setInterval 15min | /loop 270s (during active dev) | CronCreate 30min |
| audit | setInterval 10min | /loop 270s | CronCreate 15min |
| optimize | setInterval 15min | /loop 270s | CronCreate 30min |
| consolidate | setInterval 30min | N/A (low priority) | CronCreate 60min |
| testgaps | setInterval 20min | /loop 270s | CronCreate 30min |
| predict | setInterval 10min | /loop 120s | CronCreate 10min |
| document | setInterval 60min | N/A | CronCreate 120min |

Key insight: **In-session workers use /loop with cache-aware delays. Background workers use CronCreate for fire-and-forget.**

#### Daemon Deprecation Path

1. Phase 1: Add `/loop` support alongside daemon (both work)
2. Phase 2: CLAUDE.md recommends `/loop` for in-session, CronCreate for background
3. Phase 3: Deprecate `daemon start` for in-session use (keep for CI/headless environments)
4. Phase 4: Remove daemon's setInterval loop; make it a thin wrapper around CronCreate

### Workstream 2: Monitor for Event-Driven Swarm Coordination

**Replace polling-based swarm status with Monitor-based event streaming.**

Current pattern (from CLAUDE.md):
```bash
# User asks "how is my swarm doing?"
npx @claude-flow/cli swarm status  # One-shot snapshot
```

New pattern:
```
Monitor("npx @claude-flow/cli swarm watch --stream")
# Each agent completion emits a line to stdout → Monitor delivers it as a notification
```

#### Design

Add `--stream` flag to swarm-related commands that outputs newline-delimited JSON events:

```bash
npx @claude-flow/cli swarm watch --stream
# Output (one line per event):
{"event":"agent_started","agent":"coder-1","task":"implement auth","ts":"2026-04-27T10:00:00Z"}
{"event":"agent_completed","agent":"coder-1","result":"success","duration_ms":45000,"ts":"2026-04-27T10:00:45Z"}
{"event":"agent_started","agent":"tester-1","task":"write auth tests","ts":"2026-04-27T10:00:46Z"}
```

Claude Code's Monitor tool streams these events, delivering each as a notification. The LLM can then react to events (e.g., when tester completes, trigger reviewer).

#### Integration Points

| Command | Current | With --stream |
|---------|---------|---------------|
| `swarm status` | One-shot JSON | Continuous NDJSON events |
| `swarm watch` | New command | NDJSON event stream |
| `agent logs` | Static log dump | Live log streaming |
| `task list` | One-shot list | Task state change events |
| `performance benchmark` | Run + report | Progress events during run |

#### MCP Tool Updates

The `swarm_status` MCP tool response should include:

```
[MONITOR_AVAILABLE] For live updates, use Monitor tool:
Monitor("npx @claude-flow/cli swarm watch --stream")
```

### Workstream 3: CronCreate for Persistent Background Workers

**Replace the detached daemon process with CronCreate for workers that should run across sessions.**

Current flow:
```
daemon start → PID file → detached process → survives session end → can orphan
```

New flow:
```
CronCreate("audit-worker", "*/15 * * * *", "Run security audit worker") → Claude Code manages lifecycle
```

#### Design

New `daemon schedule` subcommand that creates Cron entries:

```bash
npx @claude-flow/cli daemon schedule --worker audit --interval 15m
# Internally calls CronCreate with appropriate prompt
```

The `daemon start` command detects when running inside Claude Code (stdin is piped / MCP transport) and automatically uses CronCreate instead of spawning a detached process.

#### Cron Worker Mapping

| Worker | Cron Expression | Prompt |
|--------|----------------|--------|
| audit | `*/15 * * * *` | "Run npx @claude-flow/cli hooks worker dispatch --trigger audit and report findings" |
| map | `*/30 * * * *` | "Run npx @claude-flow/cli hooks worker dispatch --trigger map" |
| optimize | `*/30 * * * *` | "Run npx @claude-flow/cli hooks worker dispatch --trigger optimize" |
| consolidate | `0 * * * *` | "Run npx @claude-flow/cli hooks worker dispatch --trigger consolidate" |
| testgaps | `*/30 * * * *` | "Run npx @claude-flow/cli hooks worker dispatch --trigger testgaps" |

#### Autonomous Loop Sentinel

For workers that need adaptive pacing (not fixed cron), use `<<autonomous-loop-dynamic>>`:

```
CronCreate → fires → ScheduleWakeup with <<autonomous-loop-dynamic>> sentinel
→ worker runs → ScheduleWakeup(delay based on results) → worker runs again → ...
```

### Workstream 4: Agent Teams Integration

**Bridge Ruflo's swarm topology with Claude Code's native Agent Teams.**

Current pattern:
```javascript
// Ruflo MCP
swarm_init({ topology: "hierarchical", maxAgents: 8 })
// Claude Code Task tool
Task({ prompt: "...", subagent_type: "coder" })
```

New pattern:
```javascript
// Ruflo MCP sets up topology
swarm_init({ topology: "hierarchical", maxAgents: 8 })
// Claude Code creates team
TeamCreate({ team_name: "feature-dev", description: "..." })
// Spawn agents with native isolation
Task({ prompt: "...", subagent_type: "coder", team_name: "feature-dev", isolation: "worktree" })
// Direct messaging
SendMessage({ recipient: "coder-1", content: "Architect design ready, proceed" })
// Shared task list
TaskCreate({ subject: "Implement auth endpoint", description: "..." })
```

#### Integration Points

| Ruflo Concept | Claude Code Native | Bridge Strategy |
|---|---|---|
| Swarm topology | TeamCreate | `swarm_init` MCP tool returns team creation suggestion |
| Agent spawn | Task tool with team | `agent_spawn` MCP tool returns Task-compatible config |
| Memory coordination | SendMessage | `hooks notify` bridges to SendMessage |
| Task tracking | TaskCreate/Update/List | `task_create` MCP tool syncs with native task list |
| Consensus | SendMessage + voting | Hive-mind consensus uses SendMessage for proposals |

#### Worktree Isolation

For agents that modify files, suggest `isolation: "worktree"`:

```
[ISOLATION_RECOMMENDED] This agent modifies files. Use worktree isolation:
Task({ ..., isolation: "worktree" })
```

This prevents the common problem where two coder agents edit the same file simultaneously.

### Workstream 5: CLAUDE.md and Skill Overhaul

**Rewrite CLAUDE.md instructions and update skills to teach Claude Code the native patterns.**

#### CLAUDE.md Changes

Add new section: "Native Capability Integration"

```markdown
## Native Claude Code Capabilities (PREFER OVER MCP)

### Periodic Tasks → /loop
When a task needs to repeat, use /loop instead of daemon start:
- /loop "Run audit worker" → repeats with self-paced ScheduleWakeup
- Cache-aware: delays <270s keep cache warm, >300s cause miss

### Live Monitoring → Monitor
When watching a process, use Monitor instead of polling:
- Monitor("npx @claude-flow/cli swarm watch --stream")
- Each event arrives as a notification — no polling needed

### Background Workers → CronCreate
For workers that should persist across sessions:
- CronCreate("audit", "*/15 * * * *", "Run audit worker")
- Managed by Claude Code — no orphan processes

### Agent Isolation → worktree
For agents that modify files in parallel:
- Task({ ..., isolation: "worktree" })
- Each agent gets its own git worktree — no conflicts

### Cross-Session → PushNotification + RemoteTrigger
For long-running tasks that span sessions:
- PushNotification to alert when done
- RemoteTrigger to resume work from another session
```

#### Skill Updates

Create/update skills:
- `worker-integration` skill: Teaches /loop + CronCreate patterns
- `swarm-orchestration` skill: Adds Monitor + TeamCreate patterns
- `hooks-automation` skill: Adds ScheduleWakeup metadata to hook responses

#### MCP Tool Response Updates

Every MCP tool response that suggests a follow-up action should include the appropriate native tool suggestion:

| Context | Suggestion |
|---------|------------|
| User asks for periodic monitoring | `[LOOP_SUGGESTION] /loop "check status"` |
| User starts long-running process | `[MONITOR_SUGGESTION] Monitor("command --stream")` |
| User asks for background workers | `[CRON_SUGGESTION] CronCreate(...)` |
| Agent needs file isolation | `[WORKTREE_SUGGESTION] isolation: "worktree"` |
| Multi-agent coordination | `[TEAM_SUGGESTION] TeamCreate + SendMessage` |
| Task spans sessions | `[NOTIFY_SUGGESTION] PushNotification when done` |

## Implementation Plan

### Phase 1: Foundation (Week 1)

| Task | Files | Description |
|------|-------|-------------|
| Add `--stream` flag to CLI commands | `commands/swarm.ts`, `commands/agent.ts`, `commands/task.ts` | NDJSON event output for Monitor compatibility |
| Update MCP tool responses | `mcp-tools/hooks-tools.ts`, `mcp-tools/swarm-tools.ts` | Add native capability suggestions |
| Add ScheduleWakeup metadata to worker dispatch | `mcp-tools/hooks-tools.ts` | Return `suggestedDelay` and `loopPrompt` fields |
| Update CLAUDE.md | `/CLAUDE.md`, `/v3/CLAUDE.md`, `/v3/@claude-flow/cli/CLAUDE.md` | Add "Native Capability Integration" section |

### Phase 2: Worker Migration (Week 2)

| Task | Files | Description |
|------|-------|-------------|
| Add `daemon schedule` subcommand | `commands/daemon.ts` | Wrapper around CronCreate |
| Detect MCP context in `daemon start` | `services/worker-daemon.ts` | Auto-use CronCreate when inside Claude Code |
| Add `/loop`-compatible worker runner | `services/loop-worker-runner.ts` (new) | Stateless worker execution for /loop |
| Update worker-integration skill | `.claude/skills/worker-integration/` | Teach /loop + CronCreate patterns |

### Phase 3: Agent Teams Bridge (Week 3)

| Task | Files | Description |
|------|-------|-------------|
| Bridge `swarm_init` to TeamCreate | `mcp-tools/swarm-tools.ts` | Suggest TeamCreate in response |
| Bridge `agent_spawn` to Task tool | `mcp-tools/agent-tools.ts` | Return Task-compatible config |
| Add worktree isolation hints | `mcp-tools/agent-tools.ts` | Suggest `isolation: "worktree"` |
| Bridge `hooks notify` to SendMessage | `mcp-tools/hooks-tools.ts` | Cross-agent messaging |
| Update swarm skills | `.claude/skills/swarm-orchestration/` | Add TeamCreate + SendMessage patterns |

### Phase 4: Event-Driven Coordination (Week 4)

| Task | Files | Description |
|------|-------|-------------|
| Implement `swarm watch --stream` | `commands/swarm.ts` | Live NDJSON event stream |
| Add Monitor suggestions to MCP | `mcp-tools/swarm-tools.ts` | `[MONITOR_AVAILABLE]` hints |
| Add PushNotification for long tasks | `mcp-tools/task-tools.ts` | `[NOTIFY_SUGGESTION]` for spanning tasks |
| Update all skills for Monitor usage | `.claude/skills/*/` | Replace polling patterns |

## File Change Matrix

| File | Workstream | Change Type | Priority |
|------|-----------|-------------|----------|
| `CLAUDE.md` (root) | 5 | Add native capabilities section | P0 |
| `v3/CLAUDE.md` | 5 | Add native capabilities section | P0 |
| `v3/@claude-flow/cli/CLAUDE.md` | 5 | Add native capabilities section | P0 |
| `mcp-tools/hooks-tools.ts` | 1, 4 | Add ScheduleWakeup metadata, SendMessage bridge | P0 |
| `mcp-tools/swarm-tools.ts` | 2, 4 | Add --stream, Monitor/TeamCreate hints | P0 |
| `mcp-tools/agent-tools.ts` | 4 | Add Task-compatible config, worktree hints | P1 |
| `mcp-tools/task-tools.ts` | 4 | Bridge to native TaskCreate, PushNotification | P1 |
| `commands/daemon.ts` | 3 | Add `schedule` subcommand, detect MCP context | P1 |
| `commands/swarm.ts` | 2 | Add `watch --stream` subcommand | P1 |
| `commands/agent.ts` | 2 | Add `--stream` to `logs` | P2 |
| `services/worker-daemon.ts` | 1, 3 | Auto-detect Claude Code runtime, use CronCreate | P1 |
| `services/loop-worker-runner.ts` | 1 | New: stateless worker for /loop execution | P1 |
| `services/headless-worker-executor.ts` | 1 | Deprecation path documentation | P2 |
| `.claude/skills/worker-integration/` | 1 | /loop + CronCreate teaching | P1 |
| `.claude/skills/swarm-orchestration/` | 2, 4 | Monitor + TeamCreate teaching | P1 |
| `.claude/skills/hooks-automation/` | 1 | ScheduleWakeup metadata | P2 |

## Consequences

### Positive

- **Reduced complexity**: Eliminate detached daemon process, PID file management, orphan recovery
- **Better reliability**: Claude Code manages worker lifecycle natively — no more #1117 orphan bugs
- **Cache efficiency**: /loop's cache-aware scheduling saves 30-50% on repeated worker runs
- **True isolation**: Worktree-based agent isolation prevents file conflicts in parallel work
- **Event-driven**: Monitor replaces polling, reducing latency and unnecessary API calls
- **Cross-session**: PushNotification enables durable agent workflows
- **Simpler CLAUDE.md**: Native patterns require fewer instructions than MCP-based protocols

### Negative

- **Claude Code dependency**: These features only work inside Claude Code; CI/headless environments still need the daemon
- **Migration effort**: Existing skills and CLAUDE.md need significant updates
- **Two code paths**: During transition, both native and MCP patterns must work
- **Testing complexity**: Native Claude Code tools can't be unit tested the same way as MCP tools

### Risks

| Risk | Mitigation |
|------|------------|
| /loop API changes | Abstract behind Ruflo's worker interface; swap implementation |
| CronCreate limitations | Keep daemon as fallback for complex scheduling |
| Monitor stdout parsing | Use structured NDJSON format; validate with JSON.parse |
| Agent Teams API instability | Feature-flag Team integration; fall back to MCP-only |

## Metrics

| Metric | Before | Target | How to Measure |
|--------|--------|--------|----------------|
| Worker cold-start cost | ~$0.01-0.05/run | $0 (in-context) | Cost per /loop iteration |
| Orphan daemon processes | ~5% of sessions | 0% | Track PID file staleness |
| Swarm status latency | 2-5s (poll + MCP) | <100ms (Monitor event) | Time from event to notification |
| Worker scheduling accuracy | +/- 30s (timer drift) | +/- 1s (ScheduleWakeup) | Actual vs scheduled execution time |
| Agent file conflicts | ~10% of parallel runs | 0% (worktree) | Git conflict rate in multi-agent work |
| CLAUDE.md instruction size | ~800 lines | ~500 lines | Line count of orchestration instructions |

## References

- Claude Code documentation: ScheduleWakeup, Monitor, CronCreate, Agent Teams
- ADR-020: Headless Worker Integration Architecture
- ADR-026: 3-Tier Model Routing
- Issue #1117: Daemon orphan process on timeout
- ICLR 2025: Event-driven agent architectures
- CrewAI, AutoGen, LangGraph: Modern agent orchestration frameworks
