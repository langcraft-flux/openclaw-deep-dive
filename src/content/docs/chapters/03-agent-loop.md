---
title: The Agent Loop
description: Full turn lifecycle — context assembly, LLM call, tool execution, and reply delivery.
---

# The Agent Loop

A single user message triggers a multi-step pipeline inside the agent. This chapter traces that pipeline from message receipt to final reply, with particular attention to context assembly, the tool-execution loop, and how thinking levels influence the underlying API call.

## The Embedded Runner

The core execution engine is `runEmbeddedPiAgent` in `src/agents/pi-embedded-runner/run.ts`. It wraps the `@mariozechner/pi-agent-core` SDK and adds all OpenClaw-specific logic: workspace loading, tool registration, compaction, sandbox enforcement, and delivery routing.

The gateway `chat.send` handler resolves an agent route and then calls `runEmbeddedPiAgent` with the assembled parameters. The runner returns an `EmbeddedPiRunResult` that the gateway uses to persist the turn and broadcast events.

## Phase 1 — Context Assembly

Before the API call, the runner assembles the full system prompt and message history. The key steps are:

### System Prompt Construction

`buildSystemPrompt` (in `src/agents/system-prompt.ts`) stitches together:

1. **Identity line** — the agent's name and channel context
2. **Project Context** — bootstrap files in sorted order (see Chapter 2)
3. **Dynamic Context** — HEARTBEAT.md re-read on every heartbeat turn
4. **Tooling section** — descriptions of available tools and their usage conventions
5. **Runtime section** — current date/time, model info, session key, channel
6. **Memory search results** — citations retrieved from the memory backend (Chapter 7)
7. **Skills section** — injected SKILL.md content for any active skills (Chapter 8)

A cache boundary marker (`SYSTEM_PROMPT_CACHE_BOUNDARY`) is inserted at a stable position so prompt-caching APIs (Anthropic's `cache_control`, OpenAI's `cached_tokens`) get maximum hit rates.

### Message History

The ContextEngine's `assemble` method is called with the full session message list and a `tokenBudget`. The budget is derived from the model's context window size minus reserved tokens for the system prompt and expected output. The legacy engine performs a simple tail-slice — keeping the most recent turns that fit. Advanced engines (registered via plugins) can do retrieval-augmented selection or sliding-window compaction.

## Phase 2 — The LLM Call

With context assembled, `runEmbeddedPiAgent` invokes the provider transport. OpenClaw supports:

- **Anthropic Messages API** — via `anthropic-transport-stream.ts`  
- **OpenAI Chat Completions** — via `openai-transport-stream.ts`
- **OpenAI Responses API** — via `openresponses-http.ts`
- **CLI backends** — delegating to Claude Code CLI, Gemini CLI, etc., via `cli-runner.ts`

The transport layer handles streaming, token counting, and normalising provider-specific event shapes into a common `AgentMessage` format consumed by the rest of the pipeline.

### Thinking Levels

The `ThinkLevel` type (from `src/auto-reply/thinking.ts`) maps to provider-specific parameters:

| Level | Anthropic | OpenAI |
|---|---|---|
| `auto` | default budget | default |
| `low` | `thinking.budget_tokens: 1024` | `reasoning_effort: low` |
| `medium` | `thinking.budget_tokens: 8192` | `reasoning_effort: medium` |
| `high` | `thinking.budget_tokens: 32768` | `reasoning_effort: high` |
| `x-high` | max extended thinking | `reasoning_effort: high` + hints |

The `normalizeThinkLevel` function resolves the active level from config, per-session overrides, and runtime commands like `/thinking`. The level is passed to the transport as part of `ExtraParams` assembled by `resolveExtraParams`.

For CLI backends, thinking is mapped to the `--verbose` / `--thinking` flags of the underlying CLI.

## Phase 3 — Tool Execution Loop

When the model responds with tool calls, the runner enters a synchronous tool-execution loop. Each tool call goes through the pipeline in `src/agents/pi-tools.ts`:

```
tool call received
  → beforeToolCall hook
  → tool policy check (allow/deny list)
  → ownership check (ownerOnly tools)
  → tool.execute()
  → afterToolCall hook
  → result appended to message history
  → next LLM call with updated context
```

The loop continues until the model produces a response with no tool calls, hits the maximum tool-call depth, or the run is aborted.

### Tool Result Persistence

Every tool call and its result is written to the session `.jsonl` file by `session-tool-result-guard.ts` before `execute()` runs. This ensures that if the process crashes mid-tool, the partial tool call is not replayed on restart.

### The Exec Approval Flow

When the `exec` tool fires with `ask: "on-miss"` or `ask: "always"`, the runner calls `ExecApprovalManager.create()` and suspends the tool loop. An approval request is broadcast to connected clients. The run resumes only after `awaitDecision()` resolves — either from a `/approve` command or a timeout. The approval record is keyed by a UUID and the requesting connection ID, preventing replay from other clients.

## Phase 4 — Compaction

After a successful turn, the ContextEngine's `afterTurn` method is called. If the accumulated token count exceeds the compaction threshold, `compact()` is triggered. The legacy compaction (`src/agents/compaction.ts`) calls `piGenerateSummary` from the SDK to produce a summary of prior history, which replaces the compacted messages in the session file. The new summary is prefixed with a `compaction` record type so `hasCompletedBootstrapTurn` doesn't mistake it for a fresh bootstrap.

Compaction has a retry policy (`retryAsync`) and a safety timeout. If compaction fails repeatedly, the runner logs a warning and continues — it prefers a slightly-over-budget context over a crashed turn.

## Phase 5 — Reply Delivery

The `subscribeEmbeddedPiSession` subscriber (in `pi-embedded-subscribe.ts`) intercepts the streaming response and delivers chunks via the gateway's broadcast mechanism:

- **Text deltas** — streamed as `chat.delta` events with `dropIfSlow: true`
- **Tool call summaries** — broadcast as `chat.tool` events
- **Final reply** — the assembled text is persisted to the session and broadcast as `chat.message`

Heartbeat replies are filtered by `shouldHideHeartbeatChatOutput` — if the reply is purely a `HEARTBEAT_OK` acknowledgement it is suppressed from the chat surface but still persisted.

## Subagent Turns

When the model calls the `sessions_spawn` tool, a subagent turn begins. The subagent runs in its own session (with a `subagent:` key suffix), with its own context assembly. Results are delivered back to the parent via `subagent-announce-delivery.ts` — the parent's session receives the subagent's final reply as a synthetic `user` message.

Subagent depth is tracked by counting `:subagent:` segments in the session key (`getSubagentDepth`). The default depth limit prevents runaway recursive spawning.

## Key Takeaways

- The agent loop is: context assembly → LLM call → tool loop → compaction → delivery
- System prompt construction assembles eight distinct sections in a deterministic order with a cache boundary for prompt-cache efficiency
- Thinking levels map directly to provider-specific API parameters
- Tool calls are persisted before execution to survive crashes
- The exec approval flow blocks the tool loop and waits for a human (or a pre-approved allowlist rule) to decide
- Compaction replaces old history with a summary, tracked by a special record type in the session file
