## Why

Personal skills currently exist as loose files in `~/.claude/skills/` and `~/.codex/skills/` — unversioned, hard to sync across machines, with no namespace separation from system or third-party skills. Packaging them as a named plugin provides version control, clean `john:` prefix isolation, and a single-repo install mechanism that works identically on both Claude Code and Codex.

## What Changes

- Create `john-skills` Claude Code + Codex plugin with `name: "john"` (skills callable as `john:spec`, `john:kb`, etc.)
- Migrate 7 skills from loose directories into `skills/` within this repo, preserving all sub-files (assets, scripts, references, supporting .md files)
- Add `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` plugin manifests
- Add `install.ts` script that registers the plugin on Claude Code (`~/.claude/plugins/installed_plugins.json`) and creates `~/.codex/john/` symlink
- **BREAKING**: After verification, remove originals from `~/.claude/skills/{john,kb,music-downloader,mydata,spec,wechat-cli,git-commit-helper}` and `~/.codex/skills/{john,kb,mydata,spec,wechat-cli,git-commit-helper}`
- Skills previously invoked as `/spec`, `/kb`, etc. must now be invoked as `/john:spec`, `/john:kb`, etc.

## Capabilities

### New Capabilities
- `plugin-manifest`: Plugin metadata files that identify this repo as a namespaced skill plugin for Claude Code and Codex
- `install-script`: Automated registration of the plugin on both platforms from a single `bun run install.ts` command
- `skill-bundle`: 7 skills packaged under the `john:` namespace with all supporting files preserved

### Modified Capabilities
(none — this is a net-new package; existing loose skills are being replaced, not modified in behavior)

## Impact

- `~/.claude/plugins/installed_plugins.json`: new `john@local` entry added
- `~/.claude/skills/`: 7 directories removed post-verification
- `~/.codex/john/`: new symlink → this repo
- `~/.codex/skills/`: 6 directories removed post-verification (music-downloader did not previously exist there)
- No changes to any other installed plugins, PAI internals, or external tools referenced by the skills
