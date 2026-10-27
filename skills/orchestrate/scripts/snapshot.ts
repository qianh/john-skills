import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { isSensitivePath, scanText, type SafetyPolicy } from "./safety.ts"

export interface SensitiveStat {
  size: number
  mtimeMs: number
  ctimeMs: number
  mode: number
  kind: "file" | "directory" | "symlink" | "other"
}

export interface Snapshot {
  tree: string
  head: string | null
  indexTree: string
  safeHead: string
  sensitive: Record<string, SensitiveStat>
  preexisting: string[]
  evidenceGaps?: string[]
  redactions?: string[]
}

function nulList(text: string): string[] {
  return text.split("\0").filter(Boolean)
}

function gitEnv(index?: string): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" }
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete (env as NodeJS.ProcessEnv)[name]
  if (index) (env as NodeJS.ProcessEnv).GIT_INDEX_FILE = index
  return env
}

export class SnapshotManager {
  readonly cwd: string
  readonly gitDir: string
  private readonly indexPath: string
  private readonly tempRoot: string
  private filterOverrides: string[] = []

  constructor(cwd: string, runDir: string, private readonly policy: SafetyPolicy = {}) {
    this.cwd = realpathSync(cwd)
    const root = this.git(["rev-parse", "--show-toplevel"]).trim()
    if (!root) throw new Error("Snapshots require a git worktree")
    this.cwd = realpathSync(root)
    this.gitDir = path.resolve(this.cwd, this.git(["rev-parse", "--git-dir"]).trim())
    this.indexPath = path.resolve(this.cwd, this.git(["rev-parse", "--git-path", "index"]).trim())
    this.tempRoot = path.resolve(runDir, "snapshot-indexes")
    mkdirSync(this.tempRoot, { recursive: true })
    const filters = this.gitResult(["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"])
    if (filters.error || ![0, 1].includes(filters.status ?? -1)) throw new Error("Unable to inspect git filter names")
    this.filterOverrides = filters.stdout.split("\n").filter(Boolean).flatMap((name) => ["-c", `${name}=${name.endsWith(".required") ? "false" : ""}`])
    this.assertSupported()
  }

  private gitResult(args: string[], index?: string, input?: string) {
    // A caller's index/worktree overrides must not redirect our checks elsewhere.
    return spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...this.filterOverrides, ...args], { cwd: this.cwd, env: gitEnv(index), encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 })
  }

  private git(args: string[], index?: string, input?: string): string {
    const result = this.gitResult(args, index, input)
    if (result.error || result.status !== 0) {
      // Do not forward git stderr: hooks/filters can include credentials in errors.
      throw new Error(`Git snapshot operation failed: ${args[0]} (exit ${result.status ?? "unknown"})`)
    }
    return result.stdout
  }

  private assertSupported(): void {
    if (this.git(["ls-files", "-u", "-z"])) throw new Error("Unresolved git conflicts are not supported")
    const sparse = this.gitResult(["config", "--bool", "core.sparseCheckout"])
    if (sparse.error || ![0, 1].includes(sparse.status ?? -1)) throw new Error("Unable to check sparse checkout configuration")
    if (sparse.status === 0 && sparse.stdout.trim() === "true") throw new Error("Sparse checkouts are not supported")
    const flags = nulList(this.git(["ls-files", "-v", "-z"]))
    if (flags.some((line) => /^[Ss] /.test(line))) throw new Error("skip-worktree entries are not supported")
    if (nulList(this.git(["ls-files", "--stage", "-z"])).some((line) => line.startsWith("160000 "))) throw new Error("Submodule entries are not supported")
  }

  private withIndex<T>(fromUser: boolean, operation: (index: string) => T): T {
    const dir = mkdtempSync(path.join(this.tempRoot, "index-"))
    const index = path.join(dir, "index")
    try {
      if (fromUser && existsSync(this.indexPath)) copyFileSync(this.indexPath, index)
      else this.git(["read-tree", "--empty"], index)
      return operation(index)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private entries(index?: string): string[] {
    return nulList(this.git(["ls-files", "-z"], index))
  }

  private sensitive(file: string): boolean {
    return isSensitivePath(file, this.policy.sensitiveExtra) || isSensitivePath(path.join(this.cwd, file), this.policy.sensitiveExtra)
  }

  private remove(index: string, files: string[]): void {
    if (files.length) this.git(["update-index", "--force-remove", "-z", "--stdin"], index, files.join("\0") + "\0")
  }

  private safeHeadTree(head: string | null): string {
    return this.withIndex(false, (index) => {
      if (head) this.git(["read-tree", head], index)
      this.remove(index, this.entries(index).filter((file) => this.sensitive(file)))
      return this.git(["write-tree"], index).trim()
    })
  }

  safeHead(ref = "HEAD"): string {
    const result = this.gitResult(["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`])
    if (result.status !== 0 && ref !== "HEAD") throw new Error("Invalid snapshot base reference")
    return this.safeHeadTree(result.status === 0 ? result.stdout.trim() : null)
  }

  /** lstat every component so a replaced parent symlink is never traversed. */
  private stat(file: string): SensitiveStat | null {
    const parts = file.replace(/\/$/, "").split("/")
    if (parts.some((part) => part === "..") || path.isAbsolute(file)) throw new Error("Invalid repository path")
    let current = this.cwd
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i])
      try {
        const info = lstatSync(current)
        if (i < parts.length - 1 && (!info.isDirectory() || info.isSymbolicLink())) return null
        if (i === parts.length - 1) return {
          size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, mode: info.mode,
          kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        }
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) return null
        throw new Error("Unable to stat repository path safely")
      }
    }
    return null
  }

  captureBaseline(): Snapshot {
    return this.captureSnapshot()
  }

  captureSnapshot(): Snapshot {
    this.assertSupported()
    const headResult = this.gitResult(["rev-parse", "--verify", "HEAD"])
    const head = headResult.status === 0 ? headResult.stdout.trim() : null
    const tracked = this.entries()
    const untracked = nulList(this.git(["ls-files", "-o", "--exclude-standard", "-z"]))
    const ignored = nulList(this.git(["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"]))
    const sensitive: Record<string, SensitiveStat> = Object.create(null)
    for (const file of new Set([...tracked, ...untracked, ...ignored])) {
      if (!this.sensitive(file)) continue
      const info = this.stat(file)
      if (info) sensitive[file] = info
    }
    const indexTree = this.withIndex(true, (index) => this.git(["write-tree"], index).trim())
    const safeHead = this.safeHeadTree(head)
    const tree = this.withIndex(true, (index) => {
      const indexed = this.entries(index)
      this.remove(index, indexed.filter((file) => this.sensitive(file)))
      // A copied index can hide actual edits behind assume-unchanged stat bits.
      const safeIndexed = this.entries(index)
      const indexedPaths = new Set(safeIndexed)
      if (safeIndexed.length) this.git(["update-index", "--no-assume-unchanged", "-z", "--stdin"], index, safeIndexed.join("\0") + "\0")
      const candidates = [...new Set([...safeIndexed, ...untracked])].filter((file) => !this.sensitive(file))
      const add: string[] = []
      const remove: string[] = []
      for (const file of candidates) {
        const info = this.stat(file)
        // Never ask git add to recurse a directory: it could read excluded children.
        if (info && (info.kind === "file" || info.kind === "symlink")) add.push(file)
        else if (indexedPaths.has(file)) remove.push(file)
      }
      this.remove(index, remove)
      if (add.length) this.git(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], index, add.join("\0") + "\0")
      return this.git(["write-tree"], index).trim()
    })
    return { tree, head, indexTree, safeHead, sensitive, preexisting: this.changedPaths(safeHead, tree) }
  }

  diffTrees(from: string, to: string, paths?: string[]): string {
    if (paths && !paths.length) return ""
    return this.git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", from, to, "--", ...paths ?? []])
  }

  changedPaths(from: string, to: string): string[] {
    return nulList(this.git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from, to, "--"]))
  }

  checkSafety(baseline: Snapshot, current: Snapshot): string[] {
    return checkSafety(baseline, current)
  }

  exportSafeTree(tree: string, targetDir: string): { flags: string[], skipped: string[] } {
    const info = lstatSync(targetDir)
    if (!info.isDirectory() || info.isSymbolicLink() || readdirSync(targetDir).length) throw new Error("Safe export requires an empty, non-symlink directory")
    const target = realpathSync(targetDir)
    const flags: string[] = []
    const skipped: string[] = []
    this.withIndex(false, (index) => {
      this.git(["read-tree", tree], index)
      const files: string[] = []
      for (const row of nulList(this.git(["ls-files", "--stage", "-z"], index))) {
        const tab = row.indexOf("\t")
        const file = row.slice(tab + 1)
        const mode = row.slice(0, 6)
        if (this.sensitive(file) || !["100644", "100755"].includes(mode)) skipped.push(file)
        else files.push(file)
      }
      this.remove(index, skipped)
      this.git(["checkout-index", "--all", `--prefix=${target}${path.sep}`], index)
      for (const file of files) {
        const full = path.join(target, file)
        const bytes = readFileSync(full)
        // Binary blobs are copied as bytes and are never interpreted or executed.
        if (bytes.includes(0)) continue
        let text: string
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { continue }
        const scanned = scanText(text)
        if (scanned.flags.length) {
          writeFileSync(full, scanned.text)
          flags.push(...scanned.flags.map((flag) => `${flag}:${file}`))
        }
      }
    })
    return { flags, skipped }
  }
}

export function captureBaseline(cwd: string, runDir: string, policy: SafetyPolicy = {}): Snapshot {
  return new SnapshotManager(cwd, runDir, policy).captureBaseline()
}

export function captureSnapshot(cwd: string, runDir: string, policy: SafetyPolicy = {}): Snapshot {
  return new SnapshotManager(cwd, runDir, policy).captureSnapshot()
}

export function diffTrees(cwd: string, from: string, to: string, paths?: string[]): string {
  if (paths && !paths.length) return ""
  const result = spawnSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", from, to, "--", ...paths ?? []], { cwd, env: gitEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error("Unable to diff snapshots")
  return result.stdout
}

export function changedPaths(cwd: string, from: string, to: string): string[] {
  const result = spawnSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from, to, "--"], { cwd, env: gitEnv(), encoding: "utf8" })
  if (result.status !== 0) throw new Error("Unable to list snapshot changes")
  return nulList(result.stdout)
}

export function checkSafety(baseline: Snapshot, current: Snapshot): string[] {
  const flags: string[] = []
  if (baseline.head !== current.head) flags.push("head-changed")
  if (baseline.indexTree !== current.indexTree) flags.push("index-changed")
  for (const file of new Set([...Object.keys(baseline.sensitive), ...Object.keys(current.sensitive)])) {
    if (JSON.stringify(baseline.sensitive[file]) !== JSON.stringify(current.sensitive[file])) flags.push(`sensitive-path-changed:${file}`)
  }
  return flags
}
