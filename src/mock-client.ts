import type { AgentSpec, OrchestratorContext } from "./orchestrator"
import { getOptions } from "./orchestrator"

export interface RecordedPrompt {
  sessionId: string
  system: string
  user: string
  tools?: Record<string, boolean>
  agent?: string
}

export interface MockClientOptions {
  /** Text returned for each prompt, chosen from the recorded prompt. */
  respond?: (prompt: RecordedPrompt, index: number) => string
  /** Artificial delay in session.create (used to trigger timeouts). */
  createDelayMs?: number
  /** Artificial delay in session.prompt (used to trigger timeouts). */
  promptDelayMs?: number
  /**
   * Per-prompt delay override (milliseconds). Takes precedence over
   * `promptDelayMs`, so a test can stall one phase — e.g. a slow analyze
   * call — while later phases answer promptly.
   */
  promptDelay?: (prompt: RecordedPrompt, index: number) => number
  /** Make session.create fail with an SDK-style error. */
  failCreate?: boolean
  /** Make selected prompts fail with an SDK-style error (retried by the engine). */
  failPrompt?: (prompt: RecordedPrompt, index: number) => boolean
}

export interface RecordedSession {
  id: string
  title: string
  parentID?: string
}

export interface RecordedToast {
  title?: string
  message: string
  variant?: string
}

export interface MockClientState {
  created: string[]
  createdTitles: string[]
  /** Full record of every session.create, including the nesting parent. */
  sessionRecords: RecordedSession[]
  deleted: string[]
  prompts: RecordedPrompt[]
  logs: string[]
  openSessions: Set<string>
  /** TUI toasts the plugin asked OpenCode to show. */
  toasts: RecordedToast[]
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createMockClient(options: MockClientOptions = {}) {
  const state: MockClientState = {
    created: [],
    createdTitles: [],
    sessionRecords: [],
    deleted: [],
    prompts: [],
    logs: [],
    openSessions: new Set(),
    toasts: [],
  }
  let nextId = 0

  const client = {
    app: {
      log: async ({ body }: { body?: { message?: string } }) => {
        state.logs.push(String(body?.message ?? ""))
      },
    },
    tui: {
      showToast: async ({ body }: { body?: RecordedToast }) => {
        state.toasts.push(body ?? { message: "" })
        return {}
      },
    },
    session: {
      create: async (args?: { body?: { title?: string; parentID?: string } }) => {
        if (options.createDelayMs) await delay(options.createDelayMs)
        if (options.failCreate) return { data: null, error: "session create failed" }
        const id = `session-${++nextId}`
        const title = args?.body?.title ?? "untitled"
        const parentID = args?.body?.parentID
        state.created.push(id)
        state.createdTitles.push(title)
        state.sessionRecords.push({ id, title, parentID })
        state.openSessions.add(id)
        return { data: { id, title }, error: null }
      },
      prompt: async ({ path, body }: { path: { id: string }; body: any }) => {
        const record: RecordedPrompt = {
          sessionId: path.id,
          system: String(body?.system ?? ""),
          user: String(body?.parts?.[0]?.text ?? ""),
          tools: body?.tools,
          agent: body?.agent,
        }
        const delayMs = options.promptDelay
          ? options.promptDelay(record, state.prompts.length)
          : options.promptDelayMs ?? 0
        if (delayMs > 0) await delay(delayMs)
        state.prompts.push(record)
        const index = state.prompts.length - 1
        if (options.failPrompt?.(record, index)) {
          return { data: null, error: "prompt failed" }
        }
        const text = options.respond ? options.respond(record, index) : ""
        return { data: { parts: [{ type: "text", text }] }, error: null }
      },
      delete: async ({ path }: { path: { id: string } }) => {
        state.deleted.push(path.id)
        state.openSessions.delete(path.id)
        return { data: {}, error: null }
      },
    },
  }

  return { client: client as any, state }
}

export function makeContext(client: any, options: Record<string, unknown> = {}): OrchestratorContext {
  return {
    client,
    project: { id: "test-project" },
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    createdSessions: [],
    options: getOptions(options, process.cwd()),
    customTemplates: new Map(),
  } as unknown as OrchestratorContext
}

export function makeSpec(overrides: Partial<AgentSpec> & { id: string }): AgentSpec {
  return {
    role: "Researcher",
    goal: `Goal of ${overrides.id}`,
    prompt: `SYSTEM_PROMPT_FOR_${overrides.id}`,
    tools: ["read"],
    model_tier: "balanced",
    depends_on: [],
    output_format: "markdown",
    timeout_ms: 1000,
    retry_policy: { max_retries: 0, simplify_on_retry: true },
    ...overrides,
  }
}

export interface PipelineFixtures {
  analysis?: Record<string, unknown>
  specs: AgentSpec[]
  consensus?: Record<string, unknown>
  finalResult?: string
}

/**
 * Routes mock LLM responses by the phase marker embedded in the system prompt,
 * so a single responder drives the whole 5-phase pipeline.
 */
export function pipelineResponder(fixtures: PipelineFixtures) {
  const analysis = fixtures.analysis ?? {
    task_type: "coding",
    complexity: "moderate",
    domains: ["backend"],
    capabilities: ["code_execution"],
    consensus_strategy: "single",
    parallel_groups: [{ group_id: 1, independent: true, subtasks: ["build"] }],
  }
  const consensus = fixtures.consensus ?? {
    consensus_reached: true,
    final_output: "consensus output",
    confidence: 0.9,
    strategy_used: analysis.consensus_strategy,
    rounds_executed: 1,
    agent_contributions: {},
    metadata: { convergence_score: 1 },
  }
  const finalResult = fixtures.finalResult ?? "FINAL SYNTHESIZED RESULT"

  return (prompt: RecordedPrompt): string => {
    // The phase instruction is appended after the bundled agent prompt, so the
    // marker that appears LAST is the one that identifies the current phase.
    const markers: Array<[marker: string, reply: string]> = [
      ["You are in Phase 1: ANALYZE", JSON.stringify(analysis)],
      ["You are in Phase 2: PLAN", JSON.stringify(fixtures.specs)],
      ["You are handling a SIMPLE task", JSON.stringify(fixtures.specs)],
      ["You are in Phase 4: CONSENSUS", JSON.stringify(consensus)],
      ["You are in Phase 5: SYNTHESIZE", finalResult],
    ]
    let bestIndex = -1
    let reply = ""
    for (const [marker, candidate] of markers) {
      const index = prompt.system.indexOf(marker)
      if (index > bestIndex) {
        bestIndex = index
        reply = candidate
      }
    }
    if (bestIndex >= 0) return reply

    const agent = fixtures.specs.find(spec => spec.prompt === prompt.system)
    if (agent) return `OUTPUT[${agent.id}]`
    return "unrouted response"
  }
}
