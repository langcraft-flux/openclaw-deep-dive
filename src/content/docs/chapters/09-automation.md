---
title: Automation
description: Cron job internals, hooks, standing orders, TaskFlow, and how scheduled agent turns work.
---

# Automation

OpenClaw's automation layer spans three distinct systems: *cron jobs* (time-based scheduling), *hooks* (event-driven triggers), and *TaskFlow* (durable multi-step work). Each builds on the same underlying agent turn machinery but with different lifecycle ownership.

## The Cron Service

`CronService` in `src/cron/service.ts` is the top-level scheduling engine. It implements `CronServiceContract` and delegates all work to `service/ops.ts`. The service is started by `buildGatewayCronService` during `startGatewayPostAttachRuntime`.

### Job Storage

Cron jobs are persisted in a JSON store at `<stateDir>/cron/jobs.json`. The store is loaded lazily by `ensureLoaded` and written back by `persist` after every mutation. A mutex-like `locked` wrapper prevents concurrent writes:

```ts
// src/cron/service/locked.ts
export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T>
```

Each `CronJob` record carries:
- `id` — UUID
- `schedule` — cron expression (`"0 9 * * *"`) or heartbeat marker
- `agentId` — which agent runs this job
- `text` — the prompt injected into the agent turn
- `channel` / `to` — optional delivery target for the result
- `enabled` — soft-disable flag
- `nextRunAtMs` / `lastRunAtMs` — scheduling state

### The Timer Loop

`armTimer` in `service/timer.ts` sets a `setTimeout` for the next due job. The maximum timer delay is capped at `MAX_TIMER_DELAY_MS = 60_000 ms`. This cap means the timer re-evaluates at least every minute, which is important because `setTimeout` delays can drift under system load.

The minimum refire gap (`MIN_REFIRE_GAP_MS = 2_000 ms`) prevents spin-loops when a job's `computeJobNextRunAtMs` returns a time within the current second. This guards against infinite re-trigger cycles discovered in practice.

### Startup Catchup

When the gateway restarts, jobs that were due during the downtime are caught up. `runMissedJobs` processes at most `DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5` missed jobs, staggered by `DEFAULT_MISSED_JOB_STAGGER_MS = 5_000 ms` to avoid a thundering-herd on startup. Jobs that were actively running when the gateway stopped are marked with `STARTUP_INTERRUPTED_ERROR` in their run log.

### Isolated Agent Turns

Each cron run triggers an *isolated* agent turn via `runCronIsolatedAgentTurn` (in `src/cron/isolated-agent/run.ts`). This function:

1. **Resolves the session key** — `resolveCronAgentSessionKey` creates a key like `agent:<agentId>:cron:<jobId>:run:<runUuid>`
2. **Loads agent context** — workspace files, skills, model config for the target agent
3. **Builds the prompt** — combines the job's `text` with the cron delivery plan
4. **Runs the embedded agent** — via `runEmbeddedPiAgent` just like any interactive turn
5. **Delivers the result** — sends the reply to the configured channel/peer if set
6. **Sweeps the session** — `sweepCronRunSessions` archives or deletes the ephemeral session after the run

The run is tracked in the task registry (`createRunningTaskRun` / `completeTaskRunByRunId`) so the task status tool can report its progress.

### Delivery Plans

`resolveCronDeliveryPlan` determines where the cron output goes. It supports:
- Delivery to a specific channel + peer (`channel: discord`, `to: "@username"`)
- Broadcast to the main session (for heartbeat-style jobs)
- Suppressed delivery (the run happens but output is only logged)

The `isHeartbeatOnlyResponse` helper detects `HEARTBEAT_OK` replies and suppresses delivery to avoid noisy acknowledgement messages in chat.

### Failure Handling

Cron jobs have configurable retry policies (`config.cron.retryOn`). Failed runs increment a failure counter. After `DEFAULT_FAILURE_ALERT_AFTER = 2` consecutive failures, an alert is sent to the delivery target. The alert has a `DEFAULT_FAILURE_ALERT_COOLDOWN_MS = 1 hour` cooldown to prevent spam.

## Hooks

Hooks are event-driven triggers that fire agent turns in response to external signals. The hooks system lives in `src/hooks/` and uses an internal event bus (`src/hooks/internal-hooks.js`).

The `registerHook` / `triggerHook` API is used by built-in hooks (Gmail watcher, gateway startup hooks) and by plugins. Hook events carry a `type` and optional `payload`. The agent turn triggered by a hook is routed through the same cron isolated-agent machinery, inheriting all the scheduling infrastructure.

### Gateway Hooks

Hooks mapped via `config.hooks` can fire on:
- `gateway.startup` — runs once when the gateway becomes ready
- `gateway.shutdown` — runs before graceful shutdown
- Custom hook types contributed by plugins

`hasConfiguredInternalHooks` (in `src/hooks/configured.ts`) is checked at startup to avoid initialising the hook infrastructure when no hooks are configured.

### Gmail Watcher

`src/hooks/gmail-watcher.ts` is a built-in hook that polls a configured Gmail account and triggers an agent turn when new email arrives. It manages OAuth credential refresh, watch lifecycle, and error backoff independently. The watcher is registered as a channel-level plugin, so it participates in the channel health monitoring system.

## Standing Orders

Standing orders are long-lived cron jobs with special semantics. The main-agent heartbeat is the canonical example: it fires on a recurring schedule with a short prompt (`HEARTBEAT.md` content) to give the agent a chance to do proactive work.

The heartbeat job is identified by its schedule marker rather than a UUID. `heartbeat-policy.ts` in the cron service determines when heartbeat jobs should fire vs. be suppressed (e.g., during active conversations when the human is present).

## TaskFlow

TaskFlow (`src/tasks/`) is the durable task substrate for multi-step work that spans multiple agent turns or multiple subagents. It sits above the cron and subagent systems and provides:

- **Task identity** — stable UUIDs that survive gateway restarts
- **Status tracking** — `pending`, `running`, `completed`, `failed`, `lost`
- **Child linkage** — parent tasks can track child task IDs
- **Waiting state** — tasks can suspend and resume when an awaited event arrives

`task-registry.maintenance.ts` runs a sweep loop every `TASK_SWEEP_INTERVAL_MS = 60 s` to detect and mark lost tasks (running tasks whose agent context is gone), reconcile cron run state, and clean up entries older than `TASK_RETENTION_MS = 7 days`.

### TaskFlow vs. Cron

TaskFlow is not a replacement for cron. Cron owns *scheduling* (when to fire). TaskFlow owns *identity and state* (what was fired, is it done, did it succeed). A cron run registers a TaskFlow task via `createRunningTaskRun` on start and calls `completeTaskRunByRunId` or `failTaskRunByRunId` on completion. This is how the `session_status` tool can report the live status of any ongoing cron or subagent run.

### The session_status Tool

`createSessionStatusTool` provides the agent with a window into TaskFlow state. The agent can call `session_status` with a session key or task ID to get:
- Whether the target session is running, idle, or compacting
- The current model and token usage
- Any active subagent runs and their status

This tool is what makes multi-agent coordination possible: a coordinator agent can poll the status of its subagents and decide when to proceed.

## Key Takeaways

- The cron timer is capped at 60 s to prevent drift; a 2 s refire guard prevents spin-loops
- Startup catchup replays at most 5 missed jobs, staggered by 5 s each
- Each cron run gets an isolated session key; sessions are swept after completion
- The delivery plan system lets cron runs send results to any channel/peer, or suppress output
- Hooks fire on gateway lifecycle events and can be extended by plugins
- TaskFlow provides durable task identity that persists across restarts and spans multiple subagents
- The `session_status` tool reads TaskFlow state, enabling coordinator agents to observe child progress
