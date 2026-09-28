import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { 
  getOrchestrateTool, getTelemetrySnapshot, resetTelemetry, getSessionInfo, cleanupOldSessions,
  setGoal, getGoal, updateGoal, completeGoal, blockGoal, pauseGoal, resumeGoal, clearGoal,
  incrementTurnCount, validateCompletion
} from "./orchestrator"

export const AgentFactoryPlugin: Plugin = async ({ project, client, directory, worktree }, options) => {
  await client.app.log({
    body: {
      service: "agent-factory",
      level: "info",
      message: "Agent Factory plugin loaded",
      extra: { project: project?.id ?? "unknown" },
    },
  })

  const orchestrateTool = getOrchestrateTool(client, project, directory, worktree, options)

  return {
    tool: {
      orchestrate: tool(orchestrateTool),
      
      // Goal management tools (like opencode-goal-plugin)
      goal_set: tool({
        description: "Set a new orchestration goal. Call this to start autonomous multi-agent work.",
        args: {
          objective: tool.schema.string().describe("The goal objective to achieve"),
          maxTurns: tool.schema.optional(tool.schema.number().describe("Maximum turns before forced completion (default: 50)")),
        },
        async execute(args, context) {
          const goal = setGoal(context.sessionID, args.objective, args.maxTurns ?? 50)
          return JSON.stringify({ 
            status: "active", 
            goalId: goal.id, 
            objective: goal.objective,
            message: "Goal set. Working autonomously..."
          })
        },
      }),
      
      goal_status: tool({
        description: "Get the current goal status",
        args: {},
        async execute(args, context) {
          const goal = getGoal(context.sessionID)
          if (!goal) return JSON.stringify({ status: "none", message: "No active goal" })
          return JSON.stringify({
            id: goal.id,
            objective: goal.objective,
            status: goal.status,
            turnCount: goal.turnCount,
            maxTurns: goal.maxTurns,
            createdAt: new Date(goal.createdAt).toISOString(),
            updatedAt: new Date(goal.updatedAt).toISOString(),
            checkpoints: goal.checkpoints,
            blocker: goal.blocker,
            completionEvidence: goal.completionEvidence,
          })
        },
      }),
      
      goal_complete: tool({
        description: "Mark the current goal as complete. Requires evidence of completion.",
        args: {
          evidence: tool.schema.string().describe("Evidence that the goal was achieved"),
        },
        async execute(args, context) {
          const validation = validateCompletion(context.sessionID, args.evidence)
          if (!validation.valid) {
            return JSON.stringify({ 
              status: "rejected", 
              reason: validation.reason,
              message: `Goal completion rejected: ${validation.reason}`
            })
          }
          const goal = completeGoal(context.sessionID, args.evidence)
          return JSON.stringify({ 
            status: "completed", 
            goalId: goal?.id,
            message: "Goal completed successfully"
          })
        },
      }),
      
      goal_block: tool({
        description: "Mark the current goal as blocked with a reason",
        args: {
          blocker: tool.schema.string().describe("Description of what is blocking the goal"),
        },
        async execute(args, context) {
          const goal = blockGoal(context.sessionID, args.blocker)
          if (!goal) return JSON.stringify({ status: "error", message: "No active goal" })
          return JSON.stringify({ 
            status: "blocked", 
            goalId: goal.id,
            blocker: goal.blocker,
            message: `Goal blocked: ${args.blocker}`
          })
        },
      }),
      
      goal_pause: tool({
        description: "Pause the current goal",
        args: {},
        async execute(args, context) {
          const goal = pauseGoal(context.sessionID)
          if (!goal) return JSON.stringify({ status: "error", message: "No active goal" })
          return JSON.stringify({ 
            status: "paused", 
            goalId: goal.id,
            message: "Goal paused"
          })
        },
      }),
      
      goal_resume: tool({
        description: "Resume a paused goal",
        args: {},
        async execute(args, context) {
          const goal = resumeGoal(context.sessionID)
          if (!goal) return JSON.stringify({ status: "error", message: "No active goal" })
          return JSON.stringify({ 
            status: "active", 
            goalId: goal.id,
            message: "Goal resumed"
          })
        },
      }),
      
      goal_clear: tool({
        description: "Clear the current goal",
        args: {},
        async execute(args, context) {
          const deleted = clearGoal(context.sessionID)
          return JSON.stringify({ 
            status: "cleared",
            message: deleted ? "Goal cleared" : "No goal to clear"
          })
        },
      }),
      
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

    // Event hooks for auto-continue and state tracking
    event: async ({ event }) => {
      // Track idle events for auto-continue
      if (event.type === "session.idle") {
        const sessionId = event.properties.sessionID
        const goal = getGoal(sessionId)
        
        await client.app.log({
          body: {
            service: "agent-factory",
            level: "debug",
            message: `Session ${sessionId} idle${goal ? `, goal status: ${goal.status}` : ""}`,
          },
        })
        
        if (goal && goal.status === "active") {
          const turnCount = incrementTurnCount(sessionId)
          
          await client.app.log({
            body: {
              service: "agent-factory",
              level: "debug",
              message: `Goal active, turn ${turnCount}/${goal.maxTurns}`,
            },
          })
          
          // Check if we've exceeded max turns
          if (turnCount >= goal.maxTurns) {
            await client.app.log({
              body: {
                service: "agent-factory",
                level: "warn",
                message: `Goal exceeded max turns (${goal.maxTurns}), pausing`,
              },
            })
            pauseGoal(sessionId)
            return
          }
          
          // Auto-continue: send continuation prompt
          try {
            await client.session.prompt({
              path: { id: sessionId },
              body: {
                parts: [{ 
                  type: "text", 
                  text: `[Auto-continue] Turn ${turnCount}/${goal.maxTurns}. Continue working on the goal: "${goal.objective}". Use orchestrate tool for multi-agent work, or work directly. Call goal_complete when done with evidence.`
                }],
              },
              query: { directory },
            })
          } catch (err) {
            await client.app.log({
              body: {
                service: "agent-factory",
                level: "error",
                message: `Auto-continue failed: ${err}`,
              },
            })
          }
        }
      }
      
      // Track session creation
      if (event.type === "session.created") {
        await client.app.log({
          body: {
            service: "agent-factory",
            level: "debug",
            message: `Session created: ${event.properties.info.id}`,
          },
        })
      }
    },

    // Log tool executions
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
      if (input.tool === "orchestrate") {
        await client.app.log({
          body: {
            service: "agent-factory",
            level: "info",
            message: `Orchestration started: ${output.args.prompt?.substring(0, 100)}...`,
          },
        })
      }
    },
    
    // Log tool results
    "tool.execute.after": async (input, output) => {
      if (input.tool === "orchestrate") {
        await client.app.log({
          body: {
            service: "agent-factory",
            level: "info",
            message: `Orchestration completed: ${output.title}`,
          },
        })
      }
    },
  }
}

export default AgentFactoryPlugin
