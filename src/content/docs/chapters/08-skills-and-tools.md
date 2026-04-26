---
title: Skills & Tools
description: Built-in tool registration, the AgentSkills spec, SKILL.md discovery, and tool allow/deny lists.
---

# Skills & Tools

The tool system has two distinct layers: *built-in tools* shipped with OpenClaw, and *AgentSkills* — discoverable packages that inject SKILL.md instructions at runtime. Understanding both layers — and how they interact with allow/deny policies — is essential for customising what an agent can do.

## Built-In Tools: Registration

All built-in OpenClaw tools are assembled in `createOpenClawTools` (`src/agents/openclaw-tools.ts`). The function constructs tool instances from individual factories and returns them as an array of `AnyAgentTool` objects. Built-in tools include:

| Tool Name | Factory | Purpose |
|---|---|---|
| `exec` | `createExecTool` | Shell command execution |
| `process` | `createProcessTool` | Process management (poll, send-keys, etc.) |
| `read`, `write`, `edit` | Pi SDK tools | File system access |
| `sessions_spawn` | `createSessionsSpawnTool` | Launch subagents |
| `sessions_yield` | `createSessionsYieldTool` | Yield results to parent |
| `message` | `createMessageTool` | Send messages to channels |
| `memory_search` | (inline) | Query memory index |
| `cron` | `createCronTool` | Manage scheduled jobs |
| `web_fetch` | `createWebFetchTool` | HTTP fetch |
| `web_search` | `createWebSearchTool` | Web search |
| `image` | `createImageTool` | Image analysis |
| `nodes` | `createNodesTool` | Remote node control |

The `createOpenClawTools` function is rich in options — it accepts over 30 parameters to configure sandboxing, channel context, threading mode, ownership checks, and plugin tool extensions.

## Tool Groups and Normalisation

Tools are referenced in allow/deny lists by name or group. `TOOL_GROUPS` in `src/agents/tool-policy-shared.ts` maps group names to arrays of tool names:

```ts
export const TOOL_GROUPS: Record<string, string[]> = { ...CORE_TOOL_GROUPS };
```

`CORE_TOOL_GROUPS` is defined in `tool-catalog.ts`. Groups like `"fs"` expand to `["read", "write", "edit", "glob"]`, and `"exec_capable"` covers the execution tools.

`normalizeToolName` applies canonical aliases:
```ts
const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};
```

This means `bash` and `exec` are interchangeable in allow/deny configs — they refer to the same tool.

## Tool Allow/Deny Policy

The policy pipeline in `src/agents/tool-policy-pipeline.ts` resolves the effective tool set for a run by combining multiple policy layers in precedence order:

1. **Profile defaults** — `tools.profile` (e.g., `"default"`, `"minimal"`, `"coding"`) resolved by `resolveToolProfilePolicy`
2. **Agent config** — `agents[n].tools.allow` / `agents[n].tools.deny`
3. **Run-level override** — `tools.allow` / `tools.deny` in the inbound run request

The final effective set is computed as: `(profile_defaults ∩ agent_allow) - agent_deny - run_deny`.

`expandToolGroups` is called on every list before evaluation, so group names in allow/deny lists are expanded to their constituent tool names before matching.

### Owner-Only Tools

Some tools are marked `ownerOnly: true`. These are only available to the sender identified as the session owner (the human who set up the agent). In multi-user scenarios, guest users cannot call `cron`, `gateway`, or `nodes` tools even if the allow list includes them. `applyOwnerOnlyToolPolicy` wraps the tool's `execute` with a guard that throws if the sender is not an owner:

```ts
// src/agents/tool-policy.ts
function wrapOwnerOnlyToolExecution(tool, senderIsOwner): AnyAgentTool {
  if (tool.ownerOnly !== true || senderIsOwner || !tool.execute) return tool;
  return {
    ...tool,
    execute: async () => { throw new Error("Tool restricted to owner senders."); }
  };
}
```

## Plugin Tools

Plugins can contribute additional tools via `api.registerAgentTool()`. These are collected by `resolveOpenClawPluginToolsForOptions` and merged with the core tool list. Plugin tools participate in the same allow/deny pipeline as built-in tools.

The `pluginToolAllowlist` option in `createOpenClawTools` restricts which plugin tools are included for a given run. This is used by the gateway to enforce per-session plugin tool visibility without affecting other sessions.

## AgentSkills: The SKILL.md Spec

AgentSkills are the second layer. A skill is a directory (typically published as an npm package) that contains a `SKILL.md` file at the top level. The skill directory may also contain:

- `references/` — supplementary documents the skill may reference
- `scripts/` — helper scripts used by the skill's instructions
- Any other files the skill needs

Skills are discovered from three locations:
1. **Bundled skills** — shipped inside OpenClaw, resolved by `resolveBundledSkillsDir`
2. **Workspace skills** — `~/.openclaw/skills/<name>/SKILL.md`  
3. **Plugin skills** — contributed by plugins via `resolvePluginSkillDirs`

## SKILL.md Discovery and Loading

`loadWorkspaceSkillEntries` (in `src/agents/skills/workspace.ts`) scans each skill directory, reads `SKILL.md`, and parses its front-matter via `resolveOpenClawMetadata`. The front-matter specifies:

```yaml
---
name: github
description: GitHub operations via `gh` CLI
version: 1.0.0
---
```

The skill description appears in the `## Skills` section of the system prompt, enabling the agent to know *which skills exist* without loading all their full content. This keeps the base system prompt compact.

When the agent calls `read` on a `SKILL.md` path, the full instructions are loaded on demand. The agent is instructed (by the system prompt skills section) to read the skill file before executing skill-specific tasks.

## Skill Path Compaction

`compactSkillPaths` in `skills/workspace.ts` replaces the user's home directory prefix in skill file paths with `~`:

```ts
"/Users/alice/.nvm/versions/node/v22.22.2/lib/.../skills/github/SKILL.md"
// → "~/.nvm/.../skills/github/SKILL.md"
```

This saves approximately 5–6 tokens per skill path. With 10+ skills active, that's 50–60 tokens saved before any content is read — a meaningful reduction given prompt-cache boundary constraints.

## Skill Filtering and Eligibility

`resolveEffectiveAgentSkillFilter` applies the agent's configured skill filter. Skills can be enabled/disabled globally or per-agent via the `skills` config key. The `SkillEligibilityContext` carries the agent ID, channel, and session key, so skills can declare themselves conditionally available.

`filterWorkspaceSkillEntries` combines the agent-level filter with the bundled allowlist. Bundled skills (shipped with OpenClaw) are subject to the `isBundledSkillAllowed` check — operators can restrict which bundled skills appear for their deployment.

## Skill Invocation Policy

The `resolveSkillInvocationPolicy` function (in `skills/frontmatter.ts`) reads the `invocation` field from a skill's front-matter. The policy can be:

- `"on-demand"` — the agent reads the skill when needed (default)
- `"always"` — the full skill content is injected into every turn's context

The `"always"` mode is useful for skills with short, critical instructions (like a company's communication guidelines) that must be present on every turn rather than discovered lazily.

## The Exec Tool in Depth

The `exec` tool (`createExecTool` in `bash-tools.exec.ts`) is the most complex tool in the system. It layers:

1. **Target resolution** — `resolveExecTarget` determines `sandbox`, `gateway`, or `node`
2. **Path prepend** — `applyPathPrepend` adds tool-specific directories to `$PATH`
3. **Env sanitisation** — `sanitizeHostExecEnvWithDiagnostics` strips dangerous env vars
4. **Allowlist check** — `loadExecApprovals` evaluates per-pattern allow/deny rules
5. **Approval flow** — if `ask` is not `"off"`, suspends for human approval
6. **Process execution** — `runExecProcess` with timeout and output limits

The sandbox variant (`ExecHost = "sandbox"`) routes through the sandbox bridge, which enforces additional filesystem restrictions.

## Key Takeaways

- Built-in tools are registered once per run via `createOpenClawTools` with context-specific options
- Tool names are normalised — `bash` and `exec` are the same tool
- The allow/deny policy pipeline combines profile defaults, agent config, and run-level overrides
- Owner-only tools (`cron`, `gateway`, `nodes`) are gated by sender ownership, not just the allow list
- Skills inject only their descriptions into the system prompt; full content is read on-demand
- Skill path compaction saves ~50 tokens per turn across a typical skill set
- The exec tool has a six-layer evaluation stack before a command runs
