import { expect, test, describe, beforeEach } from "bun:test"
import { runNativeDAGExecution, OrchestrationError, resetTelemetry } from "./orchestrator"
import { createMockClient, makeContext, makeSpec, pipelineResponder } from "./mock-client"

function newFixture(options: Parameters<typeof makeContext>[1] = {}, mockOptions: Parameters<typeof createMockClient>[0] = {}) {
  const mock = createMockClient(mockOptions)
  const context = makeContext(mock.client, options)
  const progress: Array<{ phase: string; step: string; message: string }> = []
  context.onProgress = event => progress.push({ phase: event.phase, step: event.step, message: event.message })
  return { mock, context, progress }
}

beforeEach(() => resetTelemetry())

describe("runNativeDAGExecution", () => {
  test("runs a three-level chain strictly in dependency order", async () => {
    const specs = [
      makeSpec({ id: "a" }),
      makeSpec({ id: "b", depends_on: ["a"] }),
      makeSpec({ id: "c", depends_on: ["b"] }),
    ]
    const { mock, context } = newFixture({}, { respond: pipelineResponder({ specs }) })

    const result = await runNativeDAGExecution(context, specs, "build it", context.abort)

    expect(result.execution_metadata.total_groups).toBe(3)
    expect(result.execution_metadata.completed).toBe(3)
    expect(result.execution_metadata.failed).toBe(0)
    expect(mock.state.prompts.map(p => p.system)).toEqual([
      "SYSTEM_PROMPT_FOR_a",
      "SYSTEM_PROMPT_FOR_b",
      "SYSTEM_PROMPT_FOR_c",
    ])
    expect(result.results.a.output).toBe("OUTPUT[a]")
    expect(result.results.b.output).toBe("OUTPUT[b]")
    expect(result.results.c.output).toBe("OUTPUT[c]")
  })

  test("feeds dependency outputs into downstream prompts", async () => {
    const specs = [
      makeSpec({ id: "a" }),
      makeSpec({ id: "b", depends_on: ["a"] }),
      makeSpec({ id: "c", depends_on: ["b"] }),
    ]
    const { mock, context } = newFixture({}, { respond: pipelineResponder({ specs }) })

    await runNativeDAGExecution(context, specs, "build it", context.abort)

    const promptC = mock.state.prompts[2]
    expect(promptC.user).toContain("DEPENDENCY OUTPUTS FROM PRIOR AGENTS")
    // Only direct dependencies are injected; c depends on b, not on a.
    expect(promptC.user).toContain("b: OUTPUT[b]")
    expect(promptC.user).not.toContain("a: OUTPUT[a]")
    expect(promptC.user).toContain("build it")
  })

  test("pins the child agent and blocks re-entry tools on every prompt", async () => {
    const specs = [makeSpec({ id: "a", tools: ["read", "orchestrate", "delegate"] as any })]
    const { mock, context } = newFixture({}, { respond: pipelineResponder({ specs }) })

    await runNativeDAGExecution(context, specs, "task", context.abort)

    expect(mock.state.prompts).toHaveLength(1)
    const prompt = mock.state.prompts[0]
    expect(prompt.agent).toBe("build")
    expect(prompt.tools).toMatchObject({ read: true, orchestrate: false, delegate: false })
  })

  test("uses the configured child agent for prompts", async () => {
    const specs = [makeSpec({ id: "a" })]
    const { mock, context } = newFixture({ childAgent: "general" }, { respond: pipelineResponder({ specs }) })

    await runNativeDAGExecution(context, specs, "task", context.abort)

    expect(mock.state.prompts[0].agent).toBe("general")
  })

  test("runs root agents in a single parallel group", async () => {
    const specs = [makeSpec({ id: "a" }), makeSpec({ id: "b" }), makeSpec({ id: "c" })]
    const { mock, context } = newFixture({}, { respond: pipelineResponder({ specs }) })

    const result = await runNativeDAGExecution(context, specs, "task", context.abort)

    expect(result.execution_metadata.total_groups).toBe(1)
    expect(result.execution_metadata.total_agents).toBe(3)
    expect(mock.state.prompts).toHaveLength(3)
    expect(result.execution_metadata.completed).toBe(3)
  })

  test("executes a diamond as three waves", async () => {
    const specs = [
      makeSpec({ id: "a" }),
      makeSpec({ id: "b", depends_on: ["a"] }),
      makeSpec({ id: "c", depends_on: ["a"] }),
      makeSpec({ id: "d", depends_on: ["b", "c"] }),
    ]
    const { mock, context } = newFixture({}, { respond: pipelineResponder({ specs }) })

    const result = await runNativeDAGExecution(context, specs, "task", context.abort)

    expect(result.execution_metadata.total_groups).toBe(3)
    expect(mock.state.prompts.map(p => p.system)).toEqual([
      "SYSTEM_PROMPT_FOR_a",
      "SYSTEM_PROMPT_FOR_b",
      "SYSTEM_PROMPT_FOR_c",
      "SYSTEM_PROMPT_FOR_d",
    ])
    const promptD = mock.state.prompts[3]
    expect(promptD.user).toContain("b: OUTPUT[b]")
    expect(promptD.user).toContain("c: OUTPUT[c]")
  })

  test("rejects an unknown dependency before spawning anything", async () => {
    const specs = [makeSpec({ id: "a", depends_on: ["ghost"] })]
    const { mock, context } = newFixture()

    const error = await runNativeDAGExecution(context, specs, "task", context.abort).catch(e => e)
    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error.message).toContain('unknown agent "ghost"')
    expect(mock.state.created).toHaveLength(0)
  })

  test("rejects a dependency cycle", async () => {
    const specs = [
      makeSpec({ id: "a", depends_on: ["c"] }),
      makeSpec({ id: "b", depends_on: ["a"] }),
      makeSpec({ id: "c", depends_on: ["b"] }),
    ]
    const { context } = newFixture()

    const error = await runNativeDAGExecution(context, specs, "task", context.abort).catch(e => e)
    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error.message).toContain("Dependency cycle detected")
  })

  test("isolates a failing agent instead of failing the group", async () => {
    const specs = [makeSpec({ id: "a" }), makeSpec({ id: "b" })]
    const { context } = newFixture({}, {
      respond: pipelineResponder({ specs }),
      failPrompt: prompt => prompt.system === "SYSTEM_PROMPT_FOR_b",
    })

    const result = await runNativeDAGExecution(context, specs, "task", context.abort)

    expect(result.results.a.status).toBe("completed")
    expect(result.results.b.status).toBe("failed")
    expect(result.results.b.error).toContain("prompt failed")
    expect(result.execution_metadata.completed).toBe(1)
    expect(result.execution_metadata.failed).toBe(1)
  })

  test("warns through progress when an agent requests unknown tools", async () => {
    const specs = [makeSpec({ id: "a", tools: ["read", "time_travel"] })]
    const { context, progress } = newFixture({}, { respond: pipelineResponder({ specs }) })

    await runNativeDAGExecution(context, specs, "task", context.abort)

    const warning = progress.find(p => p.step === "agent-a-tool-warning")
    expect(warning).toBeDefined()
    expect(warning!.message).toContain("time_travel")
  })

  test("aborts immediately when the signal is already aborted", async () => {
    const specs = [makeSpec({ id: "a" })]
    const { context } = newFixture()
    const controller = new AbortController()
    controller.abort()

    await expect(runNativeDAGExecution(context, specs, "task", controller.signal)).rejects.toThrow("aborted")
  })

  test("retries failed prompts using the configured backoff base", async () => {
    const specs = [makeSpec({ id: "a" })]
    let failures = 2
    const { mock, context } = newFixture(
      { maxRetries: 3, baseRetryDelayMs: 1 },
      {
        respond: pipelineResponder({ specs }),
        failPrompt: () => {
          if (failures > 0) {
            failures--
            return true
          }
          return false
        },
      }
    )

    const result = await runNativeDAGExecution(context, specs, "task", context.abort)

    expect(result.results.a.status).toBe("completed")
    expect(result.results.a.output).toBe("OUTPUT[a]")
    expect(mock.state.prompts).toHaveLength(3)
  })

  test("gives up after maxRetries and records the failure", async () => {
    const specs = [makeSpec({ id: "a" })]
    const { mock, context } = newFixture(
      { maxRetries: 1, baseRetryDelayMs: 1 },
      { respond: pipelineResponder({ specs }), failPrompt: () => true }
    )

    const result = await runNativeDAGExecution(context, specs, "task", context.abort)

    expect(result.results.a.status).toBe("failed")
    expect(result.execution_metadata.failed).toBe(1)
    expect(mock.state.prompts).toHaveLength(2)
  })

  test("does not retry when the orchestration signal is aborted mid-flight", async () => {
    const specs = [makeSpec({ id: "a" })]
    const controller = new AbortController()
    const { mock, context } = newFixture(
      { maxRetries: 3, baseRetryDelayMs: 1 },
      {
        respond: pipelineResponder({ specs }),
        failPrompt: () => {
          controller.abort()
          return true
        },
      }
    )

    const result = await runNativeDAGExecution(context, specs, "task", controller.signal)

    expect(result.results.a.status).toBe("failed")
    expect(mock.state.prompts).toHaveLength(1)
  })
})
