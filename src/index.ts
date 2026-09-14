import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, readdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadMdFiles(subdir: string): Record<string, string> {
  const dir = join(__dirname, "..", subdir)
  const files: Record<string, string> = {}
  try {
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".md")) {
        const name = file.replace(".md", "")
        files[name] = readFileSync(join(dir, file), "utf-8")
      }
    }
  } catch {
    // directory doesn't exist, skip
  }
  return files
}

function parseAgentMd(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const frontmatter: Record<string, any> = {}
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      frontmatter[key] = value
    }
  }
  return { frontmatter, body: match[2] }
}

const AgentFactoryPlugin: Plugin = async (ctx) => {
  const agents = loadMdFiles("agents")
  const commands = loadMdFiles("commands")

  const agentDefs: Record<string, any> = {}
  for (const [name, content] of Object.entries(agents)) {
    const { frontmatter, body } = parseAgentMd(content)
    agentDefs[name] = {
      description: frontmatter.description || `Agent: ${name}`,
      mode: frontmatter.mode || "subagent",
      prompt: body,
    }
  }

  const commandDefs: Record<string, any> = {}
  for (const [name, content] of Object.entries(commands)) {
    const { frontmatter, body } = parseAgentMd(content)
    commandDefs[name] = {
      description: frontmatter.description || `Command: ${name}`,
      agent: frontmatter.agent || "dynamic-orchestrator",
      template: body,
    }
  }

  return {
    config: (cfg) => {
      cfg.agent = { ...agentDefs, ...(cfg.agent || {}) }
      cfg.command = { ...commandDefs, ...(cfg.command || {}) }
      if (!cfg.default_agent) {
        cfg.default_agent = "dynamic-orchestrator"
      }
    },
  }
}

export default AgentFactoryPlugin
