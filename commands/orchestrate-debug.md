---
description: Run orchestration with detailed execution logging and step-by-step verification
agent: dynamic-orchestrator
---

Execute the dynamic orchestration workflow for: $ARGUMENTS

**DEBUG MODE** - Provide detailed logging at each phase:

1. ANALYZE - Output the full task analysis JSON before proceeding
2. PLAN - Show each agent specification generated
3. EXECUTE - Log each task spawn with agent config
4. CONSENSUS - Display consensus process and convergence metrics
5. SYNTHESIZE - Show how final output was constructed

At each phase, pause and confirm before continuing.

Return complete execution trace with:
- All intermediate JSON structures
- Timing per agent and per group
- Consensus convergence metrics
- Any failures and recoveries
