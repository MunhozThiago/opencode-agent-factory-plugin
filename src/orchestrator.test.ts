import { expect, test, describe, beforeAll } from "bun:test"
import { join } from "path"
import {
  extractJson,
  validateTaskAnalysis,
  validateAgentSpecs,
  normalizeAgentSpecs,
  generateAgentSpecs,
  validateExecutionResult,
  validateConsensusResult,
  validateInput,
  validateAgentTools,
  getOptions,
  normalizeStrategy,
  computeGroupLevels,
  buildAgentPrompt,
  getAgentPrompt,
  loadCustomAgentTemplates,
  generateOrchestrationDiagram,
  OrchestrationError,
} from "./orchestrator"
import { makeSpec, createMockClient, makeContext } from "./mock-client"

// ============================================================
// extractJson
// ============================================================

describe("extractJson", () => {
  test("returns null for empty or null input", () => {
    expect(extractJson(null as any)).toBeNull()
    expect(extractJson("")).toBeNull()
    expect(extractJson("   ")).toBeNull()
  })

  test("parses direct JSON objects", () => {
    expect(extractJson<any>('{"key": "value"}')).toStrictEqual({ key: "value" })
    expect(extractJson<any>('{"nested": {"key": 123}}')).toStrictEqual({ nested: { key: 123 } })
  })

  test("parses direct JSON arrays", () => {
    expect(extractJson<any[]>('[1, 2, 3]')).toStrictEqual([1, 2, 3])
    expect(extractJson<any[]>('[{"id": "a"}, {"id": "b"}]')).toStrictEqual([{ id: "a" }, { id: "b" }])
  })

  test("extracts JSON from markdown code blocks", () => {
    const input = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.'
    expect(extractJson<any>(input)).toStrictEqual({ key: "value" })
  })

  test("extracts JSON from code blocks without language tag", () => {
    const input = '```\n{"key": "value"}\n```'
    expect(extractJson<any>(input)).toStrictEqual({ key: "value" })
  })

  test("handles text before and after JSON", () => {
    const input = 'The analysis shows:\n{"task_type": "coding", "complexity": "simple"}\nThat is all.'
    expect(extractJson<any>(input)).toStrictEqual({ task_type: "coding", complexity: "simple" })
  })

  test("handles strings containing JSON-like characters", () => {
    const input = '{"key": "value with { braces }", "num": 42}'
    expect(extractJson<any>(input)).toStrictEqual({ key: "value with { braces }", num: 42 })
  })

  test("handles escaped quotes in strings", () => {
    const input = '{"key": "He said \\"hello\\""}'
    expect(extractJson<any>(input)).toStrictEqual({ key: 'He said "hello"' })
  })

  test("returns null for text with no JSON", () => {
    expect(extractJson("This is just plain text with no JSON")).toBeNull()
  })

  test("handles trailing commas", () => {
    expect(extractJson<any>('{"key": "value",}')).toStrictEqual({ key: "value" })
  })

  test("handles nested objects", () => {
    const input = '{"outer": {"inner": {"deep": true}}}'
    expect(extractJson<any>(input)).toStrictEqual({ outer: { inner: { deep: true } } })
  })

  test("extracts TaskAnalysis from a real agent-factory response", () => {
    const llmResponse = `Based on my analysis of the task, here is the JSON output:

\`\`\`json
{
  "task_type": "coding",
  "complexity": "moderate",
  "domains": ["frontend", "backend"],
  "capabilities": ["code_execution", "file_ops"],
  "consensus_strategy": "single",
  "parallel_groups": [
    {"group_id": 1, "independent": true, "subtasks": ["Build API", "Build UI"]}
  ]
}
\`\`\`

This task involves both frontend and backend work.`

    const result = extractJson<any>(llmResponse)
    expect(result).not.toBeNull()
    expect(result!.task_type).toBe("coding")
    expect(result!.complexity).toBe("moderate")
    expect(result!.domains).toEqual(["frontend", "backend"])
  })

  test("extracts AgentSpec array from a real plan response", () => {
    const llmResponse = `Here are the agent specifications:

${JSON.stringify([makeSpec({ id: "agent_1", role: "API Developer" }), makeSpec({ id: "agent_2", role: "UI Developer" })], null, 2)}`

    const result = extractJson<any[]>(llmResponse)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(2)
    expect(result![0].role).toBe("API Developer")
    expect(result![1].role).toBe("UI Developer")
  })
})

// ============================================================
// Validators
// ============================================================

describe("validateTaskAnalysis", () => {
  const base = {
    task_type: "coding",
    complexity: "simple",
    domains: ["frontend"],
    capabilities: ["code_execution"],
    consensus_strategy: "single",
    parallel_groups: [{ group_id: 1, independent: true, subtasks: ["test"] }],
  }

  test("accepts valid task analysis", () => {
    expect(validateTaskAnalysis(base)).toBe(true)
  })

  test("accepts every task type the agent-factory prompt advertises", () => {
    for (const taskType of [
      "coding", "research", "analysis", "creative", "debugging", "planning",
      "decision", "evaluation", "synthesis",
    ]) {
      expect(validateTaskAnalysis({ ...base, task_type: taskType })).toBe(true)
    }
  })

  test("rejects invalid task_type", () => {
    expect(validateTaskAnalysis({ ...base, task_type: "invalid" })).toBe(false)
  })

  test("rejects invalid complexity", () => {
    expect(validateTaskAnalysis({ ...base, complexity: "hard" })).toBe(false)
  })

  test("rejects null/undefined/primitives", () => {
    expect(validateTaskAnalysis(null)).toBeFalsy()
    expect(validateTaskAnalysis(undefined)).toBeFalsy()
    expect(validateTaskAnalysis("string")).toBeFalsy()
  })

  test("rejects missing fields", () => {
    expect(validateTaskAnalysis({ task_type: "coding" })).toBe(false)
    expect(validateTaskAnalysis({ task_type: "coding", complexity: "simple" })).toBe(false)
  })

  test("rejects non-array parallel_groups", () => {
    expect(validateTaskAnalysis({ ...base, parallel_groups: "nope" })).toBe(false)
  })
})

describe("validateAgentSpecs", () => {
  test("accepts valid agent specs", () => {
    expect(validateAgentSpecs([makeSpec({ id: "agent_1" })])).toBe(true)
  })

  test("accepts empty array", () => {
    expect(validateAgentSpecs([])).toBe(true)
  })

  test("rejects non-array", () => {
    expect(validateAgentSpecs("string")).toBe(false)
    expect(validateAgentSpecs({})).toBe(false)
  })

  test("rejects invalid model_tier", () => {
    expect(validateAgentSpecs([makeSpec({ id: "a", model_tier: "ultra" as any })])).toBe(false)
  })

  test("rejects invalid output_format", () => {
    expect(validateAgentSpecs([makeSpec({ id: "a", output_format: "yaml" as any })])).toBe(false)
  })

  test("rejects missing required fields", () => {
    expect(validateAgentSpecs([{ id: "agent_1" }])).toBe(false)
  })

  test("rejects specs without retry_policy", () => {
    const spec: any = makeSpec({ id: "a" })
    delete spec.retry_policy
    expect(validateAgentSpecs([spec])).toBe(false)
  })
})

describe("normalizeAgentSpecs", () => {
  test("passes a valid spec through untouched", () => {
    const { specs, issues } = normalizeAgentSpecs([makeSpec({ id: "a" })])
    expect(issues).toEqual([])
    expect(specs).toHaveLength(1)
    expect(validateAgentSpecs(specs)).toBe(true)
  })

  test("repairs off-vocabulary values instead of failing the run", () => {
    const { specs, issues } = normalizeAgentSpecs([{
      id: "a",
      role: "Builder",
      goal: "Build it",
      prompt: "Do the work",
      tools: "read, write",
      model_tier: "high",
      output_format: "plain text",
      depends_on: [],
      timeout_ms: 5000,
      retry_policy: { max_retries: 2, simplify_on_retry: true },
    }])

    expect(specs).toHaveLength(1)
    // "high" is an accepted alias for powerful, so it needs no issue
    expect(specs[0].model_tier).toBe("powerful")
    expect(specs[0].output_format).toBe("markdown")
    expect(specs[0].tools).toEqual(["read", "write"])
    expect(validateAgentSpecs(specs)).toBe(true)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain("output_format")
  })

  test("falls back to balanced for an unknown model tier", () => {
    const { specs, issues } = normalizeAgentSpecs([{
      id: "a",
      role: "Builder",
      goal: "Build it",
      prompt: "Do the work",
      model_tier: "ultra",
    }])

    expect(specs[0].model_tier).toBe("balanced")
    expect(issues.join(" ")).toContain("model_tier")
  })

  test("unwraps object wrappers such as {agents: [...]}", () => {
    const { specs } = normalizeAgentSpecs({ agents: [makeSpec({ id: "a" })] })
    expect(specs.map(s => s.id)).toEqual(["a"])
  })

  test("fills defaults for omitted fields and derives an id from the role", () => {
    const { specs } = normalizeAgentSpecs([{
      role: "Code Reviewer",
      goal: "Review the diff",
      prompt: "Review it",
    }])

    expect(specs).toHaveLength(1)
    expect(specs[0].id).toBe("code-reviewer")
    expect(specs[0].model_tier).toBe("balanced")
    expect(specs[0].output_format).toBe("markdown")
    expect(specs[0].timeout_ms).toBeGreaterThan(0)
    expect(specs[0].retry_policy.max_retries).toBeGreaterThanOrEqual(0)
    expect(validateAgentSpecs(specs)).toBe(true)
  })

  test("drops entries without a prompt and reports why", () => {
    const { specs, issues } = normalizeAgentSpecs([
      makeSpec({ id: "a" }),
      { id: "broken", role: "Ghost", goal: "No prompt here" },
    ])

    expect(specs.map(s => s.id)).toEqual(["a"])
    expect(issues.join(" ")).toContain("missing goal or prompt")
  })

  test("reports non-spec responses instead of throwing", () => {
    expect(normalizeAgentSpecs("just text").specs).toEqual([])
    expect(normalizeAgentSpecs(null).issues.length).toBeGreaterThan(0)
    expect(normalizeAgentSpecs({ unrelated: true }).specs).toEqual([])
  })

  test("caps the spec count at maxAgents and reports the truncation", () => {
    const many = Array.from({ length: 20 }, (_, i) => makeSpec({ id: `a${i}` }))
    const { specs, issues } = normalizeAgentSpecs(many, 12)

    expect(specs).toHaveLength(12)
    expect(issues.join(" ")).toContain("maxAgents=12")
    expect(validateAgentSpecs(specs)).toBe(true)
  })

  test("drops unknown and self dependencies instead of failing", () => {
    const { specs, issues } = normalizeAgentSpecs([
      makeSpec({ id: "a", depends_on: ["ghost", "a", "b", "b"] }),
      makeSpec({ id: "b" }),
    ])

    expect(specs[0].depends_on).toEqual(["b"])
    const joined = issues.join(" ")
    expect(joined).toContain('unknown dependency "ghost"')
    expect(joined).toContain("self-dependency")
    expect(validateAgentSpecs(specs)).toBe(true)
  })

  test("drops dependencies pointing at agents removed by the cap", () => {
    const many = Array.from({ length: 12 }, (_, i) => makeSpec({ id: `a${i}` }))
    many.push(makeSpec({ id: "extra", depends_on: ["a11"] }))
    many[0].depends_on = ["extra"]

    const { specs, issues } = normalizeAgentSpecs(many, 12)

    expect(specs.map(s => s.id)).not.toContain("extra")
    expect(specs[0].depends_on).toEqual([])
    expect(issues.join(" ")).toContain('unknown dependency "extra"')
  })

  test("serializes agents that can write the same file", () => {
    const { specs, issues } = normalizeAgentSpecs([
      makeSpec({ id: "a", outputs: ["src/app.ts"] }),
      makeSpec({ id: "b", outputs: ["src/app.ts"] }),
    ])

    expect(specs[1].depends_on).toEqual(["a"])
    expect(issues.join(" ")).toContain('serialized behind "a"')
    expect(validateAgentSpecs(specs)).toBe(true)
  })

  test("serializes nested write targets but keeps disjoint owners parallel", () => {
    const nested = normalizeAgentSpecs([
      makeSpec({ id: "a", outputs: ["docs"] }),
      makeSpec({ id: "b", outputs: ["docs/api.md"] }),
    ])
    expect(nested.specs[1].depends_on).toEqual(["a"])

    const disjoint = normalizeAgentSpecs([
      makeSpec({ id: "a", outputs: ["src/a.ts"] }),
      makeSpec({ id: "b", outputs: ["src/b.ts"] }),
    ])
    expect(disjoint.specs[1].depends_on).toEqual([])
    expect(disjoint.issues).toEqual([])
  })

  test("keeps an already-ordered pair as-is even with overlapping outputs", () => {
    const { specs, issues } = normalizeAgentSpecs([
      makeSpec({ id: "a", outputs: ["src/app.ts"] }),
      makeSpec({ id: "b", outputs: ["src/app.ts"], depends_on: ["a"] }),
    ])

    expect(specs[1].depends_on).toEqual(["a"])
    expect(issues).toEqual([])
  })
})

describe("generateAgentSpecs", () => {
  const ARGS = ["spec title", "phase2-plan", "SYSTEM", "USER"] as const

  test("retries a prose response once and succeeds", async () => {
    let calls = 0
    const mock = createMockClient({
      respond: () => {
        calls += 1
        return calls === 1
          ? "Let me explain my plan instead of returning JSON."
          : JSON.stringify([makeSpec({ id: "a" })])
      },
    })
    const context = makeContext(mock.client, { maxRetries: 2, baseRetryDelayMs: 0 })

    const { specs } = await generateAgentSpecs(context, ARGS[0], ARGS[1], ARGS[2], ARGS[3], context.abort, 0.5)

    expect(calls).toBe(2)
    expect(specs.map(s => s.id)).toEqual(["a"])
  })

  test("skips retries entirely for a non-recoverable error", async () => {
    let calls = 0
    const mock = createMockClient({
      respond: () => {
        calls += 1
        throw new OrchestrationError("invalid api key", "phase2-plan")
      },
    })
    const context = makeContext(mock.client, { maxRetries: 3, baseRetryDelayMs: 0 })

    const error = await generateAgentSpecs(context, ARGS[0], ARGS[1], ARGS[2], ARGS[3], context.abort, 0.5)
      .then(() => null)
      .catch(e => e)

    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error.recoverable).toBe(false)
    expect(calls).toBe(1)
  })

  test("stops retrying once the abort signal fires", async () => {
    let calls = 0
    const mock = createMockClient({
      respond: () => {
        calls += 1
        throw new OrchestrationError("failed", "phase2-plan", undefined, true)
      },
    })
    const context = makeContext(mock.client, { maxRetries: 5, baseRetryDelayMs: 0 })
    const abort = new AbortController()
    abort.abort()

    await expect(
      generateAgentSpecs(context, ARGS[0], ARGS[1], ARGS[2], ARGS[3], abort.signal, 0.5)
    ).rejects.toThrow()
    expect(calls).toBe(0)
  })
})

describe("validateExecutionResult", () => {
  const valid = {
    results: { a: { status: "completed", output: "x", error: null, duration_ms: 1 } },
    execution_metadata: { total_groups: 1, total_agents: 1, completed: 1, failed: 0, total_time_ms: 1 },
  }

  test("accepts a well-formed result", () => {
    expect(validateExecutionResult(valid)).toBe(true)
  })

  test("rejects missing metadata counts", () => {
    expect(validateExecutionResult({ results: {} })).toBe(false)
    expect(validateExecutionResult({ results: {}, execution_metadata: { total_groups: 1 } })).toBe(false)
  })

  test("rejects null", () => {
    expect(validateExecutionResult(null)).toBe(false)
  })
})

describe("validateConsensusResult", () => {
  const valid = {
    consensus_reached: true,
    final_output: "done",
    confidence: 0.9,
    strategy_used: "voting",
    rounds_executed: 2,
    agent_contributions: {},
    metadata: { convergence_score: 0.8 },
  }

  test("accepts a well-formed consensus", () => {
    expect(validateConsensusResult(valid)).toBe(true)
  })

  test("rejects wrong types", () => {
    expect(validateConsensusResult({ ...valid, confidence: "high" })).toBe(false)
    expect(validateConsensusResult({ ...valid, consensus_reached: "yes" })).toBe(false)
  })

  test("rejects null", () => {
    expect(validateConsensusResult(null)).toBe(false)
  })
})

// ============================================================
// Input validation
// ============================================================

describe("validateInput", () => {
  test("accepts a normal prompt", () => {
    expect(() => validateInput("build a REST API", "auto")).not.toThrow()
  })

  test("rejects empty prompt", () => {
    expect(() => validateInput("", "auto")).toThrow(OrchestrationError)
    expect(() => validateInput("   ", "auto")).toThrow("Prompt cannot be empty")
  })

  test("rejects oversized prompt", () => {
    expect(() => validateInput("x".repeat(50001), "auto")).toThrow("exceeds maximum length")
  })

  test("rejects unknown strategy", () => {
    expect(() => validateInput("task", "banana")).toThrow("Invalid strategy")
  })

  test("accepts every valid strategy", () => {
    for (const strategy of ["auto", "single", "debate", "voting", "expert_review", "hierarchical"]) {
      expect(() => validateInput("task", strategy)).not.toThrow()
    }
  })
})

// ============================================================
// Options
// ============================================================

describe("getOptions", () => {
  test("returns documented defaults when no options are given", () => {
    const opts = getOptions(undefined, "/tmp/proj")
    expect(opts.overallTimeoutMs).toBe(300000)
    expect(opts.phaseTimeoutMs).toBe(120000)
    expect(opts.maxRetries).toBe(2)
    expect(opts.baseRetryDelayMs).toBe(1000)
    expect(opts.enableProgress).toBe(true)
    expect(opts.fastPathThresholdChars).toBe(500)
    expect(opts.defaultStrategy).toBe("auto")
    expect(opts.enablePersistentTelemetry).toBe(false)
    expect(opts.enableTemplateLibrary).toBe(true)
    expect(opts.telemetryPath).toBe(join("/tmp/proj", ".agent-factory", "telemetry.json"))
    expect(opts.templateDirs).toEqual([join("/tmp/proj", ".opencode", "agents")])
    expect(opts.childAgent).toBe("build")
  })

  test("applies overrides", () => {
    const opts = getOptions({
      overallTimeoutMs: 1000,
      phaseTimeoutMs: 500,
      maxRetries: 5,
      baseRetryDelayMs: 10,
      enableProgress: false,
      fastPathThresholdChars: 42,
      defaultStrategy: "voting",
      enablePersistentTelemetry: true,
      telemetryPath: "/tmp/t.json",
      enableTemplateLibrary: false,
      templateDirs: ["/a", "/b"],
      childAgent: "general",
    }, "/tmp/proj")
    expect(opts.overallTimeoutMs).toBe(1000)
    expect(opts.phaseTimeoutMs).toBe(500)
    expect(opts.maxRetries).toBe(5)
    expect(opts.baseRetryDelayMs).toBe(10)
    expect(opts.enableProgress).toBe(false)
    expect(opts.fastPathThresholdChars).toBe(42)
    expect(opts.defaultStrategy).toBe("voting")
    expect(opts.enablePersistentTelemetry).toBe(true)
    expect(opts.telemetryPath).toBe("/tmp/t.json")
    expect(opts.enableTemplateLibrary).toBe(false)
    expect(opts.templateDirs).toEqual(["/a", "/b"])
    expect(opts.childAgent).toBe("general")
  })

  test("falls back to defaults for invalid values", () => {
    const opts = getOptions({
      overallTimeoutMs: "soon" as any,
      phaseTimeoutMs: -5,
      maxRetries: NaN,
      enableProgress: "yes" as any,
      defaultStrategy: "chaos",
      templateDirs: [123, "/ok"] as any,
      childAgent: "   ",
    }, "/tmp/proj")
    expect(opts.overallTimeoutMs).toBe(300000)
    expect(opts.phaseTimeoutMs).toBe(120000)
    expect(opts.maxRetries).toBe(2)
    expect(opts.enableProgress).toBe(true)
    expect(opts.defaultStrategy).toBe("auto")
    expect(opts.templateDirs).toEqual(["/ok"])
    expect(opts.childAgent).toBe("build")
  })
})

describe("normalizeStrategy", () => {
  test("passes through valid strategies", () => {
    expect(normalizeStrategy("debate")).toBe("debate")
    expect(normalizeStrategy("single")).toBe("single")
  })

  test("coerces unknown values to auto", () => {
    expect(normalizeStrategy("nope")).toBe("auto")
    expect(normalizeStrategy(undefined)).toBe("auto")
    expect(normalizeStrategy(7)).toBe("auto")
  })
})

// ============================================================
// Tool validation
// ============================================================

describe("validateAgentTools", () => {
  test("separates known and unknown tools", () => {
    const result = validateAgentTools(["read", "bash", "time_travel"])
    expect(result.valid).toEqual(["read", "bash"])
    expect(result.invalid).toEqual(["time_travel"])
  })

  test("accepts every goal tool the plugin registers", () => {
    const goalTools = ["goal_set", "goal_status", "goal_complete", "goal_block", "goal_pause", "goal_resume", "goal_clear", "telemetry"]
    expect(validateAgentTools(goalTools).invalid).toEqual([])
  })

  test("rejects tools that would re-enter the orchestration", () => {
    const result = validateAgentTools(["read", "orchestrate", "delegate"])
    expect(result.valid).toEqual(["read"])
    expect(result.invalid).toEqual(["orchestrate", "delegate"])
  })

  test("returns empty lists for no tools", () => {
    expect(validateAgentTools([])).toStrictEqual({ valid: [], invalid: [] })
  })
})

// ============================================================
// DAG grouping
// ============================================================

describe("computeGroupLevels", () => {
  test("puts roots in level 1", () => {
    const levels = computeGroupLevels([makeSpec({ id: "a" }), makeSpec({ id: "b" })])
    expect(levels.get("a")).toBe(1)
    expect(levels.get("b")).toBe(1)
  })

  test("assigns one level per dependency hop in a chain", () => {
    const levels = computeGroupLevels([
      makeSpec({ id: "a" }),
      makeSpec({ id: "b", depends_on: ["a"] }),
      makeSpec({ id: "c", depends_on: ["b"] }),
    ])
    expect(levels.get("a")).toBe(1)
    expect(levels.get("b")).toBe(2)
    expect(levels.get("c")).toBe(3)
  })

  test("uses the longest path in a diamond", () => {
    const levels = computeGroupLevels([
      makeSpec({ id: "a" }),
      makeSpec({ id: "b", depends_on: ["a"] }),
      makeSpec({ id: "c", depends_on: ["a"] }),
      makeSpec({ id: "d", depends_on: ["b", "c"] }),
      // e depends on the deepest node, so it must land after d
      makeSpec({ id: "e", depends_on: ["d"] }),
    ])
    expect(levels.get("a")).toBe(1)
    expect(levels.get("b")).toBe(2)
    expect(levels.get("c")).toBe(2)
    expect(levels.get("d")).toBe(3)
    expect(levels.get("e")).toBe(4)
  })

  test("an agent never lands in the same group as its dependency", () => {
    const specs = [
      makeSpec({ id: "a" }),
      makeSpec({ id: "b", depends_on: ["a"] }),
      makeSpec({ id: "c", depends_on: ["b"] }),
      makeSpec({ id: "d", depends_on: ["a"] }),
    ]
    const levels = computeGroupLevels(specs)
    for (const spec of specs) {
      for (const dep of spec.depends_on) {
        expect(levels.get(spec.id)!).toBeGreaterThan(levels.get(dep)!)
      }
    }
  })

  test("tolerates a dependency that is missing from the spec list", () => {
    // Unknown dependencies are rejected by runNativeDAGExecution before grouping,
    // so grouping only has to stay deterministic instead of crashing.
    const levels = computeGroupLevels([makeSpec({ id: "a", depends_on: ["ghost"] })])
    expect(levels.get("a")).toBe(2)
  })
})

// ============================================================
// Prompt builders
// ============================================================

describe("buildAgentPrompt", () => {
  const spec = makeSpec({ id: "a", goal: "Design the schema" })

  test("includes task, subtask and output format", () => {
    const prompt = buildAgentPrompt(spec, "Build a todo app", {})
    expect(prompt).toContain("Build a todo app")
    expect(prompt).toContain("Design the schema")
    expect(prompt).toContain("OUTPUT FORMAT: markdown")
    expect(prompt).not.toContain("DEPENDENCY OUTPUTS")
  })

  test("injects dependency outputs when present", () => {
    const prompt = buildAgentPrompt(spec, "Build a todo app", { root: "root output" })
    expect(prompt).toContain("DEPENDENCY OUTPUTS FROM PRIOR AGENTS")
    expect(prompt).toContain("root: root output")
  })

  test("injects file ownership rules when the agent owns outputs", () => {
    const prompt = buildAgentPrompt(makeSpec({ id: "a", outputs: ["src/app.ts"] }), "Build a todo app", {})
    expect(prompt).toContain("FILE OWNERSHIP")
    expect(prompt).toContain("src/app.ts")
    expect(prompt).toContain("Do not modify any file outside this list")
  })

  test("omits ownership rules for agents without outputs", () => {
    const prompt = buildAgentPrompt(spec, "Build a todo app", {})
    expect(prompt).not.toContain("FILE OWNERSHIP")
  })
})

describe("getAgentPrompt", () => {
  test("loads bundled agent definitions from disk", () => {
    const prompt = getAgentPrompt("agent-factory")
    expect(prompt.length).toBeGreaterThan(100)
    expect(prompt).toContain("agent-factory")
  })

  test("custom templates win over bundled files", () => {
    const custom = new Map([["agent-factory", "CUSTOM PROMPT"]])
    expect(getAgentPrompt("agent-factory", custom)).toBe("CUSTOM PROMPT")
  })

  test("returns empty string for unknown agents", () => {
    expect(getAgentPrompt("does-not-exist")).toBe("")
  })
})

describe("loadCustomAgentTemplates", () => {
  let templates: Map<string, string>

  beforeAll(() => {
    templates = loadCustomAgentTemplates([join(process.cwd(), "agents"), join(process.cwd(), "nope-missing-dir")])
  })

  test("reads every markdown agent in the directory", () => {
    expect(templates.size).toBeGreaterThanOrEqual(4)
    expect(templates.get("consensus-manager")).toContain("Consensus")
  })

  test("skips directories that do not exist", () => {
    expect(loadCustomAgentTemplates([join(process.cwd(), "definitely-missing")]).size).toBe(0)
  })
})

// ============================================================
// Diagram
// ============================================================

describe("generateOrchestrationDiagram", () => {
  const specs = [
    makeSpec({ id: "a", role: "Researcher" }),
    makeSpec({ id: "b", role: "Builder", depends_on: ["a"] }),
    makeSpec({ id: "c", role: "Reviewer", depends_on: ["b"] }),
  ]

  test("renders strategy, agent map, execution flow and timings", () => {
    const diagram = generateOrchestrationDiagram(
      "Build the thing",
      {
        task_type: "coding",
        complexity: "complex",
        domains: ["backend"],
        capabilities: [],
        consensus_strategy: "debate",
        parallel_groups: [],
      },
      specs,
      {
        results: {
          a: { status: "completed", output: "researched", error: null, duration_ms: 10 },
          b: { status: "failed", output: "", error: "boom", duration_ms: 5 },
          c: { status: "completed", output: "reviewed", error: null, duration_ms: 7 },
        },
        execution_metadata: { total_groups: 3, total_agents: 3, completed: 2, failed: 1, total_time_ms: 22 },
      },
      {
        consensus_reached: true,
        final_output: "final",
        confidence: 0.8,
        strategy_used: "debate",
        rounds_executed: 2,
        agent_contributions: { a: { weight: 0.5, accepted: true } },
        metadata: { convergence_score: 0.9 },
      },
      "debate selected",
      { analyze: 12, plan: 34 },
      46
    )

    expect(diagram).toContain("# Orchestration Diagram")
    expect(diagram).toContain("## Strategy Selection")
    expect(diagram).toContain("debate selected")
    expect(diagram).toContain("## Task Analysis")
    expect(diagram).toContain("Type:        coding")
    expect(diagram).toContain("## Agent Map")
    expect(diagram).toContain("[a] Researcher")
    expect(diagram).toContain("## Execution Flow")
    expect(diagram).toContain("GROUP 3")
    expect(diagram).toContain("✓ [a] Researcher")
    expect(diagram).toContain("✗ [b] Builder")
    expect(diagram).toContain("## Consensus")
    expect(diagram).toContain("Strategy:     debate")
    expect(diagram).toContain("a: weight=0.50, accepted=true")
    expect(diagram).toContain("## Phase Timings")
    expect(diagram).toContain("analyze")
    expect(diagram).toContain("TOTAL          46ms")
  })

  test("renders a chain of three agents as three separate levels", () => {
    const diagram = generateOrchestrationDiagram("t", null, specs, null, null, "", {}, 0)
    const agentMap = diagram.slice(diagram.indexOf("## Agent Map"), diagram.indexOf("## Execution Flow"))
    const levelOf = (id: string) => {
      const section = agentMap.split("↓").find(part => part.includes(`[${id}]`))!
      return section
    }
    expect(levelOf("a")).not.toContain("←")
    expect(levelOf("b")).toContain("← a")
    expect(levelOf("c")).toContain("← b")
    // three distinct levels means two separator arrows
    expect((agentMap.match(/↓/g) ?? []).length).toBe(2)
  })
})
