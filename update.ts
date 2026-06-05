import { execSync } from "child_process";
import { existsSync, lstatSync, readlinkSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd());
const HOME = homedir();

const CC_CACHE = join(HOME, ".claude/plugins/cache/john-skills");
const CODEX_CACHE = join(HOME, ".codex/plugins/cache/john-skills");
const CC_SYMLINK = join(HOME, ".claude/skills/john");
const CODEX_SYMLINK = join(HOME, ".codex/john");

function run(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, { cwd: cwd ?? REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function isSymlinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

function detectInstalls(): { local: boolean; ccCache: boolean; codexCache: boolean } {
  return {
    local: isSymlinkTo(CC_SYMLINK, REPO_ROOT) || isSymlinkTo(CODEX_SYMLINK, REPO_ROOT),
    ccCache: existsSync(CC_CACHE),
    codexCache: existsSync(CODEX_CACHE),
  };
}

function listSkills(): string[] {
  const skillsDir = join(REPO_ROOT, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md")))
    .map(d => d.name)
    .sort();
}

// --- main ---

const installs = detectInstalls();
const before = run("git rev-parse HEAD");

console.log("🔄 正在拉取最新代码...\n");
const pullOutput = run("git pull --rebase");
console.log(pullOutput || "(已是最新)");

const after = run("git rev-parse HEAD");

if (before && after && before !== after) {
  console.log("\n📋 更新内容：");
  console.log(run(`git log --oneline ${before}..${after}`));
} else {
  console.log("\nℹ️  没有新的提交");
}

// Local symlink install: nothing more needed, symlinks point to repo
if (installs.local) {
  console.log("\n✅ 本地符号链接安装 — 已自动生效");
}

// Marketplace cache: need re-install to refresh cache
if (installs.ccCache || installs.codexCache) {
  console.log("\n⚠️  检测到 marketplace 缓存安装，需要重新安装以刷新缓存：");
  if (installs.ccCache) {
    console.log("   Claude Code:  /plugin marketplace add qianh/john-skills");
  }
  if (installs.codexCache) {
    console.log("   Codex:        codex plugin marketplace add qianh/john-skills");
  }
}

// Show current skills
const skills = listSkills();
console.log(`\n📦 当前 ${skills.length} 个技能：`);
skills.forEach(s => console.log(`  john:${s}`));
