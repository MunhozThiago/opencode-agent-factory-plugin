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
[3. EXECUTE]  -- execution-engine spawns agents in parallel groups via SDK sessions
    |
    v
[4. CONSENSUS]-- consensus-manager unifies outputs via selected strategy
    |
    v
[5. SYNTHESIZE]-- dynamic-orchestrator compiles final response
    |
    v
Final Result + Execution Summary
```

### What Makes This Different From Built-in Sub-Agents

| Feature | Built-in `task` tool | Agent Factory Plugin |
|---------|---------------------|---------------------|
| Agent roles | Pre-defined, fixed | Generated per-task at runtime |
| Parallel execution | Manual | Automatic DAG scheduling via SDK |
| Dependencies | Manual tracking | Automatic injection between groups |
| Consensus | None | 5 strategies (debate, voting, etc.) |
| Model selection | Manual | Automatic tier assignment |

## Agents

### dynamic-orchestrator (primary)

Master orchestrator. Analyzes the task, delegates to subagents via SDK session.create/prompt, synthesizes results. Never does work directly -- always spawns subagents.

### agent-factory

Analyzes task complexity and generates agent specifications. Creates specialized roles, prompts, tool selections, and dependency graphs for each task. Runs in two modes: ANALYZE (phase 1) and PLAN (phase 2).

### execution-engine

Executes agent DAGs with parallel group scheduling. Spawns agents via SDK sessions in parallel groups, handles dependency injection, timeouts, retries, and failure recovery. Outputs structured execution results.

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

## Configuration

The plugin requires no configuration. It automatically:
- Registers the `orchestrate` custom tool
- Loads 4 agent definitions (dynamic-orchestrator, agent-factory, execution-engine, consensus-manager)
- Logs orchestration events via the OpenCode SDK

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
│   └── index.test.ts         # Unit tests
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