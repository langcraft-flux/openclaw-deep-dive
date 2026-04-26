---
title: Security & Permissions
description: Exec policy, the approval flow, sandboxing, auth profiles, token scopes, and the gateway's trust model.
---

OpenClaw's security model is layered: authentication at the gateway boundary, authorisation at the method level, exec policy for shell commands, and sandboxing for process isolation. This chapter walks each layer from the outermost to the innermost.

## Layer 1: Gateway Authentication

Every WebSocket connection must authenticate before receiving any response beyond `health`. `resolveGatewayAuth` (in `src/gateway/auth-resolve.ts`) determines the active auth mode from the config, supporting:

- **Shared secret** (`auth.mode: "shared-secret"`) — a bearer token compared via `safeEqualSecret` (constant-time comparison from `src/security/secret-equal.ts`)
- **Trusted proxy** — for reverse-proxy deployments where the proxy terminates auth
- **Tailscale** — Tailscale identity is resolved via `readTailscaleWhoisIdentity`; the gateway accepts connections from Tailscale peers without a password
- **Device token** — pairing flow for mobile companion apps

Auth failures are rate-limited by `AuthRateLimiter` (`src/gateway/auth-rate-limit.ts`). Failed attempts from the same IP increment a counter. The limiter scope is `AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET`. Rate-limited responses include a `retryAfterMs` field.

Browser connections from the control UI are additionally validated by `checkBrowserOrigin` — the `Origin` header must be in the `allowedOrigins` list to prevent CSRF from malicious websites loading the control UI iframe.

## Layer 2: Role-Based Access

Connected clients carry a **role**:

| Role | Description |
|---|---|
| `operator` | Full access — owner of the gateway |
| `viewer` | Read-only access to sessions and health |
| `node` | Remote node role — limited to node-specific methods |
| `guest` | Highly restricted; channel-specific interactions only |

`isRoleAuthorizedForMethod` (in `src/gateway/role-policy.ts`) enforces coarse-grained role → method access. The node role, for example, is restricted to the set `NODE_ROLE_METHODS` defined in `method-scopes.ts`:

```ts
const NODE_ROLE_METHODS = new Set([
  "node.invoke.result",
  "node.event",
  "node.pending.drain",
  // ...
]);
```

## Layer 3: Operator Scopes

Within the `operator` role, fine-grained capabilities are expressed as **scopes**. The canonical scope set is defined in `src/gateway/operator-scopes.ts`:

| Scope | Capabilities |
|---|---|
| `admin` | Config writes, restart, update |
| `read` | Session history, health, models |
| `write` | Sending messages, cron management |
| `approvals` | Exec approval list/resolve |
| `pairing` | Node and device pairing |
| `talk-secrets` | Voice/TTS configuration secrets |

The CLI default profile uses all scopes (`CLI_DEFAULT_OPERATOR_SCOPES`). Mobile apps and web clients typically receive narrower scope sets. `authorizeOperatorScopesForMethod` in `method-scopes.ts` maps each gateway method to its required minimum scope.

Plugin HTTP routes declare their own scope requirements, evaluated by `plugin-route-runtime-scopes.ts`.

## Layer 4: Exec Policy

Shell command execution is controlled by a three-axis policy evaluated in `src/infra/exec-approvals.ts`:

### Axis 1: `security`

| Value | Meaning |
|---|---|
| `"deny"` | All exec is blocked |
| `"allowlist"` | Only pre-approved commands are allowed |
| `"full"` | Any command can run (with ask-based approval) |

### Axis 2: `ask`

| Value | Meaning |
|---|---|
| `"off"` | No approval prompts — run automatically |
| `"on-miss"` | Prompt only if not on the allowlist |
| `"always"` | Always prompt, regardless of allowlist |

### Axis 3: `host`

| Value | Meaning |
|---|---|
| `"sandbox"` | Run inside a Docker/SSH sandbox |
| `"gateway"` | Run on the gateway host directly |
| `"node"` | Run on a remote paired node |
| `"auto"` | Resolved based on the current context |

These three axes combine to form the effective exec policy. A typical "safe" configuration is `security: allowlist, ask: on-miss, host: sandbox`.

### Allowlist Pattern Matching

The exec allowlist (`src/infra/exec-approvals-allowlist.ts`) stores `ExecAllowlistEntry` records. Each entry specifies an `argv` pattern (exact or glob), optional `cwd` constraint, optional `agentId` filter, and an optional `envHash` for environment-sensitive approvals.

`resolveAllowAlwaysPatternEntries` evaluates whether a proposed command matches any allowlist entry. The matching algorithm checks:
1. Argv segment count matches
2. Each segment matches its pattern (exact string or glob)
3. CWD is within the declared directory (if specified)

### The Approval Flow

When `ask: "on-miss"` or `"always"` is active and the command is not on the allowlist, the exec tool creates an approval record via `ExecApprovalManager`:

```ts
const record = approvalManager.create(request, timeoutMs);
const decision = await approvalManager.register(record, timeoutMs);
```

The record is broadcast to all connected clients with `APPROVALS_SCOPE`. Clients with that scope can call `exec.approval.resolve` to approve or deny. The approval is keyed by UUID and the requesting connection ID — only the connection that created the request (or an admin) can resolve it.

Approval timeouts are configurable per exec call. On timeout, the exec tool receives a `null` decision and returns an error to the model.

## Layer 5: Sandboxing

The sandbox system (`src/agents/sandbox/`) routes exec operations into an isolated environment. The default sandbox backend is Docker (`DEFAULT_SANDBOX_IMAGE`). An SSH sandbox backend is also available for remote execution.

`resolveSandboxContext` determines the sandbox configuration for a given agent and session. It reads `agents[n].sandbox` from the config, which can specify:
- Container image and resource limits
- Mounted paths (workspace directory, media paths)
- Network access level
- The path to the workspace inside the container

`resolveSandboxToolPolicyForAgent` generates the exec tool's tool policy from the sandbox config. Tools that would require host filesystem access are downgraded to sandbox-path equivalents automatically.

The sandbox `SandboxFsBridge` (`sandbox/fs-bridge.ts`) translates host paths to container paths for read/write/edit tools. When the agent calls `read /workspace/AGENTS.md`, the bridge translates it to the mounted path inside the container.

## Layer 6: Secret Management

Credentials are managed by the secrets runtime (`src/secrets/runtime.ts`). `PreparedSecretsRuntimeSnapshot` contains:
- The resolved config with secret references replaced by actual values
- Auth profile stores per agent directory
- Resolved web tool API keys

Secrets are sourced from:
1. Config values (plain text — not recommended for production)
2. Environment variables via `secretRef: { env: "MY_TOKEN" }`
3. Auth profile stores in `~/.openclaw/<agentDir>/auth/`

`clearSecretsRuntimeSnapshot` and `getActiveSecretsRuntimeSnapshot` in `src/secrets/runtime.ts` gate runtime access so secrets are never exposed outside the resolved snapshot's lifetime.

## Auth Profiles

Auth profiles (`src/agents/auth-profiles/`) are credential sets for LLM providers. Multiple profiles per provider enable:
- **Rotation** — cycle through API keys on 429 rate limit responses
- **Fallback** — try the next profile if the current one returns an auth error
- **Cooldown** — mark a profile as temporarily unavailable after repeated failures

`markAuthProfileFailure` updates the failure count and `soonestCooldownExpiry`. `resolveAuthProfileOrder` sorts profiles by last-used time, remaining cooldown, and explicit ordering config.

## The Known Weak Secrets List

`src/gateway/known-weak-gateway-secrets.ts` maintains a set of example/default secret values from the OpenClaw documentation. If the configured gateway secret matches any of these, the gateway logs a startup warning. This prevents accidental deployments using copy-pasted example credentials.

## Input Allowlists

At the channel level, `src/channels/allowlists/` provides per-channel input filtering. The `ChannelAllowlistAdapter` lets channel plugins declare which sender IDs or patterns are permitted to reach the agent. Decisions are made before routing — disallowed senders are rejected at the channel boundary without ever entering the agent loop.

The `input-allowlist.ts` in the gateway layer applies additional message-content filtering: payloads that exceed `MAX_PAYLOAD_BYTES` or match denial patterns are rejected before being decoded.

## Security Audit System

`src/security/audit.ts` is a self-auditing system that OpenClaw runs on demand (and during the `doctor` command). It checks:
- Gateway auth configuration (strength, exposure)
- Exec policy settings
- Sandbox configuration
- Workspace skill file safety (no injected exec commands)
- Plugin trust levels
- Config file permissions

The audit produces findings at `info`, `warning`, and `critical` severity levels. Critical findings include things like `security: full` + `ask: off` without a sandbox.

## Key Takeaways

- Authentication is rate-limited and constant-time compared; browser origins are validated against an allowlist
- Roles provide coarse-grained access; scopes provide fine-grained capability within the operator role
- Exec policy is a three-axis matrix: security mode × ask mode × host target
- The approval flow suspends the agent loop and waits for human confirmation before running sensitive commands
- Docker/SSH sandboxing isolates filesystem access; the `SandboxFsBridge` translates paths transparently
- Auth profiles enable per-provider credential rotation and cooldown without restarting the gateway
- The built-in security audit system (`doctor`) evaluates the entire configuration posture on demand
