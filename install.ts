import { existsSync, lstatSync, symlinkSync, unlinkSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const REPO_ROOT = resolve(process.cwd());
const HOME = homedir();
// Claude Code loads plugins from ~/.claude/skills/<name>/ as <name>@skills-dir (official local mechanism)
const CC_SKILLS_SYMLINK = join(HOME, ".claude/skills/john");
const CODEX_JOHN_SYMLINK = join(HOME, ".codex/john");

const args = process.argv.slice(2);
const unregister = args.includes("--unregister");
const dryRun = args.includes("--dry-run");

try {
  if (unregister) {
    await doUninstall();
  } else {
    await doInstall();
  }
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

function symlinkEntry(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

async function doInstall() {
  // Pre-flight: verify skills/ exists before mutating any external state
  const skillsDir = join(REPO_ROOT, "skills");
  if (!existsSync(skillsDir)) {
    throw new Error(`skills/ directory not found at ${skillsDir} — is REPO_ROOT correct?`);
  }

  // 1. Claude Code: ~/.claude/skills/john/ → REPO_ROOT  (loads as john@skills-dir)
  if (symlinkEntry(CC_SKILLS_SYMLINK)) {
    if (!dryRun) unlinkSync(CC_SKILLS_SYMLINK);
  }
  if (!dryRun) {
    symlinkSync(REPO_ROOT, CC_SKILLS_SYMLINK);
  }
  console.log(`✅ Claude Code: ${dryRun ? "[DRY RUN] would create" : "created"} ~/.claude/skills/john → ${REPO_ROOT}`);
  console.log(`   loads as: john@skills-dir`);

  // 2. Codex: ~/.codex/john/ → REPO_ROOT
  if (symlinkEntry(CODEX_JOHN_SYMLINK)) {
    if (!dryRun) unlinkSync(CODEX_JOHN_SYMLINK);
  }
  if (!dryRun) {
    symlinkSync(REPO_ROOT, CODEX_JOHN_SYMLINK);
  }
  console.log(`✅ Codex: ${dryRun ? "[DRY RUN] would create" : "created"} ~/.codex/john → ${REPO_ROOT}`);

  // 3. List discovered skills
  const skills = readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md")))
    .map(d => d.name)
    .sort();
  console.log(`\n📦 Discovered ${skills.length} skills:`);
  skills.forEach(s => console.log(`  john:${s}`));
}

async function doUninstall() {
  // Remove Claude Code symlink
  if (symlinkEntry(CC_SKILLS_SYMLINK)) {
    if (!dryRun) unlinkSync(CC_SKILLS_SYMLINK);
    console.log(`✅ Claude Code: ${dryRun ? "[DRY RUN] would remove" : "removed"} ~/.claude/skills/john`);
  } else {
    console.log(`ℹ️  Claude Code: ~/.claude/skills/john did not exist`);
  }

  // Remove Codex symlink
  if (symlinkEntry(CODEX_JOHN_SYMLINK)) {
    if (!dryRun) unlinkSync(CODEX_JOHN_SYMLINK);
    console.log(`✅ Codex: ${dryRun ? "[DRY RUN] would remove" : "removed"} ~/.codex/john`);
  } else {
    console.log(`ℹ️  Codex: ~/.codex/john did not exist`);
  }
}
