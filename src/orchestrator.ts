import type { PluginInput } from "@opencode-ai/plugin"
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

// Performance: in-memory prompt cache
const agentPromptCache = new Map<string, string>()

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

interface ExecutionResult {
  results: Record<string, {
    status: "completed" | "failed" | "timeout"
    output: string
    error: string | null
    duration_ms: number
  }>
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
  fn: () => Promise<T>,
  phase: string,
  maxRetries = 2,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500
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
  const response = await withRetry(async () => {
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

async function promptSession(context: OrchestratorContext, sessionId: string, systemPrompt: string, userPrompt: string, agent?: string, tools?: Record<string, boolean>, signal?: AbortSignal) {
  checkAbort(signal ?? context.abort, "promptSession")
  const response = await withRetry(async () => {
    return context.client.session.prompt({
      path: { id: sessionId },
      body: {
        agent,
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

async function runPhase1Analyze(context: OrchestratorContext, userPrompt: string, strategyOverride: string, signal: AbortSignal): Promise<TaskAnalysis> {
  const child = await createChildSession(context, "agent-factory:analyze", signal)
  const factoryPrompt = getAgentPrompt("agent-factory")
  const systemPrompt = `${factoryPrompt}

You are in Phase 1: ANALYZE. Analyze the task and output ONLY the TaskAnalysis JSON.`

  const response = await promptSession(context, child.id, systemPrompt, `Task: ${userPrompt}\n\n${strategyOverride !== "auto" ? `Strategy override: ${strategyOverride}` : "Select the best strategy automatically."}`, "agent-factory", undefined, signal)
  const analysis = extractJson<TaskAnalysis>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!analysis || !validateTaskAnalysis(analysis)) throw new OrchestrationError("Failed to parse or validate task analysis", "phase1-analyze")
  return analysis
}

async function runPhase2Plan(context: OrchestratorContext, analysis: TaskAnalysis, signal: AbortSignal): Promise<AgentSpec[]> {
  const child = await createChildSession(context, "agent-factory:plan", signal)
  const factoryPrompt = getAgentPrompt("agent-factory")
  const systemPrompt = `${factoryPrompt}

You are in Phase 2: PLAN. Generate agent specifications from the analysis. Output ONLY the JSON array.`

  const response = await promptSession(context, child.id, systemPrompt, JSON.stringify(analysis, null, 2), "agent-factory", undefined, signal)
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
    promptSession(context, child1.id, systemPrompt, `Task: ${userPrompt}\n\n${strategyOverride !== "auto" ? `Strategy override: ${strategyOverride}` : "Select the best strategy automatically."}`, "agent-factory", undefined, signal),
    // Phase 2 will wait for analysis result, so we run it after
    (async () => {
      const analysisResponse = await promptSession(context, child1.id, systemPrompt, `Task: ${userPrompt}\n\n${strategyOverride !== "auto" ? `Strategy override: ${strategyOverride}` : "Select the best strategy automatically."}`, "agent-factory", undefined, signal)
      const analysis = extractJson<TaskAnalysis>(analysisResponse.parts.find(p => p.type === "text")?.text ?? "")
      if (!analysis || !validateTaskAnalysis(analysis)) throw new OrchestrationError("Failed to parse or validate task analysis", "phase1-analyze")
      
      const planSystemPrompt = `${factoryPrompt}

You are in Phase 2: PLAN. Generate agent specifications from the analysis. Output ONLY the JSON array.`
      
      return promptSession(context, child2.id, planSystemPrompt, JSON.stringify(analysis, null, 2), "agent-factory", undefined, signal)
    })()
  ])
  
  const analysis = extractJson<TaskAnalysis>(analysisResponse.parts.find(p => p.type === "text")?.text ?? "")
  if (!analysis || !validateTaskAnalysis(analysis)) throw new OrchestrationError("Failed to parse or validate task analysis", "phase1-analyze")
  
  const specs = extractJson<AgentSpec[]>(planResponse.parts.find(p => p.type === "text")?.text ?? "")
  if (!specs || !validateAgentSpecs(specs)) throw new OrchestrationError("Failed to parse or validate agent specs", "phase2-plan")
  
  return { analysis, specs }
}

async function runPhase3Execute(context: OrchestratorContext, specs: AgentSpec[], userTask: string, signal: AbortSignal): Promise<ExecutionResult> {
  const child = await createChildSession(context, "execution-engine:execute", signal)
  const executionPrompt = getAgentPrompt("execution-engine")
  const systemPrompt = `${executionPrompt}

You are in Phase 3: EXECUTE. Execute the agent DAG. Output ONLY the ExecutionResult JSON.`

  // Performance: send reduced spec (no full prompts)
  const reducedSpecs = specs.map(buildExecutionSpec)
  
  const response = await promptSession(context, child.id, systemPrompt, `Agent specs:\n${JSON.stringify(reducedSpecs, null, 2)}\n\nUser task: ${userTask}`, "execution-engine", undefined, signal)
  const result = extractJson<ExecutionResult>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!result || !validateExecutionResult(result)) throw new OrchestrationError("Failed to parse or validate execution result", "phase3-execute")
  return result
}

async function runPhase4Consensus(context: OrchestratorContext, executionResult: ExecutionResult, strategy: string, signal: AbortSignal): Promise<ConsensusResult> {
  const child = await createChildSession(context, "consensus-manager:consensus", signal)
  const consensusPrompt = getAgentPrompt("consensus-manager")
  const systemPrompt = `${consensusPrompt}

You are in Phase 4: CONSENSUS. Apply the consensus strategy. Output ONLY the ConsensusResult JSON.`

  const response = await promptSession(context, child.id, systemPrompt, `Strategy: ${strategy}\nAgent outputs:\n${JSON.stringify(executionResult.results, null, 2)}`, "consensus-manager", undefined, signal)
  const result = extractJson<ConsensusResult>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!result || !validateConsensusResult(result)) throw new OrchestrationError("Failed to parse or validate consensus result", "phase4-consensus")
  return result
}

async function runPhase5Synthesize(context: OrchestratorContext, consensus: ConsensusResult, executionResult: ExecutionResult, signal: AbortSignal): Promise<string> {
  const child = await createChildSession(context, "dynamic-orchestrator:synthesize", signal)
  const orchestratorPrompt = getAgentPrompt("dynamic-orchestrator")
  const systemPrompt = `${orchestratorPrompt}

You are in Phase 5: SYNTHESIZE. Compile the final response using the consensus output. Output ONLY the final answer.`

  const response = await promptSession(context, child.id, systemPrompt, `Consensus result:\n${JSON.stringify(consensus, null, 2)}\n\nExecution metadata:\n${JSON.stringify(executionResult.execution_metadata, null, 2)}`, "dynamic-orchestrator", undefined, signal)
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
  
  const overallSignal = createTimeoutSignal(DEFAULT_OVERALL_TIMEOUT_MS, context.abort)
  const startTime = Date.now()
  let phasesCompleted = 0

  await context.client.app.log({
    body: { service: "agent-factory", level: "info", message: "Starting orchestration pipeline" }
  })

  try {
    // Performance: fast-path for single strategy or simple tasks
    const isSimpleStrategy = strategy === "single" || (strategy === "auto" && userPrompt.length < 500)
    
    let analysis: TaskAnalysis
    let specs: AgentSpec[]
    
    if (isSimpleStrategy) {
      // Fast path: single phase for simple tasks
      const child = await createChildSession(context, "agent-factory:fast-path", overallSignal)
      const factoryPrompt = getAgentPrompt("agent-factory")
      const systemPrompt = `${factoryPrompt}

You are handling a SIMPLE task. Analyze and directly produce the final agent specification in one step. Output ONLY the AgentSpec[] JSON.`
      
      const response = await promptSession(context, child.id, systemPrompt, `Task: ${userPrompt}\n\nStrategy: single`, "agent-factory", undefined, overallSignal)
      const fastPathSpecs = extractJson<AgentSpec[]>(response.parts.find(p => p.type === "text")?.text ?? "")
      if (!fastPathSpecs || !validateAgentSpecs(fastPathSpecs)) throw new OrchestrationError("Failed to parse or validate agent specs", "fast-path")
      
      // Create minimal analysis for metadata
      analysis = {
        task_type: "coding",
        complexity: "simple",
        domains: ["general"],
        capabilities: ["code_execution"],
        consensus_strategy: "single",
        parallel_groups: [{ group_id: 1, independent: true, subtasks: fastPathSpecs.map(s => s.goal) }]
      }
      specs = fastPathSpecs
      phasesCompleted = 1
      await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Fast-path: single strategy complete" } })
    } else {
      // Performance: run phase 1 & 2 in parallel
      const { analysis: a, specs: s } = await runPhase1And2Parallel(context, userPrompt, strategy, overallSignal)
      analysis = a
      specs = s
      phasesCompleted = 2
      await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Phase 1+2: Analyze & Plan complete (parallel)" } })
    }

    const execution = await runPhase3Execute(context, specs, userPrompt, overallSignal)
    phasesCompleted++
    await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Phase 3: Execute complete" } })

    const finalStrategy = strategy !== "auto" ? strategy : analysis.consensus_strategy
    
    // Skip consensus for single strategy
    let consensus: ConsensusResult
    if (finalStrategy === "single") {
      consensus = {
        consensus_reached: true,
        final_output: execution.results[Object.keys(execution.results)[0]]?.output ?? "No output",
        confidence: 0.9,
        strategy_used: "single",
        rounds_executed: 1,
        agent_contributions: {},
        metadata: { convergence_score: 1.0 }
      }
      phasesCompleted++
      await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Phase 4: Consensus skipped (single strategy)" } })
    } else {
      consensus = await runPhase4Consensus(context, execution, finalStrategy, overallSignal)
      phasesCompleted++
      await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Phase 4: Consensus complete" } })
    }

    const finalResult = await runPhase5Synthesize(context, consensus, execution, overallSignal)
    phasesCompleted++
    await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Phase 5: Synthesize complete" } })

    const totalTime = Date.now() - startTime

    return {
      result: finalResult,
      metadata: {
        phases_completed: phasesCompleted,
        agents_spawned: execution.execution_metadata.total_agents,
        parallel_groups: execution.execution_metadata.total_groups,
        consensus_strategy: finalStrategy,
        consensus_reached: consensus.consensus_reached,
        confidence: consensus.confidence,
        total_time_ms: totalTime,
      }
    }
  } finally {
    await cleanupSessions(context)
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