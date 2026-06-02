import { existsSync, lstatSync, symlinkSync, unlinkSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";

const REPO_ROOT = resolve(process.cwd());
const HOME = homedir();
const CC_PLUGINS_JSON = join(HOME, ".claude/plugins/installed_plugins.json");
const CODEX_JOHN_SYMLINK = join(HOME, ".codex/john");
const PLUGIN_KEY = "john@john";

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

async function readPlugins(): Promise<Record<string, unknown[]>> {
  if (!existsSync(CC_PLUGINS_JSON)) {
    return { version: 2, plugins: {} } as unknown as Record<string, unknown[]>;
  }
  return JSON.parse(await Bun.file(CC_PLUGINS_JSON).text());
}

async function doInstall() {
  // 0. Pre-flight: verify skills/ exists before mutating any external state
  const skillsDir = join(REPO_ROOT, "skills");
  if (!existsSync(skillsDir)) {
    throw new Error(`skills/ directory not found at ${skillsDir} — is REPO_ROOT correct?`);
  }

  // 1. Claude Code registration
  const ccPlugins = await readPlugins() as { version: number; plugins: Record<string, unknown[]> };
  ccPlugins.plugins ??= {};
  const now = new Date().toISOString();
  const existing = (ccPlugins.plugins[PLUGIN_KEY] as { installedAt?: string }[])?.[0];
  ccPlugins.plugins[PLUGIN_KEY] = [{
    scope: "user",
    installPath: REPO_ROOT,
    version: "local",
    installedAt: existing?.installedAt ?? now,
    lastUpdated: now,
  }];
  if (!dryRun) {
    await Bun.write(CC_PLUGINS_JSON, JSON.stringify(ccPlugins, null, 2));
  }
  console.log(`✅ Claude Code: ${dryRun ? "[DRY RUN] would register" : "registered"} ${PLUGIN_KEY} → ${REPO_ROOT}`);

  // 2. Codex symlink — use lstatSync to detect dangling symlinks that existsSync misses
  const symlinkExists = (() => {
    try { lstatSync(CODEX_JOHN_SYMLINK); return true; } catch { return false; }
  })();
  if (symlinkExists) {
    if (!dryRun) unlinkSync(CODEX_JOHN_SYMLINK);
    if (!dryRun) console.log(`  (removed existing ~/.codex/john)`);
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
  // Remove from Claude Code
  const ccPlugins = await readPlugins() as { plugins: Record<string, unknown[]> };
  ccPlugins.plugins ??= {};
  if (ccPlugins.plugins[PLUGIN_KEY]) {
    delete ccPlugins.plugins[PLUGIN_KEY];
    if (!dryRun) await Bun.write(CC_PLUGINS_JSON, JSON.stringify(ccPlugins, null, 2));
    console.log(`✅ Claude Code: ${dryRun ? "[DRY RUN] would remove" : "removed"} ${PLUGIN_KEY}`);
  } else {
    console.log(`ℹ️  Claude Code: ${PLUGIN_KEY} was not registered`);
  }

  // Remove Codex symlink — use lstatSync to catch dangling symlinks
  const symlinkExists = (() => {
    try { lstatSync(CODEX_JOHN_SYMLINK); return true; } catch { return false; }
  })();
  if (symlinkExists) {
    if (!dryRun) unlinkSync(CODEX_JOHN_SYMLINK);
    console.log(`✅ Codex: ${dryRun ? "[DRY RUN] would remove" : "removed"} ~/.codex/john`);
  } else {
    console.log(`ℹ️  Codex: ~/.codex/john did not exist`);
  }
}
