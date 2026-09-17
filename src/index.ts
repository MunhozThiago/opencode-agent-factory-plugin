import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { getOrchestrateTool } from "./orchestrator"

export const AgentFactoryPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  await client.app.log({
    body: {
      service: "agent-factory",
      level: "info",
      message: "Agent Factory plugin loaded",
      extra: { project: project?.id ?? "unknown" },
    },
  })

  const orchestrateTool = getOrchestrateTool(client, project, directory, worktree)

  return {
    tool: {
      orchestrate: tool(orchestrateTool),
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