---
title: Introduction
description: What this course covers and who it's for.
---

# OpenClaw: Under the Hood

This course is a deep technical dive into how OpenClaw works internally — written for developers and power users who want to understand the system beyond what the official documentation covers.

**What this is not:**
- A getting-started guide (see [docs.openclaw.ai](https://docs.openclaw.ai) for that)
- A guide to model selection or the TUI
- A tutorial on connecting channels

**What this is:**
- An architectural deep dive into every major subsystem
- Explanations of how things fit together internally
- Source-backed analysis of real implementation decisions
- A reference you can return to when building on top of OpenClaw

## The 10 Chapters

| # | Chapter | What you'll learn |
|---|---------|-------------------|
| 1 | [Gateway Architecture](/openclaw-deep-dive/chapters/01-gateway-architecture) | The WebSocket broker, routing, agent dispatch |
| 2 | [Workspace Structure](/openclaw-deep-dive/chapters/02-workspace-structure) | File hierarchy, loading order, precedence |
| 3 | [The Agent Loop](/openclaw-deep-dive/chapters/03-agent-loop) | Turn lifecycle, tool execution, thinking levels |
| 4 | [Session Management](/openclaw-deep-dive/chapters/04-session-management) | Key construction, isolation, compaction, storage |
| 5 | [Channel & Account Model](/openclaw-deep-dive/chapters/05-channel-account-model) | How channels work, multi-account, plugin interface |
| 6 | [Multi-Agent Routing](/openclaw-deep-dive/chapters/06-multi-agent-routing) | Bindings, isolation, cross-agent communication |
| 7 | [Memory System](/openclaw-deep-dive/chapters/07-memory-system) | File-based memory, context injection, search |
| 8 | [Skills & Tools](/openclaw-deep-dive/chapters/08-skills-and-tools) | Built-in tools, AgentSkills spec, skill loading |
| 9 | [Automation](/openclaw-deep-dive/chapters/09-automation) | Cron, hooks, standing orders, TaskFlow |
| 10 | [Security & Permissions](/openclaw-deep-dive/chapters/10-security-permissions) | Exec policy, sandboxing, auth profiles |

## About

Built by [LangCraft](https://langcraft.com). Source analysis based on OpenClaw v2026.4.x.
