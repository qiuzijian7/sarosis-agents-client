/**
 * auto-recall hook (v3): injects relevant memories + persona into agent context
 * before the agent starts processing.
 *
 * - Searches L1 memories using configurable strategy (keyword / embedding / hybrid)
 *   - keyword: FTS5 BM25 (requires FTS5; returns empty if unavailable)
 *   - embedding: VectorStore cosine similarity
 *   - hybrid: keyword + embedding merged with RRF
 * - L3 persona injection
 * - L2 scene navigation (full injection, LLM decides relevance)
 * - Related context (option D): for each L1 hit, attach
 *     a) the surrounding L0 messages (±3, truncated to 120 chars) — A聚合
 *     b) sibling L1 memories from the same scene with priority>=50 — D扩展
 *   into a separate `<related-context>` block so the relevance signal of the
 *   primary `<relevant-memories>` block is preserved.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import type { MemoryRecord } from "../record/l1-reader.js";
import type { IMemoryStore, L1SearchResult, L1FtsResult } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService, EmbeddingCallOptions } from "../store/embedding.js";
import { sanitizeText } from "../../utils/sanitize.js";

const TAG = "[memory-tdai] [recall]";

/**
 * Memory tools usage guide — injected at the end of memory context so the
 * main agent knows how to actively retrieve deeper information.
 */
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

当上方注入的记忆片段不足以回答用户问题时，可主动调用以下工具获取更多信息：

- **tdai_memory_search**：搜索结构化记忆（L1），适用于回忆用户偏好、历史事件节点、规则等关键信息。
- **tdai_conversation_search**：搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节；也可用于补充或校验 memory_search 的结果。

### ⚠️ 调用次数限制
每轮对话中，tdai_memory_search 和 tdai_conversation_search **合计最多调用 3 次**。
- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 3 次。
- 若 3 次搜索后仍无结果，说明该信息不在记忆中，请直接根据已有信息回复用户，不要继续搜索。

## 主动记忆写入（内联记忆标签）

当本轮对话中出现**值得长期记住**的信息时，在回复末尾追加记忆标签，系统会自动提取并写入记忆库。

**标签格式（推荐）：**

  <memory_extract>{"content":"记忆内容","type":"episodic","priority":80,"scene_name":"场景名称"}</memory_extract>

**字段说明：**
- content：记忆内容（独立完整，无上下文也能看懂）
- type：记忆类型
  - episodic：事件/活动记录（用户做了什么、发生了什么）
  - instruction：用户的明确指令或规则（"帮我记住..."、"以后..."）
  - persona：用户偏好、习惯、身份特征
- priority：重要程度 0-100，全局强制指令用 -1
- scene_name：所属场景名称（简短描述，如"游戏开发-空投系统"）

**使用原则（宁缺毋滥）：**
- 只在用户**明确要求记录**，或信息**跨会话仍有价值**时才输出标签
- 闲聊、临时性操作、一次性问答**不要**输出标签
- 每轮最多输出 3 条标签

**示例：**

  <memory_extract>{"content":"GM代码在S1GameCheatExtension，Rush空投在RushAirDropActor和GUVObject_GenerateAirDrop_Rush","type":"instruction","priority":90,"scene_name":"游戏开发-空投系统"}</memory_extract>

标签对用户**不可见**，系统会自动在流式阶段剥离后再展示回复。
</memory-tools-guide>\``

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** A single recalled L1 memory with its search score and type. */
export interface RecalledMemory {
  content: string;
  score: number;
  type: string;
}

/**
 * A primary L1 hit retained in raw structured form so we can build the
 * companion `<related-context>` block (option A: surrounding L0; option D:
 * sibling L1 in the same scene).
 */
interface RawL1Hit {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  /** May be empty for legacy rows persisted before the source_message_ids column was added. */
  source_message_ids: string[];
  timestamp_start: string;
  timestamp_end: string;
}

export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt text (dynamic, per-turn) */
  prependContext?: string;
  /** Stable recall context appended to system prompt (persona, scene nav, tools guide — cacheable) */
  appendSystemContext?: string;

  // ── Metric payload (for pendingRecallCache in index.ts) ──
  /** L1 memories that were recalled (with scores), for metric reporting */
  recalledL1Memories?: RecalledMemory[];
  /** L3 Persona raw content loaded during recall (null if none) */
  recalledL3Persona?: string | null;
  /** Effective search strategy used */
  recallStrategy?: string;
}

export async function performAutoRecall(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  /**
   * 召回作用域：决定能搜到哪些 L1 记忆。
   *   - 'agent'     → 仅 sessionKey 与本 agent 一致的 L1（默认严格隔离）
   *   - 'workspace' → allowedSessionKeys 列出的 L1（同一 workspace 全部 agent）
   *   - 'global'    → 全库 L1（旧行为，跨 agent / 跨 workspace 均可见）
   * 缺省时（向后兼容老调用方）按 'global' 处理。
   */
  scope?: 'agent' | 'workspace' | 'global';
  /** 当 scope='workspace' 时，列出本 workspace 下所有 agent 的 sessionKey。 */
  allowedSessionKeys?: readonly string[];
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}): Promise<RecallResult | undefined> {
  const { cfg, logger } = params;
  const timeoutMs = cfg.recall.timeoutMs ?? 5000;

  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    performAutoRecallInner(params).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        logger?.warn?.(
          `${TAG} ⚠️ Recall timed out after ${timeoutMs}ms — skipping memory injection to avoid blocking the user`,
        );
        resolve(undefined);
      }, timeoutMs);
    }),
  ]);
}

async function performAutoRecallInner(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  scope?: 'agent' | 'workspace' | 'global';
  allowedSessionKeys?: readonly string[];
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}): Promise<RecallResult | undefined> {
  const { userText, cfg, pluginDataDir, logger, vectorStore, embeddingService } = params;
  const tRecallStart = performance.now();

  // Resolve effective sessionKeys filter from scope:
  //   - 'agent'     → [sessionKey]   (only this agent's own memories)
  //   - 'workspace' → allowedSessionKeys (caller-provided, includes self)
  //   - 'global'    → undefined      (no filter — search everything)
  // Defensively clamp invalid combinations (e.g. workspace scope without
  // allowedSessionKeys → fall back to agent-only to err on the side of safety).
  const effectiveScope = params.scope ?? 'global';
  let recallSessionKeys: readonly string[] | undefined;
  if (effectiveScope === 'agent') {
    recallSessionKeys = params.sessionKey ? [params.sessionKey] : undefined;
  } else if (effectiveScope === 'workspace') {
    if (params.allowedSessionKeys && params.allowedSessionKeys.length > 0) {
      recallSessionKeys = params.allowedSessionKeys;
    } else {
      logger?.warn?.(
        `${TAG} scope='workspace' but allowedSessionKeys empty — falling back to agent-only filter`,
      );
      recallSessionKeys = params.sessionKey ? [params.sessionKey] : undefined;
    }
  } else {
    recallSessionKeys = undefined;
  }
  if (recallSessionKeys && recallSessionKeys.length > 0) {
    logger?.debug?.(
      `${TAG} Recall scope=${effectiveScope}, restricting L1 search to ${recallSessionKeys.length} sessionKey(s): ` +
      `[${recallSessionKeys.slice(0, 5).join(', ')}${recallSessionKeys.length > 5 ? ', …' : ''}]`,
    );
  } else {
    logger?.debug?.(`${TAG} Recall scope=${effectiveScope}, L1 search runs across the full library (no sessionKey filter)`);
  }

  // Search relevant memories (L1 layer) — skip only when userText is empty/undefined
  const tSearchStart = performance.now();
  let memoryLines: string[] = [];
  let rawHits: RawL1Hit[] = [];
  let effectiveStrategy = "skipped";
  let recalledL1Memories: RecalledMemory[] = [];
  let searchTiming: SearchTiming = { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 };
  if (!userText || userText.length === 0) {
    logger?.debug?.(`${TAG} User text empty/undefined, skipping memory search (persona/scene still injected)`);
  } else {
    effectiveStrategy = cfg.recall.strategy ?? "hybrid";
    const searchResult = await searchMemories(userText, pluginDataDir, cfg, logger, effectiveStrategy as "keyword" | "embedding" | "hybrid", vectorStore, embeddingService, recallSessionKeys);
    memoryLines = searchResult.lines;
    rawHits = searchResult.rawHits;
    searchTiming = searchResult.timing;

    // Extract structured RecalledMemory from formatted lines for metric reporting
    recalledL1Memories = memoryLines.map((line) => {
      const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(活动时间:.*\))?$/);
      if (match) {
        const tag = match[1];
        const content = match[2].trim();
        const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
        return { content, score: 0, type: typePart };
      }
      return { content: line, score: 0, type: "unknown" };
    });
  }
  const tSearchEnd = performance.now();

  // Read persona (L3 layer)
  const tPersonaStart = performance.now();
  let personaContent: string | undefined;
  try {
    const personaPath = path.join(pluginDataDir, "persona.md");
    const raw = await fs.readFile(personaPath, "utf-8");
    personaContent = stripSceneNavigation(raw).trim();
    if (!personaContent) personaContent = undefined;
    logger?.debug?.(`${TAG} Persona loaded: ${personaContent ? `${personaContent.length} chars` : "empty"}`);
  } catch {
    logger?.debug?.(`${TAG} No persona file found (expected for new users)`);
  }
  const tPersonaEnd = performance.now();

  // Load full scene navigation (L2 layer)
  const tSceneStart = performance.now();
  let sceneNavigation: string | undefined;
  try {
    const sceneIndex = await readSceneIndex(pluginDataDir);
    if (sceneIndex.length > 0) {
      sceneNavigation = generateSceneNavigation(sceneIndex, pluginDataDir);
      logger?.debug?.(`${TAG} Scene navigation generated: ${sceneIndex.length} scenes`);
    }
  } catch {
    logger?.debug?.(`${TAG} No scene index found`);
  }
  const tSceneEnd = performance.now();

  if (memoryLines.length === 0 && !personaContent && !sceneNavigation) {
    const totalMs = performance.now() - tRecallStart;
    logger?.info(
      `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
      `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryLines.length},` +
      `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
      `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
      `persona=${(tPersonaEnd - tPersonaStart).toFixed(0)}ms, ` +
      `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms — no context to inject`,
    );
    logger?.debug?.(`${TAG} No memories/persona/scenes to inject`);
    return undefined;
  }

  // Split recall context into stable and dynamic parts to optimize prompt caching.
  //
  // appendSystemContext (system prompt end — stable, cacheable):
  //   persona, scene navigation, memory tools guide
  //   These change infrequently; when content is identical across turns,
  //   providers with prompt caching (Anthropic/OpenAI) can cache this region.
  //
  // prependContext (user prompt prefix — dynamic, per-turn):
  //   L1 relevant memories — different every turn, moved out of system prompt
  //   so it doesn't bust the system prompt cache.
  const stableParts: string[] = [];
  if (personaContent) {
    stableParts.push(`<user-persona>\n${personaContent}\n</user-persona>`);
  }
  if (sceneNavigation) {
    stableParts.push(`<scene-navigation>\n${sceneNavigation}\n</scene-navigation>`);
  }

  // Dynamic part: L1 relevant memories (changes every turn) → prependContext (user prompt)
  let prependContext: string | undefined;
  if (memoryLines.length > 0) {
    prependContext =
      `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${memoryLines.join("\n")}\n</relevant-memories>`;
  }

  // Layered enrichment (option A + D): only built when we actually have hits.
  // Failures in this stage must NEVER block recall — wrap in try/catch.
  if (rawHits.length > 0) {
    try {
      const tRelStart = performance.now();
      const relatedBlock = await buildRelatedContext({
        hits: rawHits,
        vectorStore,
        fallbackSessionKey: params.sessionKey,
        logger,
      });
      const relMs = performance.now() - tRelStart;
      if (relatedBlock) {
        prependContext = prependContext
          ? `${prependContext}\n\n${relatedBlock}`
          : relatedBlock;
        logger?.debug?.(`${TAG} [related-context] attached ${relatedBlock.length} chars in ${relMs.toFixed(0)}ms`);
      } else {
        logger?.debug?.(`${TAG} [related-context] empty (built in ${relMs.toFixed(0)}ms)`);
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} [related-context] build failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Append memory tools usage guide to the stable part so the agent knows
  // how to actively retrieve deeper context when the injected snippets
  // are not enough. This is static content and benefits from caching.
  if (stableParts.length > 0 || prependContext) {
    stableParts.push(MEMORY_TOOLS_GUIDE);
  }

  const appendSystemContext = stableParts.length > 0 ? stableParts.join("\n\n") : undefined;

  const totalMs = performance.now() - tRecallStart;
  logger?.info(
    `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
    `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryLines.length},` +
    `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
    `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
    `persona=${(tPersonaEnd - tPersonaStart).toFixed(0)}ms(${personaContent ? `${personaContent.length}chars` : "none"}), ` +
    `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms(${sceneNavigation ? "loaded" : "none"})`,
  );

  if (!appendSystemContext && !prependContext) {
    return undefined;
  }

  return {
    prependContext,
    appendSystemContext,
    recalledL1Memories,
    recalledL3Persona: personaContent ?? null,
    recallStrategy: effectiveStrategy,
  };
}

// ============================
// Multi-strategy search dispatcher
// ============================

interface ScoredRecord {
  record: MemoryRecord;
  score: number;
}

/** Timing breakdown from memory search */
interface SearchTiming {
  ftsMs: number;
  embeddingMs: number;
  ftsHits: number;
  embeddingHits: number;
}

interface SearchResult {
  lines: string[];
  timing: SearchTiming;
  /** Top L1 hits in raw structured form (used to build related-context). */
  rawHits: RawL1Hit[];
}

/**
 * Search memories and return both formatted lines and structured details.
 *
 * This is a thin wrapper around `searchMemories` that also captures
 * the recalled memory metadata for metric reporting (agent_turn event).
 * It parses the returned formatted lines to extract type/content info.
 */
async function searchMemoriesWithDetails(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: "keyword" | "embedding" | "hybrid",
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<{ lines: string[]; memories: RecalledMemory[]; timing: SearchTiming }> {
  const result = await searchMemories(userText, pluginDataDir, cfg, logger, strategy, vectorStore, embeddingService);

  // Extract structured data from formatted memory lines.
  // Format: "- [type|scene] content (活动时间: ...)" or "- [type] content"
  const memories: RecalledMemory[] = result.lines.map((line) => {
    const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(活动时间:.*\))?$/);
    if (match) {
      const tag = match[1];
      const content = match[2].trim();
      const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
      return { content, score: 0, type: typePart };
    }
    return { content: line, score: 0, type: "unknown" };
  });

  return { lines: result.lines, memories, timing: result.timing };
}

/**
 * Search memories using the configured strategy.
 *
 * - "keyword": JSONL keyword-based (Jaccard similarity) — no embedding needed
 * - "embedding": VectorStore cosine similarity — requires vectorStore + embeddingService
 * - "hybrid": merge both keyword and embedding results with RRF (Reciprocal Rank Fusion)
 *
 * Falls back to keyword if embedding resources are unavailable.
 */
async function searchMemories(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: "keyword" | "embedding" | "hybrid",
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
  sessionKeys?: readonly string[],
): Promise<SearchResult> {
  const emptyResult: SearchResult = { lines: [], timing: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 }, rawHits: [] };
  // Strip gateway-injected inbound metadata (Sender, timestamps, media markers,
  // base64 image data, etc.) so FTS / embedding queries are based on pure user intent.
  const cleanText = sanitizeText(userText);

  if (cleanText.length < 2) {
    logger?.debug?.(`${TAG} Query too short for memory search (raw=${userText.length}, clean=${cleanText.length})`);
    return emptyResult;
  }

  if (cleanText.length !== userText.length) {
    logger?.debug?.(
      `${TAG} userText sanitized: ${userText.length} → ${cleanText.length} chars`,
    );
  }

  const maxResults = cfg.recall.maxResults ?? 5;
  const threshold = cfg.recall.scoreThreshold ?? 0.3;

  const embeddingAvailable = !!vectorStore && !!embeddingService;

  logger?.debug?.(
    `${TAG} [searchMemories] strategy=${strategy}, embeddingAvailable=${embeddingAvailable}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}, ` +
    `maxResults=${maxResults}, threshold=${threshold}`,
  );

  // Determine effective strategy (fall back to keyword if embedding not available)
  let effectiveStrategy = strategy;
  if ((strategy === "embedding" || strategy === "hybrid") && !embeddingAvailable) {
    logger?.warn?.(
      `${TAG} Strategy "${strategy}" requested but EmbeddingService not available, falling back to keyword`,
    );
    effectiveStrategy = "keyword";
  }

  logger?.debug?.(`${TAG} Search strategy: ${effectiveStrategy} (configured: ${strategy})`);

  // Resolve per-call embedding timeout for recall path.
  // Falls back to global embedding.timeoutMs when recallTimeoutMs is not configured.
  const recallEmbeddingTimeoutMs = cfg.embedding?.recallTimeoutMs ?? cfg.embedding?.timeoutMs;
  const embeddingCallOpts: EmbeddingCallOptions = { timeoutMs: recallEmbeddingTimeoutMs };

  try {
    if (effectiveStrategy === "keyword") {
      const tFts = performance.now();
      const { lines, rawHits } = await searchByKeyword(cleanText, pluginDataDir, maxResults, threshold, logger, vectorStore, sessionKeys);
      return { lines, rawHits, timing: { ftsMs: performance.now() - tFts, embeddingMs: 0, ftsHits: lines.length, embeddingHits: 0 } };
    }

    if (effectiveStrategy === "embedding") {
      const tEmb = performance.now();
      const { lines, rawHits } = await searchByEmbedding(cleanText, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts, sessionKeys);
      return { lines, rawHits, timing: { ftsMs: 0, embeddingMs: performance.now() - tEmb, ftsHits: 0, embeddingHits: lines.length } };
    }

    // Hybrid: if the store natively supports hybrid search (e.g. TCVDB does
    // server-side dense + sparse + RRF in a single API call), short-circuit
    // to avoid a redundant second HTTP request and a wasted local embed().
    if (vectorStore?.getCapabilities().nativeHybridSearch) {
      const tNative = performance.now();
      const results = await vectorStore.searchL1Hybrid!({ query: cleanText, topK: maxResults, sessionKeys });
      const nativeMs = performance.now() - tNative;
      logger?.debug?.(`${TAG} [hybrid-native] Single-call hybrid: ${results.length} results in ${nativeMs.toFixed(0)}ms`);
      const lines = results.map((r) => formatMemoryLine(vectorResultToFormatable(r)));
      const rawHits = results.map(vectorResultToRawHit);
      return { lines, rawHits, timing: { ftsMs: 0, embeddingMs: nativeMs, ftsHits: 0, embeddingHits: results.length } };
    }

    // Fallback: run keyword + embedding in parallel, merge with client-side RRF (SQLite path)
    return await searchHybrid(cleanText, pluginDataDir, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts, sessionKeys);
  } catch (err) {
    logger?.warn?.(`${TAG} Memory search failed (strategy=${effectiveStrategy}): ${err instanceof Error ? err.message : String(err)}`);
    return emptyResult;
  }
}

// ============================
// Strategy: Keyword (FTS5 BM25, no in-memory fallback)
// ============================

async function searchByKeyword(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  sessionKeys?: readonly string[],
): Promise<{ lines: string[]; rawHits: RawL1Hit[] }> {
  // Prefer FTS5 if available
  if (vectorStore?.isFtsAvailable()) {
    const ftsQuery = buildFtsQuery(userText);
    if (ftsQuery) {
      logger?.debug?.(`${TAG} [keyword-fts] Using FTS5 BM25 search: query="${ftsQuery}"`);
      const ftsResults = await vectorStore.searchL1Fts(ftsQuery, maxResults * 2, sessionKeys);
      if (ftsResults.length > 0) {
        logger?.debug?.(
          `${TAG} [keyword-fts] FTS5 raw results (${ftsResults.length}): ` +
          ftsResults.map((r) => `id=${r.record_id} score=${r.score.toFixed(6)}`).join(", "),
        );
        const filtered = ftsResults
          .filter((r) => r.score >= threshold)
          .slice(0, maxResults);

        if (filtered.length > 0) {
          logger?.debug?.(`${TAG} [keyword-fts] FTS5 found ${filtered.length} results (from ${ftsResults.length} raw, threshold=${threshold})`);
          return {
            lines: filtered.map((r) => formatMemoryLine(ftsResultToFormatable(r))),
            rawHits: filtered.map(ftsResultToRawHit),
          };
        }

        // BM25 absolute scores are unreliable when the document set is very
        // small (e.g. 1–3 records) because IDF approaches 0.  In that case,
        // trust FTS5's MATCH + rank ordering and return the top results anyway.
        if (ftsResults.length <= maxResults) {
          logger?.debug?.(
            `${TAG} [keyword-fts] All ${ftsResults.length} results below threshold=${threshold} ` +
            `but document set is small — returning all matched results`,
          );
          const top = ftsResults.slice(0, maxResults);
          return {
            lines: top.map((r) => formatMemoryLine(ftsResultToFormatable(r))),
            rawHits: top.map(ftsResultToRawHit),
          };
        }
        logger?.debug?.(`${TAG} [keyword-fts] FTS5 returned 0 results above threshold (from ${ftsResults.length} raw)`);
      }
    }
  }

  // FTS5 not available or returned no results — skip in-memory fallback to avoid O(N) full scan
  logger?.debug?.(`${TAG} [keyword] FTS5 unavailable or no results, skipping keyword search`);
  return { lines: [], rawHits: [] };
}

// ============================
// Strategy: Embedding (VectorStore cosine)
// ============================

async function searchByEmbedding(
  userText: string,
  maxResults: number,
  threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
  sessionKeys?: readonly string[],
): Promise<{ lines: string[]; rawHits: RawL1Hit[] }> {
  logger?.debug?.(
    `${TAG} [embedding-search] START query="${userText.slice(0, 80)}...", maxResults=${maxResults}, threshold=${threshold}`,
  );
  const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
  logger?.debug?.(
    `${TAG} [embedding-search] Query embedding OK: dims=${queryEmbedding.length}, ` +
    `norm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}, ` +
    `searching top-${maxResults * 2}...`,
  );
  // Retrieve more candidates for subsequent filtering
  const vecResults: L1SearchResult[] = await vectorStore.searchL1Vector(queryEmbedding, maxResults * 2, undefined, sessionKeys);

  if (vecResults.length === 0) {
    logger?.debug?.(`${TAG} [embedding-search] Returned 0 results`);
    return { lines: [], rawHits: [] };
  }

  logger?.debug?.(`${TAG} [embedding-search] Got ${vecResults.length} candidates, filtering by threshold=${threshold}`);
  for (const r of vecResults) {
    logger?.debug?.(
      `${TAG} [embedding-search] candidate id=${r.record_id}, score=${r.score.toFixed(4)}, ` +
      `type=${r.type}, content="${r.content.slice(0, 60)}..."`,
    );
  }

  const filtered = vecResults
    .filter((r) => r.score >= threshold)
    .slice(0, maxResults);

  if (filtered.length > 0) {
    logger?.debug?.(`${TAG} [embedding-search] Found ${filtered.length} relevant memories above threshold (from ${vecResults.length} candidates)`);
    return {
      lines: filtered.map((r) => formatMemoryLine(vectorResultToFormatable(r))),
      rawHits: filtered.map(vectorResultToRawHit),
    };
  }

  logger?.debug?.(`${TAG} [embedding-search] No results above threshold ${threshold}`);
  return { lines: [], rawHits: [] };
}

// ============================
// Strategy: Hybrid (Keyword + Embedding + RRF)
// ============================

/**
 * Hybrid search: run keyword (FTS5) and embedding in parallel, merge with
 * Reciprocal Rank Fusion (RRF) to combine rank lists.
 *
 * RRF score for a record at rank r = 1 / (k + r), where k=60 is a constant.
 * If a record appears in both lists, its RRF scores are summed.
 *
 * If FTS5 is unavailable, the keyword side returns empty and RRF uses
 * embedding results only.
 */
async function searchHybrid(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  _threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
  sessionKeys?: readonly string[],
): Promise<SearchResult> {
  // Run keyword and embedding searches in parallel
  const candidateK = maxResults * 3; // retrieve more for merging

  const [keywordResult, embeddingResult] = await Promise.all([
    // Keyword search: FTS5 only (no in-memory fallback)
    (async () => {
      const tStart = performance.now();
      try {
        // Try FTS5 first
        if (vectorStore.isFtsAvailable()) {
          const ftsQuery = buildFtsQuery(userText);
          if (ftsQuery) {
            const ftsResults = await vectorStore.searchL1Fts(ftsQuery, candidateK, sessionKeys);
            if (ftsResults.length > 0) {
              logger?.debug?.(`${TAG} [hybrid-keyword-fts] FTS5 found ${ftsResults.length} candidates`);
              // Convert FtsSearchResult to ScoredRecord for RRF merge
              const records = ftsResults.map((r): ScoredRecord => ({
                record: {
                  id: r.record_id,
                  content: r.content,
                  type: r.type as MemoryRecord["type"],
                  priority: r.priority,
                  scene_name: r.scene_name,
                  source_message_ids: r.source_message_ids ?? [],
                  metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })() : {},
                  timestamps: [r.timestamp_str].filter(Boolean),
                  createdAt: "",
                  updatedAt: "",
                  sessionKey: r.session_key,
                  sessionId: r.session_id,
                },
                score: r.score,
              }));
              // Carry along the FTS rows for raw-hit reconstruction (timestamp_start/end live there).
              return { records, ftsRows: ftsResults, ms: performance.now() - tStart };
            }
          }
        }
        // FTS5 not available or returned no results — skip in-memory fallback
        logger?.debug?.(`${TAG} [hybrid-keyword] FTS5 unavailable or no results, skipping keyword part`);
        return { records: [] as ScoredRecord[], ftsRows: [] as L1FtsResult[], ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: keyword part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { records: [] as ScoredRecord[], ftsRows: [] as L1FtsResult[], ms: performance.now() - tStart };
      }
    })(),
    // Embedding search
    (async () => {
      const tStart = performance.now();
      try {
        logger?.debug?.(`${TAG} [hybrid-embedding] Generating query embedding...`);
        const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
        logger?.debug?.(
          `${TAG} [hybrid-embedding] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}...`,
        );
        const results = await vectorStore.searchL1Vector(queryEmbedding, candidateK, userText, sessionKeys);
        logger?.debug?.(`${TAG} [hybrid-embedding] Got ${results.length} candidates`);
        return { results, ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: embedding part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { results: [] as L1SearchResult[], ms: performance.now() - tStart };
      }
    })(),
  ]);

  const keywordResults = keywordResult.records;
  const ftsRows = keywordResult.ftsRows;
  const embeddingResults = embeddingResult.results;
  const timing: SearchTiming = {
    ftsMs: keywordResult.ms,
    embeddingMs: embeddingResult.ms,
    ftsHits: keywordResults.length,
    embeddingHits: embeddingResults.length,
  };

  if (keywordResults.length === 0 && embeddingResults.length === 0) {
    logger?.debug?.(`${TAG} Hybrid search: both strategies returned 0 results`);
    return { lines: [], timing, rawHits: [] };
  }

  // RRF merge: k=60 is a standard constant from the RRF paper
  const RRF_K = 60;

  // Map: record_id → { rrfScore, formatable, rawHit }
  const mergedMap = new Map<string, { rrfScore: number; formatable: FormatableMemory; rawHit: RawL1Hit }>();

  // Build a lookup from ftsRows so we can recover timestamp_start/end (the
  // ScoredRecord shape used for keyword RRF doesn't carry those columns).
  const ftsRowById = new Map<string, L1FtsResult>();
  for (const r of ftsRows) ftsRowById.set(r.record_id, r);

  // Process keyword results
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank];
    const id = r.record.id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      const ftsRow = ftsRowById.get(id);
      const rawHit: RawL1Hit = ftsRow
        ? ftsResultToRawHit(ftsRow)
        : {
          record_id: r.record.id,
          content: r.record.content,
          type: r.record.type,
          priority: r.record.priority,
          scene_name: r.record.scene_name,
          session_key: r.record.sessionKey,
          source_message_ids: r.record.source_message_ids ?? [],
          timestamp_start: "",
          timestamp_end: "",
        };
      mergedMap.set(id, { rrfScore, formatable: recordToFormatable(r.record), rawHit });
    }
  }

  // Process embedding results
  for (let rank = 0; rank < embeddingResults.length; rank++) {
    const r = embeddingResults[rank];
    const id = r.record_id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      mergedMap.set(id, { rrfScore, formatable: vectorResultToFormatable(r), rawHit: vectorResultToRawHit(r) });
    }
  }

  // Sort by combined RRF score and take top results
  const sorted = [...mergedMap.entries()]
    .sort((a, b) => b[1].rrfScore - a[1].rrfScore)
    .slice(0, maxResults);

  if (sorted.length > 0) {
    logger?.debug?.(
      `${TAG} Hybrid search found ${sorted.length} results ` +
      `(keyword=${keywordResults.length}, embedding=${embeddingResults.length})`,
    );
    return {
      lines: sorted.map(([, { formatable }]) => formatMemoryLine(formatable)),
      rawHits: sorted.map(([, { rawHit }]) => rawHit),
      timing,
    };
  }

  logger?.debug?.(`${TAG} Hybrid search: no results after merge`);
  return { lines: [], timing, rawHits: [] };
}

// ============================
// Unified memory line formatter
// ============================

/**
 * Format a single memory record into a rich natural-language line for prompt injection.
 *
 * Time semantics:
 *   - timestamp (点时间): when the activity/event happened, e.g. "2025-03-01 mentioned something"
 *   - activity_start_time / activity_end_time (段时间): activity time range, e.g. "trip from 2025-05-01 to 2025-05-10"
 *   - All three time fields may be empty/undefined — handled gracefully.
 *
 * Output examples:
 *   - [persona] 用户叫王小明，30岁，是一名软件工程师。
 *   - [episodic|旅行计划] 用户计划五月去日本旅行。(活动时间: 2025-05-01 ~ 2025-05-10)
 *   - [episodic] 用户今天加班到很晚。(活动时间: 2025-03-01)
 *   - [instruction] 用户要求回答时使用中文，保持简洁。
 */
interface FormatableMemory {
  type: string;
  content: string;
  scene_name?: string;
  /** Activity time range start (段时间 start), may be empty */
  activity_start_time?: string;
  /** Activity time range end (段时间 end), may be empty */
  activity_end_time?: string;
  /** Activity point-in-time (点时间: when it happened), may be empty */
  timestamp?: string;
}

function formatMemoryLine(m: FormatableMemory): string {
  // 1. Type tag + optional scene name
  const tag = m.scene_name ? `${m.type}|${m.scene_name}` : m.type;

  // 2. Content (core)
  let line = `- [${tag}] ${m.content}`;

  // 3. Time info — prefer activity_start/end range; fall back to timestamp as point-in-time
  const start = formatTimestamp(m.activity_start_time);
  const end = formatTimestamp(m.activity_end_time);
  const point = formatTimestamp(m.timestamp);

  if (start && end) {
    // 段时间: both start and end
    line += ` (活动时间: ${start} ~ ${end})`;
  } else if (start) {
    // 段时间: only start
    line += ` (活动时间: ${start}起)`;
  } else if (end) {
    // 段时间: only end
    line += ` (活动时间: 至${end})`;
  } else if (point) {
    // 点时间: single timestamp
    line += ` (活动时间: ${point})`;
  }
  // If all three are empty → no time info appended (graceful)

  return line;
}

/**
 * Format an ISO 8601 timestamp to a concise date or datetime string.
 * - If the time part is 00:00:00 → show date only (e.g. "2025-03-01")
 * - Otherwise → show date + time (e.g. "2025-03-01 14:30")
 * - Returns undefined for empty/invalid inputs.
 */
function formatTimestamp(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  // Try to parse ISO format: "2025-03-01T14:30:00.000Z" or "2025-03-01"
  const match = ts.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2})?)?/);
  if (!match) return undefined;
  const datePart = match[1];
  const timePart = match[2];
  if (!timePart || timePart === "00:00") {
    return datePart;
  }
  return `${datePart} ${timePart}`;
}

/**
 * Build a FormatableMemory from a full MemoryRecord (keyword search path).
 * Handles empty metadata, empty timestamps array gracefully.
 */
function recordToFormatable(record: MemoryRecord): FormatableMemory {
  const meta = record.metadata as { activity_start_time?: string; activity_end_time?: string } | undefined;
  return {
    type: record.type,
    content: record.content,
    scene_name: record.scene_name || undefined,
    activity_start_time: meta?.activity_start_time || undefined,
    activity_end_time: meta?.activity_end_time || undefined,
    timestamp: (record.timestamps && record.timestamps.length > 0) ? record.timestamps[0] : undefined,
  };
}

/**
 * Build a FormatableMemory from a VectorSearchResult (embedding search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function vectorResultToFormatable(r: L1SearchResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}

/**
 * Build a FormatableMemory from an FtsSearchResult (FTS5 keyword search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function ftsResultToFormatable(r: L1FtsResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}

// ============================
// Raw-hit converters (used by related-context builder)
// ============================

function vectorResultToRawHit(r: L1SearchResult): RawL1Hit {
  return {
    record_id: r.record_id,
    content: r.content,
    type: r.type,
    priority: r.priority,
    scene_name: r.scene_name,
    session_key: r.session_key,
    source_message_ids: r.source_message_ids ?? [],
    timestamp_start: r.timestamp_start ?? "",
    timestamp_end: r.timestamp_end ?? "",
  };
}

function ftsResultToRawHit(r: L1FtsResult): RawL1Hit {
  return {
    record_id: r.record_id,
    content: r.content,
    type: r.type,
    priority: r.priority,
    scene_name: r.scene_name,
    session_key: r.session_key,
    source_message_ids: r.source_message_ids ?? [],
    timestamp_start: r.timestamp_start ?? "",
    timestamp_end: r.timestamp_end ?? "",
  };
}

// ============================
// Related-context builder (option A: surrounding L0 + option D: sibling L1)
// ============================

/** Tunables for the related-context block. */
const RELATED_CONTEXT_L0_NEIGHBORS = 3;       // ±N L0 messages around each L1 hit (option A)
const RELATED_CONTEXT_L0_SNIPPET_CHARS = 120; // truncate each L0 line to N chars (option Q5-b)
const RELATED_CONTEXT_L0_TIME_WINDOW_MS = 10 * 60 * 1000; // ±10 min around L1 timestamp (legacy fallback)
const RELATED_CONTEXT_L1_PER_SCENE = 5;       // sibling L1 cap per scene (option D)
const RELATED_CONTEXT_L1_MIN_PRIORITY = 50;   // sibling L1 priority floor (option D)
const RELATED_CONTEXT_L1_TOTAL_CAP = 8;       // overall sibling L1 cap to keep injection bounded
const RELATED_CONTEXT_TOTAL_CHAR_BUDGET = 4000; // hard cap on the whole block to avoid runaway prompts

/**
 * Truncate text to a max display length, collapsing internal whitespace so each
 * snippet stays single-line in the prompt.
 */
function snippetize(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

/**
 * For each primary L1 hit:
 *   A) attach surrounding L0 messages — prefer source_message_ids; fall back to
 *      a recorded_at time window when ids are missing (legacy data).
 *   D) attach sibling L1 memories from the same scene with priority >= 50.
 *
 * Returns a single `<related-context>...</related-context>` string, or undefined
 * when no useful enrichment is available.
 */
async function buildRelatedContext(params: {
  hits: RawL1Hit[];
  vectorStore?: IMemoryStore;
  fallbackSessionKey: string;
  logger?: Logger;
}): Promise<string | undefined> {
  const { hits, vectorStore, fallbackSessionKey, logger } = params;
  if (!vectorStore || hits.length === 0) return undefined;

  // Track seen ids to avoid sibling duplication with primary hits and across hits.
  const seenL1Ids = new Set(hits.map((h) => h.record_id));

  // ── Option A: surrounding L0 per hit ──
  const perHitBlocks: string[] = [];
  for (const hit of hits) {
    const L0Lines: string[] = [];

    // 1) Try precise lookup via source_message_ids when available.
    if (hit.source_message_ids.length > 0 && typeof vectorStore.getL0ByIds === "function") {
      const sourceRows = await vectorStore.getL0ByIds(hit.source_message_ids);
      if (sourceRows.length > 0) {
        // Use the first source row's session_key + recorded_at as anchors for
        // the surrounding-window query.
        const anchor = sourceRows[0];
        const sessionKey = anchor.session_key || hit.session_key || fallbackSessionKey;
        const anchorMs = Date.parse(anchor.recorded_at);
        if (Number.isFinite(anchorMs) && typeof vectorStore.queryL0InWindow === "function") {
          const fromIso = new Date(anchorMs - RELATED_CONTEXT_L0_TIME_WINDOW_MS).toISOString();
          const toIso = new Date(anchorMs + RELATED_CONTEXT_L0_TIME_WINDOW_MS).toISOString();
          const windowRows = await vectorStore.queryL0InWindow(sessionKey, fromIso, toIso, 64);

          // Find anchor index, slice ±N around it.
          const anchorIdx = windowRows.findIndex((r) => r.record_id === anchor.record_id);
          const start = Math.max(0, (anchorIdx >= 0 ? anchorIdx : 0) - RELATED_CONTEXT_L0_NEIGHBORS);
          const end = Math.min(windowRows.length, (anchorIdx >= 0 ? anchorIdx : 0) + RELATED_CONTEXT_L0_NEIGHBORS + 1);
          const slice = windowRows.slice(start, end);
          for (const row of slice) {
            const marker = hit.source_message_ids.includes(row.record_id) ? "★" : " ";
            L0Lines.push(`  ${marker} [${row.role}] ${snippetize(row.message_text, RELATED_CONTEXT_L0_SNIPPET_CHARS)}`);
          }
        } else {
          // No window helper — fall back to just the source rows themselves.
          for (const row of sourceRows) {
            L0Lines.push(`  ★ [${row.role}] ${snippetize(row.message_text, RELATED_CONTEXT_L0_SNIPPET_CHARS)}`);
          }
        }
      }
    }

    // 2) Fallback: legacy hit (no source_message_ids) — use timestamp_start/end.
    if (L0Lines.length === 0 && typeof vectorStore.queryL0InWindow === "function") {
      const startMs = Date.parse(hit.timestamp_start || "");
      const endMs = Date.parse(hit.timestamp_end || "");
      const center = Number.isFinite(startMs) && Number.isFinite(endMs)
        ? (startMs + endMs) / 2
        : (Number.isFinite(startMs) ? startMs : endMs);
      if (Number.isFinite(center)) {
        const fromIso = new Date(center - RELATED_CONTEXT_L0_TIME_WINDOW_MS).toISOString();
        const toIso = new Date(center + RELATED_CONTEXT_L0_TIME_WINDOW_MS).toISOString();
        const windowRows = await vectorStore.queryL0InWindow(
          hit.session_key || fallbackSessionKey,
          fromIso,
          toIso,
          RELATED_CONTEXT_L0_NEIGHBORS * 2 + 1,
        );
        for (const row of windowRows) {
          L0Lines.push(`  · [${row.role}] ${snippetize(row.message_text, RELATED_CONTEXT_L0_SNIPPET_CHARS)}`);
        }
      }
    }

    if (L0Lines.length > 0) {
      const header = `· 关于"${snippetize(hit.content, 60)}" 的相邻对话片段：`;
      perHitBlocks.push(`${header}\n${L0Lines.join("\n")}`);
    }
  }

  // ── Option D: sibling L1 per unique scene ──
  const scenes = [...new Set(hits.map((h) => h.scene_name).filter(Boolean))];
  const siblingBlocks: string[] = [];
  let siblingsTaken = 0;
  for (const scene of scenes) {
    if (siblingsTaken >= RELATED_CONTEXT_L1_TOTAL_CAP) break;
    const remaining = RELATED_CONTEXT_L1_TOTAL_CAP - siblingsTaken;
    const perSceneCap = Math.min(RELATED_CONTEXT_L1_PER_SCENE, remaining);
    const siblings = await vectorStore.queryL1Records({
      sceneName: scene,
      minPriority: RELATED_CONTEXT_L1_MIN_PRIORITY,
      limit: perSceneCap + seenL1Ids.size, // over-fetch a bit to account for filtering
    });

    const filteredSiblings = siblings
      .filter((s) => !seenL1Ids.has(s.record_id))
      .slice(0, perSceneCap);

    if (filteredSiblings.length === 0) continue;

    const lines = filteredSiblings.map((s) => {
      seenL1Ids.add(s.record_id);
      siblingsTaken++;
      return `  · [${s.type}] ${snippetize(s.content, 160)} (priority=${s.priority})`;
    });
    siblingBlocks.push(`· 同场景"${scene}"下的相关记忆：\n${lines.join("\n")}`);
  }

  if (perHitBlocks.length === 0 && siblingBlocks.length === 0) {
    logger?.debug?.(`${TAG} [related-context] no enrichment available`);
    return undefined;
  }

  const sections: string[] = [];
  if (perHitBlocks.length > 0) {
    sections.push(`## 相邻对话上下文 (来自原始消息)\n${perHitBlocks.join("\n\n")}`);
  }
  if (siblingBlocks.length > 0) {
    sections.push(`## 同场景关联记忆\n${siblingBlocks.join("\n\n")}`);
  }

  let body = sections.join("\n\n");
  if (body.length > RELATED_CONTEXT_TOTAL_CHAR_BUDGET) {
    body = `${body.slice(0, RELATED_CONTEXT_TOTAL_CHAR_BUDGET - 1)}…`;
    logger?.debug?.(`${TAG} [related-context] truncated to ${RELATED_CONTEXT_TOTAL_CHAR_BUDGET} chars`);
  }

  return `<related-context>\n以下是基于上方记忆扩展出的相邻对话片段与同场景记忆，仅作为补充参考：\n\n${body}\n</related-context>`;
}
