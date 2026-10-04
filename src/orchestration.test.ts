import { expect, test, describe, beforeEach } from "bun:test"
import {
  runOrchestration,
  getOrchestrateTool,
  getTelemetrySnapshot,
  resetTelemetry,
  createTimeoutSignal,
  validateAgentSpecs,
  OrchestrationError,
} from "./orchestrator"
import { createMockClient, makeContext, makeSpec, pipelineResponder, delay } from "./mock-client"

const LONG_PROMPT = "Design and implement a REST API for a todo application with authentication. ".repeat(8).trim()
const SHORT_PROMPT = "say hi"

function analysis(strategy = "debate") {
  return {
    task_type: "coding",
    complexity: "complex",
    domains: ["backend"],
    capabilities: ["code_execution"],
    consensus_strategy: strategy,
    parallel_groups: [{ group_id: 1, independent: true, subtasks: ["build"] }],
  }
}

function specs() {
  return [makeSpec({ id: "a" }), makeSpec({ id: "b", depends_on: ["a"] })]
}

beforeEach(() => resetTelemetry())

describe("runOrchestration: pipeline selection", () => {
  test("runs the full five-phase pipeline for a long auto prompt", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })
    const context = makeContext(mock.client)

    const result = await runOrchestration(context, LONG_PROMPT, "auto")

    expect(result.result).toBe("FINAL SYNTHESIZED RESULT")
    expect(result.metadata.phases_completed).toBe(5)
    expect(result.metadata.agents_spawned).toBe(2)
    expect(result.metadata.parallel_groups).toBe(2)
    expect(result.metadata.consensus_strategy).toBe("debate")
    expect(result.metadata.consensus_reached).toBe(true)

    const systems = mock.state.prompts.map(p => p.system)
    expect(systems.some(s => s.includes("Phase 1: ANALYZE"))).toBe(true)
    expect(systems.some(s => s.includes("Phase 2: PLAN"))).toBe(true)
    expect(systems.some(s => s.includes("Phase 4: CONSENSUS"))).toBe(true)
    expect(systems.some(s => s.includes("Phase 5: SYNTHESIZE"))).toBe(true)
    expect(systems).toContain("SYSTEM_PROMPT_FOR_a")
    expect(systems).toContain("SYSTEM_PROMPT_FOR_b")

    expect(result.diagram.analysis!.task_type).toBe("coding")
    expect(result.diagram.specs).toHaveLength(2)
    expect(result.diagram.consensus!.strategy_used).toBe("debate")
  })

  test("skips the consensus phase when the strategy is single", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis("single"), specs: specs() }) })
    const context = makeContext(mock.client)

    const result = await runOrchestration(context, LONG_PROMPT, "auto")

    expect(result.metadata.consensus_strategy).toBe("single")
    expect(mock.state.prompts.some(p => p.system.includes("Phase 4: CONSENSUS"))).toBe(false)
    expect(result.diagram.consensus!.final_output).toBe("OUTPUT[a]")
  })

  test("uses the fast path for strategy=single", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ specs: specs() }) })
    const context = makeContext(mock.client)

    const result = await runOrchestration(context, LONG_PROMPT, "single")

    expect(result.metadata.phases_completed).toBe(3)
    expect(result.metadata.consensus_strategy).toBe("single")
    expect(result.result).toBe("FINAL SYNTHESIZED RESULT")
    expect(mock.state.prompts.some(p => p.system.includes("Phase 1: ANALYZE"))).toBe(false)
    expect(mock.state.prompts.some(p => p.system.includes("SIMPLE task"))).toBe(true)
    expect(result.diagram.phaseTimings).toHaveProperty("fast-path")
  })

  test("repairs near-miss specs from the model instead of failing the run", async () => {
    const messySpecs = {
      agents: [{
        role: "Implementer",
        goal: "Write fibonacci.py",
        prompt: "Write the fibonacci function",
        model_tier: "high",
        output_format: "plain text",
      }],
    }
    const phaseFallback = pipelineResponder({ specs: specs() })
    const mock = createMockClient({
      respond: prompt =>
        prompt.system.includes("SIMPLE task")
          ? JSON.stringify(messySpecs)
          : phaseFallback(prompt),
    })
    const context = makeContext(mock.client)

    const result = await runOrchestration(context, SHORT_PROMPT, "auto")

    expect(result.metadata.phases_completed).toBe(3)
    expect(result.result).toBe("FINAL SYNTHESIZED RESULT")
    expect(result.diagram.specs).toHaveLength(1)
    expect(result.diagram.specs[0].model_tier).toBe("powerful")
    expect(validateAgentSpecs(result.diagram.specs)).toBe(true)
  })

  test("retries spec generation when the model answers with prose instead of JSON", async () => {
    let specCalls = 0
    const phaseFallback = pipelineResponder({ specs: [makeSpec({ id: "a" })] })
    const mock = createMockClient({
      respond: prompt => {
        if (prompt.system.includes("SIMPLE task")) {
          specCalls++
          return specCalls === 1
            ? "Sure - I'll write that function for you now."
            : JSON.stringify([makeSpec({ id: "a" })])
        }
        return phaseFallback(prompt)
      },
    })
    const context = makeContext(mock.client)

    const result = await runOrchestration(context, SHORT_PROMPT, "auto")

    expect(specCalls).toBe(2)
    expect(result.metadata.phases_completed).toBe(3)
    expect(result.diagram.consensus!.final_output).toBe("OUTPUT[a]")
  })

  test("degrades to a single local agent when the planner keeps failing", async () => {
    let planCalls = 0
    const phaseFallback = pipelineResponder({ analysis: analysis(), specs: specs() })
    const mock = createMockClient({
      respond: prompt => {
        if (prompt.system.includes("Phase 2: PLAN")) {
          planCalls += 1
          throw new OrchestrationError("planner exploded", "phase2-plan", undefined, true)
        }
        return phaseFallback(prompt)
      },
    })
    const context = makeContext(mock.client, { maxRetries: 0, baseRetryDelayMs: 0 })
    const progress: string[] = []
    context.onProgress = event => progress.push(event.step)

    const result = await runOrchestration(context, LONG_PROMPT, "auto")

    expect(planCalls).toBe(4)
    expect(progress).toContain("plan-fallback")
    expect(progress).toContain("plan-degraded")
    expect(result.metadata.agents_spawned).toBe(1)
    expect(result.metadata.phases_completed).toBe(5)
    expect(result.result).toBe("FINAL SYNTHESIZED RESULT")
    expect(mock.state.prompts.some(p => p.system.includes("sole worker"))).toBe(true)
  })

  test("runs a review round, applies fixes, then approves", async () => {
    let reviewCalls = 0
    const phaseFallback = pipelineResponder({ analysis: analysis("single"), specs: specs() })
    const mock = createMockClient({
      respond: prompt => {
        if (prompt.system.includes("You are a strict but fair reviewer")) {
          reviewCalls += 1
          return reviewCalls === 1
            ? JSON.stringify({ approved: false, issues: [{ agent_id: "a", description: "edge cases missing" }] })
            : JSON.stringify({ approved: true, issues: [] })
        }
        return phaseFallback(prompt)
      },
    })
    const context = makeContext(mock.client, { maxReviewRounds: 2 })
    const progress: string[] = []
    context.onProgress = event => progress.push(event.step)

    const result = await runOrchestration(context, LONG_PROMPT, "auto")

    expect(reviewCalls).toBe(2)
    expect(progress).toContain("review-round")
    expect(progress).toContain("review-issues")
    expect(progress).toContain("review-fixes")
    expect(progress).toContain("review-approved")
    expect(result.result).toBe("FINAL SYNTHESIZED RESULT")
    expect(result.metadata.phases_completed).toBe(5)
    const fixPrompt = mock.state.prompts.find(p => p.user.includes("DID NOT PASS REVIEW"))
    expect(fixPrompt).toBeDefined()
    expect(fixPrompt!.user).toContain("edge cases missing")
  })

  test("stops after maxReviewRounds and reports unresolved issues to synthesis", async () => {
    let reviewCalls = 0
    const phaseFallback = pipelineResponder({ analysis: analysis("single"), specs: specs() })
    const mock = createMockClient({
      respond: prompt => {
        if (prompt.system.includes("You are a strict but fair reviewer")) {
          reviewCalls += 1
          return JSON.stringify({ approved: false, issues: [{ agent_id: "a", description: "still wrong" }] })
        }
        return phaseFallback(prompt)
      },
    })
    const context = makeContext(mock.client, { maxReviewRounds: 1 })
    const progress: string[] = []
    context.onProgress = event => progress.push(event.step)

    const result = await runOrchestration(context, LONG_PROMPT, "auto")

    expect(reviewCalls).toBe(2)
    expect(progress).not.toContain("review-approved")
    expect(result.result).toBe("FINAL SYNTHESIZED RESULT")
  })

  test("uses the fast path for a short auto prompt under the default threshold", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ specs: specs() }) })
    const context = makeContext(mock.client)

    const result = await runOrchestration(context, SHORT_PROMPT, "auto")

    expect(result.metadata.phases_completed).toBe(3)
    expect(mock.state.prompts.some(p => p.system.includes("Phase 1: ANALYZE"))).toBe(false)
  })

  test("executes the generated agents on the fast path instead of faking the run", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ specs: specs() }) })
    const context = makeContext(mock.client)

    const result = await runOrchestration(context, SHORT_PROMPT, "auto")

    const systems = mock.state.prompts.map(p => p.system)
    expect(systems).toContain("SYSTEM_PROMPT_FOR_a")
    expect(systems).toContain("SYSTEM_PROMPT_FOR_b")
    expect(result.metadata.parallel_groups).toBe(2)
    expect(result.diagram.execution!.execution_metadata.completed).toBe(2)
    // single consensus adopts the primary agent's real output
    expect(result.diagram.consensus!.final_output).toBe("OUTPUT[a]")
    expect(result.result).toBe("FINAL SYNTHESIZED RESULT")
  })

  test("respects fastPathThresholdChars=0 so short prompts still take the slow path", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })
    const context = makeContext(mock.client, { fastPathThresholdChars: 0 })

    const result = await runOrchestration(context, SHORT_PROMPT, "auto")

    expect(result.metadata.phases_completed).toBe(5)
  })

  test("resolves auto to the configured defaultStrategy", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ specs: specs() }) })
    const context = makeContext(mock.client, { defaultStrategy: "single" })

    const result = await runOrchestration(context, LONG_PROMPT, "auto")

    expect(result.metadata.phases_completed).toBe(3)
    expect(mock.state.prompts.some(p => p.system.includes("SIMPLE task"))).toBe(true)
  })
})

describe("runOrchestration: input validation", () => {
  test("rejects an empty prompt", async () => {
    const context = makeContext(createMockClient().client)
    await expect(runOrchestration(context, "", "auto")).rejects.toThrow("Prompt cannot be empty")
  })

  test("rejects an unknown strategy", async () => {
    const context = makeContext(createMockClient().client)
    await expect(runOrchestration(context, LONG_PROMPT, "banana")).rejects.toThrow("Invalid strategy")
  })

  test("rejects a prompt above the size limit", async () => {
    const context = makeContext(createMockClient().client)
    await expect(runOrchestration(context, "x".repeat(50001), "auto")).rejects.toThrow("exceeds maximum length")
  })
})

describe("runOrchestration: failures, cleanup and telemetry", () => {
  test("cleans up every session it created when a phase fails", async () => {
    const mock = createMockClient({ respond: () => "not json at all" })
    const context = makeContext(mock.client)

    const error = await runOrchestration(context, LONG_PROMPT, "auto").catch(e => e)

    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error.message).toContain("task analysis")
    expect(mock.state.created.length).toBeGreaterThan(0)
    expect(mock.state.deleted).toEqual(mock.state.created)
    expect(mock.state.openSessions.size).toBe(0)
  })

  test("cleans up sessions when the run succeeds", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })
    const context = makeContext(mock.client)

    await runOrchestration(context, LONG_PROMPT, "auto")

    expect(mock.state.deleted).toEqual(mock.state.created)
    expect(mock.state.openSessions.size).toBe(0)
  })

  test("records a successful run with per-phase timings", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })
    const context = makeContext(mock.client)

    await runOrchestration(context, LONG_PROMPT, "auto")

    const snapshot = getTelemetrySnapshot()
    expect(snapshot.totalOrchestrations).toBe(1)
    expect(snapshot.successfulOrchestrations).toBe(1)
    expect(snapshot.failedOrchestrations).toBe(0)
    expect(snapshot.complexPathUsage).toBe(1)
    expect(snapshot.fastPathUsage).toBe(0)
    expect(snapshot.strategyUsage.debate).toBe(1)
    expect(snapshot.totalAgentsSpawned).toBe(2)
    expect(snapshot.avgExecutionTimeMs).toBeGreaterThanOrEqual(0)
    expect(snapshot.avgAgentsPerOrchestration).toBe(2)

    for (const phase of ["analyze", "plan", "execute", "consensus", "synthesize"]) {
      expect(Array.isArray(snapshot.phaseTimings[phase])).toBe(true)
      expect(snapshot.phaseTimings[phase]!.length).toBe(1)
      expect(snapshot.phaseTimings[phase]![0]).toBeGreaterThanOrEqual(0)
    }
  })

  test("records fast-path usage", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ specs: specs() }) })
    const context = makeContext(mock.client)

    await runOrchestration(context, LONG_PROMPT, "single")

    const snapshot = getTelemetrySnapshot()
    expect(snapshot.fastPathUsage).toBe(1)
    expect(snapshot.complexPathUsage).toBe(0)
    expect(Object.keys(snapshot.phaseTimings)).toEqual(["fast-path", "execute", "review", "synthesize"])
  })

  test("records a failed run", async () => {
    const mock = createMockClient({ respond: () => "" })
    const context = makeContext(mock.client)

    await expect(runOrchestration(context, LONG_PROMPT, "auto")).rejects.toThrow()

    const snapshot = getTelemetrySnapshot()
    expect(snapshot.totalOrchestrations).toBe(1)
    expect(snapshot.failedOrchestrations).toBe(1)
    expect(snapshot.successfulOrchestrations).toBe(0)
  })

  test("resetTelemetry clears every counter", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ specs: specs() }) })
    await runOrchestration(makeContext(mock.client), LONG_PROMPT, "single")

    resetTelemetry()

    const snapshot = getTelemetrySnapshot()
    expect(snapshot.totalOrchestrations).toBe(0)
    expect(snapshot.fastPathUsage).toBe(0)
    expect(snapshot.phaseTimings).toEqual({})
    expect(snapshot.strategyUsage).toEqual({})
  })
})

describe("runOrchestration: child session contract", () => {
  test("every phase prompt pins an agent and disables orchestrate", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })
    const context = makeContext(mock.client)

    await runOrchestration(context, LONG_PROMPT, "auto")

    expect(mock.state.prompts.length).toBeGreaterThan(0)
    for (const prompt of mock.state.prompts) {
      expect(prompt.agent).toBe("build")
      expect(prompt.tools?.orchestrate).toBe(false)
      expect(prompt.tools?.delegate).toBe(false)
    }
  })

  test("honours a configured child agent", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })
    const context = makeContext(mock.client, { childAgent: "general" })

    await runOrchestration(context, LONG_PROMPT, "auto")

    expect(mock.state.prompts.every(p => p.agent === "general")).toBe(true)
  })
})

describe("runOrchestration: timeouts and aborts", () => {
  test("aborts the run when the overall timeout elapses", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }), createDelayMs: 30 })
    const context = makeContext(mock.client, { overallTimeoutMs: 1 })

    const error = await runOrchestration(context, LONG_PROMPT, "auto").catch(e => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/abort/i)
    expect(mock.state.deleted).toEqual(mock.state.created)
  })

  test("fails a phase that exceeds phaseTimeoutMs with a phase-scoped error", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }), createDelayMs: 30 })
    const context = makeContext(mock.client, { phaseTimeoutMs: 1 })

    const error = await runOrchestration(context, LONG_PROMPT, "auto").catch(e => e)

    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error.phase).toBe("analyze")
    expect(error.message).toContain("phase timeout")
    expect(error.recoverable).toBe(true)
    expect(mock.state.deleted).toEqual(mock.state.created)
  })

  test("stops immediately when the caller aborts", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })
    const controller = new AbortController()
    controller.abort()
    const context = makeContext(mock.client)
    context.abort = controller.signal

    await expect(runOrchestration(context, LONG_PROMPT, "auto")).rejects.toThrow(/abort/i)
  })

  test("createTimeoutSignal aborts on timeout and stays quiet after dispose", async () => {
    const timed = createTimeoutSignal(10)
    expect(timed.signal.aborted).toBe(false)
    await delay(30)
    expect(timed.signal.aborted).toBe(true)

    const disposed = createTimeoutSignal(10)
    disposed.dispose()
    await delay(30)
    expect(disposed.signal.aborted).toBe(false)
  })

  test("fails a hung phase call at the phase deadline", async () => {
    const mock = createMockClient({
      respond: pipelineResponder({ analysis: analysis(), specs: specs() }),
      promptDelayMs: 3000,
    })
    const context = makeContext(mock.client, { phaseTimeoutMs: 150, overallTimeoutMs: 60000, maxRetries: 0 })

    const started = Date.now()
    const error = await runOrchestration(context, LONG_PROMPT, "auto").catch(e => e)
    const elapsed = Date.now() - started

    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error.message).toContain("phase timeout")
    expect(error.phase).toBe("analyze")
    expect(elapsed).toBeLessThan(1500)
  })

  test("fails a hung phase call at the overall deadline", async () => {
    const mock = createMockClient({
      respond: pipelineResponder({ analysis: analysis(), specs: specs() }),
      promptDelayMs: 3000,
    })
    const context = makeContext(mock.client, { overallTimeoutMs: 150, phaseTimeoutMs: 60000, maxRetries: 0 })

    const started = Date.now()
    const error = await runOrchestration(context, LONG_PROMPT, "auto").catch(e => e)
    const elapsed = Date.now() - started

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/abort/i)
    expect(elapsed).toBeLessThan(1500)
  })
})

describe("getOrchestrateTool", () => {
  test("returns a diagram plus an execution summary", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })

    const tool = getOrchestrateTool(mock.client, { id: "p1" }, process.cwd(), process.cwd(), {})
    const output = await tool.execute({ prompt: LONG_PROMPT }, { abort: new AbortController().signal })

    expect(typeof output).toBe("string")
    expect(output).toContain("# Orchestration Diagram")
    expect(output).toContain("## Task Analysis")
    expect(output).toContain("## Result")
    expect(output).toContain("FINAL SYNTHESIZED RESULT")
    expect(output).toContain("## Execution Summary")
    expect(output).toContain("Agents spawned: 2")
    expect(output).toContain("Consensus strategy: debate")
    expect(mock.state.deleted).toEqual(mock.state.created)
  })

  test("returns a structured failure message instead of throwing", async () => {
    const mock = createMockClient({ failCreate: true })

    const tool = getOrchestrateTool(mock.client, { id: "p1" }, process.cwd(), process.cwd(), { maxRetries: 0 })
    const output = await tool.execute({ prompt: LONG_PROMPT }, { abort: new AbortController().signal })

    expect(output).toContain("## Orchestration Failed")
    expect(output).toContain("createChildSession")
    expect(output).toContain("Recoverable:")
  })

  test("passes plugin options through to the engine", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })

    // progress disabled => no [Progress] logs, proving the option reached the engine
    const tool = getOrchestrateTool(mock.client, { id: "p1" }, process.cwd(), process.cwd(), { enableProgress: false })
    await tool.execute({ prompt: LONG_PROMPT }, { abort: new AbortController().signal })

    expect(mock.state.logs.some(m => m.startsWith("[Progress]"))).toBe(false)
  })

  test("emits progress logs by default", async () => {
    const mock = createMockClient({ respond: pipelineResponder({ analysis: analysis(), specs: specs() }) })

    const tool = getOrchestrateTool(mock.client, { id: "p1" }, process.cwd(), process.cwd(), {})
    await tool.execute({ prompt: LONG_PROMPT }, { abort: new AbortController().signal })

    expect(mock.state.logs.some(m => m.startsWith("[Progress]"))).toBe(true)
  })

  test("returns a failure report instead of hanging when a model call stalls", async () => {
    const mock = createMockClient({
      respond: pipelineResponder({ analysis: analysis(), specs: specs() }),
      promptDelayMs: 1000,
    })

    const tool = getOrchestrateTool(mock.client, { id: "p1" }, process.cwd(), process.cwd(), {
      phaseTimeoutMs: 200,
      overallTimeoutMs: 60000,
      maxRetries: 0,
    })

    const started = Date.now()
    const output = (await tool.execute(
      { prompt: LONG_PROMPT },
      { abort: new AbortController().signal }
    )) as string
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(900)
    expect(output).toContain("## Orchestration Failed")
    expect(output).toContain("Recoverable:** no")
    expect(output).not.toContain("Please try again or simplify")
  })

  test("marks a phase timeout as non-recoverable at the tool boundary", async () => {
    const mock = createMockClient({
      respond: pipelineResponder({ analysis: analysis(), specs: specs() }),
      promptDelayMs: 1000,
    })

    const tool = getOrchestrateTool(mock.client, { id: "p1" }, process.cwd(), process.cwd(), {
      phaseTimeoutMs: 200,
      overallTimeoutMs: 60000,
      maxRetries: 0,
    })

    const output = (await tool.execute(
      { prompt: LONG_PROMPT },
      { abort: new AbortController().signal }
    )) as string

    expect(output).toContain("## Orchestration Failed (analyze)")
    expect(output).toContain("exceeded phase timeout")
    expect(output).toContain("Recoverable:** no")
    expect(output).toContain("phaseTimeoutMs")
    expect(output).not.toContain("Please try again or simplify")
  })

  test("marks an exhausted overall time budget as non-recoverable", async () => {
    const mock = createMockClient({
      respond: pipelineResponder({ analysis: analysis(), specs: specs() }),
      promptDelayMs: 1000,
    })

    const tool = getOrchestrateTool(mock.client, { id: "p1" }, process.cwd(), process.cwd(), {
      overallTimeoutMs: 200,
      phaseTimeoutMs: 60000,
      maxRetries: 0,
    })

    const output = (await tool.execute(
      { prompt: LONG_PROMPT },
      { abort: new AbortController().signal }
    )) as string

    expect(output).toContain("## Orchestration Failed")
    expect(output).toContain("Recoverable:** no")
    expect(output).toContain("overall time budget")
    expect(output).not.toContain("Please try again or simplify")
  })
})
