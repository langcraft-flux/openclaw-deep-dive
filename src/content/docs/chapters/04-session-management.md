---
title: Session Management
description: Session key construction, storage, isolated vs shared sessions, and compaction.
---

Sessions are the persistence layer of every agent conversation. OpenClaw encodes a wealth of routing information directly into the session key, which means the key alone tells you which agent owns the session, which channel it arrived from, and what kind of conversation it represents.

## Session Key Anatomy

Session keys follow a structured format. `parseAgentSessionKey` (in `src/sessions/session-key-utils.ts`) parses any key of the form:

```
agent:<agentId>:<rest>
```

Where `<rest>` encodes the conversation scope. The `<rest>` segment has several recognised patterns:

| Pattern | Meaning |
|---|---|
| `main` | The agent's primary session |
| `discord:direct:<userId>` | DM session on Discord for that user |
| `discord:channel:<guildId>:<channelId>` | Server channel session |
| `cron:<jobId>:run:<runId>` | An isolated cron run |
| `subagent:<parentKey>:subagent:<childId>` | Nested subagent |
| `acp:<...>` | ACP (agent communication protocol) session |

The helper functions `isCronSessionKey`, `isSubagentSessionKey`, and `isAcpSessionKey` all operate on these patterns with regex matching against the `<rest>` segment.

### Building a Session Key

`buildAgentSessionKey` in `src/routing/session-key.ts` assembles the key from routing parameters:

```ts
buildAgentSessionKey({
  agentId: "main",
  channel: "discord",
  accountId: "myaccount",
  peer: { kind: "direct", id: "123456" },
  dmScope: "main",  // or "per-peer", "per-channel-peer", "per-account-channel-peer"
})
// → "agent:main:discord:direct:123456"
```

The `dmScope` setting in `session.dmScope` controls whether DM conversations collapse to a single shared session (`main`) or fan out per peer, per channel, or per account+channel combination. The default `main` gives every DM user the same session, which is usually the right choice for personal assistants.

## Where Sessions are Stored

Each session maps to a `.jsonl` file on disk. The file path is resolved by `resolveStorePath` in `src/config/sessions.ts`:

```
<stateDir>/sessions/<agentId>/<sessionKey>.jsonl
```

The state directory defaults to `~/.openclaw/state/` but can be overridden by `OPENCLAW_STATE_DIR`. Each line in the file is a JSON record representing one event in the conversation history:

- `{ type: "message", message: { role: "user"|"assistant", ... } }` — dialogue turns
- `{ type: "tool_use", ... }` — tool call records
- `{ type: "tool_result", ... }` — tool results
- `{ type: "compaction", summary: "..." }` — compaction checkpoints
- `{ type: "custom", customType: "openclaw:bootstrap-context:full" }` — bootstrap completion marker

## The Session Store

The session store is an in-memory index loaded by `loadSessionStore`. It maps session keys to `SessionEntry` metadata objects:

```ts
type SessionEntry = {
  sessionId: string;   // UUID assigned at first run
  sessionKey: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  // ... model, token counts, etc.
}
```

The store file lives at `<stateDir>/sessions/store.json`. The gateway loads the store on startup and keeps it warm. Changes (new sessions, model overrides, token count updates) are written back via `writeConfigFile` which uses a mutex-protected queued writer to prevent concurrent write corruption.

### Session ID vs. Session Key

The distinction matters. A **session key** is a deterministic routing identifier derived from agent + channel + peer. A **session ID** is a UUID generated when the session is first created. The session ID is stable across session key migrations (e.g., if you rename an account). The gateway resolves session keys → session IDs via `resolvePreferredSessionKeyForSessionIdMatches`.

## Isolated vs. Shared Sessions

### Shared (Main) Sessions

The main session (`agent:main:main`) is shared across all surfaces that don't have a more specific route. When a CLI user and a Discord user both talk to the same default agent without channel-specific bindings, they share session history.

### Isolated Sessions

Several session types always get their own isolated key:

- **Cron runs** — `agent:<id>:cron:<jobId>:run:<runUuid>` — each scheduled run gets a fresh session. After the run completes, the session is cleaned up by the session reaper (`session-reaper.ts`).
- **Subagents** — `agent:<id>:subagent:<parentKey>:subagent:<childKey>` — the full parent path is embedded in the child key, which is how `getSubagentDepth` counts nesting levels.
- **Hook sessions** — hooks that trigger agent turns spawn their own per-invocation sessions.

### Per-Peer DM Isolation

When `session.dmScope` is set to `per-peer`, each Discord/Telegram/WhatsApp user gets their own session. The key becomes `agent:main:discord:direct:<userId>`. This is the recommended mode for multi-user bots where conversation history must not bleed between users.

## Session Compaction

When the accumulated session history grows too large to fit in the model's context window, compaction kicks in. The compaction process (covered functionally in Chapter 3) produces a `compaction` record in the `.jsonl` file. On the next turn, the ContextEngine's `assemble` method reads back to the most recent compaction record and uses the embedded summary as the history baseline, discarding the older entries.

`session-compaction-checkpoints.ts` in the gateway tracks the last compaction position so that incremental re-reads are efficient on large session files.

### Session Repair

`session-transcript-repair.ts` handles corrupted sessions — incomplete tool-use/result pairs left by crashed processes. It walks the jsonl records and either re-pairs orphaned tool calls with synthetic error results or strips them. This runs at turn start before the ContextEngine assembles context.

## Session Migration

`server-startup-session-migration.ts` runs at gateway startup to migrate legacy session file formats (pre-dating the `agent:` key prefix) to the current schema. Once migrated, an entry is added to the store under both the old and new keys with the new key as canonical.

## Write Locking

The session file is protected by a cooperative write lock (`session-write-lock.ts`). Multiple concurrent agent runs targeting the same session key must acquire the lock before appending to the `.jsonl` file. The lock timeout is bounded — if a lock cannot be acquired within the deadline, the run fails with a `SessionWriteLockError` rather than silently corrupting the file.

## Session Archive and Export

Long-lived sessions can be archived to compressed files via `session-archive.fs.ts`. The gateway exposes `sessions-history-http.ts` which serves paginated session history over HTTP for the control UI. Each archived session is content-addressed so duplicate-free storage is straightforward.

## Key Takeaways

- Session keys are deterministic and encode agent, channel, peer, and scope — they're not opaque IDs
- The jsonl append-only format makes crash recovery straightforward: just re-read from the last checkpoint
- Compaction records embed the summary text so the file is self-describing
- The session ID (UUID) is stable even when session keys are migrated
- Write locks prevent concurrent corruption; repair routines fix crashes after the fact
- DM isolation (`dmScope`) is configurable and defaults to shared main sessions
