## ADDED Requirements

### Requirement: Claude Code plugin manifest
The repo SHALL contain `.claude-plugin/plugin.json` declaring `name: "john"` so Claude Code loads skills under the `john:` namespace.

#### Scenario: Claude Code recognizes the plugin
- **WHEN** `installPath` in `installed_plugins.json` points to this repo
- **THEN** Claude Code session startup lists skills as `john:john`, `john:kb`, `john:spec`, etc.

### Requirement: Codex plugin manifest
The repo SHALL contain `.codex-plugin/plugin.json` declaring `name: "john"` so Codex loads skills under the `john:` namespace.

#### Scenario: Codex recognizes the plugin
- **WHEN** `~/.codex/john/` is a symlink to this repo
- **THEN** Codex session startup lists skills as `john:john`, `john:kb`, `john:spec`, etc.

### Requirement: Package name alignment
`package.json` SHALL have `name: "john"` matching both plugin manifests to ensure consistent namespace resolution.

#### Scenario: Plugin name consistency
- **WHEN** reading `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`
- **THEN** all three declare the same `name: "john"`
