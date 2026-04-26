---
title: Multi-Agent Routing
description: Binding evaluation, agent isolation, workspace-per-agent, and how the gateway picks which agent handles a message.
---

# Multi-Agent Routing

One of OpenClaw's less-obvious capabilities is hosting multiple agents simultaneously — each with their own workspace, session history, system prompt, and tool configuration — all served from a single gateway process. This chapter explains how a message from any channel gets matched to the right agent.

## The Binding System

Bindings live in `config.bindings` as an array of `AgentRouteBinding` objects. Each binding declares a `match` (which messages it applies to) and an `agentId` (which agent should handle them):

```yaml
bindings:
  - match:
      channel: discord
      accountId: mybot
      peer:
        kind: direct
        id: "123456789"
    agentId: support
  - match:
      channel: discord
    agentId: main
```

The key files are `src/routing/bindings.ts` (listing) and `src/routing/resolve-route.ts` (evaluation).

## Binding Evaluation: The Tier System

`resolveAgentRoute` (in `src/routing/resolve-route.ts`) evaluates bindings in a strict tier order. Each tier is tried in sequence; the first match wins:

| Tier | Condition | `matchedBy` |
|---|---|---|
| 1 | Exact peer match | `binding.peer` |
| 2 | Parent peer match (for threads) | `binding.peer.parent` |
| 3 | Wildcard peer kind (`direct:*`) | `binding.peer.wildcard` |
| 4 | Guild + member roles | `binding.guild+roles` |
| 5 | Guild (no roles) | `binding.guild` |
| 6 | Slack/Teams team | `binding.team` |
| 7 | Account pattern | `binding.account` |
| 8 | Channel-wide wildcard | `binding.channel` |
| 9 | (no match) | `default` |

The `matchedBy` field on the returned `ResolvedAgentRoute` is invaluable for debugging. Enable `OPENCLAW_VERBOSE=1` to see `[routing]` debug log lines that print every binding candidate and the eventual match reason.

## Performance: Indexed Evaluation

Naively scanning every binding for every message would become slow with large configs. The resolver caches a two-level index per config object:

1. **`byChannel`** — bindings grouped by channel ID
2. **Within each channel**, a sub-index by account, then by peer, wildcard, guild, team, and channel

The index is keyed against `cfg.bindings` using a `WeakMap`. If the config object reference is stable (which it is between config reloads), all subsequent route resolutions hit the cache rather than rebuilding indexes.

A second `resolvedRouteCacheByCfg` WeakMap stores completed `ResolvedAgentRoute` objects keyed by a tuple of `channel + accountId + peer + guildId + teamId + memberRoleIds + dmScope`. With a warm cache, `resolveAgentRoute` degenerates to a single map lookup. The cache is bounded at `MAX_RESOLVED_ROUTE_CACHE_KEYS = 4000` entries.

## Session Key Construction

Once a binding match is found, `buildAgentSessionKey` constructs the canonical session key. The key encodes:

- `agentId` — from the winning binding
- `channel` — normalised to lowercase
- `accountId` — the account the message arrived on
- `peer` — the sender (kind + id)
- `dmScope` — the DM isolation level from `session.dmScope`

```ts
// Example result
"agent:support:discord:direct:123456789"
```

The `mainSessionKey` is separately computed as `agent:<agentId>:main` — the agent's top-level session, used as a fallback anchor for features that operate at the agent level rather than the conversation level.

## Thread Inheritance

Discord threads (and equivalent concepts in Slack, Teams) create a challenge: a thread message has both a `peer` (the thread) and a `parentPeer` (the parent channel). The tier system handles this via tier 2 (`binding.peer.parent`): if no binding matches the thread ID, the resolver tries the parent channel's binding. This means a binding on a Discord channel automatically applies to all threads in that channel without extra config.

## Agent Isolation

Each agent listed in `config.agents.list` is independently isolated:

- **Workspace** — via `resolveAgentWorkspaceDir`. Default: `~/.openclaw/workspace/`, overrideable per agent.
- **Session store** — keyed by `agentId`. Agent A cannot read Agent B's sessions.
- **Tool config** — each agent can have its own `tools.allow`, `tools.deny`, exec policy, and sandbox config.
- **Memory** — the memory search backend is scoped to `agentId`. Agents don't share memory indexes.
- **System prompt** — each agent loads its own workspace files (SOUL.md, IDENTITY.md, etc.)

The `resolveSessionAgentIds` function resolves the agent ID from a session key, so any part of the system can determine ownership without needing the full routing context.

## Default Agent Fallback

When no binding matches, `resolveDefaultAgentId(cfg)` returns the first agent in `agents.list` (or `"main"` if the list is empty). This is the fallback that handles messages that don't match any explicit rule.

`pickFirstExistingAgentId` additionally validates that the resolved agent ID actually exists in the configured agents list. If a binding references a deleted agent ID, it falls back gracefully to the default rather than crashing.

## Role-Based Routing (Discord)

Discord servers expose member role IDs. Bindings can match on these:

```yaml
- match:
    channel: discord
    guildId: "987654321"
    roles: ["111111", "222222"]
  agentId: staff-bot
```

The gateway receives `memberRoleIds` from the channel plugin and passes them through to `resolveAgentRoute`. The tier 4 matcher (`binding.guild+roles`) requires *all* listed roles to be present in the member's role set (intersection semantics), sorted for deterministic cache keys.

## Account-Based Routing

The `accountId` in a binding's match constrains which account the message must arrive on. This is critical for multi-account setups: you can route messages arriving on `accountId: "customer-success"` to the support agent while routing messages on `accountId: "dev-team"` to the dev agent, even when both accounts are the same Discord server.

The wildcard `accountId: "*"` matches any account, and maps to tier 8 (`binding.channel`).

## Identity Links

The `session.identityLinks` config allows mapping multiple external IDs to a single canonical session. For example, if a user appears as both a Discord user and a Slack user, their conversations can be collapsed into a single session. The `identityLinks` map is incorporated into `buildAgentSessionKey` — when a peer ID appears in the map, the canonical group ID is substituted before key construction.

## Subagent Routing

Subagents don't go through the binding system. Their session key is constructed by appending `:subagent:<childId>` to the parent session key. The agent ID is inherited from the spawn request, not derived from bindings. This means subagents are always children of a specific parent turn, not independently-routed agents.

## Key Takeaways

- Bindings evaluate in a strict 8-tier priority order with the first match winning
- The evaluation is fully cached — warm-path routing is a single WeakMap lookup
- Thread messages fall back to parent-channel bindings automatically
- Each agent is fully isolated: workspace, sessions, tools, memory, and system prompt are all scoped
- Role-based routing (for Discord) uses intersection semantics on member role IDs
- Identity links can collapse multi-platform users into shared sessions
