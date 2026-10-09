# opencode-agent-factory-plugin

Dynamic multi-agent orchestration for [OpenCode](https://opencode.ai). Analyzes prompts, generates specialized agents at runtime, executes them in parallel with dependency resolution, and synthesizes results using consensus protocols.

Inspired by [SpawnVerse](https://github.com/sajosam/spawnverse) (runtime agent generation), [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (parallel team mode), and [SIM-ONE](https://github.com/dansasser/SIM-ONE) (governed cognition).

## Quick Start

```bash
# Install
npm install opencode-agent-factory-plugin
# or
bun add opencode-agent-factory-plugin
```

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agent-factory-plugin"]
}
```

Restart OpenCode. Use the `/orchestrate` command:

```
/orchestrate Design a REST API for a todo app with authentication
```

Or call the `orchestrate` tool directly from any agent:

```
Use the orchestrate tool to: Design a REST API for a todo app with authentication
```

## How It Works

The plugin runs a 5-phase pipeline using OpenCode's SDK to spawn real child sessions:

```
User Prompt
    |
    v
[1. ANALYZE]  -- agent-factory analyzes task, outputs structured task analysis JSON
    |
    v
[2. PLAN]     -- agent-factory generates agent specifications (roles, prompts, tools, deps)
    |
    v
[3. EXECUTE]  -- native DAG scheduler runs agents in parallel waves via SDK sessions,
    |             injecting dependency outputs from the previous wave
    v
[4. CONSENSUS]-- consensus-manager unifies outputs via selected strategy
    |
    v
[5. SYNTHESIZE]-- dynamic-orchestrator compiles final response
    |
    v
Final Result + Execution Summary
```

Tasks marked `single`, or auto-detected prompts shorter than `fastPathThresholdChars`, take a fast path that skips analysis and consensus: agents are generated, run through the same DAG scheduler, and synthesized.

Spec output that is close-but-not-quite (unknown model tier, wrapper objects instead of a bare array, prose instead of JSON) is repaired or retried rather than failing the whole run, so a single sloppy model response does not abort the orchestration. If the planner still fails, the run falls back to a trimmed brief and then to a single locally-built agent instead of returning a hard error.

**File-producing work (coding, writing, creative).** Agents can declare an `outputs` list (paths or globs they may write). Agents with overlapping `outputs` are automatically serialized into dependency order, and each agent gets an explicit "you alone own these files" instruction — so work runs *in parallel* when files are disjoint and never *concurrently* on the same file.

**Validation loop.** After execution a reviewer agent grades the deliverables like a teammate's review pass: flagged agents get a fix round carrying their previous output and the issues, then it re-reviews — up to `maxReviewRounds` times. Unresolved issues are handed to synthesis so they are called out in the final answer. Disable with `enableReviewLoop: false`.

### What Makes This Different From Built-in Sub-Agents

| Feature | Built-in `task` tool | Agent Factory Plugin |
|---------|---------------------|---------------------|
| Decomposition | Model improvises: one prompt in, one message out | Fixed 5-phase pipeline: analyze → plan → execute → consensus → synthesize |
| Agent roles | Pre-defined, fixed agents | Generated per task at runtime (role, goal, tools, model tier) |
| Parallel execution | Model issues several calls by hand | Automatic DAG scheduling with dependency-ordered groups |
| Dependencies | Manual tracking | Automatic injection between groups |
| Retries & time budgets | None — a stalled call stalls the turn | Per-phase deadlines, retries with simplify-on-retry, overall budget, graceful degradation instead of a hard failure |
| Consensus | Parent model merges results informally | 6 strategies, including multi-round debate, voting, expert review and hierarchical |
| Session lifetime | Fresh session per task call | Pooled long-lived session per agent, reused across debate rounds and fix passes |
| Visibility | One background task card | Nested child sessions, live per-agent activity, `# Orchestration Diagram`, `.agent-factory/last-orchestration.md`, completion toasts |
| Failure behaviour | Error bubbles up to the model | Finished agents are salvaged and the plan + diagram are still returned |
| Output | A single message | Structured report: answer, agent cards, diagram, phase timings, telemetry |
| Model selection | Manual | Automatic tier assignment |

Use `task` when a single, well-scoped chunk of work is enough. Use `orchestrate` when the deliverable has parts with dependencies, needs parallel agents plus a structured synthesis, or has to survive a slow provider without dying halfway.

## Agents

### dynamic-orchestrator (primary)

Master orchestrator. Analyzes the task, delegates to subagents via SDK session.create/prompt, synthesizes results. Never does work directly -- always spawns subagents.

### agent-factory

Analyzes task complexity and generates agent specifications. Creates specialized roles, prompts, tool selections, and dependency graphs for each task. Runs in two modes: ANALYZE (phase 1) and PLAN (phase 2).

### execution-engine

Bundled reference definition for DAG execution. Phase 3 no longer spawns this agent: the plugin now schedules the generated agents itself, in parallel waves, with dependency injection, timeouts and retries.

### consensus-manager

Unifies multiple agent outputs using consensus protocols:

| Strategy | When Used | How It Works |
|----------|-----------|--------------|
| `single` | Simple tasks, one clear answer | Return primary agent output directly |
| `debate` | Multiple valid approaches | Multi-round: state, critique, revise, check convergence |
| `voting` | Discrete options | Weighted votes by expertise, confidence scores |
| `expert_review` | High-stakes output | Reviewer evaluates all outputs, approves or requests revision |
| `hierarchical` | Multi-level refinement | Junior, Senior, Lead chain with each level adding value |

## Commands

### /orchestrate

Run the full dynamic orchestration workflow:

```
/orchestrate <your task description>
```

### /orchestrate-debug

Same workflow with detailed execution logging and step-by-step verification:

```
/orchestrate-debug <your task description>
```

## Custom Tool

The plugin registers an `orchestrate` tool that any agent can call:

```
orchestrate(prompt="Build a React component", strategy="debate")
```

Parameters:
- `prompt` (required): The task to orchestrate
- `strategy` (optional): Consensus strategy override (auto, single, debate, voting, expert_review, hierarchical)

## Telemetry

The plugin tracks orchestration metrics automatically. Use the `telemetry` tool to query:

```
telemetry(action="snapshot")   # View all metrics
telemetry(action="reset")      # Reset metrics
telemetry(action="session")    # View persisted session info
telemetry(action="cleanup")    # Clean old sessions
```

Metrics include: total orchestrations, success/failure rates, average execution time, strategy usage, and per-phase timing breakdowns.

The `telemetry` tool data is **local and in-memory**: this plugin does not ship an OTLP pipeline of its own. It does, however, **bridge** every run into an OpenTelemetry pipeline if one is registered in the process (e.g. by `opencode-otel-plugin`, which sets the global `MeterProvider`). Each orchestration publishes `orchestration.count` (attributes: `status`, `path`, `strategy`), `orchestration.duration`, `orchestration.agents`, and `orchestration.phase.duration` (attribute: `phase`) on meter `opencode.agent-factory`, prefixed with `OPENCODE_OTEL_METRIC_PREFIX` when set. The bridge is a soft dependency on `@opentelemetry/api` only — with no provider registered it is a silent no-op, and telemetry can never break a run. The optional `enablePersistentTelemetry` file (off by default) is the only thing written to disk.

## Configuration

Configure the plugin via `opencode.json`. Options are passed as the second element of the plugin tuple:

```json
{
  "plugin": [
    [
      "opencode-agent-factory-plugin",
      {
        "overallTimeoutMs": 300000,
        "phaseTimeoutMs": 120000,
        "maxRetries": 2,
        "baseRetryDelayMs": 1000,
        "maxAgents": 12,
        "enableReviewLoop": true,
        "maxReviewRounds": 1,
        "enableProgress": true,
        "fastPathThresholdChars": 500,
        "defaultStrategy": "auto"
      }
    ]
  ]
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `overallTimeoutMs` | `300000` (5min) | Max total orchestration time (hard deadline — enforced even if a model call never returns) |
| `phaseTimeoutMs` | `120000` (2min) | Max time per phase (same hard enforcement; a stalled call is abandoned, not awaited). Phase 3 (execute) gets **2×** this budget because it fans out to every agent in parallel, capped by `overallTimeoutMs` |
| `maxRetries` | `2` | Retry count for failed phases/agents |
| `baseRetryDelayMs` | `1000` | Base delay for exponential backoff |
| `maxAgents` | `12` | Max agents spawned per run; extra specs and unresolvable `depends_on` refs are dropped instead of failing |
| `enableReviewLoop` | `true` | Review → fix → re-review pass after execution (fails open if the reviewer is unavailable) |
| `maxReviewRounds` | `1` (max 3) | Fix rounds allowed after the first review; unresolved issues go to synthesis |
| `enableProgress` | `true` | Stream progress events |
| `fastPathThresholdChars` | `500` | Prompt length below which fast-path is used |
| `defaultStrategy` | `"auto"` | Default consensus strategy (`auto`, `single`, `debate`, `voting`, `expert_review`, `hierarchical`) |
| `enablePersistentTelemetry` | `false` | Write telemetry snapshots to disk |
| `telemetryPath` | `.agent-factory/telemetry.json` | Telemetry file location (relative to project dir) |
| `enableTemplateLibrary` | `true` | Load saved analysis/plan templates |
| `templateDirs` | `[.agent-factory/templates]` | Additional directories to load templates from |
| `childAgent` | `"build"` | Agent used for every child session. Set this if your `default_agent` is an orchestrator (children must not call `orchestrate` again) |
| `enableSessionPool` | `true` | Maintain concurrent long-lived agent session pool across orchestration phases for fast multi-turn interaction |
| `consensusRounds` | `2` (max 4) | Number of multi-turn debate rounds executed in Phase 4 when debate strategy is selected |
| `maxDebateAgents` | `3` (max 12) | Maximum number of active participant sessions in multi-turn debate rounds |

Invalid values (wrong type, out-of-range numbers, unknown strategy) fall back to the defaults above.

To override agent settings, add them to your `opencode.json`:

```json
{
  "plugin": ["opencode-agent-factory-plugin"],
  "agent": {
    "dynamic-orchestrator": {
      "model": "anthropic/claude-sonnet-4-6"
    }
  }
}
```

### Failure Behavior & Degraded Runs

A slow or flaky provider should cost you a partial answer, never a bare error:

- **Failure output always carries the plan.** When a run stops early you still get `## Orchestration Failed`, a `## Run Stopped Early` summary, `PROPOSED AGENT CARDS`, and the full `# Orchestration Diagram` — never just an exception string.
- **Phase timeouts degrade instead of aborting.** `analyze` falls back to local analysis and a local single-agent spec (the LLM planner is skipped); `execute` keeps every agent that already finished and continues to review/consensus/synthesis; `consensus` and `synthesize` fall back to their defaults.
- **Execute gets `2 × phaseTimeoutMs`.** Execution fans out to N agents in parallel, so a budget sized for one call would kill the fan-out before any agent returns.
- **Workers are straightforward.** The planner is told to emit direct-doer specs; debate/voting/consensus framing belongs to Phase 4, so sub-agents don't argue with each other.
- **Sessions are pooled and long-lived within a run.** Each `agent:<id>` session is created once, reused across rounds and fix passes, and only deleted at cleanup — after any still-streaming prompt finishes.

### Inspecting a Run

A run is observable while it happens and inspectable afterwards, whether or not the model chooses to relay anything back:

- **Full report on disk.** Every run — success or failure — is written to `.agent-factory/last-orchestration.md`, containing the answer, the `# Orchestration Diagram`, the proposed agent cards and the execution summary with phase timings.
- **Toast on completion.** A `success` toast announces agents, strategy, duration and the report path; failures show an `error` toast pointing at the saved report.
- **Lead line in the tool output.** The tool result starts with `**Orchestrate:** N agents · strategy · Xs · full report: …`, so whatever the model echoes back already names the run.
- **Nested sub-agent sessions.** Child sessions are created with the calling session's `parentID`, so they appear as that session's sub-agents rather than as orphan sessions.
- **Live activity.** Server events for those children are forwarded into progress events — per-agent `tool bash (running)`, reasoning, text previews and `finished` — surfaced through tool metadata and `app.log` as `[Progress] agents: agent:<id> …`.

## Consensus Strategies in Detail

### Single

Best for: simple tasks, one agent does the work, no conflict to resolve.
Returns the primary agent's output directly.

### Debate

Best for: complex reasoning with multiple valid approaches.
Runs 2-3 rounds: agents state positions, critique each other, revise.
Checks convergence (similarity > 85%). If diverged, escalates to expert_review.

### Voting

Best for: discrete choices (tech stack, architecture decisions).
Each agent votes on options with confidence scores.
Weights votes by agent expertise. Returns highest-scoring option.

### Expert Review

Best for: high-stakes output needing validation.
Designates a reviewer agent who evaluates all outputs.
Approves, requests revision, or rejects. Max 2 revision cycles.

### Hierarchical

Best for: multi-level refinement.
Junior agents draft, senior agents refine, lead agent synthesizes.
Each level adds value, not just passes through.

## Development

```bash
git clone https://github.com/MunhozThiago/opencode-agent-factory-plugin.git
cd opencode-agent-factory-plugin
bun install
bun run build
bun run typecheck
bun test
```

### Local Testing

Add to your `opencode.json`:

```json
{
  "plugin": ["./path/to/opencode-agent-factory-plugin"]
}
```

### Project Structure

```
opencode-agent-factory-plugin/
├── src/
│   ├── index.ts              # Plugin entry point (orchestrate tool + hooks)
│   ├── orchestrator.ts       # 5-phase SDK-driven orchestration engine
│   ├── mock-client.ts        # Shared test harness (mock SDK client)
│   ├── index.test.ts         # Plugin lifecycle, tools, hooks
│   ├── orchestrator.test.ts  # Options, validators, prompts, diagrams
│   ├── orchestration.test.ts # End-to-end engine runs
│   ├── dag.test.ts           # Native DAG execution
│   └── goal.test.ts          # Goal tools
├── agents/
│   ├── dynamic-orchestrator.md
│   ├── agent-factory.md
│   ├── execution-engine.md
│   └── consensus-manager.md
├── commands/
│   ├── orchestrate.md
│   └── orchestrate-debug.md
├── .github/workflows/
│   ├── ci.yml                # Build, typecheck, test on push/PR
│   └── release.yml           # npm publish on tag
├── package.json
├── tsconfig.json
└── README.md
```

## Publishing

```bash
# Tag a release
git tag v1.0.0
git push origin v1.0.0

# GitHub Action will:
# 1. Build the plugin
# 2. Run typecheck and tests
# 3. Create a GitHub Release
# 4. Publish to npm with provenance
```

## Community

This plugin is listed in:
- [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) - Curated list of OpenCode plugins
- [OpenCode Ecosystem](https://opencode.ai/docs/ecosystem/) - Official ecosystem page

## License

AGPL-3.0