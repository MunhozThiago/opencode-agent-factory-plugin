---
description: Run orchestration with detailed execution logging and step-by-step verification
agent: dynamic-orchestrator
---

The user has invoked the `/orchestrate-debug` command with the following task:

$ARGUMENTS

You MUST now call the `orchestrate` tool with the user's task as the `prompt` argument. Do NOT attempt to analyze, plan, or execute anything yourself. Simply invoke the tool:

orchestrate(prompt: "$ARGUMENTS")

Return the tool's result directly to the user.
