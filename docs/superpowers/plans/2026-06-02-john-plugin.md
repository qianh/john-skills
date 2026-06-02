# john-plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package 7 personal skills into a Claude Code + Codex plugin named `john`, enabling `john:skill-name` invocation on both platforms.

**Architecture:** The repo becomes the plugin install path directly (dev mode). Plugin manifests declare `name: "john"`. Claude Code reads from `~/.claude/plugins/installed_plugins.json`; Codex reads from `~/.codex/john/` symlink. An `install.ts` script automates both registrations.

**Tech Stack:** Bun (runtime for install script), TypeScript, Claude Code plugin system, Codex plugin system

---

## File Structure

Files to **create**:
- `.claude-plugin/plugin.json` — Claude Code plugin manifest
- `.codex-plugin/plugin.json` — Codex plugin manifest
- `package.json` — npm package definition (name: "john")
- `skills/john/SKILL.md` — personal context loader
- `skills/kb/SKILL.md` + `skills/kb/references/{ingest,lint,query}.md`
- `skills/music-downloader/SKILL.md` + `skills/music-downloader/scripts/download.sh`
- `skills/mydata/SKILL.md`
- `skills/spec/SKILL.md` + `skills/spec/{matrix.md,registry.yaml,spec-template.md}` + `skills/spec/references/{install.md,registry.md}`
- `skills/wechat-cli/SKILL.md`
- `skills/git-commit-helper/SKILL.md` + `skills/git-commit-helper/scripts/{analyze_changes.py,detect_commit_type.py}`
- `install.ts` — registration script for Claude Code + Codex

Files to **modify**:
- `CLAUDE.md` — add install commands and final file map
- `README.md` — add usage and install instructions

External mutations (done by `install.ts`, not committed):
- `~/.claude/plugins/installed_plugins.json` — add `john@local` entry
- `~/.codex/john/` — create symlink → repo root

---

### Task 1: Plugin manifests and package.json

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.codex-plugin/plugin.json`
- Create: `package.json`

- [ ] **Step 1: Write verification test**

```bash
# Run after creating files to confirm they pass
node -e "
const cc = require('./.claude-plugin/plugin.json');
const cx = require('./.codex-plugin/plugin.json');
const pkg = require('./package.json');
console.assert(cc.name === 'john', 'cc name must be john');
console.assert(cx.name === 'john', 'cx name must be john');
console.assert(pkg.name === 'john', 'pkg name must be john');
console.log('✅ All names are john');
"
```

Expected: exits 0 with `✅ All names are john`
Expected right now: `Cannot find module './.claude-plugin/plugin.json'`

- [ ] **Step 2: Create `.claude-plugin/plugin.json`**

```bash
mkdir -p .claude-plugin
```

```json
{
  "name": "john",
  "description": "John's personal skill bundle: context loader, KB agent, spec orchestrator, WeChat CLI, music downloader, mydata profiler, git commit helper",
  "version": "1.0.0",
  "author": {
    "name": "钱宏"
  },
  "keywords": ["skills", "personal", "workflow"],
  "skills": "./skills/"
}
```

Write to: `.claude-plugin/plugin.json`

- [ ] **Step 3: Create `.codex-plugin/plugin.json`**

```bash
mkdir -p .codex-plugin
```

```json
{
  "name": "john",
  "description": "John's personal skill bundle: context loader, KB agent, spec orchestrator, WeChat CLI, music downloader, mydata profiler, git commit helper",
  "version": "1.0.0",
  "author": {
    "name": "钱宏"
  },
  "keywords": ["skills", "personal", "workflow"],
  "skills": "./skills/",
  "interface": {
    "displayName": "John",
    "shortDescription": "Personal skills: spec, kb, wechat-cli, music-downloader, mydata, git-commit-helper",
    "category": "Productivity"
  }
}
```

Write to: `.codex-plugin/plugin.json`

- [ ] **Step 4: Create `package.json`**

```json
{
  "name": "john",
  "version": "1.0.0",
  "description": "John's personal Claude Code + Codex skill plugin",
  "type": "module"
}
```

Write to: `package.json`

- [ ] **Step 5: Run the verification test**

```bash
node -e "
const cc = require('./.claude-plugin/plugin.json');
const cx = require('./.codex-plugin/plugin.json');
const pkg = require('./package.json');
console.assert(cc.name === 'john', 'cc name must be john');
console.assert(cx.name === 'john', 'cx name must be john');
console.assert(pkg.name === 'john', 'pkg name must be john');
console.log('✅ All names are john');
"
```

Expected: `✅ All names are john`

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json .codex-plugin/plugin.json package.json
git commit -m "feat: add plugin manifests for claude-code and codex (name: john)"
```

---

### Task 2: Copy skill bundle — single-file skills

**Files:**
- Create: `skills/john/SKILL.md` (copy from `~/.claude/skills/john/SKILL.md`)
- Create: `skills/mydata/SKILL.md` (copy from `~/.claude/skills/mydata/SKILL.md`)
- Create: `skills/wechat-cli/SKILL.md` (copy from `~/.claude/skills/wechat-cli/SKILL.md`)

- [ ] **Step 1: Write verification test**

```bash
for skill in john mydata wechat-cli; do
  if [ ! -f "skills/$skill/SKILL.md" ]; then
    echo "MISSING: skills/$skill/SKILL.md"
    exit 1
  fi
  name=$(grep -m1 '^name:' "skills/$skill/SKILL.md" | sed 's/name: *//' | tr -d '"')
  if [ "$name" != "$skill" ]; then
    echo "WRONG NAME in skills/$skill/SKILL.md: got '$name', expected '$skill'"
    exit 1
  fi
done
echo "✅ Single-file skills OK"
```

Expected right now: `MISSING: skills/john/SKILL.md`

- [ ] **Step 2: Copy the three single-file skills**

```bash
mkdir -p skills/john skills/mydata skills/wechat-cli
cp ~/.claude/skills/john/SKILL.md skills/john/SKILL.md
cp ~/.claude/skills/mydata/SKILL.md skills/mydata/SKILL.md
cp ~/.claude/skills/wechat-cli/SKILL.md skills/wechat-cli/SKILL.md
```

- [ ] **Step 3: Run the verification test**

```bash
for skill in john mydata wechat-cli; do
  if [ ! -f "skills/$skill/SKILL.md" ]; then
    echo "MISSING: skills/$skill/SKILL.md"
    exit 1
  fi
  name=$(grep -m1 '^name:' "skills/$skill/SKILL.md" | sed 's/name: *//' | tr -d '"')
  if [ "$name" != "$skill" ]; then
    echo "WRONG NAME in skills/$skill/SKILL.md: got '$name', expected '$skill'"
    exit 1
  fi
done
echo "✅ Single-file skills OK"
```

Expected: `✅ Single-file skills OK`

- [ ] **Step 4: Commit**

```bash
git add skills/john/SKILL.md skills/mydata/SKILL.md skills/wechat-cli/SKILL.md
git commit -m "feat: add john, mydata, wechat-cli skills"
```

---

### Task 3: Copy skill bundle — skills with subdirectories

**Files:**
- Create: `skills/kb/SKILL.md` + `skills/kb/references/{ingest,lint,query}.md`
- Create: `skills/git-commit-helper/SKILL.md` + `skills/git-commit-helper/scripts/{analyze_changes.py,detect_commit_type.py}`
- Create: `skills/music-downloader/SKILL.md` + `skills/music-downloader/scripts/download.sh`

- [ ] **Step 1: Write verification test**

```bash
# Check required files exist
required_files=(
  "skills/kb/SKILL.md"
  "skills/kb/references/ingest.md"
  "skills/kb/references/lint.md"
  "skills/kb/references/query.md"
  "skills/git-commit-helper/SKILL.md"
  "skills/git-commit-helper/scripts/analyze_changes.py"
  "skills/git-commit-helper/scripts/detect_commit_type.py"
  "skills/music-downloader/SKILL.md"
  "skills/music-downloader/scripts/download.sh"
)
for f in "${required_files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f"
    exit 1
  fi
done
echo "✅ Skills with subdirectories OK"
```

Expected right now: `MISSING: skills/kb/SKILL.md`

- [ ] **Step 2: Copy kb skill**

```bash
mkdir -p skills/kb/references
cp ~/.claude/skills/kb/SKILL.md skills/kb/SKILL.md
cp ~/.claude/skills/kb/references/ingest.md skills/kb/references/ingest.md
cp ~/.claude/skills/kb/references/lint.md skills/kb/references/lint.md
cp ~/.claude/skills/kb/references/query.md skills/kb/references/query.md
```

- [ ] **Step 3: Copy git-commit-helper skill**

```bash
mkdir -p skills/git-commit-helper/scripts
cp ~/.claude/skills/git-commit-helper/SKILL.md skills/git-commit-helper/SKILL.md
cp ~/.claude/skills/git-commit-helper/scripts/analyze_changes.py skills/git-commit-helper/scripts/analyze_changes.py
cp ~/.claude/skills/git-commit-helper/scripts/detect_commit_type.py skills/git-commit-helper/scripts/detect_commit_type.py
```

- [ ] **Step 4: Copy music-downloader skill**

```bash
mkdir -p skills/music-downloader/scripts skills/music-downloader/assets skills/music-downloader/references
cp ~/.claude/skills/music-downloader/SKILL.md skills/music-downloader/SKILL.md
cp ~/.claude/skills/music-downloader/scripts/download.sh skills/music-downloader/scripts/download.sh
```

- [ ] **Step 5: Run the verification test**

```bash
required_files=(
  "skills/kb/SKILL.md"
  "skills/kb/references/ingest.md"
  "skills/kb/references/lint.md"
  "skills/kb/references/query.md"
  "skills/git-commit-helper/SKILL.md"
  "skills/git-commit-helper/scripts/analyze_changes.py"
  "skills/git-commit-helper/scripts/detect_commit_type.py"
  "skills/music-downloader/SKILL.md"
  "skills/music-downloader/scripts/download.sh"
)
for f in "${required_files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f"
    exit 1
  fi
done
echo "✅ Skills with subdirectories OK"
```

Expected: `✅ Skills with subdirectories OK`

- [ ] **Step 6: Commit**

```bash
git add skills/kb skills/git-commit-helper skills/music-downloader
git commit -m "feat: add kb, git-commit-helper, music-downloader skills with subdirectories"
```

---

### Task 4: Copy spec skill (most complex — 6 supporting files)

**Files:**
- Create: `skills/spec/SKILL.md`
- Create: `skills/spec/matrix.md`
- Create: `skills/spec/registry.yaml`
- Create: `skills/spec/spec-template.md`
- Create: `skills/spec/references/install.md`
- Create: `skills/spec/references/registry.md`

- [ ] **Step 1: Write verification test**

```bash
required_spec_files=(
  "skills/spec/SKILL.md"
  "skills/spec/matrix.md"
  "skills/spec/registry.yaml"
  "skills/spec/spec-template.md"
  "skills/spec/references/install.md"
  "skills/spec/references/registry.md"
)
for f in "${required_spec_files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f"
    exit 1
  fi
done
# Verify the SKILL.md references still make sense (spot-check key file names)
if ! grep -q "matrix.md" skills/spec/SKILL.md; then
  echo "CONTENT ERROR: matrix.md not referenced in spec SKILL.md"
  exit 1
fi
if ! grep -q "registry.yaml" skills/spec/SKILL.md; then
  echo "CONTENT ERROR: registry.yaml not referenced in spec SKILL.md"
  exit 1
fi
echo "✅ spec skill OK"
```

Expected right now: `MISSING: skills/spec/SKILL.md`

- [ ] **Step 2: Copy spec skill with all supporting files**

```bash
mkdir -p skills/spec/references
cp ~/.claude/skills/spec/SKILL.md skills/spec/SKILL.md
cp ~/.claude/skills/spec/matrix.md skills/spec/matrix.md
cp ~/.claude/skills/spec/registry.yaml skills/spec/registry.yaml
cp ~/.claude/skills/spec/spec-template.md skills/spec/spec-template.md
cp ~/.claude/skills/spec/references/install.md skills/spec/references/install.md
cp ~/.claude/skills/spec/references/registry.md skills/spec/references/registry.md
```

- [ ] **Step 3: Run the verification test**

```bash
required_spec_files=(
  "skills/spec/SKILL.md"
  "skills/spec/matrix.md"
  "skills/spec/registry.yaml"
  "skills/spec/spec-template.md"
  "skills/spec/references/install.md"
  "skills/spec/references/registry.md"
)
for f in "${required_spec_files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f"
    exit 1
  fi
done
if ! grep -q "matrix.md" skills/spec/SKILL.md; then
  echo "CONTENT ERROR: matrix.md not referenced in spec SKILL.md"
  exit 1
fi
if ! grep -q "registry.yaml" skills/spec/SKILL.md; then
  echo "CONTENT ERROR: registry.yaml not referenced in spec SKILL.md"
  exit 1
fi
echo "✅ spec skill OK"
```

Expected: `✅ spec skill OK`

- [ ] **Step 4: Commit**

```bash
git add skills/spec
git commit -m "feat: add spec skill with full supporting file tree"
```

---

### Task 5: Write install.ts script

**Files:**
- Create: `install.ts`

- [ ] **Step 1: Write dry-run verification test**

```bash
# Confirm the script exists and can be parsed by bun
[ -f install.ts ] && bun --print "import('./install.ts')" 2>&1 | grep -q "syntax" && echo "SYNTAX ERROR" || echo "✅ install.ts parseable"
```

Expected right now: `install.ts: no such file or directory` (or similar)

- [ ] **Step 2: Write `install.ts`**

Write to `install.ts`:

```typescript
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
  const skills = readdirSync(skillsDir).filter(d =>
    statSync(join(skillsDir, d)).isDirectory() &&
    existsSync(join(skillsDir, d, "SKILL.md"))
  ).sort();
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
```

- [ ] **Step 3: Run dry-run to verify script is parseable and logic is sane**

```bash
bun install.ts --dry-run 2>&1
```

Expected output (approximate):
```
✅ Claude Code: [DRY RUN] would register john@local → /Users/hong/John/ai/john-skills
✅ Codex: [DRY RUN] would create ~/.codex/john → /Users/hong/John/ai/john-skills

📦 Discovered 7 skills:
  john:git-commit-helper
  john:john
  john:kb
  john:music-downloader
  john:mydata
  john:spec
  john:wechat-cli
```

Expected: 7 skills listed, no errors

- [ ] **Step 4: Commit**

```bash
git add install.ts
git commit -m "feat: add install.ts script for claude code + codex registration"
```

---

### Task 6: Run the install and verify registrations

This task mutates external state (`~/.claude/plugins/installed_plugins.json` and `~/.codex/john/`).

- [ ] **Step 1: Back up installed_plugins.json**

```bash
cp ~/.claude/plugins/installed_plugins.json ~/.claude/plugins/installed_plugins.json.bak.$(date +%Y%m%d%H%M%S)
echo "✅ Backup created"
```

- [ ] **Step 2: Run the install**

```bash
bun install.ts
```

Expected: Same output as dry-run but without `[DRY RUN]` labels.

- [ ] **Step 3: Verify Claude Code registration**

```bash
python3 -c "
import json
with open('/Users/hong/.claude/plugins/installed_plugins.json') as f:
    data = json.load(f)
entry = data['plugins'].get('john@local')
assert entry, 'john@local not found'
assert entry[0]['scope'] == 'user', 'wrong scope'
assert 'john-skills' in entry[0]['installPath'], 'wrong installPath'
print('✅ Claude Code registration verified')
print(f'   installPath: {entry[0][\"installPath\"]}')
"
```

Expected: `✅ Claude Code registration verified`

- [ ] **Step 4: Verify Codex symlink**

```bash
ls -la ~/.codex/john
readlink ~/.codex/john
```

Expected: a symlink pointing to the john-skills repo directory.

- [ ] **Step 5: No commit** — this task mutates external state only, nothing to commit.

---

### Task 7: Update CLAUDE.md and README.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update CLAUDE.md**

Replace the current contents of `CLAUDE.md` with:

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A private Claude Code + Codex **plugin package** that exposes personal skills under the `john:` namespace. Once installed, skills are invoked as `john:john`, `john:kb`, `john:spec`, etc.

## Installation

```bash
bun install.ts
```

Registers the plugin on both Claude Code and Codex. Restart both tools after running.

To unregister: `bun install.ts --unregister`

## Skills

| Skill | Invocation | Description |
|---|---|---|
| john | `john:john` | Personal context loader for new sessions |
| kb | `john:kb` | Knowledge base agent (wiki query/ingest) |
| spec | `john:spec` | Spec orchestrator (4-dim scoring + dynamic nodes) |
| mydata | `john:mydata` | Personal data profiling from conversations/notes |
| wechat-cli | `john:wechat-cli` | WeChat message query and export |
| music-downloader | `john:music-downloader` | yt-dlp music download (MP3) |
| git-commit-helper | `john:git-commit-helper` | Smart git commit with Chinese summaries |

## Plugin Structure

```
skills/
├── john/SKILL.md
├── kb/SKILL.md  +  references/{ingest,lint,query}.md
├── spec/SKILL.md  +  matrix.md  registry.yaml  spec-template.md  references/
├── mydata/SKILL.md
├── wechat-cli/SKILL.md
├── music-downloader/SKILL.md  +  scripts/download.sh
└── git-commit-helper/SKILL.md  +  scripts/{analyze_changes,detect_commit_type}.py
.claude-plugin/plugin.json   ← Claude Code manifest (name: "john")
.codex-plugin/plugin.json    ← Codex manifest (name: "john")
install.ts                   ← Registration script
```

## Adding or Updating Skills

1. Edit or create `skills/<name>/SKILL.md`.
2. No reinstall needed — changes take effect on next Claude Code / Codex session start.
3. To add a new skill directory, run `bun install.ts` to refresh the registration.

## After Verifying the Plugin Works

Remove the originals to avoid duplicate skill listings:

```bash
# Claude Code originals
rm -rf ~/.claude/skills/{john,kb,music-downloader,mydata,spec,wechat-cli,git-commit-helper}

# Codex originals
rm -rf ~/.codex/skills/{john,kb,mydata,spec,wechat-cli,git-commit-helper}
```
```

- [ ] **Step 2: Update README.md**

```markdown
# john-skills

Personal Claude Code + Codex skill plugin. Provides `john:` namespaced skills.

## Install

```bash
bun install.ts
```

## Skills

`john:john` · `john:kb` · `john:spec` · `john:mydata` · `john:wechat-cli` · `john:music-downloader` · `john:git-commit-helper`

See [CLAUDE.md](CLAUDE.md) for full documentation.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update CLAUDE.md and README with final install + usage instructions"
```

---

### Task 8: Final verification — all 7 skills present

- [ ] **Step 1: Run complete structure check**

```bash
all_ok=true
all_skills=(john kb music-downloader mydata spec wechat-cli git-commit-helper)
for skill in "${all_skills[@]}"; do
  if [ ! -f "skills/$skill/SKILL.md" ]; then
    echo "❌ MISSING: skills/$skill/SKILL.md"
    all_ok=false
  else
    echo "✅ skills/$skill/SKILL.md"
  fi
done

# Spec supporting files
for f in skills/spec/matrix.md skills/spec/registry.yaml skills/spec/spec-template.md \
          skills/spec/references/install.md skills/spec/references/registry.md; do
  if [ ! -f "$f" ]; then
    echo "❌ MISSING: $f"
    all_ok=false
  fi
done

$all_ok && echo "\n🎉 All skills verified" || echo "\n💥 Some files missing"
```

Expected: 7 `✅` lines + `🎉 All skills verified`

- [ ] **Step 2: Verify dry-run shows 7 skills**

```bash
bun install.ts --dry-run 2>&1 | grep "john:"
```

Expected: 7 lines, one per skill.

- [ ] **Step 3: Restart Claude Code and confirm skills load**

Open a new Claude Code session. In the system prompt's available skills list, you should see:
```
- john:git-commit-helper
- john:john
- john:kb
- john:music-downloader
- john:mydata
- john:spec
- john:wechat-cli
```

Try invoking: `/john:kb` or `/john:spec` to confirm the skill loads.

- [ ] **Step 4: (After confirming plugin works) Remove originals**

```bash
# Claude Code
rm -rf ~/.claude/skills/john ~/.claude/skills/kb ~/.claude/skills/music-downloader \
       ~/.claude/skills/mydata ~/.claude/skills/spec ~/.claude/skills/wechat-cli \
       ~/.claude/skills/git-commit-helper

# Codex
rm -rf ~/.codex/skills/john ~/.codex/skills/kb ~/.codex/skills/mydata \
       ~/.codex/skills/spec ~/.codex/skills/wechat-cli ~/.codex/skills/git-commit-helper
```

Expected: Originals gone. Restart both tools. Skills still appear as `john:*`.

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| `.claude-plugin/plugin.json` with `name: "john"` | Task 1 |
| `.codex-plugin/plugin.json` with `name: "john"` | Task 1 |
| `package.json` with `name: "john"` | Task 1 |
| All 7 skills have `SKILL.md` | Tasks 2, 3, 4 |
| spec skill retains 5 supporting files | Task 4 |
| music-downloader retains scripts | Task 3 |
| `SKILL.md` frontmatter `name:` matches directory | Verified in Task 2 |
| No hardcoded `~/.claude/skills/` paths in SKILL.md | Pre-verified: none found |
| `bun run install.ts` registers `john@local` in CC | Task 5, 6 |
| `bun run install.ts` creates `~/.codex/john/` symlink | Task 5, 6 |
| `--unregister` flag removes both registrations | Task 5 (in script) |
| Install prints list of 7 `john:*` skills | Task 5 |
| Originals removable after verification | Task 8 |

**No placeholders found.**

**Type consistency:** All bash/TypeScript uses consistent paths and variable names.
