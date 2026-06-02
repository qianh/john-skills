# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A private Claude Code **plugin package** that exposes personal skills under the `john:` namespace. Once installed, skills are invoked as `john:john`, `john:kb`, `john:spec`, etc. — the same mechanism used by the `superpowers` plugin.

## Plugin Structure

```
john-skills/
├── .claude-plugin/
│   ├── plugin.json        # Plugin metadata (name: "john", version, description)
│   └── marketplace.json   # Marketplace manifest — makes this repo self-distributable
├── package.json            # name: "john" (drives the skill namespace prefix)
├── skills/
│   ├── john/SKILL.md       # Personal context loader
│   ├── kb/SKILL.md         # Knowledge base agent (+ references/)
│   ├── music-downloader/   # yt-dlp music downloader (+ assets/, references/, scripts/)
│   ├── mydata/SKILL.md     # Personal data profiling
│   ├── spec/               # Spec orchestrator (+ matrix.md, registry.yaml, references/, spec-template.md)
│   ├── wechat-cli/SKILL.md # WeChat CLI query tool
│   └── git-commit-helper/  # Git commit helper (+ scripts/)
└── README.md
```

## Installation

**Claude Code** — install via marketplace (no git clone needed):

```bash
/plugin marketplace add qianh/john-skills
/plugin install john@john-skills
```

**Codex** — install via marketplace (no git clone needed):

```bash
codex plugin marketplace add qianh/john-skills
codex plugin add john@john-skills
```

**Local development** (after cloning):

```bash
bun install.ts
```

Creates `~/.claude/skills/john/` → this repo symlink (loads as `john@skills-dir`).
To unregister: `bun install.ts --unregister`

## Adding or Updating Skills

1. Create (or copy) `skills/<skill-name>/SKILL.md` — the frontmatter `name:` must match the directory name.
2. Copy any supporting files (scripts, assets, references) into `skills/<skill-name>/`.
3. No rebuild needed — Claude Code reads skills from `installPath` at session start.

## Skill Frontmatter

Every `SKILL.md` requires:

```yaml
---
name: <skill-name>          # must match directory name
description: <one-liner>    # shown in skill list; drives auto-trigger matching
---
```

## After Verifying the Plugin Works

Remove the originals to avoid duplicate skill listings:

```bash
# Claude Code originals
rm -rf ~/.claude/skills/john ~/.claude/skills/kb ~/.claude/skills/music-downloader \
       ~/.claude/skills/mydata ~/.claude/skills/spec ~/.claude/skills/wechat-cli \
       ~/.claude/skills/git-commit-helper

# Codex originals
rm -rf ~/.codex/skills/john ~/.codex/skills/kb ~/.codex/skills/mydata \
       ~/.codex/skills/spec ~/.codex/skills/wechat-cli ~/.codex/skills/git-commit-helper
```
