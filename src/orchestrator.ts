import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_OVERALL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_PHASE_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes
const CLEANUP_DEADLINE_MS = 10_000 // never stall the tool return on session cleanup
const MAX_PROMPT_LENGTH = 50000
const VALID_STRATEGIES = ["auto", "single", "debate", "voting", "expert_review", "hierarchical"] as const

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
    ["single", "debate", "voting", "expert_review", "hierarchical"].includes(analysis.consensus_strategy) &&
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
  return withRetry(context, async () => {
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

async function cleanupSessions(context: OrchestratorContext): Promise<void> {
  // Performance: parallel cleanup instead of sequential
  const pending = Promise.all(context.createdSessions.map(id => deleteSession(context, id)))
  context.createdSessions = []
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

function buildAgentPrompt(agent: AgentSpec, userTask: string, dependencyOutputs: Record<string, string>): string {
  const deps = Object.entries(dependencyOutputs)
    .map(([id, output]) => `${id}: ${output}`)
    .join("\n")

  const ownership = agent.outputs && agent.outputs.length > 0
    ? `

FILE OWNERSHIP - you alone may write these files:
${agent.outputs.map(o => `- ${o}`).join("\n")}

Do not modify any file outside this list. Another agent owns the rest; pass
coordination notes through your output instead of touching their files.`
    : ""

  return `${agent.prompt}${ownership}

ORIGINAL TASK:
${userTask}

${deps ? `DEPENDENCY OUTPUTS FROM PRIOR AGENTS:\n${deps}\n` : ""}

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

// Native DAG Execution: spawn agents in parallel groups via SDK
async function runNativeDAGExecution(
  context: OrchestratorContext, 
  specs: AgentSpec[], 
  userTask: string, 
  signal: AbortSignal
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

    // Performance: create all sessions in parallel first, then prompt in parallel
    const sessions = await Promise.all(
      groupAgents.map(spec => createChildSession(context, `agent:${spec.id}:${spec.role}`, signal))
    )
    
    // Spawn all agents in this group in parallel
    const groupPromises = groupAgents.map(async (spec, agentIndex) => {
      const agentStartTime = Date.now()
      const session = sessions[agentIndex]
      
      try {
        checkAbort(signal, `agent-${spec.id}`)
        
        const depOutputs: Record<string, string> = {}
        for (const depId of spec.depends_on) {
          if (completedOutputs[depId]) {
            depOutputs[depId] = completedOutputs[depId]
          }
        }
        
        const agentPrompt = buildAgentPrompt(spec, userTask, depOutputs)
        
        const toolsObj: Record<string, boolean> = {}
        for (const tool of spec.tools) {
          toolsObj[tool] = true
        }
        
        const response = await promptSession(
          context, 
          session.id, 
          spec.prompt, 
          agentPrompt,
          toolsObj,
          signal
        )
        
        const output = response.parts.find((p: any) => p.type === "text")?.text ?? ""
        const durationMs = Date.now() - agentStartTime
        
        completedOutputs[spec.id] = output
        completed++
        
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
async function runPhase3Execute(context: OrchestratorContext, specs: AgentSpec[], userTask: string, signal: AbortSignal): Promise<ExecutionResult> {
  return runNativeDAGExecution(context, specs, userTask, signal)
}

async function runPhase4Consensus(context: OrchestratorContext, executionResult: ExecutionResult, strategy: string, signal: AbortSignal): Promise<ConsensusResult> {
  const child = await createChildSession(context, "consensus-manager:consensus", signal)
  const consensusPrompt = getAgentPrompt("consensus-manager", context.customTemplates)
  const systemPrompt = `${consensusPrompt}

You are in Phase 4: CONSENSUS. Apply the consensus strategy. Output ONLY the ConsensusResult JSON.`

  const response = await promptSession(context, child.id, systemPrompt, `Strategy: ${strategy}\nAgent outputs:\n${JSON.stringify(executionResult.results, null, 2)}`, undefined, signal)
  const result = extractJson<ConsensusResult>(response.parts.find((p: any) => p.type === "text")?.text ?? "")
  if (!result || !validateConsensusResult(result)) throw new OrchestrationError("Failed to parse or validate consensus result", "phase4-consensus")
  return result
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
  const response = await promptSession(
    context,
    child.id,
    systemPrompt,
    `Consensus result:\n${JSON.stringify(consensus, null, 2)}\n\nExecution metadata:\n${JSON.stringify(executionResult.execution_metadata, null, 2)}${note}`,
    undefined,
    signal
  )
  return response.parts.find((p: any) => p.type === "text")?.text ?? "No result produced"
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

  const results: Record<string, AgentExecutionResult> = { ...execution.results }
  const maxRounds = context.options.maxReviewRounds
  let approved = false
  let rounds = 0
  let openIssues: string[] = []

  for (let round = 0; round <= maxRounds; round++) {
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
        const child = await createChildSession(context, `reviewer:round-${rounds}`, phaseSignal)
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
        const response = await promptSession(context, child.id, systemPrompt, userPrompt, undefined, phaseSignal)
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
  const finalResult = await withPhase(context, signal, "synthesize", phaseSignal =>
    runPhase5Synthesize(
      context,
      consensus,
      execution,
      phaseSignal,
      review.approved ? undefined : review.issues.join("\n")
    ))
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

  analysis = await withPhase(context, signal, "analyze", async (phaseSignal) => {
    const child1 = await createChildSession(context, "agent-factory:analyze", phaseSignal)
    const systemPrompt = `${factoryPrompt}

You are in Phase 1: ANALYZE. Analyze the task and output ONLY the TaskAnalysis JSON.`

    const analysisResponse = await promptSession(context, child1.id, systemPrompt, `Task: ${userPrompt}\n\n${strategy !== "auto" ? `Strategy override: ${strategy}` : "Select the best strategy automatically."}`, undefined, phaseSignal)
    const parsedAnalysis = extractJson<TaskAnalysis>(analysisResponse.parts.find((p: any) => p.type === "text")?.text ?? "")
    if (!parsedAnalysis || !validateTaskAnalysis(parsedAnalysis)) throw new OrchestrationError("Failed to parse or validate task analysis", "phase1-analyze")
    return parsedAnalysis
  })
  phaseTimings["analyze"] = Date.now() - phase1Start
  
  // Build strategy reasoning
  strategyReasoning = `Strategy "${analysis.consensus_strategy}" selected because:
- Task type: ${analysis.task_type}
- Complexity: ${analysis.complexity}
- Domains: ${analysis.domains.join(", ")}
${strategy !== "auto" ? `- User override: ${strategy}` : "- Auto-selected based on analysis"}`
  
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

You are in Phase 2: PLAN. Generate agent specifications from the analysis. Do NOT perform any of the work yourself: no file writes, no shell commands. Output ONLY the JSON array.`

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

  try {
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
  
  emitProgress(context, {
    phase: "plan",
    step: "complete",
    progress: 35,
    message: `Generated ${specs.length} agent specifications`,
    metadata: { agentCount: specs.length, roles: specs.map(s => s.role) }
  })

  // Phase 3: Execute (Native DAG)
  const phase3Start = Date.now()
  emitProgress(context, {
    phase: "execute",
    step: "starting",
    progress: 40,
    message: "Executing agent DAG natively",
    metadata: { agentCount: specs.length }
  })
  
  let execution = await withPhase(context, signal, "execute", phaseSignal =>
    runPhase3Execute(context, specs, userPrompt, phaseSignal)
  )
  phaseTimings["execute"] = Date.now() - phase3Start
  
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
      runPhase4Consensus(context, execution, finalStrategy, phaseSignal)
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

  // Phase 5: Synthesize
  const phase5Start = Date.now()
  emitProgress(context, {
    phase: "synthesize",
    step: "starting",
    progress: 90,
    message: "Synthesizing final result",
    metadata: {}
  })
  
  const finalResult = await withPhase(context, signal, "synthesize", phaseSignal =>
    runPhase5Synthesize(
      context,
      consensus,
      execution,
      phaseSignal,
      reviewOutcome.review.approved ? undefined : reviewOutcome.review.issues.join("\n")
    ))
  phaseTimings["synthesize"] = Date.now() - phase5Start
  
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
          "Consensus strategy: auto (default), single, debate, voting, expert_review, hierarchical"
        )
      ),
    },
    async execute(args: { prompt: string; strategy?: string }, context: { abort: AbortSignal }) {
      const orchestratorContext: OrchestratorContext = {
        client,
        project,
        directory,
        worktree,
        abort: context.abort,
        createdSessions: [],
        options: resolvedOptions,
        customTemplates,
      }
      
      const orchestrateStart = Date.now()
      try {
        const result = await runOrchestration(orchestratorContext, args.prompt, args.strategy ?? "auto")

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
          args.prompt,
          result.diagram.analysis,
          result.diagram.specs,
          result.diagram.execution,
          result.diagram.consensus,
          result.diagram.strategyReasoning,
          result.diagram.phaseTimings,
          result.metadata.total_time_ms
        )

        return `${diagram}

---

## Result

${result.result}

## Execution Summary
- Agents spawned: ${result.metadata.agents_spawned}
- Parallel groups: ${result.metadata.parallel_groups}
- Consensus strategy: ${result.metadata.consensus_strategy}
- Consensus reached: ${result.metadata.consensus_reached ? "yes" : "no"}
- Confidence: ${(result.metadata.confidence * 100).toFixed(0)}%
- Total time: ${result.metadata.total_time_ms}ms`
      } catch (error) {
        await cleanupSessions(orchestratorContext)
        void recordOtelBridge({
          ok: false,
          path: "unknown",
          strategy: args.strategy ?? "auto",
          agents: 0,
          totalMs: Date.now() - orchestrateStart,
          errorPhase: error instanceof OrchestrationError ? error.phase : undefined,
        })
        if (error instanceof OrchestrationError) {
          return `## Orchestration Failed (${error.phase})

**Error:** ${error.message}

**Recoverable:** ${error.recoverable ? "yes" : "no"}

Please try again or simplify your request.`
        }
        return `## Orchestration Failed

**Error:** ${error instanceof Error ? error.message : String(error)}

Please try again or contact support.`
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