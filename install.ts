import { existsSync, symlinkSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const REPO_ROOT = resolve(process.cwd());
const HOME = homedir();
const CC_PLUGINS_JSON = join(HOME, ".claude/plugins/installed_plugins.json");
const CODEX_JOHN_SYMLINK = join(HOME, ".codex/john");
const PLUGIN_KEY = "john@local";

const args = process.argv.slice(2);
const unregister = args.includes("--unregister");
const dryRun = args.includes("--dry-run");

if (unregister) {
  await doUninstall();
} else {
  await doInstall();
}

async function doInstall() {
  // 1. Claude Code registration
  const ccPluginsText = await Bun.file(CC_PLUGINS_JSON).text();
  const ccPlugins = JSON.parse(ccPluginsText);
  const now = new Date().toISOString();
  const existing = ccPlugins.plugins[PLUGIN_KEY]?.[0];
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

  // 2. Codex symlink
  if (existsSync(CODEX_JOHN_SYMLINK)) {
    if (!dryRun) unlinkSync(CODEX_JOHN_SYMLINK);
    console.log(`  (removed existing ~/.codex/john)`);
  }
  if (!dryRun) {
    symlinkSync(REPO_ROOT, CODEX_JOHN_SYMLINK);
  }
  console.log(`✅ Codex: ${dryRun ? "[DRY RUN] would create" : "created"} ~/.codex/john → ${REPO_ROOT}`);

  // 3. List discovered skills
  const skillsDir = join(REPO_ROOT, "skills");
  const skills = readdirSync(skillsDir)
    .filter(d =>
      statSync(join(skillsDir, d)).isDirectory() &&
      existsSync(join(skillsDir, d, "SKILL.md"))
    )
    .sort();
  console.log(`\n📦 Discovered ${skills.length} skills:`);
  skills.forEach(s => console.log(`  john:${s}`));
}

async function doUninstall() {
  // Remove from Claude Code
  const ccPluginsText = await Bun.file(CC_PLUGINS_JSON).text();
  const ccPlugins = JSON.parse(ccPluginsText);
  if (ccPlugins.plugins[PLUGIN_KEY]) {
    delete ccPlugins.plugins[PLUGIN_KEY];
    if (!dryRun) await Bun.write(CC_PLUGINS_JSON, JSON.stringify(ccPlugins, null, 2));
    console.log(`✅ Claude Code: ${dryRun ? "[DRY RUN] would remove" : "removed"} ${PLUGIN_KEY}`);
  } else {
    console.log(`ℹ️  Claude Code: ${PLUGIN_KEY} was not registered`);
  }

  // Remove Codex symlink
  if (existsSync(CODEX_JOHN_SYMLINK)) {
    if (!dryRun) unlinkSync(CODEX_JOHN_SYMLINK);
    console.log(`✅ Codex: ${dryRun ? "[DRY RUN] would remove" : "removed"} ~/.codex/john`);
  } else {
    console.log(`ℹ️  Codex: ~/.codex/john did not exist`);
  }
}
