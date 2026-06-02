## ADDED Requirements

### Requirement: All 7 skills present with complete file trees
The `skills/` directory SHALL contain all 7 skills with their original sub-files intact.

#### Scenario: Each skill has SKILL.md
- **WHEN** inspecting `skills/<name>/`
- **THEN** `SKILL.md` exists for each of: john, kb, music-downloader, mydata, spec, wechat-cli, git-commit-helper

#### Scenario: spec skill retains supporting files
- **WHEN** inspecting `skills/spec/`
- **THEN** `matrix.md`, `registry.yaml`, `spec-template.md`, `references/install.md`, `references/registry.md` all exist alongside `SKILL.md`

#### Scenario: music-downloader retains assets and scripts
- **WHEN** inspecting `skills/music-downloader/`
- **THEN** `assets/` and `references/` directories exist alongside `SKILL.md`

### Requirement: SKILL.md frontmatter name matches directory name
Each `SKILL.md` SHALL have a `name:` frontmatter field matching the directory name.

#### Scenario: Name field consistency
- **WHEN** reading `skills/<dir>/SKILL.md` frontmatter
- **THEN** `name:` value equals `<dir>` (e.g., `skills/spec/SKILL.md` has `name: spec`)

### Requirement: No absolute ~/.claude or ~/.codex paths in SKILL.md content
`SKILL.md` files MAY reference absolute paths to external tools (e.g., `~/John/ai/john-brain/kb.py`) but SHALL NOT contain hardcoded references to `~/.claude/skills/` or `~/.codex/skills/` that would break after original removal.

#### Scenario: Relative sub-file references work from new location
- **WHEN** the spec skill's `matrix.md` is loaded at `skills/spec/matrix.md`
- **THEN** the spec skill's instructions that reference `matrix.md` resolve correctly relative to the new skill base directory
