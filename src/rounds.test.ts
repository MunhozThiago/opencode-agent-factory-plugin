import { expect, test, describe } from "bun:test"
import { runOrchestration } from "./orchestrator"
import { createMockClient, makeContext, makeSpec } from "./mock-client"

const LONG_PROMPT = "Get the cheapest energy tariff and calculate monthly savings across multiple providers and historical usage profiles. ".repeat(6).trim()

function specs() {
  return [makeSpec({ id: "agent1", role: "researcher" }), makeSpec({ id: "agent2", role: "analyst" })]
}

describe("Strategy Smoke Tests Across All Consensus Types", () => {
  const strategies = ["single", "debate", "voting", "expert_review", "hierarchical", "mesh", "fipa_contract_net"] as const

  for (const strategy of strategies) {
    test(`runs successfully with strategy = ${strategy}`, async () => {
      const mock = createMockClient({
        respond: (prompt) => {
          if (prompt.system.includes("SIMPLE task") || prompt.system.includes("Phase 2: PLAN")) {
            return JSON.stringify(specs())
          }
          if (prompt.system.includes("Phase 1: ANALYZE")) {
            return JSON.stringify({
              task_type: "research",
              complexity: "complex",
              domains: ["utilities"],
              capabilities: ["web_fetch"],
              consensus_strategy: strategy,
              parallel_groups: [{ group_id: 1, independent: true, subtasks: ["scrape"] }]
            })
          }
          if (prompt.system.includes("CONSENSUS ROUND")) {
            return "Peer feedback received. CONVERGED: YES"
          }
          if (prompt.system.includes("Phase 4: CONSENSUS")) {
            return JSON.stringify({
              consensus_reached: true,
              final_output: `Consensus reached via ${strategy}`,
              confidence: 0.92,
              strategy_used: strategy,
              rounds_executed: 1,
              agent_contributions: { agent1: { weight: 1, accepted: true } },
              metadata: { convergence_score: 0.9 }
            })
          }
          if (prompt.system.includes("Phase 5: SYNTHESIZE")) {
            return `Final synthesized result for ${strategy}`
          }
          return JSON.stringify({ output: `Result from agent for ${strategy}`, status: "completed" })
        }
      })

      const context = makeContext(mock.client, { defaultStrategy: strategy, consensusRounds: 1, enableSessionPool: true })
      const result = await runOrchestration(context, LONG_PROMPT, strategy)

      expect(result.result).toBeDefined()
      expect(result.metadata.consensus_strategy).toBe(strategy)
      expect(result.metadata.phases_completed).toBeGreaterThanOrEqual(3)
    })
  }

  test("executes multiple debate rounds when consensusRounds >= 2", async () => {
    let consensusCalls = 0
    const mock = createMockClient({
      respond: (prompt) => {
        if (prompt.system.includes("Phase 1: ANALYZE")) {
          return JSON.stringify({
            task_type: "research",
            complexity: "complex",
            domains: ["backend"],
            capabilities: ["code_execution"],
            consensus_strategy: "debate",
            parallel_groups: [{ group_id: 1, independent: true, subtasks: ["build"] }]
          })
        }
        if (prompt.system.includes("Phase 2: PLAN")) {
          return JSON.stringify(specs())
        }
        if (prompt.system.includes("CONSENSUS ROUND")) {
          consensusCalls++
          return `Round reply ${consensusCalls}. CONVERGED: YES`
        }
        if (prompt.system.includes("Phase 4: CONSENSUS")) {
          return JSON.stringify({
            consensus_reached: true,
            final_output: "Final consensus reached across rounds",
            confidence: 0.95,
            strategy_used: "debate",
            rounds_executed: 2,
            agent_contributions: {},
            metadata: { convergence_score: 0.95 }
          })
        }
        if (prompt.system.includes("Phase 5: SYNTHESIZE")) {
          return "Synthesized Multi-Round Result"
        }
        return JSON.stringify({ output: "agent output", status: "completed" })
      }
    })

    const context = makeContext(mock.client, { defaultStrategy: "debate", consensusRounds: 2, enableSessionPool: true })
    const result = await runOrchestration(context, LONG_PROMPT, "auto")

    expect(result.metadata.consensus_reached).toBe(true)
    expect(result.result).toBe("Synthesized Multi-Round Result")
    expect(result.diagram.consensus?.rounds_executed).toBe(2)
  })

  test("degrades gracefully when consensus-manager fails", async () => {
    const mock = createMockClient({
      respond: (prompt) => {
        if (prompt.system.includes("Phase 1: ANALYZE")) {
          return JSON.stringify({
            task_type: "research",
            complexity: "complex",
            domains: ["backend"],
            capabilities: ["code_execution"],
            consensus_strategy: "debate",
            parallel_groups: [{ group_id: 1, independent: true, subtasks: ["build"] }]
          })
        }
        if (prompt.system.includes("Phase 2: PLAN")) {
          return JSON.stringify(specs())
        }
        if (prompt.system.includes("CONSENSUS ROUND")) {
          return "Round reply. CONVERGED: YES"
        }
        if (prompt.system.includes("Phase 4: CONSENSUS")) {
          throw new Error("consensus-manager crashed")
        }
        if (prompt.system.includes("Phase 5: SYNTHESIZE")) {
          return "Synthesized Fallback Result"
        }
        return JSON.stringify({ output: "agent output", status: "completed" })
      }
    })

    const context = makeContext(mock.client, { defaultStrategy: "debate", consensusRounds: 1, enableSessionPool: true })
    const result = await runOrchestration(context, LONG_PROMPT, "debate")

    expect(result.diagram.consensus?.consensus_reached).toBe(true)
    expect(result.metadata.phases_completed).toBe(5)
  })

  test("degrades gracefully when synthesis fails", async () => {
    const mock = createMockClient({
      respond: (prompt) => {
        if (prompt.system.includes("Phase 1: ANALYZE")) {
          return JSON.stringify({
            task_type: "research",
            complexity: "complex",
            domains: ["backend"],
            capabilities: ["code_execution"],
            consensus_strategy: "debate",
            parallel_groups: [{ group_id: 1, independent: true, subtasks: ["build"] }]
          })
        }
        if (prompt.system.includes("Phase 2: PLAN")) {
          return JSON.stringify(specs())
        }
        if (prompt.system.includes("CONSENSUS ROUND")) {
          return "Round reply. CONVERGED: YES"
        }
        if (prompt.system.includes("Phase 4: CONSENSUS")) {
          return JSON.stringify({
            consensus_reached: true,
            final_output: "Consensus Final Output",
            confidence: 0.9,
            strategy_used: "debate",
            rounds_executed: 1,
            agent_contributions: {},
            metadata: { convergence_score: 0.9 }
          })
        }
        if (prompt.system.includes("Phase 5: SYNTHESIZE")) {
          throw new Error("synthesizer crashed")
        }
        return JSON.stringify({ output: "agent output", status: "completed" })
      }
    })

    const context = makeContext(mock.client, { defaultStrategy: "debate", consensusRounds: 1, enableSessionPool: true })
    const result = await runOrchestration(context, LONG_PROMPT, "debate")

    expect(result.result).toBe("Consensus Final Output")
    expect(result.metadata.phases_completed).toBe(5)
  })
})
