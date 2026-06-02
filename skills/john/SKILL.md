---
name: john
description: Use when starting any task for John in a new session, unfamiliar project, or when AI is about to assume language, tech stack, or project context without being told.
---

# John's Personal Context & Workflow

## Identity
- John (hong), full-stack developer at DZG 大掌柜 (maritime logistics company)
- Uses both Claude Code and Codex for research, architecture, analysis, coding, and debugging

## DZG Projects

| Project | Stack | Purpose |
|---------|-------|---------|
| `wx-report-agent` | FastAPI + WeChat miniapp | WeChat report service + subscriptions |
| `ship-data-analysis` | FastAPI + SQLModel + AIS data | Ship tracking & port analytics platform |
| `dzg-chatbot` | Node/TS + LangChain | AI chatbot with port congestion tools |
| `dzg-llm-center` | Go + React | LLM API gateway (40+ providers) |

All DZG Python projects share: `scaffold_core` library · Apollo config center · aliyun pip mirror (`https://mirrors.aliyun.com/pypi/simple/`)

## Tech Stack
- **Backend**: FastAPI · SQLModel · `uv` · async/await · Apollo config (`Apollo > local > defaults`)
- **Frontend**: React / Vue / TypeScript · WeChat miniapp
- **Infra**: Aliyun OSS · Redis · PostgreSQL / MySQL

## Workflow Rules

**1. Read before change**
Read relevant files and understand existing structure before touching any code. Never infer behavior from names alone.

**2. Clarify before implement**
Ambiguous requirement → offer A/B options, wait for selection. Do not silently assume and implement.

**3. TDD**
Projects with tests: write failing test first, confirm red, then fix, confirm green, then lint. No skipping.

**4. Chain debugging**
Follow the full data flow (e.g., login → OSS upload → DB store → render). Fix root cause, not symptoms.

**5. Verify before done**
Run tests + lint, confirm exit code 0. Run `uv run python scripts/verify-agent-docs.py` if present in project.

**6. Minimal replies**
No narration ("I'm about to..."). No end-of-response summaries. Output result or ask one question.

**7. Chinese replies**
All responses in Chinese. Code, variable names, commands, and comments stay in English.

**8. Use superpowers for project tasks**
For any project-related task, invoke the `superpowers:using-superpowers` skill (or `using-superpowers`) before starting work.

**9. Use git-commit-helper for commits**
For any code commit task, invoke the `git-commit-helper` skill.

**10. Code review results in Chinese**
When using any code review / review-related tool, the results MUST be replied in Chinese.

**11. AGENTS.md check**
When starting on any project (with Claude Code or Codex), check for `AGENTS.md` at the project root.
If missing and the task is non-trivial, offer to create it. Minimum content: purpose, test cmd, lint cmd, key rules.
For DZG projects also include: scaffold_core usage rule, Apollo config namespace, aliyun pip mirror.

## Common Mistakes

| Mistake | Correct behavior |
|---------|-----------------|
| Responding in English | Always Chinese, unless user switches |
| Assuming tech stack without reading | Read `pyproject.toml` / `package.json` / `AGENTS.md` first |
| Big implementation before confirming scope | A/B confirm → then implement |
| Summarizing at end of every reply | Stop after result or question |
| Patching error output without tracing chain | Follow data flow to root cause |
