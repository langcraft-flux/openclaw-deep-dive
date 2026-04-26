---
title: Channel & Account Model
description: Channel plugin registration, multi-account architecture, and inbound/outbound routing.
---

OpenClaw's channel system is the abstraction that lets a single agent speak Discord, WhatsApp, Telegram, Slack, and custom platforms through a unified interface. This chapter dissects the plugin contract, account model, and the path that a message takes from a platform webhook to the agent loop — and back.

## What is a Channel?

A channel is identified by a `ChannelId` string (e.g., `"discord"`, `"whatsapp"`, `"webchat"`). The channel plugin is a structured object that satisfies the `ChannelPlugin` type defined in `src/channels/plugins/types.plugin.ts`:

```ts
type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter<ResolvedAccount>;  // required
  outbound?: ChannelOutboundAdapter;
  auth?: ChannelAuthAdapter;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  lifecycle?: ChannelLifecycleAdapter;
  // ... 15+ optional adapter slots
};
```

Most adapters are optional. A minimal read-only channel (e.g., for receiving webhooks only) only needs `config` and `gateway`. A full-featured channel adds `outbound`, `auth`, `status`, `security`, `groups`, `threading`, and so on.

## Plugin Registration

Channel plugins are registered during gateway startup by `prepareGatewayPluginBootstrap` → `server-startup-plugins.ts`. The `createChannelManager` function in `server-channels.ts` iterates over all registered plugins and calls their `lifecycle.start` adapter for each configured account.

The plugin registry is backed by `src/channels/plugins/registry.ts`. The three entry points are:

```ts
listChannelPlugins()           // all registered plugins
getChannelPlugin(channelId)    // single plugin by id
getLoadedChannelPlugin(id)     // same but throws if not loaded
```

Channels are loaded lazily — a channel plugin is only fully initialised if it has at least one configured account in the config.

## The Account Model

A single channel can run multiple accounts simultaneously. For Discord, this means multiple bot tokens. For WhatsApp, multiple numbers. Each account is identified by an `accountId` string within the channel's namespace.

Accounts are stored in the config under `channels.<channelId>.accounts.<accountId>`. The `ChannelConfigAdapter` is responsible for resolving the raw config object into a typed `ResolvedAccount` — it handles credential references, environment variable substitution, and validation.

`DEFAULT_ACCOUNT_ID` (`"default"`) is the fallback when no explicit account is configured. Most single-account setups use only the default account.

### Account Lifecycle

`server-channels.ts` manages account lifecycle with a `ChannelRuntimeStore`:

```ts
type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;   // per-account abort signals
  starting: Map<string, Promise<void>>;   // in-progress start promises
  tasks: Map<string, Promise<unknown>>;   // running account tasks
  runtimes: Map<string, ChannelAccountSnapshot>;  // live runtime state
};
```

If an account's background task crashes, the store applies an exponential backoff (`CHANNEL_RESTART_POLICY`) before restarting, up to `MAX_RESTART_ATTEMPTS`. The backoff starts at 5 seconds and caps at 5 minutes, with 10% jitter.

### Health Monitoring

The `ChannelStatusAdapter` provides a `probe` method that the gateway calls periodically to verify account health. Results feed into the health snapshot broadcast to all connected clients. A `ChannelHealthMonitor` (in `src/gateway/channel-health-monitor.ts`) tracks consecutive failures and surfaces them in the `/health` endpoint.

## Inbound Routing

When a message arrives on a channel, the channel plugin's `gateway` adapter receives it. The adapter calls the shared inbound handler, which:

1. Extracts the `accountId`, `peer` (sender ID + kind), `guildId`, and `teamId`
2. Calls `resolveAgentRoute` (Chapter 6) to determine which agent and session key should handle this message
3. Dispatches to `chat.send` with the resolved session key

The `peer` object carries both a `kind` (`"direct"`, `"group"`, `"channel"`, `"thread"`) and an `id`. This two-part structure is what enables the binding system's wildcard matching (e.g., "all DMs on this channel").

### Channel Allow-lists

`src/channels/allowlists/` hosts per-channel input filtering. The `ChannelAllowlistAdapter` lets channels declare which sender IDs or patterns are permitted to trigger agent turns. The gateway evaluates these before routing, so allow-list decisions never reach the agent loop.

## Outbound Routing

The `ChannelOutboundAdapter` is how the agent sends replies. It implements:

```ts
type ChannelOutboundAdapter = {
  send: (params: OutboundSendParams) => Promise<OutboundSendResult>;
  // optional: typing, reactions, message edits, thread creation
};
```

When the agent calls the `message` tool, the tool resolves the delivery target (channel + account + peer) via `resolveDeliveryContext`, then calls the outbound adapter's `send` method. For multi-account channels, the routing uses the `accountId` embedded in the session key to select the correct bot credentials.

### Reply Threading

Channels that implement `ChannelThreadingAdapter` can receive thread IDs in the outbound params. The `message` tool's `replyToMode` option (`"off"`, `"first"`, `"all"`, `"batched"`) controls whether replies are threaded, and if so, how.

### Platform-Specific Formatting

The channel system does not enforce a single output format. Each `ChannelOutboundAdapter` is responsible for formatting — converting markdown to platform-native markup, splitting long messages, handling character limits, and uploading attachments.

## Multi-Account Outbound Disambiguation

When multiple accounts of the same channel are active, the outbound system must pick the right one. The `last-route` mechanism tracks which account last received a message from a given peer, and uses that as the default reply target. This avoids the common bug where a multi-account bot replies from account A to a message originally sent through account B.

The `lastRoutePolicy` field in `ResolvedAgentRoute` controls whether the "last route" is tracked at the main session level or the per-session level. For DM scopes that fan out per peer, per-session tracking is used.

## Plugin HTTP Routes

Channel plugins can expose additional HTTP endpoints via `ChannelGatewayAdapter.httpRoutes`. These are registered by `server/plugins-http.ts` and are served under `/api/channels/<channelId>/`. The route handler receives the full gateway request context including auth. This is how Discord slash-command HTTP interactions, Telegram webhooks, and Stripe billing callbacks are handled without separate server processes.

Scopes required to call plugin HTTP routes are enforced by `plugin-route-runtime-scopes.ts` — each route can declare a minimum scope level so that, for example, Telegram webhooks don't require admin credentials.

## Key Takeaways

- Each channel is a typed plugin with a required `config` adapter and up to 15 optional capability adapters
- Multiple accounts of the same channel run independently with their own backoff restart policies
- Inbound routing resolves agent + session key before reaching the agent loop
- Outbound routing uses the session key's embedded `accountId` to select the correct credentials
- The `last-route` mechanism prevents multi-account reply-from-wrong-account bugs
- Channels can serve their own HTTP routes (webhooks, interactions) via the `gateway.httpRoutes` adapter
