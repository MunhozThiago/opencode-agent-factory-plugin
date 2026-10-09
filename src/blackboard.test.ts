import { expect, test, describe } from "bun:test"
import { RunBlackboard, parseBlackboardBlocks, BLACKBOARD_INSTRUCTION } from "./blackboard"

describe("parseBlackboardBlocks", () => {
  test("extracts the note and strips it from the deliverable", () => {
    const out = parseBlackboardBlocks(
      `The API exposes three endpoints.\n\n<<<BLACKBOARD kind=decision>>>\nuse sqlite for storage\n<<<END BLACKBOARD>>>`,
    )

    expect(out.notes).toHaveLength(1)
    expect(out.notes[0].kind).toBe("decision")
    expect(out.notes[0].content).toBe("use sqlite for storage")
    expect(out.rest).toBe("The API exposes three endpoints.")
    expect(out.rest).not.toContain("<<<BLACKBOARD")
    expect(out.rest).not.toContain("use sqlite for storage")
  })

  test("tolerates CRLF, a missing newline and an unknown kind", () => {
    const crlf = parseBlackboardBlocks(
      "done\r\n<<<BLACKBOARD kind=finding>>>\r\nblocked on the api\r\n<<<END BLACKBOARD>>>",
    )
    expect(crlf.notes).toHaveLength(1)
    expect(crlf.notes[0].content).toBe("blocked on the api")
    expect(crlf.rest).toBe("done")

    const unknown = parseBlackboardBlocks(
      "answer\n<<<BLACKBOARD kind=gossip>>>\nnote\n<<<END BLACKBOARD>>>",
    )
    expect(unknown.notes[0].kind).toBe("finding")
    expect(unknown.rest).toBe("answer")
  })

  test("collects several blocks and leaves plain output untouched", () => {
    const many = parseBlackboardBlocks(
      "part one\n<<<BLACKBOARD kind=finding>>>\nfirst\n<<<END BLACKBOARD>>>\nmiddle\n<<<BLACKBOARD kind=issue>>>\nsecond\n<<<END BLACKBOARD>>>",
    )
    expect(many.notes.map(note => note.kind)).toEqual(["finding", "issue"])
    // The stripped blocks leave their surrounding paragraphs behind.
    expect(many.rest).toBe("part one\n\nmiddle")
    expect(many.rest).not.toContain("<<<")

    const plain = parseBlackboardBlocks("just the deliverable")
    expect(plain.notes).toHaveLength(0)
    expect(plain.rest).toBe("just the deliverable")
  })

  test("drops empty blocks instead of posting blank notes", () => {
    const out = parseBlackboardBlocks(
      "text\n<<<BLACKBOARD kind=finding>>>\n   \n<<<END BLACKBOARD>>>",
    )
    expect(out.notes).toHaveLength(0)
    expect(out.rest).toBe("text")
  })
})

describe("RunBlackboard", () => {
  test("builds a digest that names the author and kind", () => {
    const board = new RunBlackboard()
    board.record({ agentId: "a", kind: "finding", content: "the api is rate limited", phase: "execute" })

    const digest = board.notesFor()
    expect(digest).toContain("SHARED NOTES FROM OTHER AGENTS IN THIS RUN")
    expect(digest).toContain("- [finding] a: the api is rate limited")
    expect(board.size()).toBe(1)
  })

  test("never hands an agent back its own notes", () => {
    const board = new RunBlackboard()
    board.record({ agentId: "a", kind: "finding", content: "mine" })
    board.record({ agentId: "b", kind: "issue", content: "theirs" })

    expect(board.notesFor("a")).not.toContain("mine")
    expect(board.notesFor("a")).toContain("theirs")
    expect(board.notesFor("c")).toContain("mine")
    expect(board.notesFor("c")).toContain("theirs")
  })

  test("caps the digest, dropping the stalest notes first", () => {
    const board = new RunBlackboard(40, 600, 140)
    for (const id of ["a", "b", "c", "d"]) {
      board.record({ agentId: id, kind: "finding", content: `${id} note` })
    }

    const digest = board.notesFor()
    expect(digest.length).toBeLessThanOrEqual(140)
    expect(digest).toContain("] d:")
    expect(digest).toContain("] c:")
    expect(digest).not.toContain("] a:")
  })

  test("evicts the oldest entries once maxEntries is passed", () => {
    const board = new RunBlackboard(2)
    board.record({ agentId: "a", kind: "finding", content: "first" })
    board.record({ agentId: "b", kind: "finding", content: "second" })
    board.record({ agentId: "c", kind: "finding", content: "third" })

    expect(board.size()).toBe(2)
    const entries = board.entries()
    expect(entries[0].agentId).toBe("b")
    expect(entries[1].agentId).toBe("c")
  })

  test("ignores empty notes and renders markdown for the run report", () => {
    const board = new RunBlackboard()
    expect(board.renderMarkdown()).toBe("")
    board.record({ agentId: "a", kind: "issue", content: "   " })
    expect(board.size()).toBe(0)

    board.record({ agentId: "a", kind: "issue", content: "blocked on secrets" })
    const markdown = board.renderMarkdown()
    expect(markdown).toContain("# Shared Blackboard")
    expect(markdown).toContain("**[issue]** `a`")
    expect(markdown).toContain("blocked on secrets")
  })

  test("exposes the posting instruction", () => {
    expect(BLACKBOARD_INSTRUCTION).toContain("<<<BLACKBOARD kind=finding>>>")
    expect(BLACKBOARD_INSTRUCTION).toContain("<<<END BLACKBOARD>>>")
  })
})
