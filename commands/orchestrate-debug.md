---
description: Run orchestration with detailed execution logging and step-by-step verification
agent: dynamic-orchestrator
---

The user has invoked the `/orchestrate-debug` command with the following task:

$ARGUMENTS

You MUST now call the `orchestrate` tool with the user's task as the `prompt` argument. Do NOT attempt to analyze, plan, or execute anything yourself. Simply invoke the tool:

orchestrate(prompt: "$ARGUMENTS")

Then report back in this order, without summarizing away the diagnostics:

1. The run stats line the tool returns first: `**Orchestrate:** N agents · strategy · Xs · full report: …`
2. The `## Execution Summary` block, verbatim (agents spawned, parallel groups, consensus strategy, confidence, total time).
3. The `# Orchestration Diagram` block, verbatim from its heading through the phase timings. Do not shorten, reword or omit it.
4. The saved report path, `.agent-factory/last-orchestration.md`.

The tool always writes that file, so if the output was truncated or you cannot relay the diagram, read `.agent-factory/last-orchestration.md` with your file tool and paste the diagram from there. Never answer with only the task's result.
