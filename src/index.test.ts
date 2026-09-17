import { expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { AgentFactoryPlugin } from "./index"

test("logs idle sessions through the event lifecycle hook", async () => {
  const messages: string[] = []
  const input = {
    client: {
      app: {
        log: async ({ body }: { body: { message: string } }) => {
          messages.push(body.message)
        },
      },
    },
  } as unknown as PluginInput
  const hooks = await AgentFactoryPlugin(input)

  expect(hooks.event).toBeFunction()
  expect(hooks).not.toHaveProperty("session.idle")
  await hooks.event!({
    event: { type: "session.idle", properties: { sessionID: "session-test" } },
  })
  expect(messages).toEqual([
    "Agent Factory plugin loaded",
    "Session session-test idle",
  ])
  await hooks.event!({
    event: { type: "server.connected", properties: {} },
  })
  expect(messages).toHaveLength(2)
})
