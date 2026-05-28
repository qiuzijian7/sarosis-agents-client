/**
 * TDAI Gateway — Request/Response types for the HTTP API.
 */

// ============================
// Common
// ============================

export interface GatewayErrorResponse {
  error: string;
  code?: string;
}

// ============================
// /health
// ============================

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
}

// ============================
// /recall
// ============================

export interface RecallRequest {
  query: string;
  session_key: string;
  user_id?: string;
}

export interface RecallResponse {
  context: string;
  strategy?: string;
  memory_count?: number;
}

// ============================
// /capture
// ============================

export interface CaptureRequest {
  user_content: string;
  assistant_content: string;
  session_key: string;
  session_id?: string;
  user_id?: string;
  messages?: unknown[];
}

export interface CaptureResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
}

// ============================
// /search/memories
// ============================

export interface MemorySearchRequest {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface MemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
}

// ============================
// /search/conversations
// ============================

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  session_key?: string;
}

export interface ConversationSearchResponse {
  results: string;
  total: number;
}

// ============================
// /session/end
// ============================

export interface SessionEndRequest {
  session_key: string;
  user_id?: string;
}

export interface SessionEndResponse {
  flushed: boolean;
}

// ============================
// /seed
// ============================

/**
 * Request body for `POST /seed`.
 *
 * Accepts the same input formats as the CLI `seed` command:
 * - Format A: `{ sessions: [{ sessionKey, conversations: [[...msgs]] }] }`
 * - Format B: `[{ sessionKey, conversations: [[...msgs]] }]`
 *
 * Wrapped in an envelope with optional control fields.
 */
export interface SeedRequest {
  /**
   * Seed input data — either Format A object or Format B array.
   * This is the same structure accepted by `openclaw memory-tdai seed --input`.
   */
  data: unknown;
  /** Fallback session key when input sessions lack one. */
  session_key?: string;
  /** Require each round to have both user and assistant messages. */
  strict_round_role?: boolean;
  /** Auto-fill missing timestamps (default: true). */
  auto_fill_timestamps?: boolean;
  /** Plugin config overrides (deep-merged on top of gateway memory config). */
  config_override?: Record<string, unknown>;
}

export interface SeedResponse {
  sessions_processed: number;
  rounds_processed: number;
  messages_processed: number;
  l0_recorded: number;
  duration_ms: number;
  output_dir: string;
}

// ============================
// /inject/l1
// ============================

/**
 * 单条内联记忆（由 Knot 在回复中直接输出，拦截层提取后 POST 到此端点）。
 */
export interface InjectL1Item {
  /** 记忆内容 */
  content: string;
  /** 记忆类型：persona / episodic / instruction */
  type: "persona" | "episodic" | "instruction";
  /** 优先级：0-100，-1 表示严格全局指令 */
  priority?: number;
  /** 情境名称（可选） */
  scene_name?: string;
  /** 类型相关元数据（可选，episodic 可含 activity_start_time / activity_end_time） */
  metadata?: Record<string, unknown>;
}

export interface InjectL1Request {
  /** 会话 key */
  session_key: string;
  /** 会话 ID（可选） */
  session_id?: string;
  /** 要直接写入 L1 的记忆列表 */
  memories: InjectL1Item[];
}

export interface InjectL1Response {
  /** 成功写入的记忆条数 */
  stored: number;
  /** 跳过的记忆条数（内容为空或类型非法） */
  skipped: number;
}
