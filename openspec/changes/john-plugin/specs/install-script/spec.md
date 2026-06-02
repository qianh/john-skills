## ADDED Requirements

### Requirement: Single-command installation
Running `bun run install.ts` (or `bun install-plugin.ts`) from the repo root SHALL register the plugin on both Claude Code and Codex without manual file editing.

#### Scenario: Claude Code registration
- **WHEN** `bun run install.ts` completes
- **THEN** `~/.claude/plugins/installed_plugins.json` contains a `john@local` entry with `installPath` set to the absolute path of this repo

#### Scenario: Codex registration
- **WHEN** `bun run install.ts` completes
- **THEN** `~/.codex/john/` exists as a symlink pointing to the absolute path of this repo

#### Scenario: Idempotent re-run
- **WHEN** `bun run install.ts` is run a second time
- **THEN** it succeeds without creating duplicate entries or broken symlinks

### Requirement: Post-install cleanup command
The install script SHALL include an `--unregister` flag (or companion `uninstall.ts`) that removes the plugin registration from both platforms, to be run before removing the repo or switching to a different install location.

#### Scenario: Clean uninstall
- **WHEN** `bun run install.ts --unregister` completes
- **THEN** the `john@local` entry is absent from `installed_plugins.json` and `~/.codex/john/` no longer exists

### Requirement: Verification step
The install script SHALL print the list of discovered `john:` skills after successful registration to confirm the plugin is correctly structured.

#### Scenario: Skills discovered
- **WHEN** install completes
- **THEN** script outputs each skill name in format `john:<skill-name>` confirming all 7 skills were found
