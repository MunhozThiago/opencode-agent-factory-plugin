import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { RunBlackboard, parseBlackboardBlocks, BLACKBOARD_INSTRUCTION } from "./blackboard"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_OVERALL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_PHASE_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes
const CLEANUP_DEADLINE_MS = 10_000 // never stall the tool return on session cleanup
const MAX_PROMPT_LENGTH = 50000
const VALID_STRATEGIES = ["auto", "single", "debate", "voting", "expert_review", "hierarchical", "mesh", "fipa_contract_net"] as const

// Valid OpenCode tool names.
// `orchestrate` and `delegate` are deliberately absent: a generated child agent
// must not re-enter the orchestration pipeline (that recursion creates sessions
// until the run times out).
const VALID_TOOLS = new Set([
  "read", "edit", "write", "bash", "glob", "grep", "webfetch", "websearch",
  "task", "todowrite", "question",
  "goal_set", "goal_status", "goal_complete", "goal_block", "goal_pause", "goal_resume",
  "goal_clear", "skill", "telemetry"
])

// Plugin configuration options
interface AgentFactoryPluginOptions {
  overallTimeoutMs: number
  phaseTimeoutMs: number
  maxRetries: number
  baseRetryDelayMs: number
  maxAgents: number
  enableReviewLoop: boolean
  maxReviewRounds: number
  enableProgress: boolean
  fastPathThresholdChars: number
  defaultStrategy: typeof VALID_STRATEGIES[number]
  enablePersistentTelemetry: boolean
  telemetryPath: string
  enableTemplateLibrary: boolean
  templateDirs: string[]
  childAgent: string
  enableSessionPool: boolean
  consensusRounds: number
  maxDebateAgents: number
  enableBlackboard: boolean
}

function normalizeStrategy(value: unknown): typeof VALID_STRATEGIES[number] {
  return typeof value === "string" && (VALID_STRATEGIES as readonly string[]).includes(value)
    ? (value as typeof VALID_STRATEGIES[number])
    : "auto"
}

function numOption(value: unknown, fallback: number, min = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback
}

function boolOption(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function getOptions(options?: PluginOptions, projectDir?: string): AgentFactoryPluginOptions {
  const projectRoot = projectDir ?? process.cwd()
  return {
    overallTimeoutMs: numOption(options?.overallTimeoutMs, DEFAULT_OVERALL_TIMEOUT_MS, 1),
    phaseTimeoutMs: numOption(options?.phaseTimeoutMs, DEFAULT_PHASE_TIMEOUT_MS, 1),
    maxRetries: Math.floor(numOption(options?.maxRetries, 2, 0)),
    baseRetryDelayMs: numOption(options?.baseRetryDelayMs, 1000, 0),
    maxAgents: Math.floor(numOption(options?.maxAgents, 12, 1)),
    enableReviewLoop: boolOption(options?.enableReviewLoop, true),
    maxReviewRounds: Math.min(Math.floor(numOption(options?.maxReviewRounds, 1, 0)), 3),
    enableProgress: boolOption(options?.enableProgress, true),
    fastPathThresholdChars: numOption(options?.fastPathThresholdChars, 500, 0),
    defaultStrategy: normalizeStrategy(options?.defaultStrategy),
    enablePersistentTelemetry: boolOption(options?.enablePersistentTelemetry, false),
    telemetryPath: typeof options?.telemetryPath === "string" && options.telemetryPath.length > 0
      ? options.telemetryPath
      : join(projectRoot, ".agent-factory", "telemetry.json"),
    enableTemplateLibrary: boolOption(options?.enableTemplateLibrary, true),
    templateDirs: Array.isArray(options?.templateDirs) && options.templateDirs.length > 0
      ? (options.templateDirs as unknown[]).filter((d): d is string => typeof d === "string")
      : [join(projectRoot, ".opencode", "agents")],
    // Agent used for every child session. Without an explicit agent the child
    // inherits `default_agent`, which may be an orchestrating primary agent that
    // would call `orchestrate` again instead of doing its own work.
    childAgent: typeof options?.childAgent === "string" && options.childAgent.trim().length > 0
      ? options.childAgent.trim()
      : "build",
    // Reuse one child session per agent/reviewer across rounds and fix passes
    // instead of creating a fresh session for every prompt.
    enableSessionPool: boolOption(options?.enableSessionPool, true),
    // Real multi-round consensus: each round every participant sees the
    // peers' previous replies. 1 = the legacy single aggregation call.
    consensusRounds: Math.min(Math.max(Math.floor(numOption(options?.consensusRounds, 2, 1)), 1), 4),
    maxDebateAgents: Math.min(Math.max(Math.floor(numOption(options?.maxDebateAgents, 3, 1)), 1), 12),
    // Run-scoped shared memory: agents post notes (finding/decision/issue/
    // artifact) that every later agent is shown, so a team builds on prior
    // work instead of rediscovering it.
    enableBlackboard: boolOption(options?.enableBlackboard, true),
  }
}

// Performance: prompt cache with file modification time invalidation
interface CacheEntry {
  content: string
  mtimeMs: number
}

const MAX_CACHE_SIZE = 100
const agentPromptCache = new Map<string, CacheEntry>()

// Persistent telemetry path (set at runtime)
let persistentTelemetryPath: string | null = null

// Telemetry: in-memory metrics collector
interface TelemetryMetrics {
  totalOrchestrations: number
  successfulOrchestrations: number
  failedOrchestrations: number
  totalAgentsSpawned: number
  totalExecutionTimeMs: number
  phaseTimings: Record<string, number[]>
  strategyUsage: Record<string, number>
  fastPathUsage: number
  complexPathUsage: number
}

const telemetryMetrics: TelemetryMetrics = {
  totalOrchestrations: 0,
  successfulOrchestrations: 0,
  failedOrchestrations: 0,
  totalAgentsSpawned: 0,
  totalExecutionTimeMs: 0,
  phaseTimings: {},
  strategyUsage: {},
  fastPathUsage: 0,
  complexPathUsage: 0,
}

function recordTelemetry(event: {
  type: "orchestration_start" | "orchestration_complete" | "orchestration_failed"
  strategy?: string
  durationMs?: number
  agentsSpawned?: number
  fastPath?: boolean
}): void {
  if (event.type === "orchestration_complete") {
    telemetryMetrics.totalOrchestrations++
    telemetryMetrics.successfulOrchestrations++
    telemetryMetrics.totalExecutionTimeMs += event.durationMs || 0
    if (event.agentsSpawned) telemetryMetrics.totalAgentsSpawned += event.agentsSpawned
    if (event.strategy) telemetryMetrics.strategyUsage[event.strategy] = (telemetryMetrics.strategyUsage[event.strategy] || 0) + 1
    if (event.fastPath) telemetryMetrics.fastPathUsage++
    else telemetryMetrics.complexPathUsage++
  } else if (event.type === "orchestration_failed") {
    telemetryMetrics.totalOrchestrations++
    telemetryMetrics.failedOrchestrations++
  }

  // Persist to disk if enabled
  saveTelemetry()
}

const MAX_PHASE_TIMINGS_PER_PHASE = 100

function pushPhaseTiming(phase: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return
  if (!telemetryMetrics.phaseTimings[phase]) telemetryMetrics.phaseTimings[phase] = []
  const timings = telemetryMetrics.phaseTimings[phase]
  timings.push(durationMs)
  if (timings.length > MAX_PHASE_TIMINGS_PER_PHASE) timings.shift()
}

function getTelemetrySnapshot(): TelemetryMetrics & { avgExecutionTimeMs: number; avgAgentsPerOrchestration: number } {
  const avgExecutionTimeMs = telemetryMetrics.successfulOrchestrations > 0 
    ? telemetryMetrics.totalExecutionTimeMs / telemetryMetrics.successfulOrchestrations 
    : 0
  const avgAgentsPerOrchestration = telemetryMetrics.successfulOrchestrations > 0
    ? telemetryMetrics.totalAgentsSpawned / telemetryMetrics.successfulOrchestrations
    : 0
    
  return {
    ...telemetryMetrics,
    avgExecutionTimeMs: Math.round(avgExecutionTimeMs),
    avgAgentsPerOrchestration: Math.round(avgAgentsPerOrchestration * 100) / 100,
  }
}

function resetTelemetry(): void {
  telemetryMetrics.totalOrchestrations = 0
  telemetryMetrics.successfulOrchestrations = 0
  telemetryMetrics.failedOrchestrations = 0
  telemetryMetrics.totalAgentsSpawned = 0
  telemetryMetrics.totalExecutionTimeMs = 0
  telemetryMetrics.phaseTimings = {}
  telemetryMetrics.strategyUsage = {}
  telemetryMetrics.fastPathUsage = 0
  telemetryMetrics.complexPathUsage = 0
}

// Persistent telemetry: save/load from disk
function saveTelemetry(): void {
  if (!persistentTelemetryPath) return
  try {
    const dir = dirname(persistentTelemetryPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(persistentTelemetryPath, JSON.stringify(telemetryMetrics, null, 2))
  } catch {
    // Best effort
  }
}

function loadTelemetry(): void {
  if (!persistentTelemetryPath || !existsSync(persistentTelemetryPath)) return
  try {
    const data = JSON.parse(readFileSync(persistentTelemetryPath, "utf-8"))
    Object.assign(telemetryMetrics, data)
  } catch {
    // Best effort
  }
}

// Session persistence: store orchestrator state for reuse
interface PersistedSession {
  sessionId: string
  createdAt: number
  lastUsed: number
  orchestrations: number
  contextSnapshot: {
    projectId: string
    directory: string
    worktree: string
  }
}

// In-memory session store with size limit
const MAX_SESSIONS = 50
const sessionStore = new Map<string, PersistedSession>()

function getOrCreateSession(context: OrchestratorContext): string {
  const key = `${context.project.id}:${context.directory}`
  let session = sessionStore.get(key)
  
  if (!session) {
    // Evict oldest session if store is full
    if (sessionStore.size >= MAX_SESSIONS) {
      const oldestKey = Array.from(sessionStore.entries())
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]?.[0]
      if (oldestKey) sessionStore.delete(oldestKey)
    }
    
    session = {
      sessionId: `orchestrator-${context.project.id}-${Date.now()}`,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      orchestrations: 0,
      contextSnapshot: {
        projectId: context.project.id,
        directory: context.directory,
        worktree: context.worktree,
      },
    }
    sessionStore.set(key, session)
  }
  
  session.lastUsed = Date.now()
  session.orchestrations++
  return session.sessionId
}

function getSessionInfo(context: OrchestratorContext): PersistedSession | null {
  const key = `${context.project.id}:${context.directory}`
  return sessionStore.get(key) || null
}

function cleanupOldSessions(maxAgeMs = 24 * 60 * 60 * 1000): void {
  const now = Date.now()
  for (const [key, session] of sessionStore.entries()) {
    if (now - session.lastUsed > maxAgeMs) {
      sessionStore.delete(key)
    }
  }
}

// ============================================================================
// ORCHESTRATION STATE MANAGEMENT (Goal-like workflow)
// ============================================================================

interface OrchestrationGoal {
  id: string
  sessionId: string
  objective: string
  status: "active" | "paused" | "blocked" | "completed"
  createdAt: number
  updatedAt: number
  checkpoints: string[]
  blocker?: string
  completionEvidence?: string
  turnCount: number
  maxTurns: number
}

// In-memory goal store keyed by session ID
const goalStore = new Map<string, OrchestrationGoal>()

// Goal persistence path
let goalPersistencePath: string | null = null

function saveGoals(): void {
  if (!goalPersistencePath) return
  try {
    const dir = dirname(goalPersistencePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data = Array.from(goalStore.entries())
    writeFileSync(goalPersistencePath, JSON.stringify(data, null, 2))
  } catch {
    // Best effort
  }
}

function loadGoals(): void {
  if (!goalPersistencePath || !existsSync(goalPersistencePath)) return
  try {
    const data = JSON.parse(readFileSync(goalPersistencePath, "utf-8"))
    goalStore.clear()
    for (const [key, value] of data) {
      goalStore.set(key, value)
    }
  } catch {
    // Best effort
  }
}

function setGoal(sessionId: string, objective: string, maxTurns = 50): OrchestrationGoal {
  const goal: OrchestrationGoal = {
    id: `goal-${Date.now()}`,
    sessionId,
    objective,
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    checkpoints: [],
    turnCount: 0,
    maxTurns,
  }
  goalStore.set(sessionId, goal)
  saveGoals()
  return goal
}

function getGoal(sessionId: string): OrchestrationGoal | null {
  return goalStore.get(sessionId) || null
}

function updateGoal(sessionId: string, updates: Partial<OrchestrationGoal>): OrchestrationGoal | null {
  const goal = goalStore.get(sessionId)
  if (!goal) return null
  Object.assign(goal, updates, { updatedAt: Date.now() })
  goalStore.set(sessionId, goal)
  saveGoals()
  return goal
}

function completeGoal(sessionId: string, evidence: string): OrchestrationGoal | null {
  return updateGoal(sessionId, {
    status: "completed",
    completionEvidence: evidence,
  })
}

function blockGoal(sessionId: string, blocker: string): OrchestrationGoal | null {
  return updateGoal(sessionId, {
    status: "blocked",
    blocker,
  })
}

function pauseGoal(sessionId: string): OrchestrationGoal | null {
  return updateGoal(sessionId, { status: "paused" })
}

function resumeGoal(sessionId: string): OrchestrationGoal | null {
  return updateGoal(sessionId, { status: "active" })
}

function clearGoal(sessionId: string): boolean {
  const deleted = goalStore.delete(sessionId)
  saveGoals()
  return deleted
}

function incrementTurnCount(sessionId: string): number {
  const goal = goalStore.get(sessionId)
  if (!goal) return 0
  goal.turnCount++
  goal.updatedAt = Date.now()
  goalStore.set(sessionId, goal)
  saveGoals()
  return goal.turnCount
}

// Goal guard: prevents premature completion
function validateCompletion(sessionId: string, evidence: string): { valid: boolean; reason?: string } {
  const goal = goalStore.get(sessionId)
  if (!goal) return { valid: false, reason: "No active goal" }
  if (goal.status !== "active") return { valid: false, reason: `Goal is ${goal.status}` }
  if (!evidence || evidence.trim().length === 0) return { valid: false, reason: "Completion requires evidence" }
  if (goal.turnCount < 1) return { valid: false, reason: "Goal must have at least one turn before completion" }
  return { valid: true }
}

interface ProgressEvent {
  phase: string
  step: string
  progress: number // 0-100
  message: string
  metadata?: Record<string, unknown>
}

type ProgressCallback = (event: ProgressEvent) => void

function emitProgress(context: OrchestratorContext, event: ProgressEvent): void {
  if (context.options?.enableProgress !== false && context.onProgress) {
    context.onProgress(event)
  }
  if (context.options?.enableProgress !== false) {
    // Fire-and-forget: a logging failure must not break the pipeline.
    void Promise.resolve(
      context.client.app.log({
        body: {
          service: "agent-factory",
          level: "info",
          message: `[Progress] ${event.phase}: ${event.step} (${event.progress}%) - ${event.message}`,
          extra: { progress: event.progress, phase: event.phase, ...event.metadata },
        },
      })
    ).catch(() => {})
  }
}

// ============================================================================
// LIVE SUB-AGENT VISIBILITY
// ============================================================================
// OpenCode forwards every server event to the plugin's `event` hook. While a
// run is active the orchestrator registers a forwarder, so each child session's
// tool calls, reasoning and text deltas are turned into progress events — the
// same visibility the built-in task tool gives its background subagents.
type RunEventForwarder = (event: any) => void

const runEventForwarders = new Set<RunEventForwarder>()

export function addRunEventForwarder(forwarder: RunEventForwarder): () => void {
  runEventForwarders.add(forwarder)
  return () => {
    runEventForwarders.delete(forwarder)
  }
}

/** Called by the plugin for every server event (see index.ts). */
export function forwardRunEvent(event: any): void {
  if (runEventForwarders.size === 0) return
  for (const forwarder of [...runEventForwarders]) {
    try {
      forwarder(event)
    } catch {
      // Observation must never break the run it is observing.
    }
  }
}

/** Two activity lines per agent per second is plenty; nothing else floods. */
const ACTIVITY_THROTTLE_MS = 500

function activityFromPart(
  part: any,
  delta?: unknown,
): { message: string; progress: number; kind: string } | null {
  const streamed = typeof delta === "string" && delta.length > 0 ? delta : undefined
  switch (part?.type) {
    case "tool": {
      const status = part.state?.status ? ` (${part.state.status})` : ""
      return { kind: "tool", progress: 45, message: `tool ${part.tool ?? "unknown"}${status}` }
    }
    case "text": {
      const sample = String(streamed ?? part.text ?? "").trim().replace(/\s+/g, " ")
      if (!sample) return null
      return { kind: "text", progress: 65, message: sample.slice(0, 96) }
    }
    case "reasoning":
      return { kind: "reasoning", progress: 30, message: "thinking…" }
    case "step-start":
      return { kind: "step", progress: 20, message: "starting next step" }
    case "step-finish":
      return { kind: "step", progress: 90, message: "step complete" }
    case "subtask":
      return {
        kind: "subtask",
        progress: 25,
        message: `subtask: ${String(part.description ?? part.prompt ?? "")}`.slice(0, 96),
      }
    default:
      return null
  }
}

function handleRunEvent(
  context: OrchestratorContext,
  event: any,
  lastEmit: Map<string, number>,
  highWater: Map<string, number>,
): void {
  if (!event || typeof event !== "object") return
  const props = event.properties ?? {}
  const sessionID =
    event.type === "message.part.updated" ? props.part?.sessionID : props.sessionID
  if (!sessionID) return
  const title = context.sessionTitles?.get(sessionID)
  if (!title) return // not a child session of this run

  let message: string
  let target: number
  let kind: string
  if (event.type === "message.part.updated") {
    const derived = activityFromPart(props.part, props.delta)
    if (!derived) return
    ;({ message, progress: target, kind } = derived)
  } else if (event.type === "session.status" && props.status?.type === "busy") {
    message = "working"
    kind = "status"
    target = 15
  } else if (event.type === "session.status" && props.status?.type === "retry") {
    message = `retrying (attempt ${props.status.attempt ?? "?"})`
    kind = "status"
    target = 15
  } else if (event.type === "session.idle") {
    message = "finished"
    kind = "status"
    target = 100
  } else {
    return
  }

  const finished = target >= 100
  const now = Date.now()
  if (!finished && now - (lastEmit.get(sessionID) ?? 0) < ACTIVITY_THROTTLE_MS) return
  lastEmit.set(sessionID, now)

  // Progress only ever moves forward, so a late "starting next step" cannot
  // walk the bar backwards after an agent already reported 90%.
  const progress = Math.min(100, Math.max(highWater.get(sessionID) ?? 0, target))
  highWater.set(sessionID, progress)

  emitProgress(context, {
    phase: "agents",
    step: `agent:${title}`,
    progress,
    message,
    metadata: { sessionId: sessionID, agent: title, kind },
  })
}

/** Subscribe this run to live child-session activity; call the return value to stop. */
function startChildActivityWatcher(context: OrchestratorContext): () => void {
  if (context.options?.enableProgress === false) return () => {}
  const lastEmit = new Map<string, number>()
  const highWater = new Map<string, number>()
  return addRunEventForwarder(event => {
    try {
      handleRunEvent(context, event, lastEmit, highWater)
    } catch {
      // never let the inspector take a run down
    }
  })
}

class OrchestrationError extends Error {
  constructor(
    message: string,
    public readonly phase: string,
    public readonly cause?: Error,
    public readonly recoverable = false
  ) {
    super(message)
    this.name = "OrchestrationError"
  }
}

function validateInput(prompt: string, strategy: string): void {
  if (!prompt || prompt.trim().length === 0) {
    throw new OrchestrationError("Prompt cannot be empty", "input", undefined, false)
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new OrchestrationError(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`, "input", undefined, false)
  }
  if (!VALID_STRATEGIES.includes(strategy as any)) {
    throw new OrchestrationError(`Invalid strategy: ${strategy}. Valid: ${VALID_STRATEGIES.join(", ")}`, "input", undefined, false)
  }
}

function getAgentPrompt(name: string, customTemplates?: Map<string, string>): string {
  // Check custom templates first
  if (customTemplates?.has(name)) {
    return customTemplates.get(name)!
  }
  
  // Performance: cache agent prompts with file modification time invalidation
  const pluginDir = join(__dirname, "..")
  const agentFile = join(pluginDir, "agents", `${name}.md`)
  
  if (existsSync(agentFile)) {
    const stat = statSync(agentFile)
    const cached = agentPromptCache.get(name)
    
    // Return cached if file hasn't changed
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.content
    }
    
    // Read fresh content
    const content = readFileSync(agentFile, "utf-8")
    
    // Evict oldest entry if cache is full
    if (agentPromptCache.size >= MAX_CACHE_SIZE) {
      const firstKey = agentPromptCache.keys().next().value
      if (firstKey) agentPromptCache.delete(firstKey)
    }
    
    agentPromptCache.set(name, { content, mtimeMs: stat.mtimeMs })
    return content
  }
  return ""
}

// Load agent templates from custom directories
function loadCustomAgentTemplates(templateDirs: string[]): Map<string, string> {
  const templates = new Map<string, string>()
  
  for (const dir of templateDirs) {
    if (!existsSync(dir)) continue
    
    const files = readdirSync(dir).filter(f => f.endsWith(".md"))
    for (const file of files) {
      const name = file.replace(/\.md$/, "")
      const filePath = join(dir, file)
      const content = readFileSync(filePath, "utf-8")
      templates.set(name, content)
    }
  }
  
  return templates
}

// Validate agent tool names
function validateAgentTools(tools: string[]): { valid: string[]; invalid: string[] } {
  const valid: string[] = []
  const invalid: string[] = []
  
  for (const t of tools) {
    if (VALID_TOOLS.has(t)) {
      valid.push(t)
    } else {
      invalid.push(t)
    }
  }
  
  return { valid, invalid }
}

interface TaskAnalysis {
  task_type:
    | "coding" | "research" | "analysis" | "creative" | "debugging" | "planning"
    | "decision" | "evaluation" | "synthesis"
  complexity: "simple" | "moderate" | "complex"
  domains: string[]
  capabilities: string[]
  consensus_strategy: "single" | "debate" | "voting" | "expert_review" | "hierarchical"
  parallel_groups: {
    group_id: number
    independent: boolean
    depends_on?: number[]
    subtasks: string[]
  }[]
}

interface AgentSpec {
  id: string
  role: string
  goal: string
  prompt: string
  tools: string[]
  model_tier: "powerful" | "balanced" | "fast"
  depends_on: string[]
  output_format: "json" | "markdown" | "code" | "structured_text"
  timeout_ms: number
  retry_policy: { max_retries: number; simplify_on_retry: boolean }
  /** File paths/globs this agent alone may write. Agents with overlapping
   *  outputs are serialized into dependency order by normalizeAgentSpecs. */
  outputs?: string[]
}

interface AgentExecutionResult {
  status: "completed" | "failed" | "timeout"
  output: string
  error: string | null
  duration_ms: number
}

interface ExecutionResult {
  results: Record<string, AgentExecutionResult>
  execution_metadata: {
    total_groups: number
    total_agents: number
    completed: number
    failed: number
    total_time_ms: number
  }
}

interface ConsensusResult {
  consensus_reached: boolean
  final_output: string
  confidence: number
  strategy_used: string
  rounds_executed: number
  agent_contributions: Record<string, { weight: number; accepted: boolean }>
  metadata: { convergence_score: number }
}

// Whatever a run produced before it stopped. Used to render the schematic
// alongside a failure instead of returning a bare error with no context.
interface RunDiagnostics {
  analysis?: TaskAnalysis
  specs?: AgentSpec[]
  execution?: ExecutionResult
  consensus?: ConsensusResult
  phaseTimings?: Record<string, number>
  strategyReasoning?: string
  strategy?: string
}

interface OrchestratorContext {
  client: PluginInput["client"]
  project: PluginInput["project"]
  directory: PluginInput["directory"]
  worktree: PluginInput["worktree"]
  abort: AbortSignal
  createdSessions: string[]
  onProgress?: ProgressCallback
  options: AgentFactoryPluginOptions
  customTemplates?: Map<string, string>
  /** Session id promises keyed by pool key (one entry per agent/reviewer per run). */
  pool?: Map<string, Promise<string>>
  /** Absolute ms timestamp of the overall budget; extra rounds stop before it. */
  deadlineAt?: number
  /**
   * Live model prompts, mapped to the session they are streaming into.
   * Cleanup must not delete a session while one of these is outstanding:
   * that is what made OpenCode's SQLite layer throw FOREIGN KEY errors on
   * `part`/`message` inserts and left orphaned LLM calls running after the
   * run had already returned.
   */
  inFlight?: Map<Promise<unknown>, string>
  /** Whatever the run learned before it failed — rendered with the error. */
  partial?: RunDiagnostics
  /**
   * Session that invoked `orchestrate`. Children are created with this as
   * `parentID` so the TUI nests them under the calling session instead of
   * leaving them as anonymous top-level sessions nobody can find.
   */
  parentSessionID?: string
  /** Child session id -> its title, used to attribute live server events. */
  sessionTitles?: Map<string, string>
  /** Run-scoped shared memory between the agents of this run. */
  blackboard?: RunBlackboard
}

function createTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = () => controller.abort()
  externalSignal?.addEventListener("abort", onExternalAbort)
  if (externalSignal?.aborted) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeoutId)
      externalSignal?.removeEventListener("abort", onExternalAbort)
    },
  }
}

// Runs one pipeline phase under its own phase timeout while remaining
// interruptible by the overall orchestration signal.
async function withPhase<T>(
  context: OrchestratorContext,
  outerSignal: AbortSignal,
  phase: string,
  fn: (phaseSignal: AbortSignal) => Promise<T>,
  timeoutMs: number = context.options.phaseTimeoutMs
): Promise<T> {
  checkAbort(outerSignal, phase)
  const { signal, dispose } = createTimeoutSignal(timeoutMs, outerSignal)
  const deadlineError = (): OrchestrationError =>
    outerSignal.aborted
      ? new OrchestrationError(`Operation aborted during ${phase}`, phase, undefined, true)
      : new OrchestrationError(
          `Phase "${phase}" exceeded phase timeout of ${timeoutMs}ms`,
          phase,
          undefined,
          true
        )
  // A phase callee may await network calls that never observe our signal, so
  // racing the deadline here is the only way to guarantee a hung model call
  // can never outlive its phase timeout or the overall run timeout.
  const deadline = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(deadlineError())
      return
    }
    signal.addEventListener("abort", () => reject(deadlineError()), { once: true })
  })
  try {
    return await Promise.race([
      fn(signal).catch((error: unknown) => {
        if (signal.aborted && !outerSignal.aborted) {
          throw new OrchestrationError(
            `Phase "${phase}" exceeded phase timeout of ${timeoutMs}ms`,
            phase,
            error instanceof Error ? error : undefined,
            true
          )
        }
        throw error
      }),
      deadline,
    ])
  } finally {
    dispose()
  }
}

function checkAbort(signal: AbortSignal, phase: string): void {
  if (signal.aborted) {
    throw new OrchestrationError(`Operation aborted during ${phase}`, phase, undefined, true)
  }
}

async function withRetry<T>(
  context: OrchestratorContext,
  fn: () => Promise<T>,
  phase: string,
  signal?: AbortSignal
): Promise<T> {
  const maxRetries = context.options.maxRetries
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      // Don't retry on abort: either the caller's signal or the orchestration signal
      if (lastError.name === "AbortError" || (signal ?? context.abort).aborted || context.abort.aborted) {
        throw lastError
      }
      // Non-recoverable errors (bad config/model) retrying only wastes the budget
      if (lastError instanceof OrchestrationError && !lastError.recoverable) {
        throw lastError
      }
      if (attempt < maxRetries) {
        // Exponential backoff with jitter, capped at 10s
        const delay = Math.min(
          context.options.baseRetryDelayMs * Math.pow(2, attempt) + Math.random() * 500,
          10000
        )
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  const attempts = maxRetries + 1
  throw new OrchestrationError(
    `${phase} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastError?.message ?? "unknown error"}`,
    phase,
    lastError,
    true
  )
}

// Performance: optimized JSON extraction with single pass
function extractJson<T>(text: string): T | null {
  if (!text || text.trim().length === 0) return null
  
  // Fast path: try direct parse first (common for well-formed responses)
  const trimmed = text.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed) } catch { /* continue */ }
  }
  
  // Extract from markdown code blocks
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()) } catch { /* continue */ }
  }
  
  // Find JSON boundaries - skip strings to avoid false matches
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) { escape = false; continue }
    if (ch === "\\") { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "{" || ch === "[") {
      start = i
      break
    }
  }
  if (start === -1) return null
  
  // Find matching closing bracket
  const openChar = trimmed[start]
  const closeChar = openChar === "{" ? "}" : "]"
  let depth = 0
  let end = start
  inString = false
  escape = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) { escape = false; continue }
    if (ch === "\\") { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === openChar) depth++
    else if (ch === closeChar) depth--
    if (depth === 0) { end = i + 1; break }
  }
  
  const candidate = trimmed.slice(start, end)
  try { return JSON.parse(candidate) } catch {
    // Try fixing trailing commas
    try { return JSON.parse(candidate.replace(/,\s*([\]}])/g, "$1")) } catch { return null }
  }
}

function validateTaskAnalysis(analysis: any): analysis is TaskAnalysis {
  return Boolean(
    analysis &&
    typeof analysis === "object" &&
    ["coding", "research", "analysis", "creative", "debugging", "planning", "decision", "evaluation", "synthesis"].includes(analysis.task_type) &&
    ["simple", "moderate", "complex"].includes(analysis.complexity) &&
    Array.isArray(analysis.domains) &&
    Array.isArray(analysis.capabilities) &&
    ["single", "debate", "voting", "expert_review", "hierarchical", "mesh", "fipa_contract_net"].includes(analysis.consensus_strategy) &&
    Array.isArray(analysis.parallel_groups)
  )
}

const MODEL_TIER_ALIASES: Record<string, AgentSpec["model_tier"]> = {
  powerful: "powerful", high: "powerful", premium: "powerful",
  balanced: "balanced", medium: "balanced", standard: "balanced",
  fast: "fast", low: "fast", cheap: "fast", light: "fast",
}

const OUTPUT_FORMAT_ALIASES: Record<string, AgentSpec["output_format"]> = {
  json: "json",
  markdown: "markdown", md: "markdown",
  code: "code",
  structured_text: "structured_text", structured: "structured_text",
  text: "markdown", plain: "markdown", prose: "markdown",
}

function specString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function specStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/[\s,]+/).map(v => v.trim()).filter(Boolean)
  }
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map(v => v.trim())
  }
  return []
}

function normalizeOutputPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase()
}

// Returns one shared path when two agents' write targets can collide
// (identical path, one nested under the other, or overlapping glob prefixes).
function sharedOutput(a?: string[], b?: string[]): string | null {
  if (!a || !b || a.length === 0 || b.length === 0) return null
  for (const x of a) {
    for (const y of b) {
      if (x === y) return x
      if (x.startsWith(`${y}/`)) return x
      if (y.startsWith(`${x}/`)) return y
      const xBase = x.split("*")[0]
      const yBase = y.split("*")[0]
      if (xBase.length > 0 && yBase.length > 0 && (xBase.startsWith(yBase) || yBase.startsWith(xBase))) {
        return x
      }
    }
  }
  return null
}

function unwrapSpecList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>
    for (const key of ["agents", "specs", "agent_specs", "items", "results", "data"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[]
    }
    if (record.prompt || record.system_prompt || record.goal) return [raw]
  }
  return null
}

// Coerce a model-generated spec list into AgentSpec[]. Near-miss values (wrong
// vocabulary, missing retry policy, object wrappers) are repaired instead of
// failing the whole orchestration; every repair is reported as an issue.
function normalizeAgentSpecs(raw: unknown, maxAgents = 12): { specs: AgentSpec[]; issues: string[] } {
  const issues: string[] = []
  const list = unwrapSpecList(raw)
  if (!list) return { specs: [], issues: ["response was not an array of agent specs"] }

  const specs: AgentSpec[] = []
  const seenIds = new Set<string>()

  list.forEach((entry, index) => {
    const label = `spec[${index}]`
    if (!entry || typeof entry !== "object") {
      issues.push(`${label}: not an object`)
      return
    }

    const source = entry as Record<string, unknown>
    const role = specString(source.role) || `Agent ${index + 1}`
    const goal = specString(source.goal)
    const prompt = specString(source.prompt) || specString(source.system) || specString(source.system_prompt)
    if (!goal || !prompt) {
      issues.push(`${label}: missing goal or prompt`)
      return
    }

    const rawTier = specString(source.model_tier).toLowerCase()
    if (rawTier && !MODEL_TIER_ALIASES[rawTier]) {
      issues.push(`${label}: unknown model_tier "${rawTier}", using "balanced"`)
    }

    const rawFormat = specString(source.output_format ?? source.output)
      .toLowerCase()
      .replace(/[\s-]+/g, "_")
    if (rawFormat && !OUTPUT_FORMAT_ALIASES[rawFormat]) {
      issues.push(`${label}: unknown output_format "${rawFormat}", using "markdown"`)
    }

    const timeoutRaw = source.timeout_ms ?? source.timeout
    const timeoutMs = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? timeoutRaw
      : 120000

    const retryRaw = source.retry_policy as unknown
    const retrySource = (retryRaw && typeof retryRaw === "object" ? retryRaw : null) as Record<string, unknown> | null
    const retryPolicy = typeof retryRaw === "number"
      ? { max_retries: retryRaw, simplify_on_retry: true }
      : retrySource && typeof retrySource.max_retries === "number"
        ? { max_retries: retrySource.max_retries, simplify_on_retry: retrySource.simplify_on_retry !== false }
        : { max_retries: 1, simplify_on_retry: true }

    let id = specString(source.id)
      || role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      || `agent-${index + 1}`
    if (seenIds.has(id)) {
      id = `${id}-${index + 1}`
      issues.push(`${label}: duplicate id, renamed to "${id}"`)
    }
    seenIds.add(id)

    const outputs = Array.from(new Set(
      specStringList(source.outputs ?? source.output_files ?? source.writes ?? source.files)
        .map(normalizeOutputPath)
        .filter(Boolean)
    ))

    specs.push({
      id,
      role,
      goal,
      prompt,
      tools: specStringList(source.tools),
      model_tier: MODEL_TIER_ALIASES[rawTier] ?? "balanced",
      depends_on: specStringList(source.depends_on ?? source.dependencies),
      output_format: OUTPUT_FORMAT_ALIASES[rawFormat] ?? "markdown",
      timeout_ms: timeoutMs,
      retry_policy: retryPolicy,
      ...(outputs.length > 0 ? { outputs } : {}),
    })
  })

  const capped = specs.slice(0, maxAgents)
  if (capped.length < specs.length) {
    issues.push(`truncated ${specs.length} agent specs to maxAgents=${maxAgents}`)
  }

  // Resolve dependencies against the agents we are actually going to run:
  // invented ids, self-references and ids dropped by the cap must not abort
  // the whole orchestration.
  const known = new Set(capped.map(s => s.id))
  for (const spec of capped) {
    const seenDeps = new Set<string>()
    spec.depends_on = spec.depends_on.filter(dep => {
      if (seenDeps.has(dep)) return false
      seenDeps.add(dep)
      if (dep === spec.id) {
        issues.push(`spec "${spec.id}": dropped self-dependency`)
        return false
      }
      if (!known.has(dep)) {
        issues.push(`spec "${spec.id}": dropped unknown dependency "${dep}"`)
        return false
      }
      return true
    })
  }

  // File-producing agents: agents that can write the same file are serialized
  // into dependency order, so writes happen in parallel only when they cannot
  // collide. Already-ordered pairs are left alone.
  const reaches = (from: string, to: string): boolean => {
    const stack = [from]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const current = stack.pop()!
      if (current === to) return true
      if (seen.has(current)) continue
      seen.add(current)
      const spec = capped.find(s => s.id === current)
      if (spec) stack.push(...spec.depends_on)
    }
    return false
  }
  for (let i = 0; i < capped.length; i++) {
    for (let j = i + 1; j < capped.length; j++) {
      const earlier = capped[i]
      const later = capped[j]
      if (later.depends_on.includes(earlier.id) || earlier.depends_on.includes(later.id)) continue
      if (reaches(later.id, earlier.id) || reaches(earlier.id, later.id)) continue
      const shared = sharedOutput(earlier.outputs, later.outputs)
      if (!shared) continue
      later.depends_on.push(earlier.id)
      issues.push(`spec "${later.id}": serialized behind "${earlier.id}" (overlapping output "${shared}")`)
    }
  }

  return { specs: capped, issues }
}
// Sleep that rejects as soon as the signal aborts, so a retry backoff cannot
// outlive the orchestration timeout.
function abortableDelay(ms: number, signal: AbortSignal, phase: string): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new OrchestrationError(`Aborted during ${phase} backoff`, phase, undefined, true))
  }
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new OrchestrationError(`Aborted during ${phase} backoff`, phase, undefined, true))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

// Local TaskAnalysis built without an LLM round-trip. Used when Phase 1
// (analyze) blows its phase timeout on a slow provider, so the run degrades
// to a prompt-derived analysis instead of failing outright. Parse failures
// stay fatal — a model that cannot produce TaskAnalysis JSON would fail the
// later phases the same way.
function localAnalysis(task: string, strategyOverride: string): TaskAnalysis {
  const explicit = strategyOverride !== "auto" ? strategyOverride : undefined
  const complexity: TaskAnalysis["complexity"] =
    task.length <= 120 ? "simple" : task.length <= 600 ? "moderate" : "complex"
  // Prefer the override; otherwise pick something proportional to complexity.
  const chosen =
    explicit ??
    (complexity === "simple"
      ? "single"
      : complexity === "moderate"
        ? "voting"
        : "debate")
  return {
    task_type: "coding",
    complexity,
    domains: ["general"],
    capabilities: ["code_execution"],
    consensus_strategy: (VALID_STRATEGIES as readonly string[]).includes(chosen) && chosen !== "auto"
      ? chosen as TaskAnalysis["consensus_strategy"]
      : "debate",
    parallel_groups: [{ group_id: 1, independent: true, subtasks: [task.slice(0, 100)] }],
  }
}

// Generates AgentSpec[] from a child session and repairs near-miss output.
// Last-resort spec built locally (no LLM round-trip) when every planner
// attempt failed: the run degrades to one agent covering the whole task
// instead of returning a hard failure to the user.
function soloAgentSpec(task: string, timeoutMs: number): AgentSpec {
  return {
    id: "solo-worker",
    role: "Generalist",
    goal: task.slice(0, 300),
    prompt: [
      "You are the sole worker on this task. Complete it end to end:",
      "read the relevant context, do the work, and return the full deliverable",
      "as your final message.",
      "",
      `Task: ${task}`,
    ].join("\n"),
    tools: ["read", "edit", "write", "bash", "glob", "grep", "webfetch", "websearch"],
    model_tier: "powerful",
    depends_on: [],
    output_format: "markdown",
    timeout_ms: timeoutMs,
    retry_policy: { max_retries: 1, simplify_on_retry: true },
  }
}

// The model sometimes answers with prose (or does the task itself) instead of
// JSON, so a failed parse is retried with an explicit JSON-only reminder.
async function generateAgentSpecs(
  context: OrchestratorContext,
  title: string,
  phase: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  progress: number
): Promise<{ specs: AgentSpec[]; issues: string[] }> {
  const maxAttempts = Math.max(context.options.maxRetries, 1) + 1
  let lastError = new OrchestrationError("Agent spec generation did not run", phase, undefined, true)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    checkAbort(signal, phase)
    try {
      const child = await createChildSession(context, title, signal)
      const reminder = attempt > 0
        ? "\n\nREMINDER: reply with ONLY the AgentSpec[] JSON array. Do not perform the task, write files, run commands, or explain - output raw JSON."
        : ""
      const response = await promptSession(context, child.id, systemPrompt, userPrompt + reminder, undefined, signal)
      const text = String(response.parts.find((p: any) => p.type === "text")?.text ?? "")
      const raw = extractJson<unknown>(text)
      if (raw === null) {
        throw new OrchestrationError(
          `Failed to parse agent specs: no JSON found in the response (it began with "${text.slice(0, 120).replace(/\s+/g, " ")}")`,
          phase,
          undefined,
          true
        )
      }
      const { specs, issues } = normalizeAgentSpecs(raw, context.options.maxAgents)
      if (specs.length === 0) {
        throw new OrchestrationError(
          `No usable agent specs in the response: ${issues.slice(0, 5).join("; ") || "empty spec list"}`,
          phase,
          undefined,
          true
        )
      }
      return { specs, issues }
    } catch (error) {
      lastError = error instanceof OrchestrationError
        ? error
        : new OrchestrationError(
            error instanceof Error ? error.message : String(error),
            phase,
            error instanceof Error ? error : undefined,
            true
          )
      if (signal.aborted || context.abort.aborted) throw lastError
      // A non-recoverable failure (bad model id, invalid API key, broken config)
      // will fail identically on every attempt - don't burn retries on it.
      if (!lastError.recoverable) throw lastError
      if (attempt + 1 < maxAttempts) {
        emitProgress(context, {
          phase,
          step: "spec-retry",
          progress,
          message: `Agent spec generation failed, retrying (attempt ${attempt + 2}/${maxAttempts})`,
          metadata: { attempt: attempt + 2, maxAttempts }
        })
        const backoff = Math.min(context.options.baseRetryDelayMs * Math.pow(2, attempt), 10000)
        await abortableDelay(backoff, signal, phase)
      }
    }
  }
  throw lastError
}

function validateAgentSpecs(specs: any): specs is AgentSpec[] {
  return Boolean(Array.isArray(specs) && specs.every(s =>
    s && typeof s.id === "string" && typeof s.role === "string" && typeof s.goal === "string" &&
    typeof s.prompt === "string" && Array.isArray(s.tools) &&
    ["powerful", "balanced", "fast"].includes(s.model_tier) &&
    Array.isArray(s.depends_on) &&
    ["json", "markdown", "code", "structured_text"].includes(s.output_format) &&
    typeof s.timeout_ms === "number" &&
    s.retry_policy && typeof s.retry_policy.max_retries === "number"
  ))
}

function validateExecutionResult(result: any): result is ExecutionResult {
  return Boolean(
    result &&
    typeof result === "object" &&
    typeof result.results === "object" &&
    result.execution_metadata &&
    typeof result.execution_metadata.total_groups === "number" &&
    typeof result.execution_metadata.total_agents === "number"
  )
}

function validateConsensusResult(result: any): result is ConsensusResult {
  return Boolean(
    result &&
    typeof result === "object" &&
    typeof result.consensus_reached === "boolean" &&
    typeof result.final_output === "string" &&
    typeof result.confidence === "number" &&
    typeof result.strategy_used === "string"
  )
}

async function createChildSession(context: OrchestratorContext, title: string, signal: AbortSignal) {
  checkAbort(signal, "createChildSession")
  
  // Validate project ID exists
  if (!context.project?.id) {
    throw new OrchestrationError(
      "No project ID available. Make sure you're running in a project directory.",
      "createChildSession"
    )
  }
  
  await context.client.app.log({
    body: {
      service: "agent-factory",
      level: "debug",
      message: `Creating session: ${title}`,
      extra: { directory: context.directory, projectId: context.project.id },
    },
  })
  
  let session: any
  try {
    session = await withRetry(context, async () => {
      const created: any = await context.client.session.create({
        body: {
          title,
          // Nest under the calling session: the TUI then lists these as the
          // session's sub-agents instead of hiding them as orphan sessions.
          ...(context.parentSessionID ? { parentID: context.parentSessionID } : {}),
        },
        query: { directory: context.directory },
      })
      // The SDK reports failures in the envelope rather than throwing, so the
      // check has to live inside the retry loop to be retried at all.
      if (created?.error) {
        const errorDetail = typeof created.error === "string" ? created.error : JSON.stringify(created.error)
        throw new OrchestrationError(`Failed to create session: ${errorDetail}`, "createChildSession", undefined, true)
      }
      if (!created?.data?.id) {
        throw new OrchestrationError("Session creation returned no session id", "createChildSession", undefined, true)
      }
      return created.data
    }, "createChildSession", signal)
  } catch (err) {
    const errorDetail = err instanceof Error ? err.message : String(err)
    await context.client.app.log({
      body: {
        service: "agent-factory",
        level: "error",
        message: `Session creation threw: ${errorDetail}`,
        extra: { title, error: errorDetail },
      },
    })
    throw err instanceof OrchestrationError
      ? err
      : new OrchestrationError(`Session creation threw: ${errorDetail}`, "createChildSession")
  }

  await context.client.app.log({
    body: {
      service: "agent-factory",
      level: "debug",
      message: `Session created: ${session.id}`,
      extra: { sessionId: session.id },
    },
  })

  context.createdSessions.push(session.id)
  // Lets the activity watcher map a live server event back to this agent.
  ;(context.sessionTitles ??= new Map()).set(session.id, title)
  return session
}

// Forced off for every child session, overriding whatever the agent spec asked
// for: re-entering the pipeline from a child would recurse without bound.
const CHILD_TOOL_OVERRIDES: Record<string, boolean> = {
  orchestrate: false,
  delegate: false,
}

async function promptSession(context: OrchestratorContext, sessionId: string, systemPrompt: string, userPrompt: string, tools?: Record<string, boolean>, signal?: AbortSignal) {
  const active = signal ?? context.abort
  checkAbort(active, "promptSession")
  const pending = withRetry(context, async () => {
    const response: any = await context.client.session.prompt({
      path: { id: sessionId },
      body: {
        system: systemPrompt,
        parts: [{ type: "text", text: userPrompt }],
        agent: context.options.childAgent,
        tools: { ...(tools ?? {}), ...CHILD_TOOL_OVERRIDES },
      },
      query: { directory: context.directory },
    })
    // SDK errors arrive as an envelope, not a throw: retry them here.
    if (response?.error) {
      const errorDetail = typeof response.error === "string" ? response.error : JSON.stringify(response.error)
      throw new OrchestrationError(`Failed to prompt session: ${errorDetail}`, "promptSession", undefined, true)
    }
    if (!response?.data) {
      throw new OrchestrationError("Prompt returned no session data", "promptSession", undefined, true)
    }
    // The prompt itself cannot be cancelled mid-flight, so re-check once it
    // returns: a timeout fired while we were waiting must still stop the run.
    checkAbort(active, "promptSession")
    return response.data
  }, "promptSession", active)
  // Track the live call so cleanup never deletes a session that is still
  // streaming (that is what triggered OpenCode's FOREIGN KEY failures).
  const inFlight = (context.inFlight ??= new Map())
  inFlight.set(pending, sessionId)
  const settled = () => inFlight.delete(pending)
  void pending.then(settled, settled)
  return pending
}

async function deleteSession(context: OrchestratorContext, sessionId: string): Promise<void> {
  try {
    await context.client.session.delete({
      path: { id: sessionId },
      query: { directory: context.directory },
    })
  } catch {
    // Best effort cleanup
  }
}

// One child session per key (agent spec, reviewer, …). Rounds and fix
// passes then talk to a session that already remembers its own work —
// that is what makes multi-round debate real instead of a re-prompt
// from scratch, and the run creates far fewer sessions.
async function acquirePooledSession(
  context: OrchestratorContext,
  key: string,
  title: string,
  signal: AbortSignal,
): Promise<string> {
  if (!context.options.enableSessionPool) {
    return createChildSession(context, title, signal).then(session => session.id)
  }
  if (!context.pool) context.pool = new Map()
  const hit = context.pool.get(key)
  if (hit) return hit
  const created = createChildSession(context, title, signal)
    .then(session => session.id)
    .catch(error => {
      context.pool?.delete(key)
      throw error
    })
  context.pool.set(key, created)
  return created
}

async function pooledPrompt(
  context: OrchestratorContext,
  key: string,
  title: string,
  systemPrompt: string,
  userPrompt: string,
  tools?: Record<string, boolean>,
  signal?: AbortSignal,
) {
  const active = signal ?? context.abort
  const sessionId = await acquirePooledSession(context, key, title, active)
  return promptSession(context, sessionId, systemPrompt, userPrompt, tools, active)
}

async function cleanupSessions(context: OrchestratorContext): Promise<void> {
  const ids = context.createdSessions
  context.createdSessions = []
  const inFlight = context.inFlight

  // Performance: parallel cleanup instead of sequential. A session that still
  // has a prompt streaming is deleted once that prompt settles rather than
  // underneath it — ripping it out mid-stream is what made the host's SQLite
  // layer throw FOREIGN KEY errors on `part`/`message` inserts. The deferral
  // is fire-and-forget so a hung prompt can never stall the tool's return.
  const pending = Promise.all(
    ids.map(async id => {
      const live = inFlight
        ? [...inFlight.entries()].filter(([, sid]) => sid === id).map(([promise]) => promise.catch(() => {}))
        : []
      if (live.length > 0) {
        void Promise.all(live)
          .catch(() => {})
          .then(() => deleteSession(context, id))
        return
      }
      await deleteSession(context, id)
    })
  )
  // Hard-bounded: a hung session.delete call must not prevent the tool from
  // returning its result (or its failure report) to the caller.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(resolve, CLEANUP_DEADLINE_MS)
  })
  try {
    await Promise.race([pending, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function buildAgentPrompt(
  agent: AgentSpec,
  userTask: string,
  dependencyOutputs: Record<string, string>,
  blackboard?: RunBlackboard,
): string {
  const deps = Object.entries(dependencyOutputs)
    .map(([id, output]) => `${id}: ${output}`)
    .join("\n")

  const notes = blackboard?.notesFor(agent.id) ?? ""
  const sharedNotes = blackboard
    ? `${notes ? `\n${notes}\n` : "\nSHARED NOTES FROM OTHER AGENTS IN THIS RUN: (none yet — you may be first)\n"}\n${BLACKBOARD_INSTRUCTION}\n`
    : ""

  const ownership = agent.outputs && agent.outputs.length > 0
    ? `

FILE OWNERSHIP - you alone may write these files:
${agent.outputs.map(o => `- ${o}`).join("\n")}

Do not modify any file outside this list. Another agent owns the rest; pass
coordination notes through your output instead of touching their files.`
    : ""

  return `${agent.prompt}${ownership}

WORKING MODE: you are a straightforward worker. Do your subtask directly and hand back a finished artifact. Debate, voting and consensus happen later in a separate phase — do not argue with, rebut or persuade the other agents.

ORIGINAL TASK:
${userTask}

${deps ? `DEPENDENCY OUTPUTS FROM PRIOR AGENTS:\n${deps}\n` : ""}
${sharedNotes}
YOUR SPECIFIC SUBTASK:
${agent.goal}

OUTPUT FORMAT: ${agent.output_format}`
}

// Compute DAG execution levels using longest-path depth so every agent runs
// strictly after all of its dependencies (level 1 = no dependencies).
// Must be called after cycle detection has rejected cyclic specs.
function computeGroupLevels(specs: AgentSpec[]): Map<string, number> {
  const agentMap = new Map(specs.map(s => [s.id, s]))
  const levels = new Map<string, number>()

  const levelOf = (id: string, seen: Set<string>): number => {
    const cached = levels.get(id)
    if (cached !== undefined) return cached
    const spec = agentMap.get(id)
    if (!spec || spec.depends_on.length === 0) {
      levels.set(id, 1)
      return 1
    }
    if (seen.has(id)) return 1
    seen.add(id)
    const level = 1 + Math.max(...spec.depends_on.map(dep => levelOf(dep, seen)))
    seen.delete(id)
    levels.set(id, level)
    return level
  }

  for (const spec of specs) levelOf(spec.id, new Set())
  return levels
}

// Native DAG Execution: spawn agents in parallel groups via SDK.
// `sink` mirrors results as soon as each agent settles, so a phase timeout
// can still salvage whatever finished instead of discarding the whole run.
async function runNativeDAGExecution(
  context: OrchestratorContext, 
  specs: AgentSpec[], 
  userTask: string, 
  signal: AbortSignal,
  sink?: Record<string, AgentExecutionResult>
): Promise<ExecutionResult> {
  const startTime = Date.now()
  
  // Build dependency graph
  const agentMap = new Map(specs.map(s => [s.id, s]))

  // Validate: warn on unknown tools, and drop dependency references that do
  // not resolve (invented ids, self-references). A malformed spec list is
  // repaired here rather than aborting the whole run; cycles are still fatal.
  const sanitized: AgentSpec[] = []
  for (const spec of specs) {
    const toolCheck = validateAgentTools(spec.tools)
    if (toolCheck.invalid.length > 0) {
      // Log warning but don't fail - tools may be custom
      emitProgress(context, {
        phase: "validation",
        step: `agent-${spec.id}-tool-warning`,
        progress: 0,
        message: `Agent "${spec.id}" has unknown tools: ${toolCheck.invalid.join(", ")}`,
        metadata: { agentId: spec.id, invalidTools: toolCheck.invalid }
      })
    }

    const resolved = spec.depends_on.filter(dep => dep !== spec.id && agentMap.has(dep))
    const dropped = spec.depends_on.filter(dep => !resolved.includes(dep))
    if (dropped.length > 0) {
      emitProgress(context, {
        phase: "validation",
        step: `agent-${spec.id}-dep-warning`,
        progress: 0,
        message: `Agent "${spec.id}" has unresolvable dependencies, ignored: ${dropped.join(", ")}`,
        metadata: { agentId: spec.id, droppedDeps: dropped }
      })
    }
    sanitized.push(resolved.length === spec.depends_on.length ? spec : { ...spec, depends_on: resolved })
  }
  specs = sanitized
  
  // Validate: detect dependency cycles using topological sort
  const visited = new Set<string>()
  const visiting = new Set<string>()
  function detectCycle(id: string): boolean {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const spec = agentMap.get(id)
    if (spec) {
      for (const depId of spec.depends_on) {
        if (detectCycle(depId)) return true
      }
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  for (const spec of specs) {
    if (detectCycle(spec.id)) {
      throw new OrchestrationError(
        `Dependency cycle detected involving agent "${spec.id}"`,
        "dag-validation"
      )
    }
  }
  
  const groupLevels = computeGroupLevels(specs)
  const groups = new Map<number, AgentSpec[]>()
  for (const spec of specs) {
    const groupId = groupLevels.get(spec.id) ?? 1

    if (!groups.has(groupId)) groups.set(groupId, [])
    groups.get(groupId)!.push(spec)
  }
  
  const sortedGroups = Array.from(groups.entries()).sort((a, b) => a[0] - b[0])
  const totalGroups = sortedGroups.length
  let totalAgents = 0
  let completed = 0
  let failed = 0
  const results: Record<string, AgentExecutionResult> = {}
  const completedOutputs: Record<string, string> = {}

  emitProgress(context, {
    phase: "execution",
    step: "starting",
    progress: 0,
    message: `Starting native DAG execution: ${totalGroups} groups, ${specs.length} agents`,
    metadata: { totalGroups, totalAgents: specs.length }
  })

  for (let groupIndex = 0; groupIndex < sortedGroups.length; groupIndex++) {
    const [groupId, groupAgents] = sortedGroups[groupIndex]
    checkAbort(signal, `dag-group-${groupId}`)
    
    const groupProgressBase = Math.round((groupIndex / totalGroups) * 100)
    const groupProgressStep = Math.round(100 / totalGroups)
    
    emitProgress(context, {
      phase: "execution",
      step: `group-${groupId}-start`,
      progress: groupProgressBase,
      message: `Executing group ${groupId}/${totalGroups} (${groupAgents.length} agents)`,
      metadata: { groupId, groupIndex, totalGroups, agentsInGroup: groupAgents.length }
    })

    // Performance: prompt each agent directly — with the pool this creates
    // one session per agent and reuses it on fix passes; without the pool
    // each call creates its own session, exactly as before.
    const groupPromises = groupAgents.map(async (spec, agentIndex) => {
      const agentStartTime = Date.now()
      
      try {
        checkAbort(signal, `agent-${spec.id}`)
        emitProgress(context, {
          phase: "execute",
          step: `agent-${spec.id}-start`,
          progress: groupProgressBase,
          message: `▶ ${spec.id} (${spec.role}) started`,
          metadata: { agent: spec.id, role: spec.role, groupId }
        })

        const depOutputs: Record<string, string> = {}
        for (const depId of spec.depends_on) {
          if (completedOutputs[depId]) {
            depOutputs[depId] = completedOutputs[depId]
          }
        }
        
        const agentPrompt = buildAgentPrompt(spec, userTask, depOutputs, context.blackboard)
        
        const toolsObj: Record<string, boolean> = {}
        for (const tool of spec.tools) {
          toolsObj[tool] = true
        }
        
        const response = await pooledPrompt(
          context, 
          `agent:${spec.id}`,
          `agent:${spec.id}:${spec.role}`,
          spec.prompt,
          agentPrompt,
          toolsObj,
          signal
        )
        
        const rawOutput = response.parts.find((p: any) => p.type === "text")?.text ?? ""
        // Coordination notes are lifted out of the reply and posted to the
        // run's shared blackboard; the deliverable stays clean of markers.
        const { notes, rest: output } = context.blackboard
          ? parseBlackboardBlocks(rawOutput)
          : { notes: [] as Array<{ kind: any; content: string }>, rest: rawOutput }
        const durationMs = Date.now() - agentStartTime

        completedOutputs[spec.id] = output
        completed++
        if (sink) sink[spec.id] = { status: "completed", output, error: null, duration_ms: durationMs }
        if (context.blackboard && notes.length > 0) {
          for (const note of notes) {
            context.blackboard.record({
              agentId: spec.id,
              kind: note.kind,
              content: note.content,
              phase: "execute",
            })
          }
          emitProgress(context, {
            phase: "execute",
            step: "blackboard-note",
            progress: groupProgressBase,
            message: `${spec.id} posted ${notes.length} note(s) to the shared blackboard: ${notes
              .map(note => note.kind)
              .join(", ")}`,
            metadata: { agent: spec.id, kinds: notes.map(note => note.kind) },
          })
        }
        emitProgress(context, {
          phase: "execute",
          step: `agent-${spec.id}-complete`,
          progress: groupProgressBase,
          message: `✔ ${spec.id} (${spec.role}) finished in ${durationMs}ms`,
          metadata: { agent: spec.id, role: spec.role, durationMs, groupId }
        })
        
        return {
          id: spec.id,
          result: {
            status: "completed" as const,
            output,
            error: null,
            duration_ms: durationMs,
          }
        }
      } catch (error) {
        const durationMs = Date.now() - agentStartTime
        failed++
        const failureText = error instanceof Error ? error.message : String(error)
        if (context.blackboard) {
          // A failure is knowledge too: later agents and the reviewer should
          // not assume the missing work exists.
          context.blackboard.record({
            agentId: spec.id,
            kind: "issue",
            content: `agent ${spec.id} failed: ${failureText}`,
            phase: "execute",
          })
        }
        if (sink) {
          sink[spec.id] = {
            status: "failed",
            output: "",
            error: failureText,
            duration_ms: durationMs,
          }
        }
        emitProgress(context, {
          phase: "execute",
          step: `agent-${spec.id}-failed`,
          progress: groupProgressBase,
          message: `✖ ${spec.id} (${spec.role}) failed: ${failureText}`,
          metadata: { agent: spec.id, role: spec.role, durationMs, groupId }
        })
        
        return {
          id: spec.id,
          result: {
            status: "failed" as const,
            output: "",
            error: error instanceof Error ? error.message : String(error),
            duration_ms: durationMs,
          }
        }
      }
    })

    // Wait for all agents in this group to complete
    const groupResults = await Promise.all(groupPromises)
    
    for (const { id, result } of groupResults) {
      results[id] = result
    }
    
    totalAgents += groupAgents.length
    
    emitProgress(context, {
      phase: "execution",
      step: `group-${groupId}-complete`,
      progress: Math.round(((groupIndex + 1) / totalGroups) * 100),
      message: `Group ${groupId} complete: ${groupAgents.length} agents`,
      metadata: { groupId, agentsCompleted: groupAgents.length }
    })
  }

  const totalTime = Date.now() - startTime

  emitProgress(context, {
    phase: "execution",
    step: "complete",
    progress: 100,
    message: `Native DAG execution complete: ${completed}/${totalAgents} agents succeeded`,
    metadata: { totalGroups, totalAgents, completed, failed, totalTimeMs: totalTime }
  })

  return {
    results,
    execution_metadata: {
      total_groups: totalGroups,
      total_agents: totalAgents,
      completed,
      failed,
      total_time_ms: totalTime,
    }
  }
}

// REPLACED: Native DAG execution instead of LLM-based execution-engine
async function runPhase3Execute(context: OrchestratorContext, specs: AgentSpec[], userTask: string, signal: AbortSignal, sink?: Record<string, AgentExecutionResult>): Promise<ExecutionResult> {
  return runNativeDAGExecution(context, specs, userTask, signal, sink)
}

// Builds an ExecutionResult from whatever agents settled before the phase
// deadline fired, so a slow run degrades to a partial team instead of dying.
function buildPartialExecution(
  sink: Record<string, AgentExecutionResult>,
  specs: AgentSpec[],
): ExecutionResult {
  const settled = Object.values(sink)
  const completed = settled.filter(r => r.status === "completed" && r.output.length > 0).length
  return {
    results: { ...sink },
    execution_metadata: {
      total_groups: 1,
      total_agents: specs.length,
      completed,
      failed: settled.length - completed,
      total_time_ms: 0,
    },
  }
}

// Picks a bounded set of completed agents for consensus rounds.
function debateParticipants(specs: AgentSpec[] | undefined, execution: ExecutionResult, max: number): AgentSpec[] {
  if (!specs) return []
  return specs.filter(s =>
    execution.results[s.id]?.status === "completed" && execution.results[s.id].output.length > 0
  ).slice(0, max)
}

function guidanceFor(strategy: string): string {
  switch (strategy) {
    case "voting":
      return "State your recommendation clearly and change your mind only with a concrete reason."
    case "expert_review":
      return "Assess the team's work against expert standards; name the weakest deliverable and why."
    case "hierarchical":
      return "Recommend which direction the team should adopt and what to drop."
    case "mesh":
      return "Peer-to-peer collaboration: build directly upon your peers' partial outputs. Propose integrations or corrections."
    case "fipa_contract_net":
      return "FIPA Contract Net: evaluate the Call For Proposals (CFP). Propose your capability or state your refusal clearly."
    default:
      return "Defend, revise, or refine your position in light of the peers' inputs."
  }
}

// Runs real multi-round consensus: each round every participant sees the
// peers' replies from the previous round and can revise its position.
async function runPhase4Consensus(
  context: OrchestratorContext,
  executionResult: ExecutionResult,
  strategy: string,
  signal: AbortSignal,
  specs: AgentSpec[],
  userTask: string,
): Promise<ConsensusResult> {
  const wanted = context.options.consensusRounds
  const transcript: Array<{ round: number; replies: { agent: string; text: string }[] }> = []
  const participants = debateParticipants(specs, executionResult, context.options.maxDebateAgents)

  // Run real rounds only when budget allows and there are enough participants.
  if (wanted >= 2 && participants.length >= 2) {
    let budgetOk = true
    if (context.deadlineAt) {
      const reserve = context.options.phaseTimeoutMs          // leave room for aggregation + synthesis
      const expectedRound = Math.ceil(context.options.phaseTimeoutMs / 2)
      budgetOk = Date.now() + expectedRound + reserve <= context.deadlineAt
    }
    if (!budgetOk) {
      emitProgress(context, {
        phase: "consensus",
        step: "rounds-skipped",
        progress: 80,
        message: `Skipping ${wanted} consensus rounds — not enough budget remaining; aggregating with current outputs`,
        metadata: { budgetReason: "deadline" }
      })
    } else {
      let convergedEarly = false
      try {
        await withPhase(context, signal, "consensus-rounds", async phaseSignal => {
          for (let r = 1; r <= wanted && !convergedEarly; r++) {
            // Budget check before each round.
            if (context.deadlineAt) {
              const reserve = context.options.phaseTimeoutMs
              const expectedRound = Math.ceil(context.options.phaseTimeoutMs / 2)
              if (Date.now() + expectedRound + reserve > context.deadlineAt) break
            }
            emitProgress(context, {
              phase: "consensus",
              step: "round-start",
              progress: 76,
              message: `Consensus round ${r} of ${wanted} (${participants.length} agents)`,
              metadata: { round: r, maxRounds: wanted, participants: participants.length }
            })
            const replies = await Promise.all(participants.map(async (spec) => {
              const sessionId = await acquirePooledSession(context, `agent:${spec.id}`, `agent:${spec.id}:${spec.role}`, phaseSignal)
              const previousRound = transcript.length === 0
                ? ""
                : `PREVIOUS-ROUND DISCUSSION:\n${transcript.slice(-1).map(t => `ROUND ${t.round}:\n${t.replies.map(x => `  [${x.agent}]: ${x.text}`).join("\n")}`).join("\n")}`
              const roundPrompt = `CONSENSUS ROUND ${r} of ${wanted} — ${strategy} consensus.\n
YOUR ROLE: ${spec.role} — ${spec.goal}

ORIGINAL TASK:
${userTask}

YOUR TEAM DELIVERABLE (already produced):
### ${spec.id}: ${executionResult.results[spec.id]?.output || "(no output)"}

${previousRound}

${guidanceFor(strategy)}

End your reply with exactly one line: CONVERGED: YES if you agree with the emerging direction, otherwise CONVERGED: NO.`
              const response = await promptSession(context, sessionId, spec.prompt, roundPrompt, undefined, phaseSignal)
              const text = response.parts.find((p: any) => p.type === "text")?.text ?? ""
              return { agent: spec.id, text }
            }))
            transcript.push({ round: r, replies })
            if (replies.every(r => r.text.includes("CONVERGED: YES"))) {
              convergedEarly = true
            }
            emitProgress(context, {
              phase: "consensus",
              step: "round-complete",
              progress: 80,
              message: `Round ${r} complete (${replies.length} reply(ies))`,
              metadata: { round: r, replies: replies.length }
            })
          }
        })
      } catch (err) {
        if (signal.aborted || context.abort.aborted) throw err
        emitProgress(context, {
          phase: "consensus",
          step: "rounds-failed",
          progress: 80,
          message: `Consensus rounds failed (${(err as Error).message}); aggregating with execution outputs`,
          metadata: { error: (err as Error).message }
        })
      }
    }
  }

  // Aggregation (always): the consensus-manager session parses a ConsensusResult.
  try {
    const sessionId = await acquirePooledSession(context, "consensus-manager", "consensus-manager:consensus", signal)
    const consensusPrompt = getAgentPrompt("consensus-manager", context.customTemplates)
    const systemPrompt = `${consensusPrompt}
You are in Phase 4: CONSENSUS. Apply the consensus strategy. Output ONLY the ConsensusResult JSON.`
    const roundText = transcript.length > 0
      ? `ROUNDS EXECUTED: ${transcript.length}\n${transcript.slice(0, 3).map(r => `ROUND ${r.round}:\n${r.replies.map(x => `  [${x.agent}]: ${x.text}`).join("\n")}`).join("\n")}`
      : ""
    const userPrompt = `Strategy: ${strategy}\nAgent outputs:\n${JSON.stringify(executionResult.results, null, 2)}\n${roundText}`
    const response = await promptSession(context, sessionId, systemPrompt, userPrompt, undefined, signal)
    const result = extractJson<ConsensusResult>(response.parts.find((p: any) => p.type === "text")?.text ?? "")
    if (!result || !validateConsensusResult(result)) throw new OrchestrationError("Failed to parse or validate consensus result", "phase4-consensus")
    if (transcript.length > 0) result.rounds_executed = transcript.length
    return result
  } catch (err) {
    if (signal.aborted || context.abort.aborted) throw err
    emitProgress(context, {
      phase: "consensus",
      step: "consensus-degraded",
      progress: 85,
      message: `Consensus failed (${(err as Error).message}); building a local consensus from execution outputs`,
      metadata: { error: (err as Error).message }
    })
    return buildLocalConsensus(executionResult, strategy, transcript.length)
  }
}

// Builds a local fallback consensus when the consensus-manager is unavailable.
function buildLocalConsensus(executionResult: ExecutionResult, strategy: string, roundsExecuted: number): ConsensusResult {
  const completed = Object.entries(executionResult.results)
    .filter(([_, r]) => r.status === "completed" && r.output.length > 0)
  const failed = executionResult.execution_metadata.failed
  return {
    consensus_reached: completed.length > 0,
    final_output: completed.length > 0
      ? completed.map(([id, r]) => `### ${id}:\n${r.output}`).join("\n\n---\n\n")
      : "No agent produced output",
    confidence: completed.length > 0
      ? (failed === 0 ? 0.5 : 0.3)
      : 0.1,
    strategy_used: strategy,
    rounds_executed: Math.max(roundsExecuted, 1),
    agent_contributions: Object.fromEntries(
      Object.entries(executionResult.results).map(([id, r]) => [
        id, { weight: 1, accepted: r.status === "completed" && r.output.length > 0 }
      ])
    ),
    metadata: { convergence_score: completed.length > 0 ? 0.4 : 0 },
  }
}

async function runPhase5Synthesize(
  context: OrchestratorContext,
  consensus: ConsensusResult,
  executionResult: ExecutionResult,
  signal: AbortSignal,
  reviewNote?: string
): Promise<string> {
  const child = await createChildSession(context, "dynamic-orchestrator:synthesize", signal)
  const orchestratorPrompt = getAgentPrompt("dynamic-orchestrator", context.customTemplates)
  const systemPrompt = `${orchestratorPrompt}

You are in Phase 5: SYNTHESIZE. Compile the final response using the consensus output. Output ONLY the final answer.`

  const note = reviewNote && reviewNote.length > 0
    ? `\n\nREVIEW NOTES - issues the reviewer did NOT consider resolved; call them out in the final answer:\n${reviewNote}`
    : ""
  // Everything the team posted during the run travels with the synthesis, so
  // findings from agents that never made it into consensus are not lost.
  const sharedNotes = context.blackboard?.notesFor("synthesize") ?? ""
  const board = sharedNotes ? `\n\nSHARED NOTES FROM THE AGENTS:\n${sharedNotes}` : ""
  const response = await promptSession(
    context,
    child.id,
    systemPrompt,
    `Consensus result:\n${JSON.stringify(consensus, null, 2)}\n\nExecution metadata:\n${JSON.stringify(executionResult.execution_metadata, null, 2)}${note}${board}`,
    undefined,
    signal
  )
  const text = response.parts.find((p: any) => p.type === "text")?.text ?? ""
  // A synthesizer that returns no text must not sink the run: the consensus
  // output is already a usable final answer.
  if (text.trim().length > 0) return text
  return consensus.final_output || "No result produced"
}

interface ReviewOutcome {
  approved: boolean
  rounds: number
  issues: string[]
}

// Build the specs for a fix pass: only the agents the reviewer flagged get a
// round, each carrying its previous output and the issues to correct.
function buildFixSpecs(
  specs: AgentSpec[],
  issues: Array<{ agent_id?: string; description: string }>,
  results: Record<string, AgentExecutionResult>
): AgentSpec[] {
  const byAgent = new Map<string, string[]>()
  const unattributed: string[] = []
  for (const issue of issues) {
    const description = typeof issue?.description === "string" ? issue.description.trim() : ""
    if (!description) continue
    const target = typeof issue?.agent_id === "string" && specs.some(s => s.id === issue.agent_id)
      ? issue.agent_id
      : null
    if (target) {
      if (!byAgent.has(target)) byAgent.set(target, [])
      byAgent.get(target)!.push(description)
    } else {
      unattributed.push(description)
    }
  }

  const fixSpecs: AgentSpec[] = []
  for (const spec of specs) {
    const own = [...(byAgent.get(spec.id) ?? []), ...unattributed]
    if (own.length === 0) continue
    const previous = results[spec.id]?.output ?? ""
    fixSpecs.push({
      ...spec,
      depends_on: [],
      prompt: `${spec.prompt}

YOUR PREVIOUS OUTPUT DID NOT PASS REVIEW. Fix these issues:
${own.map(i => `- ${i}`).join("\n")}

PREVIOUS OUTPUT:
${previous.slice(0, 6000)}

Return the corrected deliverable in full.`,
    })
  }
  return fixSpecs
}

// Validation loop: a reviewer agent grades the deliverables, flagged agents
// revise, and the cycle repeats up to maxReviewRounds times (like a team's
// review -> fix -> re-review pass). Fails open when the reviewer is
// unavailable or unparseable so review can never sink a good run.
// Time that must still be available after execution finishes: consensus,
// aggregation and synthesis are what turn agent output into an answer. Without
// this reserve a slow execute phase consumed the entire budget and the run
// died with nothing (observed live: a 600s budget spent ~510s inside execute
// and then failed instead of synthesizing).
export function tailReserveMs(context: OrchestratorContext): number {
  const overall = context.options.overallTimeoutMs
  // 25% of the run, clamped so tiny test budgets keep half their time and
  // huge budgets do not reserve an absurd wall-clock block.
  return Math.min(Math.max(Math.round(overall * 0.25), 15_000), Math.round(overall * 0.5))
}

async function runReviewLoop(
  context: OrchestratorContext,
  signal: AbortSignal,
  userTask: string,
  specs: AgentSpec[],
  execution: ExecutionResult
): Promise<{ execution: ExecutionResult; review: ReviewOutcome }> {
  const noop = (exec: ExecutionResult, rounds: number) =>
    ({ execution: exec, review: { approved: true, rounds, issues: [] } })

  if (!context.options.enableReviewLoop || specs.length === 0 || execution.execution_metadata.total_agents === 0) {
    return noop(execution, 0)
  }

  // Review is the optional part of the tail: it may only spend what is left
  // after the essential tail (consensus + synthesis) is already covered.
  const budgetForOptionalWork = (): number => {
    const left = context.deadlineAt ? context.deadlineAt - Date.now() : Number.POSITIVE_INFINITY
    return left - tailReserveMs(context) - Math.min(context.options.phaseTimeoutMs, 60_000)
  }
  if (budgetForOptionalWork() < 0) {
    emitProgress(context, {
      phase: "review",
      step: "review-skipped",
      progress: 80,
      message: "Skipping review: remaining budget is reserved for consensus and synthesis",
      metadata: { deadlineAt: context.deadlineAt ?? null },
    })
    return noop(execution, 0)
  }

  const results: Record<string, AgentExecutionResult> = { ...execution.results }
  const maxRounds = context.options.maxReviewRounds
  let approved = false
  let rounds = 0
  let openIssues: string[] = []

  for (let round = 0; round <= maxRounds; round++) {
    // A fix round costs another full reviewer call; stop taking them once the
    // essential tail would be squeezed.
    if (round > 0 && budgetForOptionalWork() < 0) {
      emitProgress(context, {
        phase: "review",
        step: "review-skipped",
        progress: 80,
        message: "Stopping review: remaining budget is reserved for synthesis",
        metadata: { rounds },
      })
      return noop({ ...execution, results }, rounds)
    }
    rounds = round + 1
    emitProgress(context, {
      phase: "review",
      step: "review-round",
      progress: 75,
      message: `Review round ${rounds} of at most ${maxRounds + 1}`,
      metadata: { round: rounds, maxRounds: maxRounds + 1 }
    })

    let verdict: { approved: boolean; issues: Array<{ agent_id?: string; description: string }> } | null = null
    try {
      verdict = await withPhase(context, signal, "review", async (phaseSignal) => {
        const sessionId = await acquirePooledSession(context, "reviewer", `reviewer:round-${rounds}`, phaseSignal)
        const systemPrompt = `You are a strict but fair reviewer on a delivery team.
Review the deliverables against the task: correctness, completeness, internal consistency, and every requested item being present.
Output ONLY this JSON and nothing else: {"approved": boolean, "issues": [{"agent_id": string, "description": string}]}
Set approved to true only when the work is ready to ship as-is. Attribute each issue to the agent id that produced that deliverable.`
        const userPrompt = `TASK:
${userTask}

DELIVERABLES:
${Object.entries(results)
  .map(([id, r]) => `### ${id} (${r.status})\n${(r.output || r.error || "").slice(0, 8000)}`)
  .join("\n\n")}`
        const response = await promptSession(context, sessionId, systemPrompt, userPrompt, undefined, phaseSignal)
        const text = response.parts.find((p: any) => p.type === "text")?.text ?? ""
        const parsed = extractJson<{ approved?: unknown; issues?: unknown }>(text)
        if (!parsed || typeof parsed.approved !== "boolean") return null
        const issues = Array.isArray(parsed.issues)
          ? (parsed.issues as Array<{ agent_id?: unknown; description: unknown }>)
              .filter(i => i && typeof i.description === "string")
              .map(i => ({
                ...(typeof i.agent_id === "string" ? { agent_id: i.agent_id } : {}),
                description: i.description as string,
              }))
          : []
        return { approved: parsed.approved, issues }
      })
    } catch (error) {
      if (signal.aborted || context.abort.aborted) throw error
      emitProgress(context, {
        phase: "review",
        step: "review-skipped",
        progress: 80,
        message: `Reviewer unavailable (${error instanceof Error ? error.message : String(error)}); skipping review`,
        metadata: { round: rounds }
      })
      return noop({ ...execution, results }, rounds)
    }

    if (!verdict) {
      emitProgress(context, {
        phase: "review",
        step: "review-skipped",
        progress: 80,
        message: "Reviewer response was not valid JSON; skipping review",
        metadata: { round: rounds }
      })
      return noop({ ...execution, results }, rounds)
    }

    if (verdict.approved) {
      approved = true
      emitProgress(context, {
        phase: "review",
        step: "review-approved",
        progress: 85,
        message: `Deliverables approved on review round ${rounds}`,
        metadata: { round: rounds }
      })
      break
    }

    openIssues = verdict.issues.map(i => `${i.agent_id ?? "unknown"}: ${i.description}`)
    if (openIssues.length === 0) {
      approved = true
      emitProgress(context, {
        phase: "review",
        step: "review-approved",
        progress: 85,
        message: `Deliverables approved on review round ${rounds} (no issues listed)`,
        metadata: { round: rounds }
      })
      break
    }
    emitProgress(context, {
      phase: "review",
      step: "review-issues",
      progress: 75,
      message: `Review round ${rounds} found ${openIssues.length} issue(s)`,
      metadata: { round: rounds, issues: openIssues }
    })

    // The reviewer's findings are shared knowledge too: post them so the fix
    // pass and the synthesizer both see what was rejected and why.
    if (context.blackboard) {
      for (const issue of verdict.issues) {
        context.blackboard.record({
          agentId: "reviewer",
          kind: "issue",
          content: `${issue.agent_id ?? "unassigned"}: ${issue.description}`,
          phase: "review",
        })
      }
    }

    if (round === maxRounds) break

    const fixSpecs = buildFixSpecs(specs, verdict.issues, results)
    if (fixSpecs.length === 0) break

    try {
      const fixExecution = await withPhase(context, signal, "review-fix", phaseSignal =>
        runNativeDAGExecution(context, fixSpecs, userTask, phaseSignal))
      for (const [id, result] of Object.entries(fixExecution.results)) {
        results[id] = result
      }
      emitProgress(context, {
        phase: "review",
        step: "review-fixes",
        progress: 80,
        message: `Fix pass complete for ${fixSpecs.length} agent(s)`,
        metadata: { round: rounds, agentsFixed: fixSpecs.map(s => s.id) }
      })
    } catch (error) {
      if (signal.aborted || context.abort.aborted) throw error
      emitProgress(context, {
        phase: "review",
        step: "review-fix-failed",
        progress: 80,
        message: `Fix pass failed (${error instanceof Error ? error.message : String(error)})`,
        metadata: { round: rounds }
      })
      break
    }
  }

  return {
    execution: { ...execution, results },
    review: { approved, rounds, issues: openIssues },
  }
}

export async function runOrchestration(context: OrchestratorContext, userPrompt: string, strategy: string = "auto"): Promise<{
  result: string
  metadata: {
    phases_completed: number
    agents_spawned: number
    parallel_groups: number
    consensus_strategy: string
    consensus_reached: boolean
    confidence: number
    total_time_ms: number
  }
  diagram: {
    analysis: TaskAnalysis | null
    specs: AgentSpec[]
    execution: ExecutionResult | null
    consensus: ConsensusResult | null
    strategyReasoning: string
    phaseTimings: Record<string, number>
  }
}> {
  validateInput(userPrompt, strategy)

  // "auto" resolves to the configured default strategy, which may still be "auto".
  const effectiveStrategy = strategy === "auto"
    ? normalizeStrategy(context.options.defaultStrategy)
    : strategy
  // Fast path: explicit single strategy, or an auto strategy with a short prompt.
  const useFastPath =
    effectiveStrategy === "single" ||
    (effectiveStrategy === "auto" && userPrompt.length <= context.options.fastPathThresholdChars)

  const { signal: overallSignal, dispose } = createTimeoutSignal(context.options.overallTimeoutMs, context.abort)
  const startTime = Date.now()
  const sessionId = getOrCreateSession(context)

  emitProgress(context, {
    phase: "init",
    step: "starting",
    progress: 0,
    message: useFastPath
      ? "Starting orchestration pipeline (fast path)"
      : "Starting orchestration pipeline (dynamic mode)",
    metadata: { totalPhases: useFastPath ? 1 : 5, sessionId, strategy: effectiveStrategy }
  })

  // Persistent pool and deadline for multi-round consensus
  context.deadlineAt = Date.now() + context.options.overallTimeoutMs
  context.pool = new Map()
  // Filled in as phases complete, so a failure can still show the user what
  // the run planned and how far it got instead of a bare error message.
  context.partial = { strategy: effectiveStrategy }
  // Fresh run-scoped shared memory; agents post to it and later agents read it.
  context.blackboard = context.options.enableBlackboard ? new RunBlackboard() : undefined
  // Live view of every child session while the run is in flight.
  const stopActivityWatcher = startChildActivityWatcher(context)
  try {
    // Fast path for simple/short tasks, full Phase 1-5 pipeline otherwise.
    const result = useFastPath
      ? await runFastPath(context, userPrompt, overallSignal, startTime)
      : await runComplexPath(context, userPrompt, effectiveStrategy, overallSignal, startTime)

    const durationMs = Date.now() - startTime
    for (const [phase, phaseMs] of Object.entries(result.diagram.phaseTimings)) {
      pushPhaseTiming(phase, phaseMs)
    }
    recordTelemetry({
      type: "orchestration_complete",
      strategy: result.metadata.consensus_strategy,
      durationMs,
      agentsSpawned: result.metadata.agents_spawned,
      fastPath: useFastPath,
    })

    return result
  } catch (error) {
    recordTelemetry({ type: "orchestration_failed", durationMs: Date.now() - startTime })
    throw error
  } finally {
    stopActivityWatcher()
    dispose()
    await cleanupSessions(context)
  }
}

// `single` consensus: the primary agent's output is adopted as the consensus
// result, with every agent's contribution recorded for the diagram.
function buildSingleConsensus(specs: AgentSpec[], execution: ExecutionResult): ConsensusResult {
  const outputs = specs
    .map(spec => execution.results[spec.id])
    .filter(result => result.status === "completed" && result.output.length > 0)
  const failed = execution.execution_metadata.failed

  return {
    consensus_reached: outputs.length > 0,
    final_output: outputs[0]?.output
      ?? `No agent produced output (${failed}/${execution.execution_metadata.total_agents} failed)`,
    confidence: failed === 0 ? 0.9 : outputs.length > 0 ? 0.6 : 0.3,
    strategy_used: "single",
    rounds_executed: 1,
    agent_contributions: Object.fromEntries(
      specs.map(spec => [spec.id, { weight: 1, accepted: Boolean(execution.results[spec.id]?.output) }])
    ),
    metadata: { convergence_score: failed === 0 ? 1 : 0.5 },
  }
}

async function runFastPath(
  context: OrchestratorContext, 
  userPrompt: string, 
  signal: AbortSignal,
  startTime: number
) {
  emitProgress(context, {
    phase: "fast-path",
    step: "starting",
    progress: 10,
    message: "Running fast-path for simple task",
    metadata: { strategy: "single" }
  })
  
  const specStart = Date.now()
  const { analysis, specs } = await withPhase(
    context,
    signal,
    "fast-path",
    async (phaseSignal) => {
      const factoryPrompt = getAgentPrompt("agent-factory", context.customTemplates)
      const systemPrompt = `${factoryPrompt}
  
You are handling a SIMPLE task. Do NOT perform the task yourself: no file writes, no shell commands, no code execution. Produce ONLY the AgentSpec[] JSON array describing the agents that should do it.`

      const { specs: fastPathSpecs, issues } = await generateAgentSpecs(
        context,
        "agent-factory:fast-path",
        "fast-path",
        systemPrompt,
        `Task: ${userPrompt}\n\nStrategy: single`,
        phaseSignal,
        15
      )
      if (issues.length > 0) {
        emitProgress(context, {
          phase: "fast-path",
          step: "spec-repair",
          progress: 15,
          message: `Repaired ${issues.length} agent spec issue(s)`,
          metadata: { issueCount: issues.length }
        })
      }

      const analysis: TaskAnalysis = {
        task_type: "coding",
        complexity: "simple",
        domains: ["general"],
        capabilities: ["code_execution"],
        consensus_strategy: "single",
        parallel_groups: [{ group_id: 1, independent: true, subtasks: fastPathSpecs.map(s => s.goal) }]
      }

      return { analysis, specs: fastPathSpecs }
    }
  )
  const specMs = Date.now() - specStart

  emitProgress(context, {
    phase: "fast-path",
    step: "complete",
    progress: 20,
    message: "Fast-path specs generated",
    metadata: { agentsGenerated: specs.length }
  })

  // The generated agents still have to do the work: run them through the same
  // DAG scheduler as the complex path, then adopt the primary output.
  const execStart = Date.now()
  const baseExecution = await withPhase(context, signal, "execute", phaseSignal =>
    runNativeDAGExecution(context, specs, userPrompt, phaseSignal))
  const execMs = Date.now() - execStart

  const reviewStart = Date.now()
  const { execution, review } = await runReviewLoop(context, signal, userPrompt, specs, baseExecution)
  const reviewMs = Date.now() - reviewStart

  const consensus = buildSingleConsensus(specs, execution)

  const synthStart = Date.now()
  let finalResult: string
  try {
    finalResult = await withPhase(context, signal, "synthesize", phaseSignal =>
      runPhase5Synthesize(
        context,
        consensus,
        execution,
        phaseSignal,
        review.approved ? undefined : review.issues.join("\n")
      ))
  } catch (err) {
    if (signal.aborted || context.abort.aborted) throw err
    emitProgress(context, {
      phase: "synthesize",
      step: "synthesize-degraded",
      progress: 95,
      message: `Synthesis failed (${(err as Error).message}); using consensus output directly`,
      metadata: { error: (err as Error).message }
    })
    finalResult = consensus.final_output
  }
  const synthMs = Date.now() - synthStart
  
  const totalTime = Date.now() - startTime

  emitProgress(context, {
    phase: "complete",
    step: "done",
    progress: 100,
    message: `Fast-path complete in ${totalTime}ms`,
    metadata: { totalTimeMs: totalTime }
  })

  await cleanupSessions(context)
  return {
    result: finalResult,
    metadata: {
      phases_completed: 3,
      agents_spawned: specs.length,
      parallel_groups: execution.execution_metadata.total_groups,
      consensus_strategy: "single",
      consensus_reached: consensus.consensus_reached,
      confidence: consensus.confidence,
      total_time_ms: totalTime,
    },
    diagram: {
      analysis,
      specs,
      execution,
      consensus,
      strategyReasoning: `Fast-path selected: task complexity is simple, using single strategy for direct execution.`,
      phaseTimings: {
        "fast-path": specMs,
        execute: execMs,
        ...(review.rounds > 0 ? { review: reviewMs } : {}),
        synthesize: synthMs
      },
    }
  }
}

async function runComplexPath(
  context: OrchestratorContext, 
  userPrompt: string, 
  strategy: string,
  signal: AbortSignal,
  startTime: number
) {
  let analysis: TaskAnalysis
  let specs: AgentSpec[]
  const phaseTimings: Record<string, number> = {}
  let strategyReasoning = ""
  if (context.partial) context.partial.phaseTimings = phaseTimings

  const factoryPrompt = getAgentPrompt("agent-factory", context.customTemplates)

  // Phase 1: Analyze
  const phase1Start = Date.now()
  emitProgress(context, {
    phase: "analyze",
    step: "starting",
    progress: 10,
    message: "Analyzing task complexity and domains",
    metadata: { strategy }
  })

  // Phase 1 must not sink the run when the provider is merely slow: on a
  // phase timeout we build a local analysis and skip the LLM planner so the
  // run still reaches execution. Parse failures and broken session creation
  // stay fatal — later phases would fail the same way.
  let analyzeDegraded = false
  try {
    analysis = await withPhase(context, signal, "analyze", async (phaseSignal) => {
      const child1 = await createChildSession(context, "agent-factory:analyze", phaseSignal)
      const systemPrompt = `${factoryPrompt}

You are in Phase 1: ANALYZE. Analyze the task and output ONLY the TaskAnalysis JSON.`

      const analysisResponse = await promptSession(context, child1.id, systemPrompt, `Task: ${userPrompt}\n\n${strategy !== "auto" ? `Strategy override: ${strategy}` : "Select the best strategy automatically."}`, undefined, phaseSignal)
      const parsedAnalysis = extractJson<TaskAnalysis>(analysisResponse.parts.find((p: any) => p.type === "text")?.text ?? "")
      if (!parsedAnalysis || !validateTaskAnalysis(parsedAnalysis)) throw new OrchestrationError("Failed to parse or validate task analysis", "phase1-analyze")
      return parsedAnalysis
    })
  } catch (analyzeError) {
    if (signal.aborted || context.abort.aborted) throw analyzeError
    const timedOut = analyzeError instanceof OrchestrationError && /exceeded phase timeout/.test(analyzeError.message)
    if (!timedOut) throw analyzeError
    const reason = analyzeError instanceof Error ? analyzeError.message : String(analyzeError)
    emitProgress(context, {
      phase: "analyze",
      step: "analyze-degraded",
      progress: 20,
      message: `Analysis timed out (${reason}); using a local analysis so the run can continue`,
      metadata: { error: reason }
    })
    analysis = localAnalysis(userPrompt, strategy)
    analyzeDegraded = true
  }
  phaseTimings["analyze"] = Date.now() - phase1Start
  if (context.partial) context.partial.analysis = analysis
  
  // Build strategy reasoning
  strategyReasoning = `Strategy "${analysis.consensus_strategy}" selected because:
- Task type: ${analysis.task_type}
- Complexity: ${analysis.complexity}
- Domains: ${analysis.domains.join(", ")}
${strategy !== "auto" ? `- User override: ${strategy}` : "- Auto-selected based on analysis"}`
  if (context.partial) context.partial.strategyReasoning = strategyReasoning
  
  emitProgress(context, {
    phase: "analyze",
    step: "complete",
    progress: 20,
    message: `Task analyzed: ${analysis.task_type}/${analysis.complexity}`,
    metadata: { taskType: analysis.task_type, complexity: analysis.complexity, domains: analysis.domains }
  })

  // Phase 2: Plan. A slow or failing planner must not sink the whole run:
  // retry with a trimmed brief, then degrade to a locally-built single-agent
  // spec so execution still produces a result.
  const phase2Start = Date.now()
  emitProgress(context, {
    phase: "plan",
    step: "starting",
    progress: 25,
    message: "Generating agent specifications",
    metadata: { expectedAgents: "unknown" }
  })

  const planSystemPrompt = `${factoryPrompt}

You are in Phase 2: PLAN. Generate agent specifications from the analysis. Do NOT perform any of the work yourself: no file writes, no shell commands. Output ONLY the JSON array.

RULES FOR THE SPECS:
- Agents are straightforward workers: each one performs its own subtask directly and returns a finished work product.
- The consensus strategy (debate, voting, expert_review, ...) is applied LATER, in Phase 4. Never express it in the specs: no pro/con pairs, no opposing "right vs left" agents, no roles whose job is to argue, rebut or persuade. The worker never debates; it produces.
- Prefer 2-4 agents. Split further only when the subtasks are genuinely independent.`

  const runPlan = (planBrief: string, timeoutMs?: number) =>
    withPhase(context, signal, "plan", async (phaseSignal) => {
      const { specs: plannedSpecs, issues } = await generateAgentSpecs(
        context,
        "agent-factory:plan",
        "phase2-plan",
        planSystemPrompt,
        planBrief,
        phaseSignal,
        30
      )
      if (issues.length > 0) {
        emitProgress(context, {
          phase: "plan",
          step: "spec-repair",
          progress: 30,
          message: `Repaired ${issues.length} agent spec issue(s)`,
          metadata: { issueCount: issues.length }
        })
      }
      return plannedSpecs
    }, timeoutMs)

  if (analyzeDegraded) {
    // Phase 1 already burned a full phase budget on a slow provider; do not
    // spend another one planning. Build the spec locally so execution runs.
    emitProgress(context, {
      phase: "plan",
      step: "plan-degraded",
      progress: 30,
      message: "Analysis timed out earlier; skipping the planner and using a local agent spec",
      metadata: { reason: "analyze-degraded" }
    })
    specs = [soloAgentSpec(userPrompt, context.options.phaseTimeoutMs)]
  } else try {
    specs = await runPlan(JSON.stringify(analysis, null, 2))
  } catch (planError) {
    if (signal.aborted || context.abort.aborted) throw planError
    const planReason = planError instanceof Error ? planError.message : String(planError)
    emitProgress(context, {
      phase: "plan",
      step: "plan-fallback",
      progress: 30,
      message: `Planner failed (${planReason}); retrying with a trimmed brief`,
      metadata: { error: planReason }
    })
    try {
      specs = await runPlan(
        `Task: ${userPrompt}\n\nTask type: ${analysis.task_type}, complexity: ${analysis.complexity}.\nGenerate an AgentSpec[] of 1-3 agents that covers this task. Output ONLY the JSON array.`,
        Math.max(Math.ceil(context.options.phaseTimeoutMs / 2), 1000)
      )
    } catch (trimError) {
      if (signal.aborted || context.abort.aborted) throw planError
      const trimReason = trimError instanceof Error ? trimError.message : String(trimError)
      emitProgress(context, {
        phase: "plan",
        step: "plan-degraded",
        progress: 30,
        message: `Planner unavailable (${trimReason}); degrading to a single-agent run`,
        metadata: { error: trimReason }
      })
      specs = [soloAgentSpec(userPrompt, context.options.phaseTimeoutMs)]
    }
  }
  phaseTimings["plan"] = Date.now() - phase2Start
  if (context.partial) context.partial.specs = specs
  
  emitProgress(context, {
    phase: "plan",
    step: "complete",
    progress: 35,
    message: `Generated ${specs.length} agent specifications`,
    metadata: { agentCount: specs.length, roles: specs.map(s => s.role) }
  })

  // Bootstrap / Warm-up Phase
  emitProgress(context, {
    phase: "bootstrap",
    step: "warming-pool",
    progress: 38,
    message: "Bootstrapping session pool and verifying agent readiness",
    metadata: { enabled: context.options.enableSessionPool }
  })
  if (context.options.enableSessionPool && context.pool) {
    try {
      await acquirePooledSession(context, "bootstrap-probe", "bootstrap:probe", signal)
    } catch {
      // non-fatal
    }
  }

  // Phase 3: Execute (Native DAG)
  const phase3Start = Date.now()
  emitProgress(context, {
    phase: "execute",
    step: "starting",
    progress: 40,
    message: "Executing agent DAG natively",
    metadata: { agentCount: specs.length }
  })
  
  // Phase 3: Execute (Native DAG). A phase deadline here must not throw away
  // the agents that already finished — a slow provider makes partial teams
  // the common case, and dropping them produced a bare failure with no
  // diagram and no answer at all.
  //
  // The deadline also scales up: execution fans out to N agents in parallel
  // and on a slow provider individual agents measured 200-300s, so a budget
  // meant for a single call killed the whole phase before anything returned.
  // It is still capped by what is left *after* reserving the tail, so execute
  // can never spend the consensus/synthesis budget and leave the run unable to
  // produce an answer (live failure: 600s run, ~510s inside execute, no result).
  const remainingBudget = context.deadlineAt ? context.deadlineAt - Date.now() : Number.POSITIVE_INFINITY
  const spendableOnExecute =
    remainingBudget === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(1, remainingBudget - tailReserveMs(context))
  const executeTimeoutMs = Math.max(1, Math.min(context.options.phaseTimeoutMs * 2, spendableOnExecute))
  const settledAgents: Record<string, AgentExecutionResult> = {}
  let execution: ExecutionResult
  try {
    execution = await withPhase(context, signal, "execute", phaseSignal =>
      runPhase3Execute(context, specs, userPrompt, phaseSignal, settledAgents), executeTimeoutMs
    )
  } catch (executeError) {
    if (signal.aborted || context.abort.aborted) throw executeError
    const timedOut = executeError instanceof OrchestrationError && /exceeded phase timeout/.test(executeError.message)
    const salvageable = Object.values(settledAgents).filter(r => r.status === "completed" && r.output.length > 0)
    if (!timedOut || salvageable.length === 0) throw executeError
    emitProgress(context, {
      phase: "execute",
      step: "execute-partial",
      progress: 65,
      message: `Execution deadline reached with ${salvageable.length}/${specs.length} agent(s) finished; continuing with the partial team`,
      metadata: { finished: salvageable.length, planned: specs.length }
    })
    execution = buildPartialExecution(settledAgents, specs)
  }
  phaseTimings["execute"] = Date.now() - phase3Start
  if (context.partial) context.partial.execution = execution
  
  emitProgress(context, {
    phase: "execute",
    step: "complete",
    progress: 70,
    message: `Execution complete: ${execution.execution_metadata.completed}/${execution.execution_metadata.total_agents} agents succeeded`,
    metadata: { completed: execution.execution_metadata.completed, total: execution.execution_metadata.total_agents }
  })

  // Review -> fix -> re-review loop before consensus, so the team's output is
  // validated like a real delivery pass rather than trusted on first draft.
  const reviewStart = Date.now()
  const reviewOutcome = await runReviewLoop(context, signal, userPrompt, specs, execution)
  execution = reviewOutcome.execution
  if (context.partial) context.partial.execution = execution
  if (reviewOutcome.review.rounds > 0) {
    phaseTimings["review"] = Date.now() - reviewStart
  }

  const finalStrategy = strategy !== "auto" ? strategy : analysis.consensus_strategy
  
  // Phase 4: Consensus
  const phase4Start = Date.now()
  let consensus: ConsensusResult
  if (finalStrategy === "single") {
    emitProgress(context, {
      phase: "consensus",
      step: "skipped",
      progress: 75,
      message: "Consensus skipped (single strategy)",
      metadata: { strategy: "single" }
    })
    
    consensus = {
      consensus_reached: true,
      final_output: execution.results[Object.keys(execution.results)[0]]?.output ?? "No output",
      confidence: 0.9,
      strategy_used: "single",
      rounds_executed: 1,
      agent_contributions: {},
      metadata: { convergence_score: 1.0 }
    }
  } else {
    emitProgress(context, {
      phase: "consensus",
      step: "starting",
      progress: 75,
      message: `Running ${finalStrategy} consensus`,
      metadata: { strategy: finalStrategy }
    })
    
    consensus = await withPhase(context, signal, "consensus", phaseSignal =>
      runPhase4Consensus(context, execution, finalStrategy, phaseSignal, specs, userPrompt)
    )
    
    emitProgress(context, {
      phase: "consensus",
      step: "complete",
      progress: 85,
      message: `Consensus ${consensus.consensus_reached ? "reached" : "failed"} (confidence: ${Math.round(consensus.confidence * 100)}%)`,
      metadata: { consensusReached: consensus.consensus_reached, confidence: consensus.confidence }
    })
  }
  phaseTimings["consensus"] = Date.now() - phase4Start
  if (context.partial) {
    context.partial.consensus = consensus
    context.partial.strategy = finalStrategy
  }

  // Phase 5: Synthesize
  const phase5Start = Date.now()
  emitProgress(context, {
    phase: "synthesize",
    step: "starting",
    progress: 90,
    message: "Synthesizing final result",
    metadata: {}
  })
  
  const synthStart = Date.now()
  let finalResult: string
  try {
    finalResult = await withPhase(context, signal, "synthesize", phaseSignal =>
      runPhase5Synthesize(
        context,
        consensus,
        execution,
        phaseSignal,
        reviewOutcome.review.approved ? undefined : reviewOutcome.review.issues.join("\n")
      ))
  } catch (err) {
    if (signal.aborted || context.abort.aborted) throw err
    emitProgress(context, {
      phase: "synthesize",
      step: "synthesize-degraded",
      progress: 95,
      message: `Synthesis failed (${(err as Error).message}); using consensus output directly`,
      metadata: { error: (err as Error).message }
    })
    finalResult = consensus.final_output
  }
  phaseTimings["synthesize"] = Date.now() - synthStart
  
  const totalTime = Date.now() - startTime

  emitProgress(context, {
    phase: "complete",
    step: "done",
    progress: 100,
    message: `Orchestration complete in ${totalTime}ms`,
    metadata: { totalTimeMs: totalTime }
  })

  await cleanupSessions(context)
  return {
    result: finalResult,
    metadata: {
      phases_completed: 5,
      agents_spawned: execution.execution_metadata.total_agents,
      parallel_groups: execution.execution_metadata.total_groups,
      consensus_strategy: finalStrategy,
      consensus_reached: consensus.consensus_reached,
      confidence: consensus.confidence,
      total_time_ms: totalTime,
    },
    diagram: {
      analysis,
      specs,
      execution,
      consensus,
      strategyReasoning,
      phaseTimings,
    }
  }
}

function generateProposedSchematic(analysis: TaskAnalysis | null, specs: AgentSpec[], strategy: string): string {
  const lines: string[] = []
  lines.push("## Proposed Execution Blueprint & Sequence")
  lines.push("")
  lines.push("```text")
  lines.push(`Strategy: ${strategy} | Task Type: ${analysis?.task_type ?? "coding"} | Complexity: ${analysis?.complexity ?? "complex"}`)
  lines.push("─────────────────────────────────────────────────────────────")
  lines.push("PROPOSED AGENT CARDS:")
  for (const spec of specs) {
    const deps = spec.depends_on.length > 0 ? ` (deps: ${spec.depends_on.join(", ")})` : " (root)"
    lines.push(`  • [${spec.id}] ${spec.role}${deps}`)
    lines.push(`    Goal: ${spec.goal}`)
    lines.push(`    Tier: ${spec.model_tier} | Tools: ${spec.tools.join(", ")}`)
  }
  lines.push("")
  lines.push("PROPOSED INTERACTION SEQUENCE:")
  lines.push("  [Orchestrator] ──► [Bootstrap Pool Warm-up]")
  for (const spec of specs) {
    lines.push(`  [Orchestrator] ──► [${spec.id}: ${spec.role}] (Parallel DAG Wave)`)
  }
  if (strategy !== "single") {
    lines.push(`  [Agents] ──────► [Phase 4 Consensus: ${strategy} (Multi-Round)]`)
  }
  lines.push("  [Consensus] ───► [Phase 5 Synthesize] ──► [Final Result]")
  lines.push("─────────────────────────────────────────────────────────────")
  lines.push("```")
  return lines.join("\n")
}

// A run that stops early still owes the user the plan: the agent cards, the
// sequence, and how far each phase got. Rendering the diagram with the error
// is what keeps a timeout from looking like the tool did nothing at all.
function renderFailureDiagnostics(
  partial: RunDiagnostics | undefined,
  userPrompt: string,
  elapsedMs: number,
): string {
  if (!partial) return ""
  const analysis = partial.analysis ?? null
  const specs = partial.specs ?? []
  const phaseTimings = partial.phaseTimings ?? {}
  if (!analysis && specs.length === 0 && Object.keys(phaseTimings).length === 0) return ""

  const execution = partial.execution ?? null
  const finished = execution
    ? `${execution.execution_metadata.completed}/${execution.execution_metadata.total_agents} agent(s)`
    : "none"
  const phases = Object.entries(phaseTimings)
    .map(([phase, ms]) => `${phase} ${ms}ms`)
    .join(", ")

  const diagram = generateOrchestrationDiagram(
    userPrompt,
    analysis,
    specs,
    execution,
    partial.consensus ?? null,
    partial.strategyReasoning ?? "",
    phaseTimings,
    elapsedMs,
  )

  return `---

## Run Stopped Early

- Strategy: ${partial.strategy ?? "auto"}
- Agents finished before stopping: ${finished}
- Time spent: ${elapsedMs}ms
- Phase timings: ${phases || "none completed"}

${diagram}`
}

// Generate visual orchestration diagram
function generateOrchestrationDiagram(
  userPrompt: string,
  analysis: TaskAnalysis | null,
  specs: AgentSpec[],
  execution: ExecutionResult | null,
  consensus: ConsensusResult | null,
  strategyReasoning: string,
  phaseTimings: Record<string, number>,
  totalTime: number
): string {
  const lines: string[] = []
  
  // Header
  lines.push("# Orchestration Diagram")
  lines.push("")
  lines.push(`**Task:** ${userPrompt.slice(0, 120)}${userPrompt.length > 120 ? "..." : ""}`)
  lines.push("")
  
  // Strategy Selection
  lines.push("## Strategy Selection")
  lines.push("")
  lines.push("```")
  lines.push(strategyReasoning)
  lines.push("```")
  lines.push("")
  
  // Analysis Summary
  if (analysis) {
    lines.push("## Task Analysis")
    lines.push("")
    lines.push("```")
    lines.push(`Type:        ${analysis.task_type}`)
    lines.push(`Complexity:  ${analysis.complexity}`)
    lines.push(`Domains:     ${analysis.domains.join(", ")}`)
    lines.push(`Capabilities: ${analysis.capabilities.join(", ")}`)
    lines.push(`Strategy:    ${analysis.consensus_strategy}`)
    lines.push("```")
    lines.push("")
  }

  // Proposed Execution Blueprint & Sequence
  if (specs.length > 0) {
    lines.push(generateProposedSchematic(analysis, specs, consensus?.strategy_used ?? analysis?.consensus_strategy ?? "auto"))
    lines.push("")
  }
  
  // Agent Map
  lines.push("## Agent Map")
  lines.push("")
  if (specs.length > 0) {
    lines.push("```")
    lines.push("┌─────────────────────────────────────────────────────────────┐")
    lines.push("│                      AGENT MAP                              │")
    lines.push("├─────────────────────────────────────────────────────────────┤")
    
    // Group by dependency level
    const groupLevels = computeGroupLevels(specs)
    const levels = new Map<number, AgentSpec[]>()
    for (const spec of specs) {
      const level = groupLevels.get(spec.id) ?? 1
      if (!levels.has(level)) levels.set(level, [])
      levels.get(level)!.push(spec)
    }
    
    const sortedLevels = Array.from(levels.entries()).sort((a, b) => a[0] - b[0])
    
    for (let i = 0; i < sortedLevels.length; i++) {
      const [level, levelSpecs] = sortedLevels[i]
      if (i > 0) {
        lines.push("│                          ↓                                   │")
        lines.push("│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │")
      }
      
      for (const spec of levelSpecs) {
        const deps = spec.depends_on.length > 0 ? ` (← ${spec.depends_on.join(", ")})` : " (root)"
        const tools = spec.tools.slice(0, 3).join(", ") + (spec.tools.length > 3 ? "..." : "")
        lines.push(`│  [${spec.id}] ${spec.role}`)
        lines.push(`│    Goal: ${spec.goal.slice(0, 50)}${spec.goal.length > 50 ? "..." : ""}`)
        lines.push(`│    Tier: ${spec.model_tier} | Tools: ${tools}${deps}`)
      }
    }
    
    lines.push("└─────────────────────────────────────────────────────────────┘")
    lines.push("```")
  }
  lines.push("")
  
  // Execution Flow
  if (execution) {
    lines.push("## Execution Flow")
    lines.push("")
    lines.push("```")
    
    const totalGroups = execution.execution_metadata.total_groups
    const completed = execution.execution_metadata.completed
    const failed = execution.execution_metadata.failed
    const total = execution.execution_metadata.total_agents
    
    lines.push("┌─────────────────────────────────────────────────────────────┐")
    lines.push("│                   EXECUTION FLOW                            │")
    lines.push("├─────────────────────────────────────────────────────────────┤")
    
    // Show parallel groups
    const groupLevels = computeGroupLevels(specs)
    const groups = new Map<number, AgentSpec[]>()
    for (const spec of specs) {
      const groupId = groupLevels.get(spec.id) ?? 1
      if (!groups.has(groupId)) groups.set(groupId, [])
      groups.get(groupId)!.push(spec)
    }
    
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => a[0] - b[0])
    
    for (let i = 0; i < sortedGroups.length; i++) {
      const [groupId, groupAgents] = sortedGroups[i]
      const groupResults = groupAgents.map(a => execution.results[a.id])
      const groupCompleted = groupResults.filter(r => r?.status === "completed").length
      const groupFailed = groupResults.filter(r => r?.status === "failed").length
      
      lines.push(`│  GROUP ${groupId}: ${groupAgents.length} agent(s) [${groupCompleted} ok, ${groupFailed} fail]`)
      
      for (const spec of groupAgents) {
        const result = execution.results[spec.id]
        const status = result?.status === "completed" ? "✓" : result?.status === "failed" ? "✗" : "?"
        const duration = result?.duration_ms ? ` (${result.duration_ms}ms)` : ""
        const outputPreview = result?.output ? result.output.slice(0, 40).replace(/\n/g, " ") + (result.output.length > 40 ? "..." : "") : "N/A"
        lines.push(`│    ${status} [${spec.id}] ${spec.role}${duration}`)
        lines.push(`│      └─ ${outputPreview}`)
      }
      
      if (i < sortedGroups.length - 1) {
        lines.push("│                          ↓                                   │")
      }
    }
    
    lines.push("└─────────────────────────────────────────────────────────────┘")
    lines.push("```")
  }
  lines.push("")
  
  // Consensus Summary
  if (consensus) {
    lines.push("## Consensus")
    lines.push("")
    lines.push("```")
    lines.push(`Strategy:     ${consensus.strategy_used}`)
    lines.push(`Reached:      ${consensus.consensus_reached ? "Yes" : "No"}`)
    lines.push(`Confidence:   ${(consensus.confidence * 100).toFixed(0)}%`)
    lines.push(`Rounds:       ${consensus.rounds_executed}`)
    if (Object.keys(consensus.agent_contributions).length > 0) {
      lines.push("Contributions:")
      for (const [id, contrib] of Object.entries(consensus.agent_contributions)) {
        lines.push(`  - ${id}: weight=${contrib.weight.toFixed(2)}, accepted=${contrib.accepted}`)
      }
    }
    lines.push("```")
  }
  lines.push("")
  
  // Phase Timings
  lines.push("## Phase Timings")
  lines.push("")
  lines.push("```")
  lines.push("Phase           Duration    Status")
  lines.push("────────────── ─────────── ────────")
  for (const [phase, duration] of Object.entries(phaseTimings)) {
    const pad = " ".repeat(Math.max(0, 14 - phase.length))
    const durPad = " ".repeat(Math.max(0, 11 - `${duration}ms`.length))
    lines.push(`${phase}${pad} ${duration}ms${durPad} done`)
  }
  lines.push("────────────── ─────────── ────────")
  lines.push(`TOTAL          ${totalTime}ms`)
  lines.push("```")
  lines.push("")
  
  return lines.join("\n")
}

// ---- OpenTelemetry bridge --------------------------------------------------
// Publishes orchestration metrics into whatever global MeterProvider the host
// registered (e.g. opencode-otel-plugin via `metrics.setGlobalMeterProvider`).
// Degrades to a silent no-op when @opentelemetry/api or a provider is absent,
// so telemetry can never break a run and the plugin never hard-requires otel.
const OTEL_METER_NAME = "opencode.agent-factory"
const OTEL_METRIC_PREFIX = typeof process !== "undefined" && process.env?.OPENCODE_OTEL_METRIC_PREFIX
  ? process.env.OPENCODE_OTEL_METRIC_PREFIX
  : ""

interface BridgeInstruments {
  count: { add(value: number, attrs?: Record<string, unknown>): void } | null
  duration: { record(value: number, attrs?: Record<string, unknown>): void } | null
  agents: { add(value: number, attrs?: Record<string, unknown>): void } | null
  phaseDuration: { record(value: number, attrs?: Record<string, unknown>): void } | null
}

let bridgeMeter: any | null | undefined
let bridgeInstruments: BridgeInstruments | null | undefined

async function getBridgeMeter(): Promise<any | null> {
  if (bridgeMeter !== undefined) return bridgeMeter
  try {
    const api = await import("@opentelemetry/api")
    bridgeMeter = api?.metrics?.getMeter?.(OTEL_METER_NAME) ?? null
  } catch {
    bridgeMeter = null
  }
  return bridgeMeter
}

async function getBridgeInstruments(): Promise<BridgeInstruments | null> {
  if (bridgeInstruments !== undefined) return bridgeInstruments
  const meter = await getBridgeMeter()
  if (!meter || typeof meter.createCounter !== "function") {
    bridgeInstruments = null
    return null
  }
  const n = (base: string) => (OTEL_METRIC_PREFIX ? `${OTEL_METRIC_PREFIX}${base}` : base)
  try {
    bridgeInstruments = {
      count: meter.createCounter(n("orchestration.count"), { description: "Orchestration runs", unit: "invocations" }),
      duration: meter.createHistogram(n("orchestration.duration"), { description: "Total orchestration time", unit: "ms" }),
      agents: meter.createCounter(n("orchestration.agents"), { description: "Agents spawned per orchestration", unit: "agents" }),
      phaseDuration: meter.createHistogram(n("orchestration.phase.duration"), { description: "Per-phase orchestration time", unit: "ms" }),
    }
  } catch {
    bridgeInstruments = null
  }
  return bridgeInstruments
}

export interface OrchestrationBridgeEvent {
  ok: boolean
  path: "fast-path" | "complex" | "unknown"
  strategy: string
  agents: number
  totalMs: number
  phaseTimings?: Record<string, number>
  errorPhase?: string
}

// Fire-and-forget: called from the orchestrate tool after every run.
export async function recordOtelBridge(event: OrchestrationBridgeEvent): Promise<void> {
  try {
    const instruments = await getBridgeInstruments()
    if (!instruments) return
    const attrs = {
      status: event.ok ? "ok" : "error",
      path: event.path,
      strategy: event.strategy,
      ...(event.errorPhase ? { error_phase: event.errorPhase } : {}),
    }
    instruments.count?.add(1, attrs)
    instruments.duration?.record(event.totalMs, attrs)
    if (event.agents > 0) instruments.agents?.add(event.agents, { path: event.path })
    for (const [phase, ms] of Object.entries(event.phaseTimings ?? {})) {
      instruments.phaseDuration?.record(ms, { phase, path: event.path })
    }
  } catch {
    // Telemetry must never break the run.
  }
}

// Internal: drops the cached meter/instruments (exported for unit tests).
export function resetOtelBridge(): void {
  bridgeMeter = undefined
  bridgeInstruments = undefined
}

const REPORT_RELATIVE_PATH = join(".agent-factory", "last-orchestration.md")
const BLACKBOARD_RELATIVE_PATH = join(".agent-factory", "last-blackboard.md")

// The run's shared memory is persisted next to the report so the notes agents
// exchanged can be inspected after the sessions are cleaned up.
function flushBlackboard(directory: string, board?: RunBlackboard): string | null {
  const markdown = board?.renderMarkdown()
  if (!markdown) return null
  try {
    const file = join(directory, BLACKBOARD_RELATIVE_PATH)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, markdown, "utf-8")
    return BLACKBOARD_RELATIVE_PATH
  } catch {
    return null
  }
}

// The tool result is consumed by the model, which routinely paraphrases it and
// drops the diagram (observed live: a full run whose reply contained none of the
// agent cards, timings or schematic). The complete report is therefore also
// written to disk and announced, so the run stays inspectable no matter what
// the model chooses to relay back to the user.
function writeOrchestrationReport(directory: string, content: string): string | null {
  try {
    const file = join(directory, REPORT_RELATIVE_PATH)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, "utf-8")
    return REPORT_RELATIVE_PATH
  } catch {
    return null
  }
}

function showRunToast(
  context: OrchestratorContext,
  body: { title?: string; message: string; variant: "success" | "error" | "warning" | "info" },
): void {
  if (context.options?.enableProgress === false) return
  const tui: any = (context.client as any)?.tui
  if (typeof tui?.showToast !== "function") return
  void Promise.resolve(tui.showToast({ body: { duration: 10000, ...body } })).catch(() => {})
}

export function getOrchestrateTool(client: any, project: any, directory: string, worktree: string, options?: PluginOptions) {
  // Initialize options with project directory
  const resolvedOptions = getOptions(options, directory)
  
  // Set up persistent telemetry if enabled
  if (resolvedOptions.enablePersistentTelemetry) {
    persistentTelemetryPath = resolvedOptions.telemetryPath
    loadTelemetry()
  }
  
  // Load custom agent templates if enabled
  let customTemplates = new Map<string, string>()
  if (resolvedOptions.enableTemplateLibrary) {
    customTemplates = loadCustomAgentTemplates(resolvedOptions.templateDirs)
  }
  
  return {
    description:
      "Run a dynamic multi-agent workflow. Analyzes the prompt, generates specialized agents at runtime, executes them in parallel with dependency resolution, and synthesizes results using consensus strategies.",
    args: {
      prompt: tool.schema.string().describe("The task to orchestrate across multiple agents"),
      strategy: tool.schema.optional(
        tool.schema.string().describe(
          "Consensus strategy: auto (default), single, debate, voting, expert_review, hierarchical, mesh, fipa_contract_net"
        )
      ),
    },
    async execute(
      args: { prompt: string; strategy?: string },
      // `sessionID` is what lets every child session nest under the caller, so
      // the TUI shows them as this session's sub-agents instead of loose rows.
      context: { sessionID?: string; abort: AbortSignal; metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void },
    ) {
      // Commands/templates often append "strategy=debate" inside the prompt
      // text rather than as a separate argument — honor it instead of
      // silently burying it in the task description.
      let { prompt, strategy } = args
      if (!strategy) {
        const match = prompt.match(/\bstrategy\s*=\s*([a-z_]+)/i)
        if (match && (VALID_STRATEGIES as readonly string[]).includes(match[1])) {
          strategy = match[1]
          prompt = prompt.replace(match[0], "").replace(/\s*,\s*(?=$|[,.;])/g, "").trim()
        }
      }
      const orchestratorContext: OrchestratorContext = {
        client,
        project,
        directory,
        worktree,
        abort: context.abort,
        createdSessions: [],
        parentSessionID: context.sessionID,
        options: resolvedOptions,
        customTemplates,
        // Surface live phase/agent feedback in the TUI (like the task tool's
        // streaming status) so the user sees progress instead of waiting blind.
        onProgress: (event) => {
          try {
            context.metadata?.({
              title: `${event.phase}: ${event.step}`,
              metadata: { progress: event.progress, message: event.message, ...event.metadata },
            })
          } catch {
            // metadata updates must never break the run
          }
        },
      }
      
      const orchestrateStart = Date.now()
      try {
        const result = await runOrchestration(orchestratorContext, prompt, strategy ?? "auto")

        void recordOtelBridge({
          ok: true,
          path: result.metadata.phases_completed === 3 ? "fast-path" : "complex",
          strategy: result.metadata.consensus_strategy,
          agents: result.metadata.agents_spawned,
          totalMs: result.metadata.total_time_ms,
          phaseTimings: result.diagram.phaseTimings,
        })

        // Generate visual diagram
        const diagram = generateOrchestrationDiagram(
          prompt,
          result.diagram.analysis,
          result.diagram.specs,
          result.diagram.execution,
          result.diagram.consensus,
          result.diagram.strategyReasoning,
          result.diagram.phaseTimings,
          result.metadata.total_time_ms
        )

        // Persist the shared memory of the run next to the report, so the
        // notes the agents exchanged outlive the cleaned-up sessions.
        const blackboardPath = flushBlackboard(directory, orchestratorContext.blackboard)

        const body = `${result.result}

---

## Execution Schematic & Diagram

${diagram}

## Execution Summary
- Agents spawned: ${result.metadata.agents_spawned}
- Parallel groups: ${result.metadata.parallel_groups}
- Consensus strategy: ${result.metadata.consensus_strategy}
- Consensus reached: ${result.metadata.consensus_reached ? "yes" : "no"}
- Confidence: ${(result.metadata.confidence * 100).toFixed(0)}%
- Total time: ${result.metadata.total_time_ms}ms${blackboardPath ? `
- Shared blackboard: ${blackboardPath}` : ""}`

        const reportPath = writeOrchestrationReport(directory, body)
        const seconds = (result.metadata.total_time_ms / 1000).toFixed(1)
        showRunToast(orchestratorContext, {
          title: "Orchestrate",
          variant: "success",
          message: `${result.metadata.agents_spawned} agents · ${result.metadata.consensus_strategy} · ${seconds}s${
            reportPath ? ` — full report: ${reportPath}` : ""
          }`,
        })

        // Lead with the run stats: whatever the model relays back to the user,
        // it starts from a line that already names the agents, strategy and time.
        return `**Orchestrate:** ${result.metadata.agents_spawned} agents · ${
          result.metadata.consensus_strategy
        } · ${seconds}s${reportPath ? ` · full report: ${reportPath}` : ""}

${body}`
      } catch (error) {
        await cleanupSessions(orchestratorContext)
        void recordOtelBridge({
          ok: false,
          path: "unknown",
          strategy: strategy ?? "auto",
          agents: 0,
          totalMs: Date.now() - orchestrateStart,
          errorPhase: error instanceof OrchestrationError ? error.phase : undefined,
        })
        // A failure still owes the user the plan: agent cards, diagram and the
        // phase timings collected before the run stopped, so an aborted run
        // never looks like the tool did nothing at all.
        const diagnostics = renderFailureDiagnostics(
          orchestratorContext.partial,
          prompt,
          Date.now() - orchestrateStart,
        )
        let report: string
        if (error instanceof OrchestrationError) {
          // Time-budget failures are not transient: answering "recoverable,
          // please try again" makes orchestrating agents burn the same full
          // budget again in a retry loop (observed live: 3+ back-to-back
          // 300s attempts that all failed the same way).
          const externalAbort = orchestratorContext.abort.aborted
          const budgetExhausted =
            !externalAbort && /^Operation aborted during /.test(error.message)
          const phaseTimedOut = !externalAbort && /exceeded phase timeout/.test(error.message)
          if (budgetExhausted) {
            report = `## Orchestration Failed (${error.phase})

**Error:** ${error.message}

**Recoverable:** no

The overall time budget (${getOptions(options).overallTimeoutMs}ms) is spent, so
retrying now would fail the same way. Raise \`overallTimeoutMs\`, reduce the
task scope, or answer without orchestration.`
          } else if (phaseTimedOut) {
            report = `## Orchestration Failed (${error.phase})

**Error:** ${error.message}

**Recoverable:** no

The "${error.phase}" phase already used its own retries before timing out.
Retrying would spend another full run reaching the same slow step. Raise
\`phaseTimeoutMs\`, check provider latency, or simplify the task.`
          } else {
            report = `## Orchestration Failed (${error.phase})

**Error:** ${error.message}

**Recoverable:** ${error.recoverable ? "yes" : "no"}

Please try again or simplify your request.`
          }
        } else {
          report = `## Orchestration Failed

**Error:** ${error instanceof Error ? error.message : String(error)}

Please try again or contact support.`
        }
        const blackboardPath = flushBlackboard(directory, orchestratorContext.blackboard)
        const boardNote = blackboardPath
          ? `\n\n**Shared blackboard:** notes posted before the run stopped: ${blackboardPath}`
          : ""
        const fullReport = diagnostics
          ? `${report}${boardNote}\n\n${diagnostics}`
          : `${report}${boardNote}`
        const failedReportPath = writeOrchestrationReport(directory, fullReport)
        showRunToast(orchestratorContext, {
          title: "Orchestrate failed",
          variant: "error",
          message: failedReportPath
            ? `run stopped — full report: ${failedReportPath}`
            : "run stopped before producing a result",
        })
        return fullReport
      }
    }
  }
}

// Top-level exports
export {
  getTelemetrySnapshot,
  resetTelemetry,
  getSessionInfo,
  cleanupOldSessions,
  validateAgentTools,
  loadCustomAgentTemplates,
  setGoal,
  getGoal,
  updateGoal,
  completeGoal,
  blockGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
  incrementTurnCount,
  validateCompletion,
  // Internals exported for unit testing
  getOptions,
  normalizeStrategy,
  validateInput,
  validateTaskAnalysis,
  validateAgentSpecs,
  normalizeAgentSpecs,
  generateAgentSpecs,
  validateExecutionResult,
  validateConsensusResult,
  extractJson,
  getAgentPrompt,
  buildAgentPrompt,
  computeGroupLevels,
  generateOrchestrationDiagram,
  runNativeDAGExecution,
  createTimeoutSignal,
  withPhase,
  OrchestrationError,
}
export type {
  TelemetryMetrics,
  PersistedSession,
  AgentFactoryPluginOptions,
  TaskAnalysis,
  AgentSpec,
  AgentExecutionResult,
  ExecutionResult,
  ConsensusResult,
  OrchestratorContext,
  ProgressEvent,
}