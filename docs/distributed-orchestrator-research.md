# Research Report: Distributed Agent Orchestrator for agent-factory-plugin

> Measured against opencode v1.18.34 on 2026-10-06. All numbers below come from live
> experiments against a headless `opencode serve` instance (ports 4618/4619), not from
> documentation. Server mode (TUI-vs-`serve`) was also evaluated.

**Scope:** can we turn the plugin (currently: one-shot sessions per phase, single
consensus call) into a real distributed orchestrator with live, multi-turn agent
sessions, real debate rounds, and session bootstrap/warm-up — and what of what we
already built survives?

## 1. Substrate capability matrix (measured live)

| Primitive | Verdict | Evidence |
|---|---|---|
| `POST /session/{id}/prompt_async` | ✅ instant admission, runs turn | 22–65ms → 204, turn executes |
| Concurrent sessions (same process) | ✅ true concurrency | 3 turns finished 45.6/48.6/78.7s vs ~173s serialized (**2.2×**) |
| Session reuse (multi-prompt) | ✅ | 2nd prompt answered on same session |
| `abort` | ✅ immediate | 46–200ms, transcript persists |
| SSE `GET /event` | ✅ live stream | 158 events in 12s mid-turn |
| Cross-process (server A drives server B's session) | ✅ | 204 + reply visible in both (first-touch hydration ~22s) |
| `POST /api/session/{id}/wait` | ❌ **stub** | `503 "Session wait is not available yet"` |
| `delivery: "steer"` | ❌ **accept-then-drop** | 200 + `admittedSeq`, **0/5** attempts landed in transcript or changed behavior — even on a clean mid-turn multi-round session |
| `POST /api/session/{id}/interrupt` | ⚠️ partial | 204, doesn't kill in-flight tool in 15s; session stays reusable (reuse verified) |
| Agent switch `POST /api/session/{id}/agent` | ⚠️ works, **no validation** | applies known agents; accepts `nonexistent-agent-xyz` with 204 |
| `GET /session/status` | ❌ useless | `{}` while turns run → use SSE or message polling |
| v1 `POST /session/{id}/prompt` | ⚠️ admission, not reply-wait | 200 in ~30ms; blocking read = `POST /session/{id}/message` |
| Raw model latency (mimo free) | ⚠️ slow, budget-critical | trivial turn 45–90s; clean 6-step bash turn **123s / 14 messages (~20s per round)** |

**Server-mode verdict:** capability is identical (the TUI embeds the same HTTP
server — that's how our injected SDK client works today), but server mode is the
right *deployment*: a `opencode serve` daemon can hold a warm pool for days, be
driven by any client (plugin in your TUI, CI, scheduler), and cross-process driving
is proven. Design: pool hosted in daemon, orchestrator reaches it over a configured
URL.

## 2. Poison finding: session identity contamination

- `default_agent: dynamic-orchestrator` applies to **every** session without an
  explicit agent → the model immediately calls `orchestrate` (its prompt commands it).
- A **project-level `default_agent` override is ignored** (still reported global).
- Agent-level `tools: {orchestrate: false}` and `permission: deny` were **not
  enforced** (global `permission: "allow"` appears to win) — sessions called
  orchestrate anyway.
- Only the E2E-proven mechanism worked: pass `agent` + `tools` overrides **on the
  prompt body** (child sessions never recursed).

**Design implication:** pool worker sessions must get `agent`/`tools` on *every*
prompt, plus a plugin-side guard in the `orchestrate` tool itself (early-return if
invoked from a pool-marked session) as belt-and-braces.

## 3. Framework & protocol research (what to borrow)

- **AutoGen/AG2**: debate = fixed `max_round` + termination condition + per-agent
  reply caps; sparse-topology solvers + aggregator doing majority vote. Warning
  repeated everywhere: unbounded conversation loops = runaway cost.
  → *steal: `maxRounds` + early-stop + majority-vote join as hard config.*
- **CrewAI**: ordered role pipeline, fast, but no checkpointing/horizontal scale.
  → *steal: keep our existing DAG/phase structure (we're closer to this and it works).*
- **LangGraph**: explicit state graph, checkpointer, external checkpointer ⇒
  multi-worker. → *steal: round state must be serializable/persisted so a crash
  resumes at round k, not 0.*
- **A2A v1.0 (Linux Foundation)**: tasks are async; ops return immediately; updates
  via **polling, SSE streaming, or webhook push**; agents accept additional messages
  on non-terminal tasks (multi-turn is first-class).
  → *maps 1:1 onto our prompt_async + SSE/poll join model; an A2A-shaped task API is
  a viable optional external facade.*
- **ACP (Agent Client Protocol) v2 draft (Jul 2026)**: formalizes exactly what
  opencode only half-ships — prompt = acknowledgment not end-of-turn, free-running
  session updates, explicit **idle** signaling, queue/steer semantics.
  → *steal: join logic should target an "idle" concept (SSE idle event or
  last-message-settled heuristic), not the broken `wait`/`steer`.*

## 4. Audit: what we keep vs. replace

**Keep (shipped, tested, valuable):** `normalizeAgentSpecs`/`maxAgents`, DAG
execution, file ownership + review loop (`runReviewLoop`), plan fallback
(`soloAgentSpec`), OTel bridge + phase metrics, `withPhase` hard deadlines, bounded
cleanup, non-recoverable budget/timeout outputs, `abortableDelay`, full test suite
(162) + E2E harness, stats tooling.

**Replace:**

| Today | Target |
|---|---|
| `promptSession`/`createChildSession`: create → prompt once → drop | **`SessionPool`**: one persistent session per agent spec, reused across all rounds/phases |
| `runPhase4Consensus`: one `consensus-manager` call (rounds are faked) | **Real rounds**: round *r* = broadcast prompt (with accumulated transcript) to N pool sessions concurrently → join → check convergence → next round (capped) |
| No bootstrap | **Bootstrap phase**: after plan, create pool in parallel (+ optional warm-up turn) with telemetry |
| Sessions die per phase | Pool GC: abort + reuse across analyze→execute→review→synthesize |

## 5. Target flow (real rounds)

```
plan ──► bootstrap(pool: N sessions, parallel create, agent+tools per prompt)
   └──► round 1: prompt_async all N (debate msg) ──► join (SSE / poll @500ms→3s backoff)
   └──► round r: prompt_async all N (round-r msg incl. peers' last replies) ──► join
   └──► stop: convergence/majority OR r == maxRounds OR round budget hit
   └──► synthesize(final transcript) ──► review loop (pool reused for fixes) ──► GC
```

Per-round deadline = a slice of `phaseTimeoutMs`; join uses SSE when available,
poll fallback (never `wait`). Cross-process mode optional from day one
(config `serverURL`).

## 6. Latency budget (from measurements, not guesses)

- Bootstrap (warm): ~0.1s/session create; cold project init ~15s (pay once at daemon
  start). Optional warm-up turn: 45–90s once, amortized.
- Round cost ≈ slowest participant's turn: **45–120s** on the current free model
  (≈20s/round for tool-heavy turns).
- 3-round debate w/ 3 agents ≈ **2.5–6 min**, bounded by `maxRounds` ×
  `roundTimeoutMs` — vs today's reality: debate strategy **0/13 success** in 65
  recorded runs (only fast-path/single ever succeeded, 10 runs, avg 29.8s).

## 7. Migration plan

- **P0 — SessionPool + `promptRound()`** behind `enableSessionPool` flag;
  mock-client unit tests assert reuse; E2E fast path unchanged ±10%.
  *Acceptance: full test suite + E2E green.*
- **P1 — Bootstrap phase** after plan: parallel create + `bootstrap` telemetry
  metric; per-prompt `agent`/`tools` enforced + orchestrate tool guard.
  *Acceptance: bootstrap <5s warm, <20s cold.*
- **P2 — Real consensus**: rewrite `runPhase4Consensus` as N-session × R-round loop
  with `maxRounds`, early-stop, per-round timeout/budget.
  *Acceptance: E2E debate shows ≥2 distinct rounds per agent transcript; bounded
  failure, never exceeds budget.*
- **P3 — Transport/deployment**: `serverURL` external mode (cross-process), pool GC,
  SSE-first join with poll fallback. *Acceptance: orchestrate runs against daemon
  while driven from TUI.*
- **P4 — Ops**: round-level OTel metrics (existing bridge), pool health logging.
- **P5 (optional) — A2A-shaped task facade** only if cross-system delegation is ever
  needed.

## 8. Open questions

1. Is the steer/`wait` gap fixed in a newer opencode? (v1.18.34 today; poll/SSE
   design is version-proof either way.)
2. Confirm *why* per-agent `tools: false` isn't enforced (global `permission: allow`
   precedence?) — determines whether the plugin-side guard is mandatory.
3. Warm pool sizing: measured model throughput suggests 3–5 concurrent turns is sane
   on this provider; `maxAgents` already caps fan-out.
