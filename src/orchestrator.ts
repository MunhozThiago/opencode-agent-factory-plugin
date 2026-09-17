import type { PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync, readdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getAgentPrompt(name: string): string {
  const pluginDir = join(__dirname, "..")
  const agentFile = join(pluginDir, "agents", `${name}.md`)
  if (existsSync(agentFile)) {
    return readFileSync(agentFile, "utf-8")
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

async function createChildSession(context: OrchestratorContext, title: string) {
  const response = await context.client.session.create({
    body: {
      parentID: context.project.id,
      title,
    },
    query: { directory: context.directory },
  })
  if (response.error) throw new Error(`Failed to create session: ${response.error}`)
  return response.data
}

async function promptSession(context: OrchestratorContext, sessionId: string, systemPrompt: string, userPrompt: string, agent?: string, tools?: Record<string, boolean>) {
  const response = await context.client.session.prompt({
    path: { id: sessionId },
    body: {
      agent,
      system: systemPrompt,
      parts: [{ type: "text", text: userPrompt }],
      tools,
    },
    query: { directory: context.directory },
  })
  if (response.error) throw new Error(`Failed to prompt session: ${response.error}`)
  return response.data
}

async function getSessionMessages(context: OrchestratorContext, sessionId: string) {
  const response = await context.client.session.messages({
    path: { id: sessionId },
    query: { directory: context.directory },
  })
  if (response.error) throw new Error(`Failed to get messages: ${response.error}`)
  return response.data
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

async function runPhase1Analyze(context: OrchestratorContext, userPrompt: string, strategyOverride: string): Promise<TaskAnalysis> {
  const child = await createChildSession(context, "agent-factory:analyze")
  const factoryPrompt = getAgentPrompt("agent-factory")
  const systemPrompt = `${factoryPrompt}

You are in Phase 1: ANALYZE. Analyze the task and output ONLY the TaskAnalysis JSON.`

  const response = await promptSession(context, child.id, systemPrompt, `Task: ${userPrompt}\n\n${strategyOverride !== "auto" ? `Strategy override: ${strategyOverride}` : "Select the best strategy automatically."}`, "agent-factory")
  const analysis = extractJson<TaskAnalysis>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!analysis) throw new Error("Failed to parse task analysis")
  return analysis
}

async function runPhase2Plan(context: OrchestratorContext, analysis: TaskAnalysis): Promise<AgentSpec[]> {
  const child = await createChildSession(context, "agent-factory:plan")
  const factoryPrompt = getAgentPrompt("agent-factory")
  const systemPrompt = `${factoryPrompt}

You are in Phase 2: PLAN. Generate agent specifications from the analysis. Output ONLY the JSON array.`

  const response = await promptSession(context, child.id, systemPrompt, JSON.stringify(analysis, null, 2), "agent-factory")
  const specs = extractJson<AgentSpec[]>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!specs || !Array.isArray(specs)) throw new Error("Failed to parse agent specs")
  return specs
}

async function runPhase3Execute(context: OrchestratorContext, specs: AgentSpec[], userTask: string): Promise<ExecutionResult> {
  const child = await createChildSession(context, "execution-engine:execute")
  const executionPrompt = getAgentPrompt("execution-engine")
  const systemPrompt = `${executionPrompt}

You are in Phase 3: EXECUTE. Execute the agent DAG. Output ONLY the ExecutionResult JSON.`

  const response = await promptSession(context, child.id, systemPrompt, `Agent specs:\n${JSON.stringify(specs, null, 2)}\n\nUser task: ${userTask}`, "execution-engine")
  const result = extractJson<ExecutionResult>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!result) throw new Error("Failed to parse execution result")
  return result
}

async function runPhase4Consensus(context: OrchestratorContext, executionResult: ExecutionResult, strategy: string): Promise<ConsensusResult> {
  const child = await createChildSession(context, "consensus-manager:consensus")
  const consensusPrompt = getAgentPrompt("consensus-manager")
  const systemPrompt = `${consensusPrompt}

You are in Phase 4: CONSENSUS. Apply the consensus strategy. Output ONLY the ConsensusResult JSON.`

  const response = await promptSession(context, child.id, systemPrompt, `Strategy: ${strategy}\nAgent outputs:\n${JSON.stringify(executionResult.results, null, 2)}`, "consensus-manager")
  const result = extractJson<ConsensusResult>(response.parts.find(p => p.type === "text")?.text ?? "")
  if (!result) throw new Error("Failed to parse consensus result")
  return result
}

async function runPhase5Synthesize(context: OrchestratorContext, consensus: ConsensusResult, executionResult: ExecutionResult): Promise<string> {
  const child = await createChildSession(context, "dynamic-orchestrator:synthesize")
  const orchestratorPrompt = getAgentPrompt("dynamic-orchestrator")
  const systemPrompt = `${orchestratorPrompt}

You are in Phase 5: SYNTHESIZE. Compile the final response using the consensus output. Output ONLY the final answer.`

  const response = await promptSession(context, child.id, systemPrompt, `Consensus result:\n${JSON.stringify(consensus, null, 2)}\n\nExecution metadata:\n${JSON.stringify(executionResult.execution_metadata, null, 2)}`, "dynamic-orchestrator")
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
  const startTime = Date.now()
  let phasesCompleted = 0

  await context.client.app.log({
    body: { service: "agent-factory", level: "info", message: "Starting orchestration pipeline" }
  })

  const analysis = await runPhase1Analyze(context, userPrompt, strategy)
  phasesCompleted++
  await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Phase 1: Analyze complete" } })

  const specs = await runPhase2Plan(context, analysis)
  phasesCompleted++
  await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Phase 2: Plan complete" } })

  const execution = await runPhase3Execute(context, specs, userPrompt)
  phasesCompleted++
  await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Phase 3: Execute complete" } })

  const finalStrategy = strategy !== "auto" ? strategy : analysis.consensus_strategy
  const consensus = await runPhase4Consensus(context, execution, finalStrategy)
  phasesCompleted++
  await context.client.app.log({ body: { service: "agent-factory", level: "info", message: "Phase 4: Consensus complete" } })

  const finalResult = await runPhase5Synthesize(context, consensus, execution)
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
      const result = await runOrchestration({
        client,
        project,
        directory,
        worktree,
        abort: context.abort,
      }, args.prompt, args.strategy ?? "auto")

      return `## Result

${result.result}

## Execution Summary
- Agents spawned: ${result.metadata.agents_spawned}
- Parallel groups: ${result.metadata.parallel_groups}
- Consensus strategy: ${result.metadata.consensus_strategy}
- Consensus reached: ${result.metadata.consensus_reached ? "yes" : "no"}
- Confidence: ${(result.metadata.confidence * 100).toFixed(0)}%
- Total time: ${result.metadata.total_time_ms}ms`
    }
  }
}