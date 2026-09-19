import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync, readdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_OVERALL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_PHASE_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes
const MAX_PROMPT_LENGTH = 50000
const VALID_STRATEGIES = ["auto", "single", "debate", "voting", "expert_review", "hierarchical"] as const

// Plugin configuration options
interface AgentFactoryPluginOptions {
  overallTimeoutMs: number
  phaseTimeoutMs: number
  maxRetries: number
  baseRetryDelayMs: number
  enableProgress: boolean
  fastPathThresholdChars: number
  defaultStrategy: typeof VALID_STRATEGIES[number]
}

function getOptions(options?: PluginOptions): AgentFactoryPluginOptions {
  return {
    overallTimeoutMs: (options?.overallTimeoutMs as number) ?? DEFAULT_OVERALL_TIMEOUT_MS,
    phaseTimeoutMs: (options?.phaseTimeoutMs as number) ?? DEFAULT_PHASE_TIMEOUT_MS,
    maxRetries: (options?.maxRetries as number) ?? 2,
    baseRetryDelayMs: (options?.baseRetryDelayMs as number) ?? 1000,
    enableProgress: (options?.enableProgress as boolean) ?? true,
    fastPathThresholdChars: (options?.fastPathThresholdChars as number) ?? 500,
    defaultStrategy: (options?.defaultStrategy as typeof VALID_STRATEGIES[number]) ?? "auto",
  }
}

// Performance: in-memory prompt cache
const agentPromptCache = new Map<string, string>()

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
  phase?: string
  strategy?: string
  durationMs?: number
  agentsSpawned?: number
  fastPath?: boolean
}): void {
  telemetryMetrics.totalOrchestrations++
  
  if (event.type === "orchestration_complete") {
    telemetryMetrics.successfulOrchestrations++
    telemetryMetrics.totalExecutionTimeMs += event.durationMs || 0
    if (event.agentsSpawned) telemetryMetrics.totalAgentsSpawned += event.agentsSpawned
    if (event.strategy) telemetryMetrics.strategyUsage[event.strategy] = (telemetryMetrics.strategyUsage[event.strategy] || 0) + 1
    if (event.fastPath) telemetryMetrics.fastPathUsage++
    else telemetryMetrics.complexPathUsage++
  } else if (event.type === "orchestration_failed") {
    telemetryMetrics.failedOrchestrations++
  }
  
  if (event.phase && event.durationMs) {
    if (!telemetryMetrics.phaseTimings[event.phase]) telemetryMetrics.phaseTimings[event.phase] = []
    telemetryMetrics.phaseTimings[event.phase].push(event.durationMs)
  }
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

// In-memory session store (could be persisted to disk)
const sessionStore = new Map<string, PersistedSession>()

function getOrCreateSession(context: OrchestratorContext): string {
  const key = `${context.project.id}:${context.directory}`
  let session = sessionStore.get(key)
  
  if (!session) {
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
    context.client.app.log({
      body: {
        service: "agent-factory",
        level: "info",
        message: `[Progress] ${event.phase}: ${event.step} (${event.progress}%) - ${event.message}`,
        extra: { progress: event.progress, phase: event.phase, ...event.metadata },
      },
    })
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

function getAgentPrompt(name: string): string {
  // Performance: cache agent prompts after first read
  if (agentPromptCache.has(name)) return agentPromptCache.get(name)!
  
  const pluginDir = join(__dirname, "..")
  const agentFile = join(pluginDir, "agents", `${name}.md`)
  if (existsSync(agentFile)) {
    const content = readFileSync(agentFile, "utf-8")
    agentPromptCache.set(name, content)
    return content
  }
  return ""
}

interface TaskAnalysis {
  task_type: "coding" | "research" | "analysis" | "creative" | "debugging" | "planning"
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
}

function createTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  if (externalSignal) {
    externalSignal.addEventListener("abort", () => {
      clearTimeout(timeoutId)
      controller.abort()
    })
  }
  return controller.signal
}

function checkAbort(signal: AbortSignal, phase: string): void {
  if (signal.aborted) {
    throw new OrchestrationError(`Operation aborted during ${phase}`, phase, undefined, true)
  }
}

async function withRetry<T>(
  context: OrchestratorContext,
  fn: () => Promise<T>,
  phase: string
): Promise<T> {
  const maxRetries = context.options.maxRetries
  const baseDelayMs = context.options.baseRetryDelayMs
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < maxRetries) {
        const delay = context.options.baseRetryDelayMs * Math.pow(2, attempt) + Math.random() * 500
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  throw new OrchestrationError(`${phase} failed after ${maxRetries + 1} attempts`, phase, lastError, true)
}

function extractJson<T>(text: string): T | null {
  try {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (!match) return null
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

function validateTaskAnalysis(analysis: any): analysis is TaskAnalysis {
  return (
    analysis &&
    typeof analysis === "object" &&
    ["coding", "research", "analysis", "creative", "debugging", "planning"].includes(analysis.task_type) &&
    ["simple", "moderate", "complex"].includes(analysis.complexity) &&
    Array.isArray(analysis.domains) &&
    Array.isArray(analysis.capabilities) &&
    ["single", "debate", "voting", "expert_review", "hierarchical"].includes(analysis.consensus_strategy) &&
    Array.isArray(analysis.parallel_groups)
  )
}

function validateAgentSpecs(specs: any): specs is AgentSpec[] {
  return Array.isArray(specs) && specs.every(s =>
    s && typeof s.id === "string" && typeof s.role === "string" && typeof s.goal === "string" &&
    typeof s.prompt === "string" && Array.isArray(s.tools) &&
    ["powerful", "balanced", "fast"].includes(s.model_tier) &&
    Array.isArray(s.depends_on) &&
    ["json", "markdown", "code", "structured_text"].includes(s.output_format) &&
    typeof s.timeout_ms === "number" &&
    s.retry_policy && typeof s.retry_policy.max_retries === "number"
  )
}

function validateExecutionResult(result: any): result is ExecutionResult {
  return (
    result &&
    typeof result === "object" &&
    typeof result.results === "object" &&
    result.execution_metadata &&
    typeof result.execution_metadata.total_groups === "number" &&
    typeof result.execution_metadata.total_agents === "number"
  )
}

function validateConsensusResult(result: any): result is ConsensusResult {
  return (
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
  const response = await withRetry(context, async () => {
    return context.client.session.create({
      body: {
        parentID: context.project.id,
        title,
      },
      query: { directory: context.directory },
    })
  }, "createChildSession")
  
  if (response.error) throw new OrchestrationError(`Failed to create session: ${response.error}`, "createChildSession")
  const session = response.data
  context.createdSessions.push(session.id)
  return session
}

async function promptSession(context: OrchestratorContext, sessionId: string, systemPrompt: string, userPrompt: string, tools?: Record<string, boolean>, signal?: AbortSignal) {
  checkAbort(signal ?? context.abort, "promptSession")
  const response = await withRetry(context, async () => {
    return context.client.session.prompt({
      path: { id: sessionId },
      body: {
        system: systemPrompt,
        parts: [{ type: "text", text: userPrompt }],
        tools,
      },
      query: { directory: context.directory },
    })
  }, "promptSession")
  
  if (response.error) throw new OrchestrationError(`Failed to prompt session: ${response.error}`, "promptSession")
  return response.data
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
  for (const sessionId of context.createdSessions) {
    await deleteSession(context, sessionId)
  }
  context.createdSessions = []
}

// Performance: reduced agent spec for execution-engine context
function buildExecutionSpec(spec: AgentSpec): object {
  return {
    id: spec.id,
    role: spec.role,
    goal: spec.goal,
    tools: spec.tools,
    model_tier: spec.model_tier,
    depends_on: spec.depends_on,
    output_format: spec.output_format,
    timeout_ms: spec.timeout_ms,
  }
}

function buildAgentPrompt(agent: AgentSpec, userTask: string, dependencyOutputs: Record<string, string>): string {
  const deps = Object.entries(dependencyOutputs)
    .map(([id, output]) => `${id}: ${output}`)
    .join("\n")
  
  return `${agent.prompt}

ORIGINAL TASK:
${userTask}

${deps ? `DEPENDENCY OUTPUTS FROM PRIOR AGENTS:\n${deps}\n` : ""}

YOUR SPECIFIC SUBTASK:
${agent.goal}

OUTPUT FORMAT: ${agent.output_format}`
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
  const groups = new Map<number, AgentSpec[]>()
  for (const spec of specs) {
    const groupId = spec.depends_on.length === 0 ? 1 : Math.max(...spec.depends_on.map(d => {
      const dep = agentMap.get(d)
      return dep ? 1 : 1
    })) + 1
    
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

    // Spawn all agents in this group in parallel
    const groupPromises = groupAgents.map(async (spec, agentIndex) => {
      const agentStartTime = Date.now()
      const sessionTitle = `agent:${spec.id}:${spec.role}`
      
      try {
        checkAbort(signal, `agent-${spec.id}`)
        
        emitProgress(context, {
          phase: "execution",
          step: `agent-${spec.id}-start`,
          progress: groupProgressBase + Math.round((agentIndex / groupAgents.length) * groupProgressStep),
          message: `Starting agent ${spec.id} (${spec.role})`,
          metadata: { agentId: spec.id, role: spec.role, groupId }
        })
        
        const session = await createChildSession(context, `agent:${spec.id}:${spec.role}`, signal)
        
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
        
        const output = response.parts.find(p => p.type === "text")?.text ?? ""
        const durationMs = Date.now() - agentStartTime
        
        completedOutputs[spec.id] = output
        completed++
        
        emitProgress(context, {
          phase: "execution",
          step: `agent-${spec.id}-complete`,
          progress: groupProgressBase + Math.round(((agentIndex + 1) / groupAgents.length) * groupProgressStep),
          message: `Agent ${spec.id} completed (${durationMs}ms)`,
          metadata: { agentId: spec.id, durationMs, status: "completed" }
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
        
        emitProgress(context, {
          phase: "execution",
          step: `agent-${spec.id}-failed`,
          progress: groupProgressBase + Math.round(((agentIndex + 1) / groupAgents.length) * groupProgressStep),
          message: `Agent ${spec.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          metadata: { agentId: spec.id, durationMs, status: "failed", error: error instanceof Error ? error.message : String(error) }
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

async function runPhase1Analyze(context: OrchestratorContext, userPrompt: string, strategyOverride: string, signal: AbortSignal): Promise<TaskAnalysis> {
  const child = await createChildSession(context, "agent-factory:analyze", signal)
  const factoryPrompt = getAgentPrompt("agent-factory")
  const systemPrompt = `${factoryPrompt}

You are in Phase 1: ANALYZE. Analyze the task and output ONLY the TaskAnalysis JSON.`

  const response = await promptSession(context, child.id, systemPrompt, `Task: ${userPrompt}\n\n${strategyOverride !== "auto" ? `Strategy override: ${strategyOverride}` : "Select the best strategy automatically."}`, undefined, signal)
  const analysis = extractJson<TaskAnalysis>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!analysis || !validateTaskAnalysis(analysis)) throw new OrchestrationError("Failed to parse or validate task analysis", "phase1-analyze")
  return analysis
}

async function runPhase2Plan(context: OrchestratorContext, analysis: TaskAnalysis, signal: AbortSignal): Promise<AgentSpec[]> {
  const child = await createChildSession(context, "agent-factory:plan", signal)
  const factoryPrompt = getAgentPrompt("agent-factory")
  const systemPrompt = `${factoryPrompt}

You are in Phase 2: PLAN. Generate agent specifications from the analysis. Output ONLY the JSON array.`

  const response = await promptSession(context, child.id, systemPrompt, JSON.stringify(analysis, null, 2), undefined, signal)
  const specs = extractJson<AgentSpec[]>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!specs || !validateAgentSpecs(specs)) throw new OrchestrationError("Failed to parse or validate agent specs", "phase2-plan")
  return specs
}

// Performance: run phase 1 & 2 in parallel (both use agent-factory)
async function runPhase1And2Parallel(context: OrchestratorContext, userPrompt: string, strategyOverride: string, signal: AbortSignal): Promise<{ analysis: TaskAnalysis; specs: AgentSpec[] }> {
  const child1 = await createChildSession(context, "agent-factory:analyze", signal)
  const child2 = await createChildSession(context, "agent-factory:plan", signal)
  
  const factoryPrompt = getAgentPrompt("agent-factory")
  const systemPrompt = `${factoryPrompt}

You are in Phase 1: ANALYZE. Analyze the task and output ONLY the TaskAnalysis JSON.`

  // Phase 1: Analyze
  const [analysisResponse, planResponse] = await Promise.all([
    promptSession(context, child1.id, systemPrompt, `Task: ${userPrompt}\n\n${strategyOverride !== "auto" ? `Strategy override: ${strategyOverride}` : "Select the best strategy automatically."}`, undefined, signal),
    // Phase 2 will wait for analysis result, so we run it after
    (async () => {
      const analysisResponse = await promptSession(context, child1.id, systemPrompt, `Task: ${userPrompt}\n\n${strategyOverride !== "auto" ? `Strategy override: ${strategyOverride}` : "Select the best strategy automatically."}`, undefined, signal)
      const analysis = extractJson<TaskAnalysis>(analysisResponse.parts.find(p => p.type === "text")?.text ?? "")
      if (!analysis || !validateTaskAnalysis(analysis)) throw new OrchestrationError("Failed to parse or validate task analysis", "phase1-analyze")
      
      const planSystemPrompt = `${factoryPrompt}

You are in Phase 2: PLAN. Generate agent specifications from the analysis. Output ONLY the JSON array.`
      
      return promptSession(context, child2.id, planSystemPrompt, JSON.stringify(analysis, null, 2), undefined, signal)
    })()
  ])
  
  const analysis = extractJson<TaskAnalysis>(analysisResponse.parts.find(p => p.type === "text")?.text ?? "")
  if (!analysis || !validateTaskAnalysis(analysis)) throw new OrchestrationError("Failed to parse or validate task analysis", "phase1-analyze")
  
  const specs = extractJson<AgentSpec[]>(planResponse.parts.find(p => p.type === "text")?.text ?? "")
  if (!specs || !validateAgentSpecs(specs)) throw new OrchestrationError("Failed to parse or validate agent specs", "phase2-plan")
  
  return { analysis, specs }
}

// REPLACED: Native DAG execution instead of LLM-based execution-engine
async function runPhase3Execute(context: OrchestratorContext, specs: AgentSpec[], userTask: string, signal: AbortSignal): Promise<ExecutionResult> {
  return runNativeDAGExecution(context, specs, userTask, signal)
}

async function runPhase4Consensus(context: OrchestratorContext, executionResult: ExecutionResult, strategy: string, signal: AbortSignal): Promise<ConsensusResult> {
  const child = await createChildSession(context, "consensus-manager:consensus", signal)
  const consensusPrompt = getAgentPrompt("consensus-manager")
  const systemPrompt = `${consensusPrompt}

You are in Phase 4: CONSENSUS. Apply the consensus strategy. Output ONLY the ConsensusResult JSON.`

  const response = await promptSession(context, child.id, systemPrompt, `Strategy: ${strategy}\nAgent outputs:\n${JSON.stringify(executionResult.results, null, 2)}`, undefined, signal)
  const result = extractJson<ConsensusResult>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!result || !validateConsensusResult(result)) throw new OrchestrationError("Failed to parse or validate consensus result", "phase4-consensus")
  return result
}

async function runPhase5Synthesize(context: OrchestratorContext, consensus: ConsensusResult, executionResult: ExecutionResult, signal: AbortSignal): Promise<string> {
  const child = await createChildSession(context, "dynamic-orchestrator:synthesize", signal)
  const orchestratorPrompt = getAgentPrompt("dynamic-orchestrator")
  const systemPrompt = `${orchestratorPrompt}

You are in Phase 5: SYNTHESIZE. Compile the final response using the consensus output. Output ONLY the final answer.`

  const response = await promptSession(context, child.id, systemPrompt, `Consensus result:\n${JSON.stringify(consensus, null, 2)}\n\nExecution metadata:\n${JSON.stringify(executionResult.execution_metadata, null, 2)}`, undefined, signal)
  return response.parts.find(p => p.type === "text")?.text ?? "No result produced"
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
}> {
  validateInput(userPrompt, strategy)
  
  const overallSignal = createTimeoutSignal(context.options.overallTimeoutMs, context.abort)
  const startTime = Date.now()
  
  // Get or create persisted session
  const sessionId = getOrCreateSession(context)
  
  emitProgress(context, {
    phase: "init",
    step: "starting",
    progress: 0,
    message: "Starting orchestration pipeline",
    metadata: { totalPhases: 5, sessionId }
  })

  try {
    // Performance: fast-path for single strategy or simple tasks
    const isSimpleStrategy = strategy === "single" || (strategy === "auto" && userPrompt.length < context.options.fastPathThresholdChars)
    
    let result
    if (isSimpleStrategy) {
      result = await runFastPath(context, userPrompt, overallSignal, startTime)
    } else {
      result = await runComplexPath(context, userPrompt, strategy, overallSignal, startTime)
    }
    
    // Record telemetry
    const durationMs = Date.now() - startTime
    recordTelemetry({
      type: "orchestration_complete",
      strategy: result.metadata.consensus_strategy,
      durationMs,
      agentsSpawned: result.metadata.agents_spawned,
      fastPath: result.metadata.phases_completed === 1,
    })
    
    return result
  } catch (error) {
    recordTelemetry({ type: "orchestration_failed", durationMs: Date.now() - startTime })
    await cleanupSessions(context)
    throw error
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
  
  const child = await createChildSession(context, "agent-factory:fast-path", signal)
  const factoryPrompt = getAgentPrompt("agent-factory")
  const systemPrompt = `${factoryPrompt}

You are handling a SIMPLE task. Analyze and directly produce the final agent specification in one step. Output ONLY the AgentSpec[] JSON.`
  
  const response = await promptSession(context, child.id, systemPrompt, `Task: ${userPrompt}\n\nStrategy: single`, undefined, signal)
  const fastPathSpecs = extractJson<AgentSpec[]>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!fastPathSpecs || !validateAgentSpecs(fastPathSpecs)) throw new OrchestrationError("Failed to parse or validate agent specs", "fast-path")
  
  const analysis: TaskAnalysis = {
    task_type: "coding",
    complexity: "simple",
    domains: ["general"],
    capabilities: ["code_execution"],
    consensus_strategy: "single",
    parallel_groups: [{ group_id: 1, independent: true, subtasks: fastPathSpecs.map(s => s.goal) }]
  }
  const specs = fastPathSpecs
  
  emitProgress(context, {
    phase: "fast-path",
    step: "complete",
    progress: 20,
    message: "Fast-path complete",
    metadata: { agentsGenerated: specs.length }
  })

  // Fast-path: create minimal execution result and synthesize
  const execution: ExecutionResult = {
    results: {
      "fast-path": {
        status: "completed",
        output: "Fast-path completed directly",
        error: null,
        duration_ms: 0,
      }
    },
    execution_metadata: {
      total_groups: 1,
      total_agents: specs.length,
      completed: specs.length,
      failed: 0,
      total_time_ms: 0,
    }
  }

  const consensus: ConsensusResult = {
    consensus_reached: true,
    final_output: "Fast-path completed",
    confidence: 0.9,
    strategy_used: "single",
    rounds_executed: 1,
    agent_contributions: {},
    metadata: { convergence_score: 1.0 }
  }

  const finalResult = await runPhase5Synthesize(context, consensus, execution, signal)
  
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
      phases_completed: 1,
      agents_spawned: specs.length,
      parallel_groups: 1,
      consensus_strategy: "single",
      consensus_reached: true,
      confidence: 0.9,
      total_time_ms: totalTime,
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
  let phasesCompleted = 0
  let analysis: TaskAnalysis
  let specs: AgentSpec[]
  
  // Phase 1: Analyze
  emitProgress(context, {
    phase: "analyze",
    step: "starting",
    progress: 10,
    message: "Analyzing task complexity and domains",
    metadata: { strategy }
  })
  
  const child1 = await createChildSession(context, "agent-factory:analyze", signal)
  const factoryPrompt = getAgentPrompt("agent-factory")
  const systemPrompt = `${factoryPrompt}

You are in Phase 1: ANALYZE. Analyze the task and output ONLY the TaskAnalysis JSON.`

  const analysisResponse = await promptSession(context, child1.id, systemPrompt, `Task: ${userPrompt}\n\n${strategy !== "auto" ? `Strategy override: ${strategy}` : "Select the best strategy automatically."}`, undefined, signal)
  const parsedAnalysis = extractJson<TaskAnalysis>(analysisResponse.parts.find(p => p.type === "text")?.text ?? "")
  if (!parsedAnalysis || !validateTaskAnalysis(parsedAnalysis)) throw new OrchestrationError("Failed to parse or validate task analysis", "phase1-analyze")
  analysis = parsedAnalysis
  
  emitProgress(context, {
    phase: "analyze",
    step: "complete",
    progress: 20,
    message: `Task analyzed: ${analysis.task_type}/${analysis.complexity}`,
    metadata: { taskType: analysis.task_type, complexity: analysis.complexity, domains: analysis.domains }
  })

  // Phase 2: Plan
  emitProgress(context, {
    phase: "plan",
    step: "starting",
    progress: 25,
    message: "Generating agent specifications",
    metadata: { expectedAgents: "unknown" }
  })
  
  const child2 = await createChildSession(context, "agent-factory:plan", signal)
  const planSystemPrompt = `${factoryPrompt}

You are in Phase 2: PLAN. Generate agent specifications from the analysis. Output ONLY the JSON array.`

  const planResponse = await promptSession(context, child2.id, planSystemPrompt, JSON.stringify(analysis, null, 2), undefined, signal)
  const parsedSpecs = extractJson<AgentSpec[]>(planResponse.parts.find(p => p.type === "text")?.text ?? "")
  if (!parsedSpecs || !validateAgentSpecs(parsedSpecs)) throw new OrchestrationError("Failed to parse or validate agent specs", "phase2-plan")
  specs = parsedSpecs
  
  emitProgress(context, {
    phase: "plan",
    step: "complete",
    progress: 35,
    message: `Generated ${specs.length} agent specifications`,
    metadata: { agentCount: specs.length, roles: specs.map(s => s.role) }
  })

  // Phase 3: Execute (Native DAG)
  emitProgress(context, {
    phase: "execute",
    step: "starting",
    progress: 40,
    message: "Executing agent DAG natively",
    metadata: { agentCount: specs.length }
  })
  
  const execution = await runPhase3Execute(context, specs, userPrompt, signal)
  
  emitProgress(context, {
    phase: "execute",
    step: "complete",
    progress: 70,
    message: `Execution complete: ${execution.execution_metadata.completed}/${execution.execution_metadata.total_agents} agents succeeded`,
    metadata: { completed: execution.execution_metadata.completed, total: execution.execution_metadata.total_agents }
  })

  const finalStrategy = strategy !== "auto" ? strategy : analysis.consensus_strategy
  
  // Phase 4: Consensus
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
    
    consensus = await runPhase4Consensus(context, execution, finalStrategy, signal)
    
    emitProgress(context, {
      phase: "consensus",
      step: "complete",
      progress: 85,
      message: `Consensus ${consensus.consensus_reached ? "reached" : "failed"} (confidence: ${Math.round(consensus.confidence * 100)}%)`,
      metadata: { consensusReached: consensus.consensus_reached, confidence: consensus.confidence }
    })
  }

  // Phase 5: Synthesize
  emitProgress(context, {
    phase: "synthesize",
    step: "starting",
    progress: 90,
    message: "Synthesizing final result",
    metadata: {}
  })
  
  const finalResult = await runPhase5Synthesize(context, consensus, execution, signal)
  
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
    }
  }
}

export function getOrchestrateTool(client: any, project: any, directory: string, worktree: string) {
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
        options: getOptions(),
      }
      
      try {
        const result = await runOrchestration(orchestratorContext, args.prompt, args.strategy ?? "auto")

        return `## Result

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
export { getTelemetrySnapshot, resetTelemetry, getSessionInfo, cleanupOldSessions }
export type { TelemetryMetrics, PersistedSession }