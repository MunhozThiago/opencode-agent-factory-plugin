import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { getOrchestrateTool, getTelemetrySnapshot, resetTelemetry, getSessionInfo, cleanupOldSessions } from "./orchestrator"

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
      telemetry: tool({
        description: "Get telemetry metrics for the agent factory plugin",
        args: {
          action: tool.schema.string().describe("Action: snapshot, reset, session, cleanup"),
        },
        async execute(args, context) {
          const action = args.action ?? "snapshot"
          
          switch (action) {
            case "snapshot": {
              const snapshot = getTelemetrySnapshot()
              return `## Telemetry Snapshot

**Orchestrations:** ${snapshot.totalOrchestrations} total (${snapshot.successfulOrchestrations} successful, ${snapshot.failedOrchestrations} failed)

**Performance:** ${snapshot.avgExecutionTimeMs}ms avg execution time, ${snapshot.avgAgentsPerOrchestration} agents/orchestration

**Paths:** ${snapshot.fastPathUsage} fast-path, ${snapshot.complexPathUsage} complex-path

**Strategies:** ${Object.entries(snapshot.strategyUsage).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}

**Phase Timings (avg ms):**
${Object.entries(snapshot.phaseTimings as Record<string, number[]>).map(([phase, times]) => `  ${phase}: ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}ms (${times.length} runs)`).join("\n") || "  none"}
`
            }
            case "reset": {
              resetTelemetry()
              return "Telemetry metrics reset"
            }
            case "session": {
              const orchestratorContext = {
                client,
                project,
                directory,
                worktree,
                abort: context.abort,
                createdSessions: [],
                options: { enableProgress: true } as any,
              }
              const session = getSessionInfo(orchestratorContext as any)
              if (!session) return "No active session"
              return `## Session Info

**Session ID:** ${session.sessionId}
**Created:** ${new Date(session.createdAt).toISOString()}
**Last Used:** ${new Date(session.lastUsed).toISOString()}
**Orchestrations:** ${session.orchestrations}
**Project:** ${session.contextSnapshot.projectId}
**Directory:** ${session.contextSnapshot.directory}
`
            }
            case "cleanup": {
              cleanupOldSessions()
              return "Old sessions cleaned up"
            }
            default:
              return `Unknown action: ${action}. Valid: snapshot, reset, session, cleanup`
          }
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