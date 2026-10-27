import { describe, expect, test } from "bun:test"
import { parseContractText, renderPlan, reviewFindings, strictJSON, validateChecks, validatePlan, validateReview, type Plan, type Review } from "./contracts.ts"

function plan(): Plan {
  return {
    exec_type: "standard",
    criteria: [
      { id: "C1", kind: "command", text: "unit tests", commands: ["rtk bun test", "./scripts/test.sh"] },
      { id: "C2", kind: "check", text: "documentation is accurate" },
    ],
    allowed_paths: ["src/**", "README.md"], needs_permission: [], steps: ["implement"],
    context: [{ ref: "src/app.ts:1", note: "entry point" }],
  }
}

function review(): Review {
  return {
    p1: [], p2: [], criteria: [{ id: "C2", verdict: "pass", note: "checked documentation" }],
    out_of_scope: [{ path: "extra.ts", accept: true, reason: "required by implementation" }],
    reviewed_tree: "fixture-tree",
  }
}

const checks = () => ({ checked_tree: "fixture-tree", checks: [{ id: "C2", verdict: "pass" as const, evidence: "inspected README.md:1" }] })
const fence = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``

describe("strict contract JSON", () => {
  test("rejects duplicate keys, including escaped aliases and nested keys", () => {
    for (const text of ['{"p1":[],"p1":[1]}', '{"p1":[],"p\\u0031":[1]}', '{"outer":{"id":1,"id":2}}']) {
      expect(() => strictJSON(text)).toThrow(/重复键/)
    }
    expect(strictJSON('[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
  })

  test("accepts escaped text but rejects trailing payloads and malformed JSON", () => {
    const value = { text: 'braces { } and quote " and slash \\', list: [null, true, false, -1.2e3] }
    expect(strictJSON(JSON.stringify(value))).toEqual(value)
    for (const text of ['{} {}', '{} trailing', '{"x":01}', '[1,]', '{"x":}', '{"x":"unterminated}', '']) expect(() => strictJSON(text)).toThrow()
  })

  test("non-pi accepts one raw object or a single standalone json block", () => {
    expect(parseContractText(JSON.stringify(plan()), "claude")).toEqual(plan())
    expect(parseContractText(fence(plan()), "codex")).toEqual(plan())
    expect(() => parseContractText(`explanation\n${fence(plan())}`, "grok")).toThrow()
    expect(() => parseContractText(`${fence(plan())}\n${fence(plan())}`, "claude")).toThrow()
  })

  test("pi requires exactly one json block and rejects raw JSON or extra fences", () => {
    expect(parseContractText(`explanation\n${fence(plan())}\nend`, "pi")).toEqual(plan())
    expect(() => parseContractText(JSON.stringify(plan()), "pi")).toThrow(/恰好一个/)
    expect(() => parseContractText(`${fence(plan())}\n${fence(plan())}`, "pi")).toThrow(/恰好一个/)
    expect(() => parseContractText(`${fence(plan())}\n\`\`\`text\nother\n\`\`\``, "pi")).toThrow(/恰好一个/)
    expect(() => parseContractText('```json\n{"x":1,"x":2}\n```', "pi")).toThrow(/重复键/)
  })
})

describe("plan contract", () => {
  test("valid plan keeps exact command strings and renders a readable handoff", () => {
    expect(validatePlan(plan())).toEqual(plan())
    const rendered = renderPlan(plan())
    expect(rendered).toContain("rtk bun test")
    expect(rendered).toContain("./scripts/test.sh")
    expect(rendered).toContain("C2 [check]")
    expect(rendered).toContain("src/app.ts:1 entry point")
  })

  test("requires every top-level field and rejects unknown fields", () => {
    for (const key of Object.keys(plan())) {
      const value = { ...plan() } as Record<string, unknown>
      delete value[key]
      expect(() => validatePlan(value)).toThrow(/缺少字段/)
    }
    expect(() => validatePlan({ ...plan(), unexpected: true })).toThrow(/未知字段/)
    expect(() => validatePlan([])).toThrow(/JSON 对象/)
  })

  test("requires criteria, unique ids and nonempty single-line command arrays", () => {
    expect(() => validatePlan({ ...plan(), criteria: [] })).toThrow()
    expect(() => validatePlan({ ...plan(), criteria: [plan().criteria[0], plan().criteria[0]] })).toThrow(/重复/)
    for (const commands of [[], [""], ["node test.js\nnode other.js"], ["node test.js\r"], ["node\0test"]]) {
      expect(() => validatePlan({ ...plan(), criteria: [{ ...plan().criteria[0], commands }] })).toThrow()
    }
    expect(() => validatePlan({ ...plan(), criteria: [{ id: "C1", kind: "command", text: "missing commands" }] })).toThrow()
    expect(() => validatePlan({ ...plan(), criteria: [{ ...plan().criteria[1], commands: ["must not run"] }] })).toThrow()
  })

  test("rejects enum coercion instead of accepting arrays as strings", () => {
    expect(() => validatePlan({ ...plan(), exec_type: ["standard"] })).toThrow()
    expect(() => validatePlan({ ...plan(), criteria: [{ ...plan().criteria[1], kind: ["check"] }] })).toThrow()
    expect(() => validatePlan({ ...plan(), needs_permission: [{ category: ["deps"], reason: "fixture" }] })).toThrow()
  })

  test("allowed paths are nonempty relative globs without traversal", () => {
    for (const allowed_paths of [[], [""], ["/tmp/outside"], ["../outside"], ["src/../outside"], ["~/outside"], ["src/\nfile"]]) expect(() => validatePlan({ ...plan(), allowed_paths })).toThrow()
    expect(validatePlan({ ...plan(), allowed_paths: ["src/**", "*.ts"] }).allowed_paths).toEqual(["src/**", "*.ts"])
  })

  test("requires authorization reasons, steps and well-formed context", () => {
    expect(validatePlan({ ...plan(), needs_permission: [{ category: "network", reason: "query registry" }] }).needs_permission).toHaveLength(1)
    for (const needs_permission of [[{ category: "unknown", reason: "fixture" }], [{ category: "deps", reason: " " }]]) expect(() => validatePlan({ ...plan(), needs_permission })).toThrow()
    expect(() => validatePlan({ ...plan(), steps: [] })).toThrow()
    expect(() => validatePlan({ ...plan(), context: [{ ref: "", note: "fixture" }] })).toThrow()
    expect(() => validatePlan({ ...plan(), context: [{ ref: "file:1", note: "fixture", unknown: true }] })).toThrow()
  })
})

describe("review contract", () => {
  const validate = (value: unknown) => validateReview(value, plan(), "fixture-tree", ["extra.ts"])

  test("explicit empty findings are valid only with complete coverage and current tree", () => {
    expect(validate(review())).toEqual(review())
    for (const key of ["p1", "p2"]) {
      const value = { ...review() } as Record<string, unknown>
      delete value[key]
      expect(() => validate(value)).toThrow(/缺少字段/)
    }
    expect(() => validate({ ...review(), reviewed_tree: "old-tree" })).toThrow(/快照/)
  })

  test("criteria covers exactly the check criteria, without missing, extra or duplicate ids", () => {
    for (const criteria of [[], [review().criteria[0], review().criteria[0]], [{ ...review().criteria[0], id: "C1" }], [{ ...review().criteria[0], id: "unknown" }]]) {
      expect(() => validate({ ...review(), criteria })).toThrow(/恰好覆盖/)
    }
  })

  test("out_of_scope covers every supplied path exactly once", () => {
    for (const out_of_scope of [[], [review().out_of_scope[0], review().out_of_scope[0]], [{ ...review().out_of_scope[0], path: "different.ts" }]]) expect(() => validate({ ...review(), out_of_scope })).toThrow(/恰好覆盖/)
    expect(() => validate({ ...review(), out_of_scope: [{ ...review().out_of_scope[0], accept: "true" }] })).toThrow()
    expect(() => validate({ ...review(), out_of_scope: [{ ...review().out_of_scope[0], reason: " " }] })).toThrow()
  })

  test("empty finding references or issues and unknown fields are rejected", () => {
    expect(() => validate({ ...review(), p1: [{ ref: "", issue: "fixture" }] })).toThrow()
    expect(() => validate({ ...review(), p2: [{ ref: "src/a.ts:1", issue: " " }] })).toThrow()
    expect(() => validate({ ...review(), p1: [{ ref: "src/a.ts:1", issue: "fixture", unknown: true }] })).toThrow()
    expect(() => validate({ ...review(), criteria: [{ ...review().criteria[0], note: " " }] })).toThrow()
  })

  test("criteria verdict is an enum string, not an array coercible to fail", () => {
    expect(() => validate({ ...review(), criteria: [{ ...review().criteria[0], verdict: ["fail"] }] })).toThrow()
    expect(() => validate({ ...review(), criteria: [{ ...review().criteria[0], verdict: "invalid" }] })).toThrow()
  })

  test("failed checks and rejected scope become P1 while P2 stays advisory", () => {
    const value = validate({
      ...review(), p1: [{ ref: "src/a.ts:3", issue: "wrong result" }], p2: [{ ref: "src/b.ts:2", issue: "later improvement" }],
      criteria: [{ id: "C2", verdict: "fail", note: "documentation is wrong" }],
      out_of_scope: [{ path: "extra.ts", accept: false, reason: "unrelated change" }],
    })
    expect(reviewFindings(value)).toEqual([
      { ref: "src/a.ts:3", issue: "wrong result" }, { ref: "C2", issue: "documentation is wrong" }, { ref: "extra.ts", issue: "unrelated change" },
    ])
  })
})

describe("manual checks contract", () => {
  const validate = (value: unknown) => validateChecks(value, plan(), "fixture-tree")

  test("requires current snapshot, exact check ids and nonempty evidence", () => {
    expect(validate(checks())).toEqual(checks())
    expect(() => validate({ ...checks(), checked_tree: "old-tree" })).toThrow(/快照/)
    for (const entries of [[], [checks().checks[0], checks().checks[0]], [{ ...checks().checks[0], id: "C1" }]]) expect(() => validate({ ...checks(), checks: entries })).toThrow(/恰好覆盖/)
    expect(() => validate({ ...checks(), checks: [{ ...checks().checks[0], evidence: " " }] })).toThrow()
    expect(() => validate({ ...checks(), extra: true })).toThrow()
  })

  test("verdict requires a string enum without coercion", () => {
    expect(() => validate({ ...checks(), checks: [{ ...checks().checks[0], verdict: ["pass"] }] })).toThrow()
    expect(() => validate({ ...checks(), checks: [{ ...checks().checks[0], verdict: "invalid" }] })).toThrow()
  })
})
