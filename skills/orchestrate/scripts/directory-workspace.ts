import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"
import { isSensitivePath, scanText } from "./safety.ts"
import type { Snapshot } from "./snapshot.ts"

/** Read-only fallback: no Git, no writes in the inspected directory, no symlinks. */
export class DirectoryWorkspace {
  readonly cwd: string
  readonly gitDir: string
  private trees = new Map<string, Record<string, string>>()
  private flags: string[] = []
  constructor(cwd: string, runDir: string, private sensitiveExtra: string[] = []) {
    this.cwd = realpathSync(cwd); this.gitDir = runDir
  }
  private save(files: Record<string, string>): string {
    const tree = createHash("sha256").update(JSON.stringify(files)).digest("hex")
    this.trees.set(tree, files); return tree
  }
  safeHead(ref?: string): string {
    if (ref && ref !== "HEAD") throw new Error("非 Git 只读审查不支持 --base")
    return this.save({})
  }
  captureBaseline(): Snapshot { return this.captureSnapshot() }
  captureSnapshot(): Snapshot {
    const files: Record<string, string> = {}
    let bytes = 0
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir).sort()) {
        const full = path.join(dir, entry), relative = path.relative(this.cwd, full)
        if ([".git", "node_modules", ".venv", "vendor", ".cache"].includes(entry) || isSensitivePath(relative, this.sensitiveExtra)) continue
        const stat = lstatSync(full)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) { walk(full); continue }
        if (!stat.isFile() || stat.size > 1_000_000 || bytes + stat.size > 20_000_000) { this.flags.push("非 Git 审查有过大/特殊文件未展开"); continue }
        const buffer = readFileSync(full); bytes += stat.size
        if (buffer.includes(0)) { this.flags.push("非 Git 审查跳过二进制文件"); continue }
        const clean = scanText(buffer.toString("utf8")); this.flags.push(...clean.flags); files[relative] = clean.text
      }
    }
    walk(this.cwd)
    const tree = this.save(files)
    return { tree, head: null, indexTree: "no-index", safeHead: this.safeHead(), sensitive: {}, preexisting: Object.keys(files) }
  }
  changedPaths(from: string, to: string): string[] {
    const a = this.trees.get(from) ?? {}, b = this.trees.get(to) ?? {}
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort()
  }
  diffTrees(from: string, to: string, paths?: string[]): string {
    const a = this.trees.get(from) ?? {}, b = this.trees.get(to) ?? {}
    return (paths ?? this.changedPaths(from, to)).map((p) => `--- ${JSON.stringify(p)}\n+++ ${JSON.stringify(p)}\n${b[p] ?? "(deleted)"}`).join("\n\n")
  }
  checkSafety(): string[] { return [...new Set(this.flags)] }
}
