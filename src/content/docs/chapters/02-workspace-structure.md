---
title: Workspace Structure
description: File hierarchy, loading order, and how workspace context reaches the model.
---

Every OpenClaw agent lives inside a *workspace directory* — a regular folder on disk that functions as the agent's persistent identity, memory, and configuration surface. This chapter traces exactly which files are loaded, in what order, and how their content ends up in the model's context window.

## The Canonical File Set

The constants in `src/agents/workspace.ts` name every standard workspace file:

```ts
export const DEFAULT_AGENTS_FILENAME   = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME     = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME    = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME     = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME   = "MEMORY.md"; // from src/memory/root-memory-files.ts
```

The workspace also has a hidden state directory `.openclaw/` that holds runtime state (not context files). You'll find the workspace state version marker at `.openclaw/workspace-state.json`.

## How Files are Loaded

`loadWorkspaceBootstrapFiles` (in `workspace.ts`) scans the workspace directory for the known filenames above. Each file is read via `readWorkspaceFileWithGuards`, which uses a boundary-safe `openBoundaryFile` call to guarantee the path stays inside the workspace root — a deliberate security measure against symlink traversal. The read result is cached keyed on the file's inode/dev/size/mtime fingerprint, so repeated reads within a turn are free.

Files that exceed `MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES` (2 MB) are silently truncated. The guard is intentionally lenient on size — the real constraint is the model's context window, handled downstream.

Front-matter is stripped before the content is embedded. `HEARTBEAT.md` is treated specially as a "dynamic context file" — it is re-read on every turn rather than cached, because heartbeat instructions change frequently.

## Sorting Order in the System Prompt

`sortContextFilesForPrompt` in `src/agents/system-prompt.ts` orders bootstrap files before they are injected. The priority map is:

| File | Order Key |
|---|---|
| agents.md | 10 |
| soul.md | 20 |
| identity.md | 30 |
| user.md | 40 |
| tools.md | 50 |
| bootstrap.md | 60 |
| memory.md | 70 |

Any extra files discovered in the workspace that are not in the known list get appended after the primaries, sorted alphabetically. This means `AGENTS.md` always lands first and `MEMORY.md` is injected last among the standard set.

## The Bootstrap Lifecycle

There is a distinction between the *first turn* (bootstrap) and *continuation turns*. `hasCompletedBootstrapTurn` inspects the session file's last few hundred KB for a `openclaw:bootstrap-context:full` custom marker:

```ts
// written after the first successful assistant turn
record.type === "custom" &&
record.customType === FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE
```

On the first turn, `buildFullBootstrapPromptLines` writes the full file set. On continuation turns `buildLimitedBootstrapPromptLines` is used — it still includes identity files (SOUL, IDENTITY, USER) but omits bulkier workspace context that was already part of the session history.

The `contextInjection` setting in `agents.defaults` can force `"always"` (default) — which re-injects context files on every turn regardless of the bootstrap marker — or allow lightweight mode. This trade-off: always-injection keeps the model grounded but costs tokens.

## Memory vs. Bootstrap Context

The workspace has two distinct memory surfaces:

1. **Bootstrap context** — static files read from disk at turn start (`AGENTS.md`, `SOUL.md`, etc.)
2. **Memory search results** — dynamically retrieved snippets from `MEMORY.md` and the session archive via semantic search (covered in Chapter 7)

`MEMORY.md` occupies its own position (`order: 70`) in the bootstrap sort. When the memory search backend is active, retrieved citations are injected *after* the static bootstrap section, in a dedicated `## Memory Search Results` block.

## BOOTSTRAP.md and Self-Deletion

`BOOTSTRAP.md` occupies position 60. The convention (enforced by `AGENTS.md` itself, not code) is that this file is deleted by the agent after its first successful turn. The system has no automatic deletion logic — it relies on the agent following the instructions in `AGENTS.md`. This is a deliberate design: the bootstrap file is a one-time seed, not a recurring injection.

## Agent-Specific Workspaces

In multi-agent deployments each agent can have its own workspace directory. `resolveAgentWorkspaceDir` reads `agents.list[n].workspace` from the config. If unset it falls back to the default workspace. When a subagent is spawned its workspace is either inherited from the parent or overridden via `spawn.workspace`.

The `workspace-templates/` directory (resolved by `resolveWorkspaceTemplateDir`) provides starter files for new workspaces. On first run these templates are copied to the workspace directory if the targets don't exist.

## IDENTITY.md vs. SOUL.md

These two files serve distinct roles:

- **IDENTITY.md** — factual identity metadata: name, species, emoji, avatar. Sorted at position 30.
- **SOUL.md** — behavioural guidance: persona, tone, values, decision-making heuristics. Sorted at position 20, so it is read *before* the identity facts.

The ordering is intentional: the model reads the soul/personality layer before the identity facts, which produces more stable persona expression.

## The Context Engine

Beneath the workspace layer sits the pluggable `ContextEngine` interface (`src/context-engine/types.ts`). The default implementation is the "legacy" engine, registered by `registerLegacyContextEngine` during `ensureContextEnginesInitialized()`. The context engine owns:

- `assemble` — builds the final `AgentMessage[]` array sent to the LLM
- `ingest` — stores new messages into the session
- `compact` — summarises old history to free tokens
- `bootstrap` — initialises the engine for a new session

The legacy engine reads directly from the session `.jsonl` file. Alternative engines can be registered by plugins via `api.registerContextEngine()`.

## Key Takeaways

- File load order is deterministic: AGENTS → SOUL → IDENTITY → USER → TOOLS → BOOTSTRAP → MEMORY
- Files are read with boundary checks that prevent path traversal
- A bootstrap completion marker distinguishes first-turn from continuation context assembly
- HEARTBEAT.md is never cached — it is always re-read to pick up fresh instructions
- The pluggable ContextEngine interface separates *what* gets loaded from *how* it is assembled
