// ============================================================================
// SHARED BLACKBOARD (run-scoped memory)
// ============================================================================
// Agents in a run normally only see what the orchestrator hands them: their
// own spec and their dependencies' outputs. The blackboard is the run's shared
// memory — every agent can post a note (finding, decision, issue, artifact)
// and every later agent is shown those notes, so the team builds on prior work
// instead of rediscovering it. It is deliberately run-scoped: it is created
// with the run, injected into prompts, and flushed to disk at the end.

export type BlackboardKind = "finding" | "decision" | "issue" | "artifact"

export interface BlackboardEntry {
  /** Agent that wrote the note. */
  agentId: string
  kind: BlackboardKind
  content: string
  /** Phase that produced it (execute, review, ...). */
  phase?: string
  at: number
}

const VALID_KINDS: readonly string[] = ["finding", "decision", "issue", "artifact"]

// LLMs drift on exact formatting, so tolerate CRLF, missing newlines and an
// unknown kind instead of dropping the note.
const BLOCK_RE =
  /<<<BLACKBOARD(?:\s+kind=([a-zA-Z_]+))?>>>\r?\n?([\s\S]*?)\r?\n?<<<END BLACKBOARD>>>/g

export interface ParsedNote {
  kind: BlackboardKind
  content: string
}

export interface ParsedBlocks {
  notes: ParsedNote[]
  /** The agent's deliverable with every blackboard block removed. */
  rest: string
}

function normalizeKind(raw: string | undefined): BlackboardKind {
  const kind = (raw ?? "").toLowerCase()
  return (VALID_KINDS as readonly string[]).includes(kind) ? (kind as BlackboardKind) : "finding"
}

/** Extract coordination blocks from an agent reply; returns the cleaned deliverable. */
export function parseBlackboardBlocks(output: string): ParsedBlocks {
  const notes: ParsedNote[] = []
  let rest = output
  for (const match of [...output.matchAll(BLOCK_RE)]) {
    const content = (match[2] ?? "").trim()
    if (content.length > 0) notes.push({ kind: normalizeKind(match[1]), content })
    rest = rest.replace(match[0], "")
  }
  return { notes, rest: rest.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() }
}

/** Prompt text that tells an agent how to post to the board. */
export const BLACKBOARD_INSTRUCTION = `COORDINATION: other agents share this run with you. After your deliverable, if you produced something they or the final synthesis should know — a finding, a decision, an issue you hit, or an artifact you wrote — end your reply with exactly this block and nothing after it:

<<<BLACKBOARD kind=finding>>>
your one-paragraph note
<<<END BLACKBOARD>>>

The kind may be finding, decision, issue or artifact. The block is stripped out of your deliverable automatically, so your actual answer stays clean.`

const DEFAULT_MAX_ENTRIES = 40
const DEFAULT_NOTE_CHARS = 600
const DEFAULT_DIGEST_CHARS = 4000

export class RunBlackboard {
  private readonly items: BlackboardEntry[] = []

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly noteChars = DEFAULT_NOTE_CHARS,
    private readonly digestChars = DEFAULT_DIGEST_CHARS,
  ) {}

  record(entry: Omit<BlackboardEntry, "at"> & { at?: number }): void {
    const content = entry.content.trim()
    if (!content) return
    this.items.push({ ...entry, content, at: entry.at ?? Date.now() })
    if (this.items.length > this.maxEntries) this.items.splice(0, this.items.length - this.maxEntries)
  }

  size(): number {
    return this.items.length
  }

  entries(): readonly BlackboardEntry[] {
    return this.items
  }

  /**
   * Compact digest for prompt injection. Excludes the notes of the agent being
   * prompted (a re-prompted agent should not be handed back its own words) and
   * is hard-capped so a chatty team cannot blow up the context.
   */
  notesFor(excludeAgentId?: string): string {
    const header =
      "SHARED NOTES FROM OTHER AGENTS IN THIS RUN (build on these instead of repeating them):"
    // The header counts against the cap too, so the whole injection is bounded.
    let used = header.length + 1
    // Walk backwards: when the cap bites it is the stale entries that fall
    // away, never the newest work. They are re-ordered chronologically below.
    const lines: string[] = []
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]
      if (excludeAgentId && item.agentId === excludeAgentId) continue
      const content =
        item.content.length > this.noteChars ? `${item.content.slice(0, this.noteChars)}…` : item.content
      const line = `- [${item.kind}] ${item.agentId}: ${content.replace(/\s+/g, " ")}`
      if (used + line.length + 1 > this.digestChars) break
      lines.push(line)
      used += line.length + 1
    }
    if (lines.length === 0) return ""
    return [header, ...lines.reverse()].join("\n")
  }

  /** Full board rendered for the run report / post-run inspection. */
  renderMarkdown(): string {
    if (this.items.length === 0) return ""
    const lines = ["# Shared Blackboard", ""]
    for (const item of this.items) {
      lines.push(`- **[${item.kind}]** \`${item.agentId}\`${item.phase ? ` (${item.phase})` : ""}:`)
      lines.push("")
      lines.push(item.content.replace(/\n/g, "\n  "))
      lines.push("")
    }
    return lines.join("\n").trimEnd() + "\n"
  }
}
