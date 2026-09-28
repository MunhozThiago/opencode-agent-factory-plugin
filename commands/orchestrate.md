---
description: Run a dynamic multi-agent workflow: analyze prompt, generate agents, execute in parallel, apply consensus, synthesize result
agent: dynamic-orchestrator
---

The user has invoked the `/orchestrate` command with the following task:

$ARGUMENTS

You MUST now call the `orchestrate` tool with the user's task as the `prompt` argument. Do NOT attempt to analyze, plan, or execute anything yourself. Simply invoke the tool:

orchestrate(prompt: "$ARGUMENTS")

Return the tool's result directly to the user.
