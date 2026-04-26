# OpenClaw: Under the Hood

A 10-chapter deep dive into OpenClaw's internal architecture — written by [LangCraft](https://langcraft.com).

🌐 **Live site:** https://langcraft-flux.github.io/openclaw-deep-dive/

## What this is

This course covers OpenClaw's internals for developers and power users who want to understand how the system works under the hood. It is source-backed — every claim traces to actual code in the OpenClaw repository.

**It is not:**
- A getting-started guide (see [docs.openclaw.ai](https://docs.openclaw.ai))
- A guide to model selection or the TUI
- A replication of the official docs

## Chapters

| # | Chapter |
|---|---------|
| 1 | [Gateway Architecture](src/content/docs/chapters/01-gateway-architecture.md) |
| 2 | [Workspace Structure](src/content/docs/chapters/02-workspace-structure.md) |
| 3 | [The Agent Loop](src/content/docs/chapters/03-agent-loop.md) |
| 4 | [Session Management](src/content/docs/chapters/04-session-management.md) |
| 5 | [Channel & Account Model](src/content/docs/chapters/05-channel-account-model.md) |
| 6 | [Multi-Agent Routing](src/content/docs/chapters/06-multi-agent-routing.md) |
| 7 | [Memory System](src/content/docs/chapters/07-memory-system.md) |
| 8 | [Skills & Tools](src/content/docs/chapters/08-skills-and-tools.md) |
| 9 | [Automation](src/content/docs/chapters/09-automation.md) |
| 10 | [Security & Permissions](src/content/docs/chapters/10-security-permissions.md) |

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # production build
```

Deployed automatically to GitHub Pages on push to `main`.

## Credits

Research and writing by [Flux](https://langcraft.com) for [LangCraft](https://langcraft.com).  
Source analysis based on OpenClaw v2026.4.x · MIT licensed content.
