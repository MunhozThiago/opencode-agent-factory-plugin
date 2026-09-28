import { expect, test, describe, beforeEach } from "bun:test"
import { join } from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import { AgentFactoryPlugin } from "./index"
import { createMockClient, makeSpec, pipelineResponder } from "./mock-client"
import { resetTelemetry, getTelemetrySnapshot } from "./orchestrator"

const LONG_PROMPT = "Design and implement a REST API for a todo application with authentication. ".repeat(8).trim()

function buildPlugin(mockOptions: Parameters<typeof createMockClient>[0] = {}, directory = process.cwd()) {
  const mock = createMockClient(mockOptions)
  const messages: string[] = []
  const input = {
    client: {
      app: {
        log: async ({ body }: { body: { message: string } }) => {
          messages.push(body.message)
          await mock.client.app.log({ body })
        },
      },
      session: mock.client.session,
    },
    project: { id: "project-test" },
    directory,
    worktree: directory,
  } as unknown as PluginInput
  return { mock, messages, input, directory }
}

beforeEach(() => resetTelemetry())

describe("plugin lifecycle", () => {
  test("logs idle sessions through the event lifecycle hook", async () => {
    const messages: string[] = []
    const input = {
      client: {
        app: {
          log: async ({ body }: { body: { message: string } }) => {
            messages.push(body.message)
          },
        },
        session: {
          prompt: async () => ({ data: {}, error: null }),
        },
      },
    } as unknown as PluginInput
    const hooks = await AgentFactoryPlugin(input)

    expect(hooks.event).toBeFunction()
    expect(hooks).not.toHaveProperty("session.idle")
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "session-test" } },
    })
    // Event hook logs idle session and checks for goal (no goal = just logs idle)
    expect(messages).toContain("Agent Factory plugin loaded")
    expect(messages.some(m => m.includes("session-test"))).toBe(true)

    await hooks.event!({
      event: { type: "server.connected", properties: {} },
    })
    // Non-idle events should not add more logs
    expect(messages).toHaveLength(2)
  })

  test("registers every documented tool", async () => {
    const { input } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)

    expect(Object.keys(hooks.tool!).sort()).toEqual([
      "goal_block",
      "goal_clear",
      "goal_complete",
      "goal_pause",
      "goal_resume",
      "goal_set",
      "goal_status",
      "orchestrate",
      "telemetry",
    ])
    expect(hooks.tool!.orchestrate.description).toContain("multi-agent")
    expect(hooks.tool!.orchestrate.args).toHaveProperty("prompt")
    expect(hooks.tool!.orchestrate.args).toHaveProperty("strategy")
  })
})

describe("plugin options forwarding", () => {
  test("forwards options to the orchestrate engine", async () => {
    const { mock, input, messages } = buildPlugin({ createDelayMs: 30 })
    // overallTimeoutMs=1 can only abort the run if the option reaches the engine;
    // with default options this would instead fail phase-1 validation.
    const hooks = await AgentFactoryPlugin(input, { overallTimeoutMs: 1, maxRetries: 0, enableProgress: false })

    const output = (await hooks.tool!.orchestrate.execute(
      { prompt: LONG_PROMPT },
      { abort: new AbortController().signal } as any
    )) as string

    expect(output).toContain("## Orchestration Failed")
    expect(output).toMatch(/abort/i)
    expect(output).not.toContain("task analysis")
    expect(messages.some(m => m.startsWith("[Progress]"))).toBe(false)
    expect(mock.state.deleted).toEqual(mock.state.created)
  })

  test("emits progress logs when enableProgress is left on", async () => {
    const specs = [makeSpec({ id: "a" })]
    const { mock, input, messages } = buildPlugin({
      respond: pipelineResponder({ specs }),
    })
    const hooks = await AgentFactoryPlugin(input, { fastPathThresholdChars: 0 })

    await hooks.tool!.orchestrate.execute({ prompt: "short" }, { abort: new AbortController().signal } as any)

    expect(messages.some(m => m.startsWith("[Progress]"))).toBe(true)
  })
})

describe("orchestrate tool", () => {
  test("runs the pipeline and renders the diagram", async () => {
    const specs = [makeSpec({ id: "a" }), makeSpec({ id: "b", depends_on: ["a"] })]
    const { mock, input } = buildPlugin({
      respond: pipelineResponder({
        analysis: {
          task_type: "coding",
          complexity: "moderate",
          domains: ["backend"],
          capabilities: [],
          consensus_strategy: "single",
          parallel_groups: [],
        },
        specs,
      }),
    })
    const hooks = await AgentFactoryPlugin(input, { fastPathThresholdChars: 0 })

    const output = (await hooks.tool!.orchestrate.execute(
      { prompt: LONG_PROMPT },
      { abort: new AbortController().signal } as any
    )) as string

    expect(output).toContain("# Orchestration Diagram")
    expect(output).toContain("FINAL SYNTHESIZED RESULT")
    expect(output).toContain("Agents spawned: 2")
    expect(mock.state.deleted).toEqual(mock.state.created)
  })
})

describe("goal tools", () => {
  const context = { sessionID: "session-goal-test" } as any
  const parse = (raw: unknown) => JSON.parse(raw as string)

  test("set, status, complete and clear walk the full lifecycle", async () => {
    const { input } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)

    const set = parse(await hooks.tool!.goal_set.execute({ objective: "Ship it" }, context))
    expect(set.status).toBe("active")
    expect(set.goalId).toStartWith("goal-")

    const status = parse(await hooks.tool!.goal_status.execute({}, context))
    expect(status.status).toBe("active")
    expect(status.objective).toBe("Ship it")
    expect(status.turnCount).toBe(0)

    // Completion is rejected until at least one turn has happened
    const early = parse(await hooks.tool!.goal_complete.execute({ evidence: "looks done" }, context))
    expect(early.status).toBe("rejected")
    expect(early.reason).toContain("at least one turn")

    const cleared = parse(await hooks.tool!.goal_clear.execute({}, context))
    expect(cleared.status).toBe("cleared")
    expect(parse(await hooks.tool!.goal_status.execute({}, context)).status).toBe("none")
  })

  test("status reports none when no goal is set", async () => {
    const { input } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)
    expect(parse(await hooks.tool!.goal_status.execute({}, { sessionID: "session-empty" } as any)).status).toBe("none")
  })

  test("block, pause and resume require an existing goal", async () => {
    const { input } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)

    expect(parse(await hooks.tool!.goal_block.execute({ blocker: "x" }, { sessionID: "session-none" } as any)).status).toBe("error")

    await hooks.tool!.goal_set.execute({ objective: "x" }, context)
    expect(parse(await hooks.tool!.goal_pause.execute({}, context)).status).toBe("paused")
    expect(parse(await hooks.tool!.goal_resume.execute({}, context)).status).toBe("active")
    expect(parse(await hooks.tool!.goal_block.execute({ blocker: "waiting" }, context)).status).toBe("blocked")
  })

  test("goal_status exposes checkpoints and completion evidence", async () => {
    const { input } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)
    await hooks.tool!.goal_set.execute({ objective: "x" }, context)
    const status = parse(await hooks.tool!.goal_status.execute({}, context))
    expect(status.checkpoints).toEqual([])
    expect(status.blocker).toBeUndefined()
    expect(status.completionEvidence).toBeUndefined()
    expect(status.maxTurns).toBe(50)
  })
})

describe("telemetry tool", () => {
  test("reports a readable snapshot", async () => {
    const { input } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)

    const snapshot = (await hooks.tool!.telemetry.execute({ action: "snapshot" }, { sessionID: "s" } as any)) as string

    expect(snapshot).toContain("## Telemetry Snapshot")
    expect(snapshot).toContain("0 total")
    expect(snapshot).toContain("Phase Timings")
  })

  test("reset clears counters and unknown actions explain themselves", async () => {
    const { input } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)

    expect((await hooks.tool!.telemetry.execute({ action: "reset" }, { sessionID: "s" } as any))).toBe("Telemetry metrics reset")
    expect(getTelemetrySnapshot().totalOrchestrations).toBe(0)

    const unknown = (await hooks.tool!.telemetry.execute({ action: "nope" }, { sessionID: "s" } as any)) as string
    expect(unknown).toContain("Unknown action")
    expect(unknown).toContain("snapshot, reset, session, cleanup")
  })

  test("session action reports the active orchestrator session", async () => {
    const specs = [makeSpec({ id: "a" })]
    // A dedicated directory keeps this assertion isolated from sessions created
    // by earlier tests, since sessions are keyed by project + directory.
    const directory = join(process.cwd(), ".test-session-store")
    const { input } = buildPlugin({ respond: pipelineResponder({ specs }) }, directory)
    const hooks = await AgentFactoryPlugin(input)

    expect(await hooks.tool!.telemetry.execute({ action: "session" }, { sessionID: "s" } as any)).toBe("No active session")

    await hooks.tool!.orchestrate.execute({ prompt: LONG_PROMPT }, { abort: new AbortController().signal } as any)

    const session = (await hooks.tool!.telemetry.execute({ action: "session" }, { sessionID: "s" } as any)) as string
    expect(session).toContain("## Session Info")
    expect(session).toContain("orchestrator-project-test-")
    expect(session).toContain(directory)
  })

  test("cleanup action completes without error", async () => {
    const { input } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)
    expect(await hooks.tool!.telemetry.execute({ action: "cleanup" }, { sessionID: "s" } as any)).toBe("Old sessions cleaned up")
  })
})

describe("tool execution hooks", () => {
  test("logs orchestrate and task tool executions", async () => {
    const { input, messages } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)

    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "s", callID: "c" }, { args: { agent: "explore" } } as any)
    await hooks["tool.execute.before"]!({ tool: "orchestrate", sessionID: "s", callID: "c" }, { args: { prompt: "build it" } } as any)
    await hooks["tool.execute.after"]!({ tool: "orchestrate", sessionID: "s", callID: "c", args: {} }, { title: "done", output: "", metadata: {} } as any)

    expect(messages.some(m => m.includes("Spawning subagent: explore"))).toBe(true)
    expect(messages.some(m => m.includes("Orchestration started: build it"))).toBe(true)
    expect(messages.some(m => m.includes("Orchestration completed: done"))).toBe(true)
  })

  test("ignores unrelated tools", async () => {
    const { input, messages } = buildPlugin()
    const hooks = await AgentFactoryPlugin(input)
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "ls" } } as any)
    expect(messages.filter(m => m.includes("Spawning subagent") || m.includes("Orchestration started"))).toHaveLength(0)
  })
})
