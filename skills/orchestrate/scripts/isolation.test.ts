import { expect, test } from "bun:test"
import { runVerificationIsolation } from "./isolation.ts"

test("local isolation probes never grant provider admission or inspect real credentials", async () => {
  const result = await runVerificationIsolation()
  expect(result.target).toBe("verify-only")
  expect(["pass", "fail", "unavailable"]).toContain(result.status)
  expect(result.probes.length).toBeGreaterThan(0)
  expect(result.limitations.join(" ")).toContain("不读取真实凭证")
  // Unsupported hosts may report unavailable, but an exercised boundary must pass.
  if (result.status !== "unavailable") {
    expect(result.probes.filter((probe) => probe.outcome === "fail")).toEqual([])
    expect(result.status).toBe("pass")
    for (const name of ["workspace-write", "outside-write-denied", "git-metadata-write-denied", "sensitive-file-read-denied", "minimal-environment", "bun-test"]) expect(result.probes.find((probe) => probe.name === name)?.outcome).toBe("pass")
    if (Bun.which("git")) {
      expect(result.probes.find((probe) => probe.name === "local-helper-positive-control")?.outcome).toBe("pass")
      expect(result.probes.find((probe) => probe.name === "local-credential-helper-disabled")?.outcome).toBe("pass")
    }
  }
}, 120_000)
