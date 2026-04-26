---
title: Gateway Architecture
description: The WebSocket broker, session routing, and agent dispatch pipeline.
---

The OpenClaw gateway is the nerve centre of every deployment. Understanding its startup sequence, broker architecture, and message-dispatch pipeline is the foundation for everything else in this course.

## Entry Point: Lazy-Loaded Server

The public gateway entry lives in `src/gateway/server.ts`. Notice that `startGatewayServer` is not imported at module load time — it delegates through a dynamic `import()` to `server.impl.ts`:

```ts
// src/gateway/server.ts
async function loadServerImpl() {
  return await import("./server.impl.js");
}

export async function startGatewayServer(...args) {
  const mod = await loadServerImpl();
  return await mod.startGatewayServer(...args);
}
```

This lazy-load pattern keeps the TLS and HTTP stacks out of the initial require graph, which measurably speeds up CLI startup when the gateway is not needed.

## The Startup Sequence

`server.impl.ts` orchestrates a carefully ordered startup trace. The code instruments every phase with `createGatewayStartupTrace()` so the optional `OPENCLAW_GATEWAY_STARTUP_TRACE=1` environment variable can emit millisecond-level timing:

1. **Config load** — `loadConfig()` and secret resolution via `loadGatewayStartupConfigSnapshot`
2. **TLS** — `loadGatewayTlsRuntime` configures optional certificate pinning
3. **HTTP + WebSocket server** — `server/http-listen.ts` creates the raw Node.js HTTP listener
4. **Early runtime** — `startGatewayEarlyRuntime` wires mDNS/Bonjour discovery, Tailscale exposure, and maintenance timers
5. **Plugin bootstrap** — `prepareGatewayPluginBootstrap` loads registered channel plugins
6. **Auth** — `resolveGatewayAuth` resolves the shared/token auth mode
7. **Post-attach runtime** — `startGatewayPostAttachRuntime` connects the cron service, memory backend, ACP, hooks, and update checks
8. **WebSocket handler** — `attachGatewayWsHandlers` starts accepting WebSocket connections

The separation between "early" and "post-attach" is intentional: the server can begin accepting health-check HTTP requests before every background service is warm.

## WebSocket Connection Lifecycle

Each WebSocket connection enters through `server/ws-connection.ts`, which calls `attachGatewayWsConnectionHandler`. Every connected client is assigned a `GatewayWsClient` object that tracks:

- Authentication state (`connect` — populated after the `connect` handshake message)
- Role and operator scopes
- Buffered-bytes accounting (enforced against `MAX_BUFFERED_BYTES`)

The connection handler enforces two payload size limits:
- `MAX_PAYLOAD_BYTES` — for authenticated clients
- `MAX_PREAUTH_PAYLOAD_BYTES` — a tighter cap before the handshake completes, preventing unauthenticated amplification attacks

Pre-auth connections are also budget-limited by `preauthConnectionBudget` to prevent connection floods from untrusted sources.

## The Protocol Frame

Every client message is a JSON object validated by `validateRequestFrame` (from `src/gateway/protocol/index.ts`). The frame shape is:

```ts
{ id: string; method: string; params?: unknown }
```

The `method` string is the routing key. Before dispatch, `handleGatewayRequest` in `server-methods.ts` runs two authorization checks:

1. **Role check** — `isRoleAuthorizedForMethod(role, method)` — coarse-grained, derived from the client's connect role (`operator`, `viewer`, `node`, etc.)
2. **Scope check** — `authorizeOperatorScopesForMethod(method, scopes)` — fine-grained capability scopes attached to the token

Methods are registered in a flat handler map:

```ts
export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...connectHandlers,
  ...chatHandlers,
  ...sessionsHandlers,
  ...cronHandlers,
  // ... 30+ more namespaces
};
```

The naming convention `<namespace>.<action>` (e.g., `chat.send`, `sessions.list`, `cron.add`) is enforced consistently. Plugin channels can register additional gateway methods via `channel.gatewayMethods`.

## The Chat Dispatch Path

The most critical path is `chat.send`. When a user sends a message the flow is:

```
WebSocket frame
  → handleGatewayRequest          (auth + dispatch)
  → chatHandlers["chat.send"]     (src/gateway/server-methods/chat.ts)
  → resolveAgentRoute             (src/routing/resolve-route.ts)
  → runEmbeddedPiAgent            (src/agents/pi-embedded-runner/run.ts)
  → LLM provider transport
```

`resolveAgentRoute` is discussed in depth in Chapter 6. What matters here is that it returns a `sessionKey` — the canonical identifier for this conversation — before the agent turn starts.

## The Broker: Broadcast and Lanes

The gateway is not a simple request-response server. During an agent turn, real-time events flow from the embedded agent back to all subscribed clients via `server-broadcast.ts`. The broadcast function:

```ts
broadcast(event, payload, opts?: { dropIfSlow?: boolean; stateVersion? })
```

- `dropIfSlow: true` tells the gateway to skip slow clients rather than block the turn (used for streaming text deltas)
- `stateVersion` carries `presence` and `health` monotonic counters so clients can detect missed snapshots

`server-lanes.ts` applies concurrency limits per agent and per model tier. This prevents a single heavy agent turn from starving lighter sessions.

## Health and Readiness

`server/readiness.ts` exposes a readiness signal that HTTP probes (`/health`) consult. The gateway only becomes ready after:
- All configured channel plugins have started (or gracefully errored)
- The cron service is armed
- The memory backend (if qmd mode) has initialised

`server/health-state.ts` maintains dual monotonic counters — `getPresenceVersion()` and `getHealthVersion()` — that clients embed in subscriptions to detect and recover from state gaps without a full reconnect.

## Discovery

`startGatewayDiscovery` in `server-discovery-runtime.ts` publishes the gateway via mDNS (Bonjour) so mobile apps on the same LAN can find it without manual IP configuration. It respects `discovery.mdns.mode` from the config, and can optionally enable wide-area discovery for cloud deployments via `discovery.wideArea`.

## Key Takeaways

- The gateway lazy-loads its heaviest dependencies to keep CLI startup fast
- Every WebSocket frame is role- and scope-checked before reaching a handler
- The broadcast system is non-blocking: slow clients are dropped rather than blocking agent turns
- Readiness and health are tracked with monotonic counters to enable lossless client recovery
- The startup sequence is instrumented and can be traced with an env var for profiling
