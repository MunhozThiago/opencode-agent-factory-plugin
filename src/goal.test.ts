import { expect, test, describe } from "bun:test"
import {
  setGoal,
  getGoal,
  updateGoal,
  completeGoal,
  blockGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
  incrementTurnCount,
  validateCompletion,
  OrchestrationError,
} from "./orchestrator"

let sessionCounter = 0
const newSession = () => `goal-session-${++sessionCounter}-${Date.now()}`

describe("goal lifecycle", () => {
  test("setGoal creates an active goal with defaults", () => {
    const sessionId = newSession()
    const goal = setGoal(sessionId, "Ship the feature")

    expect(goal.id).toStartWith("goal-")
    expect(goal.status).toBe("active")
    expect(goal.objective).toBe("Ship the feature")
    expect(goal.maxTurns).toBe(50)
    expect(goal.turnCount).toBe(0)
    expect(getGoal(sessionId)!.id).toBe(goal.id)
  })

  test("setGoal honours maxTurns", () => {
    const sessionId = newSession()
    expect(setGoal(sessionId, "x", 3).maxTurns).toBe(3)
  })

  test("getGoal returns null for unknown sessions", () => {
    expect(getGoal(newSession())).toBeNull()
  })

  test("updateGoal patches fields and bumps updatedAt", async () => {
    const sessionId = newSession()
    const goal = setGoal(sessionId, "x")
    await new Promise(r => setTimeout(r, 2))
    const updated = updateGoal(sessionId, { checkpoints: ["analyzed"] })

    expect(updated!.checkpoints).toEqual(["analyzed"])
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(goal.updatedAt)
    expect(updateGoal(newSession(), { status: "completed" })).toBeNull()
  })

  test("pause, resume and block move through the documented states", () => {
    const sessionId = newSession()
    setGoal(sessionId, "x")

    expect(pauseGoal(sessionId)!.status).toBe("paused")
    expect(resumeGoal(sessionId)!.status).toBe("active")
    expect(blockGoal(sessionId, "waiting on API")!.status).toBe("blocked")
    expect(getGoal(sessionId)!.blocker).toBe("waiting on API")
  })

  test("clearGoal removes the goal and reports whether anything was removed", () => {
    const sessionId = newSession()
    setGoal(sessionId, "x")
    expect(clearGoal(sessionId)).toBe(true)
    expect(getGoal(sessionId)).toBeNull()
    expect(clearGoal(sessionId)).toBe(false)
  })

  test("completeGoal records evidence", () => {
    const sessionId = newSession()
    setGoal(sessionId, "x")
    incrementTurnCount(sessionId)
    completeGoal(sessionId, "shipped in abc123")

    const goal = getGoal(sessionId)!
    expect(goal.status).toBe("completed")
    expect(goal.completionEvidence).toBe("shipped in abc123")
  })
})

describe("incrementTurnCount", () => {
  test("increments monotonically", () => {
    const sessionId = newSession()
    setGoal(sessionId, "x")
    expect(incrementTurnCount(sessionId)).toBe(1)
    expect(incrementTurnCount(sessionId)).toBe(2)
    expect(getGoal(sessionId)!.turnCount).toBe(2)
  })

  test("returns 0 for unknown sessions", () => {
    expect(incrementTurnCount(newSession())).toBe(0)
  })
})

describe("validateCompletion", () => {
  test("rejects when there is no goal", () => {
    const result = validateCompletion(newSession(), "evidence")
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("No active goal")
  })

  test("rejects a non-active goal", () => {
    const sessionId = newSession()
    setGoal(sessionId, "x")
    pauseGoal(sessionId)
    const result = validateCompletion(sessionId, "evidence")
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("Goal is paused")
  })

  test("rejects empty evidence", () => {
    const sessionId = newSession()
    setGoal(sessionId, "x")
    incrementTurnCount(sessionId)
    const result = validateCompletion(sessionId, "   ")
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("Completion requires evidence")
  })

  test("rejects completion before any turn has happened", () => {
    const sessionId = newSession()
    setGoal(sessionId, "x")
    const result = validateCompletion(sessionId, "looks done")
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("at least one turn")
  })

  test("accepts an active goal with evidence after a turn", () => {
    const sessionId = newSession()
    setGoal(sessionId, "x")
    incrementTurnCount(sessionId)
    expect(validateCompletion(sessionId, "tests pass in CI")).toEqual({ valid: true })
  })

  test("blocks a goal from being completed twice", () => {
    const sessionId = newSession()
    setGoal(sessionId, "x")
    incrementTurnCount(sessionId)
    completeGoal(sessionId, "first")
    expect(validateCompletion(sessionId, "second").reason).toBe("Goal is completed")
  })
})

describe("OrchestrationError", () => {
  test("carries phase and recoverability", () => {
    const error = new OrchestrationError("boom", "phase1", undefined, true)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("OrchestrationError")
    expect(error.phase).toBe("phase1")
    expect(error.recoverable).toBe(true)
    expect(new OrchestrationError("x", "p").recoverable).toBe(false)
  })
})
