/**
 * TDAI Gateway — HTTP server for the Hermes sidecar.
 *
 * Exposes TDAI Core capabilities as HTTP endpoints:
 *   GET  /health              — Health check
 *   POST /recall              — Memory recall (prefetch)
 *   POST /capture             — Conversation capture (sync_turn)
 *   POST /search/memories     — L1 memory search (FTS/vector keyword)
 *   POST /search/conversations — L0 conversation search (FTS/vector keyword)
 *   POST /list/conversations  — L0 raw events full dump (no query, recent N)
 *   POST /list/memories       — L1/L2/L3 full dump by type (no query, recent N)
 *   POST /session/end         — Session end + flush
 *   POST /seed               — Batch seed historical conversations (L0 → L1)
 *   POST /admin/l1/reextract — Manual L1 re-extraction (rewind cursor + run)
 *
 * Built with Node.js native `http` module — no Express/Fastify dependency.
 * Designed to run as a managed sidecar alongside Hermes.
 */

import http from "node:http";
import { URL } from "node:url";
import { TdaiCore } from "../core/tdai-core.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { loadGatewayConfig } from "./config.js";
import type { GatewayConfig } from "./config.js";
import { initDataDirectories } from "../utils/pipeline-factory.js";
import { SessionFilter } from "../utils/session-filter.js";
import type {
  HealthResponse,
  RecallRequest,
  RecallResponse,
  CaptureRequest,
  CaptureResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  SessionEndRequest,
  SessionEndResponse,
  SeedRequest,
  SeedResponse,
  InjectL1Request,
  InjectL1Response,
  GatewayErrorResponse,
} from "./types.js";
import { writeMemory, generateMemoryId } from "../core/record/l1-writer.js";
import type { MemoryType } from "../core/record/l1-writer.js";
import type { Logger } from "../core/types.js";
import { validateAndNormalizeRaw, fillTimestamps, SeedValidationError } from "../core/seed/input.js";
import { executeSeed } from "../core/seed/seed-runtime.js";
import type { SeedProgress } from "../core/seed/types.js";

const TAG = "[tdai-gateway]";
const VERSION = "0.1.0";

// ============================
// Console logger (for standalone gateway — no OpenClaw logger available)
// ============================

function createConsoleLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(`${TAG} ${msg}`),
    info: (msg: string) => console.info(`${TAG} ${msg}`),
    warn: (msg: string) => console.warn(`${TAG} ${msg}`),
    error: (msg: string) => console.error(`${TAG} ${msg}`),
  };
}

// ============================
// Request body parser
// ============================

async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message } satisfies GatewayErrorResponse);
}

// ============================
// Gateway Server
// ============================

export class TdaiGateway {
  private config: GatewayConfig;
  private logger: Logger;
  private core: TdaiCore;
  private server: http.Server | null = null;
  private startTime = Date.now();

  constructor(configOverrides?: Partial<GatewayConfig>) {
    this.config = loadGatewayConfig(configOverrides);
    this.logger = createConsoleLogger();

    // Create host adapter
    const adapter = new StandaloneHostAdapter({
      dataDir: this.config.data.baseDir,
      llmConfig: this.config.llm,
      logger: this.logger,
      platform: "gateway",
    });

    // Create core
    this.core = new TdaiCore({
      hostAdapter: adapter,
      config: this.config.memory,
      sessionFilter: new SessionFilter(this.config.memory.capture.excludeAgents),
    });
  }

  /**
   * Start the Gateway HTTP server.
   */
  async start(): Promise<void> {
    // Initialize data directories
    initDataDirectories(this.config.data.baseDir);

    // Initialize core
    await this.core.initialize();

    // Create HTTP server
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    const { port, host } = this.config.server;

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.startTime = Date.now();
        this.logger.info(`Gateway listening on http://${host}:${port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /**
   * Gracefully stop the Gateway.
   */
  async stop(): Promise<void> {
    this.logger.info("Shutting down gateway...");

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    await this.core.destroy();
    this.logger.info("Gateway stopped");
  }

  // ============================
  // Request router
  // ============================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = url.pathname;

    // CORS headers (for development)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      switch (`${method} ${pathname}`) {
        case "GET /health":
          return this.handleHealth(res);
        case "POST /recall":
          return await this.handleRecall(req, res);
        case "POST /capture":
          return await this.handleCapture(req, res);
        case "POST /search/memories":
          return await this.handleSearchMemories(req, res);
        case "POST /search/conversations":
          return await this.handleSearchConversations(req, res);
        case "POST /list/conversations":
          return await this.handleListConversations(req, res);
        case "POST /list/memories":
          return await this.handleListMemories(req, res);
        case "POST /session/end":
          return await this.handleSessionEnd(req, res);
        case "POST /seed":
          return await this.handleSeed(req, res);
        case "POST /admin/l1/reextract":
          return await this.handleAdminL1Reextract(req, res);
        case "POST /admin/l1/rescan-l0":
          return await this.handleAdminL1RescanL0(req, res);
        case "POST /inject/l1":
          return await this.handleInjectL1(req, res);
        case "POST /distill/l2":
          return await this.handleDistillL2(req, res);
        case "POST /distill/l3":
          return await this.handleDistillL3(req, res);
        case "POST /delete/conversation":
          return await this.handleDeleteConversation(req, res);
        case "POST /delete/memory":
          return await this.handleDeleteMemory(req, res);
        default:
          sendError(res, 404, `Not found: ${method} ${pathname}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Request error [${method} ${pathname}]: ${msg}`);
      sendError(res, 500, msg);
    }
  }

  // ============================
  // Route handlers
  // ============================

  private handleHealth(res: http.ServerResponse): void {
    const response: HealthResponse = {
      status: this.core.getVectorStore() ? "ok" : "degraded",
      version: VERSION,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      stores: {
        vectorStore: !!this.core.getVectorStore(),
        embeddingService: !!this.core.getEmbeddingService(),
      },
    };
    sendJson(res, 200, response);
  }

  private async handleRecall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<RecallRequest>(req);

    if (!body.query || !body.session_key) {
      sendError(res, 400, "Missing required fields: query, session_key");
      return;
    }

    const startMs = Date.now();
    const result = await this.core.handleBeforeRecall(body.query, body.session_key);
    const elapsed = Date.now() - startMs;

    this.logger.info(`Recall completed in ${elapsed}ms: context=${(result.appendSystemContext?.length ?? 0)} chars`);

    const response: RecallResponse = {
      context: result.appendSystemContext ?? "",
      strategy: result.recallStrategy,
      memory_count: result.recalledL1Memories?.length ?? 0,
    };
    sendJson(res, 200, response);
  }

  private async handleCapture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<CaptureRequest>(req);

    if (!body.user_content || !body.assistant_content || !body.session_key) {
      sendError(res, 400, "Missing required fields: user_content, assistant_content, session_key");
      return;
    }

    const startMs = Date.now();
    const result = await this.core.handleTurnCommitted({
      userText: body.user_content,
      assistantText: body.assistant_content,
      messages: body.messages ?? [
        { role: "user", content: body.user_content },
        { role: "assistant", content: body.assistant_content },
      ],
      sessionKey: body.session_key,
      sessionId: body.session_id,
    });
    const elapsed = Date.now() - startMs;

    this.logger.info(`Capture completed in ${elapsed}ms: l0=${result.l0RecordedCount}`);

    const response: CaptureResponse = {
      l0_recorded: result.l0RecordedCount,
      scheduler_notified: result.schedulerNotified,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchMemories(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<MemorySearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const result = await this.core.searchMemories({
      query: body.query,
      limit: body.limit,
      type: body.type,
      scene: body.scene,
    });

    const response: MemorySearchResponse = {
      results: result.text,
      total: result.total,
      strategy: result.strategy,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchConversations(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<ConversationSearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const result = await this.core.searchConversations({
      query: body.query,
      limit: body.limit,
      sessionKey: body.session_key,
    });

    const response: ConversationSearchResponse = {
      results: result.text,
      total: result.total,
    };
    sendJson(res, 200, response);
  }

  // ──────────────────────────────────────────────────────────────────────
  //  /list/* — query-free full dumps for UI inspection panels.
  //
  //  Why these exist (separate from /search/*):
  //    The L0/L1/L2/L3 inspection panel needs to "show what's there" without
  //    a query string. /search/conversations and /search/memories require a
  //    non-empty query and run through FTS/vector matching, which by design
  //    returns nothing for placeholder queries like "*".
  //
  //  These endpoints bypass search and read the underlying store directly:
  //    - L0  : IMemoryStore.getAllL0Texts()
  //    - L1  : IMemoryStore.getAllL1Texts()
  //    - L2/L3 : IMemoryStore.pullProfiles()  (filtered by type)
  //
  //  All return the raw rows the store has; the caller is expected to
  //  truncate / format on its side. We still honour an optional `limit`
  //  for safety against giant dumps.
  // ──────────────────────────────────────────────────────────────────────

  private async handleListConversations(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    type ListConversationsRequest = { limit?: number };
    const body = await parseJsonBody<ListConversationsRequest>(req).catch(() => ({} as ListConversationsRequest));
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 500) : 50;

    const store = this.core.getVectorStore();
    if (!store) {
      sendJson(res, 200, { results: "", items: [], total: 0 });
      return;
    }

    try {
      // Prefer the rich row reader when available — it gives us role / session_key
      // / timestamp so the UI can render per-turn collapsible items. Fall back
      // to the text-only reader otherwise.
      type RichRow = {
        record_id: string;
        session_key: string;
        session_id: string;
        role: string;
        message_text: string;
        recorded_at: string;
        timestamp: number;
      };

      let items: RichRow[] = [];
      let totalAll = 0;

      if (typeof store.getAllL0Rows === "function") {
        const all = await store.getAllL0Rows();
        totalAll = all.length;
        // store already sorts by timestamp DESC; defensive copy + slice.
        items = all.slice(0, limit);
      } else {
        const all = await store.getAllL0Texts();
        totalAll = all.length;
        const sorted = [...all].sort((a, b) => (b.recorded_at ?? "").localeCompare(a.recorded_at ?? ""));
        items = sorted.slice(0, limit).map((r) => ({
          record_id: r.record_id,
          session_key: "",
          session_id: "",
          role: "",
          message_text: r.message_text,
          recorded_at: r.recorded_at,
          timestamp: 0,
        }));
      }

      // Backwards-compatible flat string (still used by older clients).
      const results = items
        .map((r) => `[${r.recorded_at}] ${r.role ? `(${r.role}) ` : ""}${r.message_text}`)
        .join("\n---\n");

      sendJson(res, 200, { results, items, total: totalAll });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`/list/conversations failed: ${msg}`);
      sendJson(res, 200, { results: "", items: [], total: 0, error: msg });
    }
  }

  private async handleListMemories(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    type ListMemoriesRequest = { type?: "L1" | "L2" | "L3"; limit?: number };
    const body = await parseJsonBody<ListMemoriesRequest>(req).catch(() => ({} as ListMemoriesRequest));
    const type = body.type ?? "L1";
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 500) : 50;

    const store = this.core.getVectorStore();
    if (!store) {
      sendJson(res, 200, { results: "", items: [], total: 0, type });
      return;
    }

    try {
      if (type === "L1") {
        const all = await store.getAllL1Texts();
        const sorted = [...all].sort((a, b) => (b.updated_time ?? "").localeCompare(a.updated_time ?? ""));
        const trimmed = sorted.slice(0, limit);
        const items = trimmed.map((r) => ({
          id: r.record_id,
          title: r.updated_time ?? "",
          subtitle: "",
          content: r.content,
          timestamp: r.updated_time ?? "",
        }));
        const results = trimmed
          .map((r) => `[${r.updated_time}] ${r.content}`)
          .join("\n---\n");
        sendJson(res, 200, { results, items, total: all.length, type });
        return;
      }

      // L2 / L3 → profile rows
      if (typeof store.pullProfiles !== "function") {
        sendJson(res, 200, { results: "", items: [], total: 0, type, note: "store has no pullProfiles()" });
        return;
      }
      const profiles = await store.pullProfiles();
      const wanted = type === "L2" ? "l2" : "l3";
      const filtered = profiles.filter((p) => p.type === wanted);
      const sorted = [...filtered].sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
      const trimmed = sorted.slice(0, limit);
      const items = trimmed.map((p) => {
        const ts = new Date(p.updatedAtMs).toISOString();
        return {
          id: p.id,
          title: p.filename,
          subtitle: ts,
          content: p.content,
          timestamp: ts,
        };
      });
      const results = trimmed
        .map((p) => {
          const ts = new Date(p.updatedAtMs).toISOString();
          return `[${ts}] ${p.filename}\n${p.content}`;
        })
        .join("\n---\n");
      sendJson(res, 200, { results, items, total: filtered.length, type });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`/list/memories failed: ${msg}`);
      sendJson(res, 200, { results: "", items: [], total: 0, type, error: msg });
    }
  }

  private async handleSessionEnd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SessionEndRequest>(req);

    if (!body.session_key) {
      sendError(res, 400, "Missing required field: session_key");
      return;
    }

    await this.core.handleSessionEnd(body.session_key);

    const response: SessionEndResponse = { flushed: true };
    sendJson(res, 200, response);
  }

  private async handleSeed(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SeedRequest>(req);

    if (!body.data) {
      sendError(res, 400, "Missing required field: data");
      return;
    }

    // Validate and normalize input (reuses seed CLI's validation layers 2-6)
    let input;
    try {
      input = validateAndNormalizeRaw(body.data, {
        sessionKey: body.session_key,
        strictRoundRole: body.strict_round_role,
        autoFillTimestamps: body.auto_fill_timestamps ?? true,
      });
    } catch (err) {
      if (err instanceof SeedValidationError) {
        sendJson(res, 400, {
          error: err.message,
          validation_errors: err.errors,
        });
        return;
      }
      throw err;
    }

    this.logger.info(
      `Seed request: ${input.sessions.length} session(s), ` +
      `${input.totalRounds} round(s), ${input.totalMessages} message(s)`,
    );

    // Resolve output directory: use gateway's data dir with a timestamped subfolder
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputDir = `${this.config.data.baseDir}/seed-${ts}`;

    // Merge config overrides if provided
    // Start with the base memory config + inject llm config from gateway settings
    const baseConfig = this.config.memory as unknown as Record<string, unknown>;
    let pluginConfig: Record<string, unknown> = {
      ...baseConfig,
      llm: {
        enabled: true,
        baseUrl: this.config.llm.baseUrl,
        apiKey: this.config.llm.apiKey,
        model: this.config.llm.model,
        maxTokens: this.config.llm.maxTokens,
        timeoutMs: this.config.llm.timeoutMs,
      },
    };
    if (body.config_override) {
      for (const key of Object.keys(body.config_override)) {
        const baseVal = pluginConfig[key];
        const overVal = body.config_override[key];
        if (baseVal && typeof baseVal === "object" && !Array.isArray(baseVal) &&
          overVal && typeof overVal === "object" && !Array.isArray(overVal)) {
          pluginConfig[key] = { ...(baseVal as Record<string, unknown>), ...(overVal as Record<string, unknown>) };
        } else {
          pluginConfig[key] = overVal;
        }
      }
    }

    // Execute seed pipeline (blocking — this may take minutes for large inputs)
    const summary = await executeSeed(input, {
      outputDir,
      openclawConfig: {},
      pluginConfig,
      logger: this.logger as import("../utils/pipeline-factory.js").PipelineLogger,
      onProgress: (progress: SeedProgress) => {
        this.logger.debug?.(
          `Seed progress: [${progress.currentRound}/${progress.totalRounds}] ` +
          `session=${progress.sessionKey} stage=${progress.stage}`,
        );
      },
    });

    this.logger.info(
      `Seed complete: sessions=${summary.sessionsProcessed}, rounds=${summary.roundsProcessed}, ` +
      `l0=${summary.l0RecordedCount}, duration=${(summary.durationMs / 1000).toFixed(1)}s`,
    );

    const response: SeedResponse = {
      sessions_processed: summary.sessionsProcessed,
      rounds_processed: summary.roundsProcessed,
      messages_processed: summary.messagesProcessed,
      l0_recorded: summary.l0RecordedCount,
      duration_ms: summary.durationMs,
      output_dir: summary.outputDir,
    };
    sendJson(res, 200, response);
  }

  /**
   * POST /inject/l1 — 直接写入 L1 记忆（绕过 LLM 蒸馏，由 Knot 内联输出的记忆标签触发）。
   *
   * 请求体：
   *   {
   *     "session_key": string,   // 必填
   *     "session_id":  string,   // 可选
   *     "memories": [
   *       { "content": string, "type": "persona"|"episodic"|"instruction",
   *         "priority": number, "scene_name": string, "metadata": {} }
   *     ]
   *   }
   *
   * 响应：
   *   { "stored": number, "skipped": number }
   */
  private async handleInjectL1(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<InjectL1Request>(req).catch(() => ({} as InjectL1Request));

    if (!body.session_key || !Array.isArray(body.memories) || body.memories.length === 0) {
      sendError(res, 400, "Missing required fields: session_key, memories (non-empty array)");
      return;
    }

    const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction"];
    let stored = 0;
    let skipped = 0;
    const startMs = Date.now();

    for (const item of body.memories) {
      if (!item.content || typeof item.content !== "string" || item.content.trim().length === 0) {
        skipped++;
        continue;
      }
      const memType = VALID_TYPES.includes(item.type as MemoryType) ? (item.type as MemoryType) : null;
      if (!memType) {
        this.logger.warn(`/inject/l1 skipped item: invalid type "${item.type}"`);
        skipped++;
        continue;
      }

      try {
        const record = await writeMemory({
          memory: {
            content: item.content.trim(),
            type: memType,
            priority: typeof item.priority === "number" ? item.priority : 70,
            source_message_ids: [],
            metadata: (item.metadata && typeof item.metadata === "object" ? item.metadata : {}) as Record<string, never>,
            scene_name: typeof item.scene_name === "string" ? item.scene_name : "Knot内联记忆",
          },
          decision: {
            record_id: generateMemoryId(),
            action: "store",
            target_ids: [],
          },
          baseDir: this.config.data.baseDir,
          sessionKey: body.session_key,
          sessionId: body.session_id,
          vectorStore: this.core.getVectorStore(),
          embeddingService: this.core.getEmbeddingService(),
        });
        if (record) {
          stored++;
        } else {
          skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`/inject/l1 writeMemory failed: ${msg}`);
        skipped++;
      }
    }

    const elapsed = Date.now() - startMs;
    this.logger.info(`/inject/l1 completed in ${elapsed}ms: stored=${stored} skipped=${skipped}`);

    const response: InjectL1Response = { stored, skipped };
    sendJson(res, 200, response);
  }

  /**
   * POST /admin/l1/rescan-l0 — 从 L0 历史对话中扫描 <memory_extract> 标签，直接补写 L1（不调 LLM）。
   *
   * 请求体：
   *   {
   *     "session_key": string   // 可选，不传则扫描所有 session
   *   }
   *
   * 响应：
   *   { "scanned": number, "stored": number, "skipped": number }
   */
  private async handleAdminL1RescanL0(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    type RescanRequest = { session_key?: string };
    const body = await parseJsonBody<RescanRequest>(req).catch(() => ({} as RescanRequest));

    const store = this.core.getVectorStore();
    if (!store || typeof store.getAllL0Rows !== "function") {
      sendError(res, 503, "Store not ready or getAllL0Rows not supported");
      return;
    }

    const startMs = Date.now();
    let scanned = 0;
    let stored = 0;
    let skipped = 0;

    try {
      const allRows = await store.getAllL0Rows() as Array<{
        record_id: string;
        session_key: string;
        session_id?: string;
        role: string;
        message_text: string;
        recorded_at: string;
      }>;

      // 过滤：只处理 assistant 消息，可选按 session_key 过滤
      const rows = allRows.filter(r =>
        r.role === "assistant" &&
        r.message_text &&
        r.message_text.includes("<memory_extract>") &&
        (!body.session_key || r.session_key === body.session_key)
      );

      const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction"];

      for (const row of rows) {
        scanned++;
        // 解析 <memory_extract>JSON</memory_extract> 标签
        const extractTagRe = /<memory_extract>([\s\S]*?)<\/memory_extract>/g;
        let match: RegExpExecArray | null;
        while ((match = extractTagRe.exec(row.message_text)) !== null) {
          try {
            const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
            const content = typeof parsed["content"] === "string" ? parsed["content"].trim() : "";
            const type = parsed["type"] as MemoryType;
            if (!content || !VALID_TYPES.includes(type)) {
              skipped++;
              continue;
            }
            const record = await writeMemory({
              memory: {
                content,
                type,
                priority: typeof parsed["priority"] === "number" ? parsed["priority"] as number : 70,
                source_message_ids: [row.record_id],
                metadata: {} as Record<string, never>,
                scene_name: typeof parsed["scene_name"] === "string" ? parsed["scene_name"] as string : "L0补写",
              },
              decision: {
                record_id: generateMemoryId(),
                action: "store",
                target_ids: [],
              },
              baseDir: this.config.data.baseDir,
              sessionKey: row.session_key,
              sessionId: row.session_id,
              vectorStore: this.core.getVectorStore(),
              embeddingService: this.core.getEmbeddingService(),
            });
            if (record) { stored++; } else { skipped++; }
          } catch {
            skipped++;
          }
        }
      }

      const elapsed = Date.now() - startMs;
      this.logger.info(`/admin/l1/rescan-l0 completed in ${elapsed}ms: scanned=${scanned} stored=${stored} skipped=${skipped}`);
      sendJson(res, 200, { scanned, stored, skipped, duration_ms: elapsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`/admin/l1/rescan-l0 failed: ${msg}`);
      sendError(res, 500, msg);
    }
  }

  /**
   * POST /distill/l2 — 立即触发指定 session 的 L2 场景蒸馏。
   *
   * 请求体：{ "session_key": string }
   * 响应：  { "triggered": true, "session_key": string }
   */
  private async handleDistillL2(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    type DistillL2Request = { session_key?: string };
    const body = await parseJsonBody<DistillL2Request>(req).catch(() => ({} as DistillL2Request));

    if (!body.session_key) {
      sendError(res, 400, "Missing required field: session_key");
      return;
    }

    await this.core.triggerDistillL2(body.session_key);
    this.logger.info(`/distill/l2 triggered for session=${body.session_key}`);
    sendJson(res, 200, { triggered: true, session_key: body.session_key });
  }

  /**
   * POST /distill/l3 — 立即触发全局 L3 画像蒸馏。
   *
   * 请求体：{} （无必填字段）
   * 响应：  { "triggered": true }
   */
  private async handleDistillL3(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await this.core.triggerDistillL3();
    this.logger.info(`/distill/l3 triggered`);
    sendJson(res, 200, { triggered: true });
  }

  /**
   * POST /admin/l1/reextract — manual L1 re-extraction.
   *
   * Rewinds the L1 cursor for a session and forces an L1 pipeline run that
   * reads the L0 messages from the rewound point and re-extracts memories.
   *
   * Request body:
   *   {
   *     "session_key": string,   // required
   *     "since_ms":    number,   // optional, default 0 (full rescan)
   *     "dry_run":     boolean   // optional, default false (only rewind cursor)
   *   }
   *
   * Response:
   *   {
   *     "session_key":      string,
   *     "previous_cursor":  number,   // cursor value before rewind (epoch ms)
   *     "new_cursor":       number,   // cursor value after rewind (= since_ms)
   *     "dry_run":          boolean,
   *     "processed_count":  number    // L0 messages re-scanned (0 in dry-run)
   *   }
   */
  private async handleAdminL1Reextract(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    type ReextractRequest = { session_key?: string; since_ms?: number; dry_run?: boolean };
    const body = await parseJsonBody<ReextractRequest>(req).catch(() => ({} as ReextractRequest));

    if (!body.session_key) {
      sendError(res, 400, "Missing required field: session_key");
      return;
    }

    const sinceMs = typeof body.since_ms === "number" && body.since_ms >= 0 ? body.since_ms : 0;
    const dryRun = body.dry_run === true;

    const startMs = Date.now();
    try {
      const result = await this.core.reextractL1(body.session_key, sinceMs, dryRun);
      const elapsed = Date.now() - startMs;
      this.logger.info(
        `/admin/l1/reextract session=${result.sessionKey} cursor ${result.previousCursor} → ${result.newCursor} ` +
        `dryRun=${result.dryRun} processed=${result.processedCount} elapsed=${elapsed}ms`,
      );
      sendJson(res, 200, {
        session_key: result.sessionKey,
        previous_cursor: result.previousCursor,
        new_cursor: result.newCursor,
        dry_run: result.dryRun,
        processed_count: result.processedCount,
        duration_ms: elapsed,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`/admin/l1/reextract failed: ${msg}`);
      sendError(res, 500, msg);
    }
  }

  /**
   * POST /delete/conversation — delete one or more L0 conversation rows by record_id.
   *
   * Request body:
   *   { "record_ids": string[] }   // required, non-empty
   *
   * Response:
   *   {
   *     "deleted":  number,         // count of rows successfully removed
   *     "failed":   string[],       // record_ids the store reported as not deleted
   *     "missing":  number          // ids that didn't exist (informational)
   *   }
   *
   * Notes:
   *   - Each delete clears metadata + vec0 + FTS5 in a single transaction
   *     (see VectorStore.deleteL0 implementation).
   *   - Failures are best-effort logged and never abort the whole batch.
   */
  private async handleDeleteConversation(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    type DeleteConversationRequest = { record_ids?: string[] };
    const body = await parseJsonBody<DeleteConversationRequest>(req).catch(() => ({} as DeleteConversationRequest));

    const ids = Array.isArray(body.record_ids)
      ? body.record_ids.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
    if (ids.length === 0) {
      sendError(res, 400, "Missing or empty field: record_ids");
      return;
    }

    const store = this.core.getVectorStore();
    if (!store) {
      sendError(res, 503, "Vector store unavailable");
      return;
    }

    let deleted = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const ok = await store.deleteL0(id);
        if (ok) deleted++;
        else failed.push(id);
      } catch (err) {
        failed.push(id);
        this.logger.warn(`/delete/conversation failed for id=${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.logger.info(`/delete/conversation requested=${ids.length} deleted=${deleted} failed=${failed.length}`);
    sendJson(res, 200, { deleted, failed, missing: ids.length - deleted - failed.length });
  }

  /**
   * POST /delete/memory — delete one or more L1 memory rows by record_id.
   *
   * Request body:
   *   {
   *     "type":       "L1",          // currently only L1 supported (L2/L3 are profile rows)
   *     "record_ids": string[]
   *   }
   *
   * Response:
   *   { "deleted": number, "failed": string[] }
   *
   * L2/L3 deletion is intentionally NOT exposed here — those rows live in the
   * profile sync table and removing them out-of-band would desync the host's
   * profile cache. Callers that really need to delete a profile should go
   * through the profile-sync path.
   */
  private async handleDeleteMemory(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    type DeleteMemoryRequest = { type?: string; record_ids?: string[] };
    const body = await parseJsonBody<DeleteMemoryRequest>(req).catch(() => ({} as DeleteMemoryRequest));

    const type = (body.type ?? "L1").toUpperCase();
    if (type !== "L1") {
      sendError(res, 400, `Unsupported type: ${body.type}. Only L1 is currently supported.`);
      return;
    }

    const ids = Array.isArray(body.record_ids)
      ? body.record_ids.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
    if (ids.length === 0) {
      sendError(res, 400, "Missing or empty field: record_ids");
      return;
    }

    const store = this.core.getVectorStore();
    if (!store) {
      sendError(res, 503, "Vector store unavailable");
      return;
    }

    // deleteL1Batch wraps the whole operation in a single SQLite transaction.
    // Treat its boolean return as "all-or-nothing for the supplied ids".
    let ok = false;
    try {
      ok = await store.deleteL1Batch(ids);
    } catch (err) {
      this.logger.warn(`/delete/memory L1 batch failed: ${err instanceof Error ? err.message : String(err)}`);
      ok = false;
    }

    if (!ok) {
      sendJson(res, 200, { deleted: 0, failed: ids });
      return;
    }

    this.logger.info(`/delete/memory L1 batch deleted=${ids.length}`);
    sendJson(res, 200, { deleted: ids.length, failed: [] });
  }
}

// ============================
// CLI entry point
// ============================

/**
 * Start the gateway from the command line.
 * Usage: node --import tsx src/gateway/server.ts
 */
async function main(): Promise<void> {
  const gateway = new TdaiGateway();

  // Graceful shutdown
  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();
}

// Auto-start when run directly
const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  main().catch((err) => {
    console.error("Gateway startup failed:", err);
    process.exit(1);
  });
}
