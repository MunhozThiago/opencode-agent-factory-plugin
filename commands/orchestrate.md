---
description: Run a dynamic multi-agent workflow: analyze prompt, generate agents, execute in parallel, apply consensus, synthesize result
agent: dynamic-orchestrator
---

Execute the full dynamic orchestration workflow for: $ARGUMENTS

Follow the 6-phase process defined in your agent instructions:

1. ANALYZE - Understand the task, extract complexity, domains, capabilities
2. PLAN - Generate agent specifications via agent-factory
3. EXECUTE - Run agents in parallel DAG via execution-engine
4. CONSENSUS - Apply consensus strategy via consensus-manager
5. SYNTHESIZE - Produce final unified result

Return the final result with execution summary.
