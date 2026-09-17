import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, readdirSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadAgentsFromDir(dir: string): Record<string, string> {
  const agents: Record<string, string> = {}
  if (!existsSync(dir)) return agents
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".md")) {
      const name = file.replace(".md", "")
      agents[name] = readFileSync(join(dir, file), "utf-8")
    }
  }
  return agents
}

function getAgentPrompt(name: string): string {
  const pluginDir = join(__dirname, "..")
  const agentFile = join(pluginDir, "agents", `${name}.md`)
  if (existsSync(agentFile)) {
    return readFileSync(agentFile, "utf-8")
  }
  return ""
}

export const AgentFactoryPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  await client.app.log({
    body: {
      service: "agent-factory",
      level: "info",
      message: "Agent Factory plugin loaded",
      extra: { project: project?.id ?? "unknown" },
    },
  })

  return {
    tool: {
      orchestrate: tool({
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
        async execute(args, context) {
          const prompt = args.prompt
          const strategy = args.strategy ?? "auto"

          const orchestratorPrompt = getAgentPrompt("dynamic-orchestrator")
          const factoryPrompt = getAgentPrompt("agent-factory")
          const executionPrompt = getAgentPrompt("execution-engine")
          const consensusPrompt = getAgentPrompt("consensus-manager")

          return `
# Orchestration Task

${orchestratorPrompt}

## User Task

${prompt}

## Consensus Strategy Override

${strategy !== "auto" ? `Use strategy: ${strategy}` : "Select the best strategy automatically based on task analysis."}

## Available Agent Definitions

### Agent Factory
${factoryPrompt}

### Execution Engine
${executionPrompt}

### Consensus Manager
${consensusPrompt}

## Instructions

Execute the full 6-phase orchestration pipeline:
1. ANALYZE - Analyze the task using agent-factory principles
2. PLAN - Generate agent specifications
3. EXECUTE - Spawn agents via task tool in parallel groups
4. CONSENSUS - Apply consensus strategy
5. SYNTHESIZE - Produce final result

Use the \`task\` tool to spawn each phase as a subagent.
`
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      await client.app.log({
        body: {
          service: "agent-factory",
          level: "debug",
          message: `Session ${event.properties.sessionID} idle`,
        },
      })
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool === "task") {
        await client.app.log({
          body: {
            service: "agent-factory",
            level: "info",
            message: `Spawning subagent: ${output.args.agent ?? "default"}`,
          },
        })
      }
    },
  }
}
