---
title: Memory System
description: How memory files are loaded, the search backends, what gets included when, and the builtin vs QMD architecture.
---

OpenClaw has two memory layers with very different characteristics. The first is *static memory* — the `MEMORY.md` file read from disk on every turn. The second is *semantic memory search* — a vector + full-text index over workspace files and session transcripts. Understanding when each layer activates and what it costs is essential for tuning agent behaviour.

## Static Memory: MEMORY.md

`MEMORY.md` is loaded as part of the standard workspace bootstrap (position 70 in the sort order — see Chapter 2). Its content is injected verbatim into the system prompt under the `## Long-term Memory` heading, after all other bootstrap files.

The canonical filename is enforced in `src/memory/root-memory-files.ts`:

```ts
export const CANONICAL_ROOT_MEMORY_FILENAME = "MEMORY.md";
export const LEGACY_ROOT_MEMORY_FILENAME = "memory.md";
```

If the legacy `memory.md` is present, it is explicitly excluded from the auxiliary memory paths (`shouldSkipRootMemoryAuxiliaryPath`) to avoid double-injection. The 2 MB read cap (`MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES`) applies — larger files are truncated before injection.

The `memory/` subdirectory is not automatically scanned. Daily note files like `memory/2026-04-26.md` are only included if the agent explicitly lists them as extra context paths in the memory config, or if the memory search backend indexes them.

## Memory Search: Configuration

Memory search is configured per-agent under `memory` in the config. The full resolved configuration type is `ResolvedMemorySearchConfig` (in `src/agents/memory-search.ts`):

```ts
type ResolvedMemorySearchConfig = {
  enabled: boolean;
  sources: Array<"memory" | "sessions">;
  extraPaths: string[];
  provider: string;      // "builtin" | "qmd" | "remote"
  store: {
    driver: "sqlite";
    path: string;
    fts: { tokenizer: "unicode61" | "trigram" };
    vector: { enabled: boolean; extensionPath?: string };
  };
  query: {
    maxResults: number;
    minScore: number;
    hybrid: { enabled: boolean; vectorWeight: number; textWeight: number; ... };
  };
  sync: { onSessionStart: boolean; onSearch: boolean; watch: boolean; ... };
  // ...
};
```

Two backends are supported:

- **`builtin`** — SQLite with optional `sqlite-vec` extension for vector search, running in-process
- **`qmd`** — a separate sidecar process (`qmd-process.ts`) communicating over a JSONL socket

## Backend 1: Builtin SQLite

The builtin backend is the default. It stores embeddings and full-text index entries in a SQLite database at `store.path` (default: `<stateDir>/memory/<agentId>.db`).

When `store.vector.enabled` is true, the `sqlite-vec` extension is loaded and vector similarity search is performed. When the extension is unavailable, the backend falls back to BM25 full-text search only.

Hybrid search weights are configured via `query.hybrid`: `vectorWeight` and `textWeight` control how vector and text scores are combined. The `mmr` (Maximal Marginal Relevance) sub-section controls result diversity — it penalises redundant results that are semantically similar to already-selected ones.

Embedding computation uses the configured provider. The `"local"` embedding path uses `node-llama.ts` to run an ONNX embedding model in-process. Remote providers (OpenAI, Cohere, etc.) are called via `embeddings-remote-fetch.ts`.

## Backend 2: QMD

The QMD backend (`src/memory-host-sdk/engine-qmd.ts`) launches a separate sidecar that handles all embedding and indexing work. This isolates the memory system from the gateway process and avoids ONNX runtime conflicts. It communicates via a JSONL socket (`qmd-process.ts`), with operations batched for throughput.

QMD is activated when `memory.backend: "qmd"` is set in the config. At gateway startup, `startGatewayMemoryBackend` (in `server-startup-memory.ts`) iterates all configured agents and warms up their QMD instances.

The QMD engine also owns the *dreaming* subsystem (`dreaming.ts`): background consolidation passes that run while the agent is idle, de-duplicating and re-ranking stored memories without interrupting active turns.

## How Memory is Indexed

The sync system (`src/memory-host-sdk/runtime-files.ts`) determines what gets indexed:

1. **`MEMORY.md`** — always indexed if the `memory` source is enabled
2. **`memory/*.md` files** — discovered by recursive scan if the workspace is watched
3. **Session transcripts** — indexed as chunks when `sources` includes `"sessions"`, subject to `sync.sessions.deltaBytes` and `sync.sessions.deltaMessages` thresholds

Files are chunked by `chunking.tokens` (default ~512 tokens) with `chunking.overlap` between adjacent chunks. Each chunk is embedded independently so that precise paragraph-level retrieval is possible.

Sync can happen:
- **`sync.onSessionStart: true`** — re-index changed files at the start of each turn
- **`sync.onSearch: true`** — index on-demand when a search is triggered
- **`sync.watch: true`** — watch the workspace with `fs.watch` and index on change (with debounce)

## The `memory_search` Tool

The `memory_search` tool (registered in `src/agents/openclaw-tools.ts` as part of the standard tool set) lets the agent query the memory index from inside a turn. The underlying call path:

```
memory_search tool
  → agent's memory search manager
  → hybrid query (BM25 + vector)
  → citation results with scores
  → injected into context as markdown
```

The tool returns citations in the format: `[Source: path] score=0.85\n<excerpt>`. The agent can use these citations to ground its reasoning in specific past decisions or knowledge.

## Context Injection of Search Results

When `sync.onSessionStart` is enabled, memory search results are pre-fetched before the LLM call and injected into the system prompt in the `## Memory Search Results` block. The injection happens in `buildMemoryPromptSection` (in `src/plugins/memory-state.ts`). 

The `MemoryCitationsMode` config (`citations.mode`) controls whether citations include source paths and scores (`"full"`), just excerpts (`"inline"`), or nothing (`"off"`).

## Session Memory

When `sources` includes `"sessions"`, the memory backend indexes the agent's own conversation history. This gives the agent long-term recall of past conversations beyond the compaction window. Session chunks are indexed with recency weighting — more recent turns receive higher base scores before the semantic similarity component is applied.

The `experimental.sessionMemory` flag gates this feature because session indexing has higher storage and compute costs than pure workspace file indexing.

## Multimodal Memory

`src/memory-host-sdk/multimodal.ts` extends the memory system to index image content. When `memory.multimodal.enabled` is true, images in the workspace (and optionally in session history) are embedded using a vision model. Searches can then return image chunks alongside text chunks. This enables the agent to recall visual information — diagrams, screenshots, charts — from its workspace.

## Key Takeaways

- `MEMORY.md` is static: read from disk, injected as-is into the system prompt on every turn
- The memory search backend (builtin SQLite or QMD) provides semantic search over workspace files and session transcripts
- Hybrid search combines BM25 full-text and vector similarity with configurable weights
- QMD runs as a sidecar to avoid in-process ONNX conflicts and enables the dreaming consolidation subsystem
- Session memory allows recall of past conversations beyond the compaction window
- Pre-fetched search results are injected into the system prompt before the LLM call; on-demand search is available via the `memory_search` tool
