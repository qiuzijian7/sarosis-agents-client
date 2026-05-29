/**
 * StandaloneLLMRunner — powered by Vercel AI SDK (`ai` + `@ai-sdk/openai`).
 *
 * This runner does NOT depend on OpenClaw's `runEmbeddedPiAgent`. It is designed
 * for the Hermes Gateway scenario where TDAI runs as an independent Node.js sidecar
 * without the OpenClaw host.
 *
 * Capabilities:
 * - `enableTools: false`: pure text output (L1 extraction, L1 dedup)
 * - `enableTools: true`: automatic tool-call loop with local file operations
 *   (L2 scene, L3 persona) via AI SDK's `maxSteps`
 *
 * Tool sandbox:
 *   When tools are enabled, three basic file operations are exposed:
 *   `read_file`, `write_to_file`, `replace_in_file`.
 *   All file paths are resolved relative to `workspaceDir`, enforcing sandbox boundaries.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";
import { generateText, tool, stepCountIs, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { report } from "../../core/report/reporter.js";
import type {
  LLMRunner,
  LLMRunParams,
  LLMRunnerFactory,
  LLMRunnerCreateOptions,
  Logger,
} from "../../core/types.js";

const TAG = "[memory-tdai] [standalone-runner]";

// Max iterations in the tool-call loop to prevent infinite loops
const MAX_TOOL_ITERATIONS = 20;

// ============================
// Configuration
// ============================

export interface StandaloneLLMConfig {
  /** OpenAI-compatible API base URL (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Default model name (e.g. "gpt-4o"). */
  model: string;
  /** Default max output tokens. */
  maxTokens?: number;
  /** Request timeout in milliseconds (default: 120_000). */
  timeoutMs?: number;
}

// ============================
// Sandboxed tool execution helpers
// ============================

function resolveSandboxedPath(workspaceDir: string, relativePath: string): string | null {
  const resolved = path.resolve(workspaceDir, relativePath);
  if (!resolved.startsWith(path.resolve(workspaceDir))) {
    return null;
  }
  return resolved;
}

// ============================
// Tool definitions (Vercel AI SDK `tool()` format)
// ============================

function createSandboxedTools(workspaceDir: string, logger?: Logger) {
  return {
    read_file: tool({
      description: "Read the contents of a file at the given relative path.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to read." },
        },
        required: ["path"],
      }),
      execute: (async (args: { path: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          return await fsPromises.readFile(resolved, "utf-8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} read_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    write_to_file: tool({
      description: "Write content to a file at the given relative path. Creates or overwrites.",
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to write." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
      }),
      execute: (async (args: { path: string; content: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
          await fsPromises.writeFile(resolved, args.content, "utf-8");
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} write_to_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    replace_in_file: tool({
      description: "Replace an exact substring in a file with new content.",
      inputSchema: jsonSchema<{ path: string; old_str: string; new_str: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path." },
          old_str: { type: "string", description: "Exact string to find and replace." },
          new_str: { type: "string", description: "Replacement string." },
        },
        required: ["path", "old_str", "new_str"],
      }),
      execute: (async (args: { path: string; old_str: string; new_str: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        if (!args.old_str) return JSON.stringify({ error: "old_str cannot be empty." });
        try {
          const existing = await fsPromises.readFile(resolved, "utf-8");
          if (!existing.includes(args.old_str)) {
            return JSON.stringify({ error: `old_str not found in file "${args.path}".` });
          }
          const updated = existing.replace(args.old_str, args.new_str);
          await fsPromises.writeFile(resolved, updated, "utf-8");
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} replace_in_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),
  };
}

/** Read-only tool subset — used when enableTools=false to avoid empty tools rejection. */
function createReadOnlyTools(workspaceDir: string, logger?: Logger) {
  const all = createSandboxedTools(workspaceDir, logger);
  return { read_file: all.read_file };
}

// ============================
// StandaloneLLMRunner
// ============================

export class StandaloneLLMRunner implements LLMRunner {
  private config: StandaloneLLMConfig;
  private model: string;
  private enableTools: boolean;
  private logger?: Logger;

  constructor(opts: {
    config: StandaloneLLMConfig;
    model?: string;
    enableTools?: boolean;
    logger?: Logger;
  }) {
    this.config = opts.config;
    this.model = opts.model ?? opts.config.model;
    this.enableTools = opts.enableTools ?? false;
    this.logger = opts.logger;
  }

  async run(params: LLMRunParams): Promise<string> {
    const runStartMs = Date.now();
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs ?? 120_000;
    const maxTokens = params.maxTokens ?? this.config.maxTokens ?? 4096;
    const workspaceDir = params.workspaceDir ?? process.cwd();

    // ── sarosis local-first build (Q3 + Q4) ──
    // 让 sarosis IDE 注入的环境变量覆盖 config 中的 LLM 参数，使 TDB-AM 的所有
    // LLM 调用（L1 抽取、L1 dedup、L2 场景、L3 画像）跟随用户当前 Chat 选定的
    // 模型，统一走 sarosis 的 Knot 桥（登录态鉴权）。
    //
    //   TDBAM_LLM_BASE_URL — Knot 桥的 OpenAI-compatible endpoint
    //   TDBAM_LLM_API_KEY  — sarosis 注入的临时 token（登录态）
    //   TDBAM_LLM_MODEL    — 用户当前 Chat 选用的模型 ID
    //
    // 这三个变量缺失时回退到 config（保留 standalone 独立运行能力）。
    const baseURL = process.env.TDBAM_LLM_BASE_URL?.trim() || this.config.baseUrl;
    const apiKey = process.env.TDBAM_LLM_API_KEY?.trim() || this.config.apiKey;
    const effectiveModel = process.env.TDBAM_LLM_MODEL?.trim() || this.model;

    this.logger?.debug?.(
      `${TAG} run() start: taskId=${params.taskId}, model=${effectiveModel}, ` +
      `tools=${this.enableTools}, timeout=${timeoutMs}ms, ` +
      `bridge=${process.env.TDBAM_LLM_BASE_URL ? "sarosis-knot" : "config"}`,
    );

    // Create OpenAI-compatible provider via AI SDK.
    // sarosis 本地化构建：@ai-sdk/openai v3.x 已默认 OpenAI-compatible 模式（无 compatibility 字段）。
    // 走 /chat/completions 端点，兼容 DeepSeek/Qwen/Knot 桥等。
    const provider = createOpenAI({
      baseURL,
      apiKey,
    });

    // enableTools=false（L1 提取、L1 dedup）：
    // 直接用原生 fetch 调用 /chat/completions 并传 tool_choice:"none"，
    // 彻底禁止 Knot 调用工具，强制纯文本输出。
    // 不能用 AI SDK generateText，因为 Knot 是 agentic 模型，
    // 即使不传 tools 也会自己生成工具调用格式的输出。
    if (!this.enableTools) {
      const messages: Array<{ role: string; content: string }> = [];
      if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
      }
      messages.push({ role: "user", content: params.prompt });

      const chatUrl = baseURL.replace(/\/$/, "") + "/chat/completions";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(chatUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: effectiveModel,
            messages,
            max_tokens: maxTokens,
            tool_choice: "none",
          }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        }
        const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
        const text = json.choices?.[0]?.message?.content?.trim() ?? "";
        const totalMs = Date.now() - runStartMs;
        this.logger?.debug?.(`${TAG} run() completed (no-tool fetch): ${totalMs}ms, output=${text.length} chars`);
        return text;
      } finally {
        clearTimeout(timer);
      }
    }

    const tools = createSandboxedTools(workspaceDir, this.logger);

    try {
      const result = await generateText({
        model: provider.chat(effectiveModel),
        system: params.systemPrompt,
        prompt: params.prompt,
        tools,
        stopWhen: stepCountIs(MAX_TOOL_ITERATIONS),
        maxOutputTokens: maxTokens,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });

      const text = result.text.trim();
      const totalMs = Date.now() - runStartMs;

      this.logger?.debug?.(
        `${TAG} run() completed: ${totalMs}ms, steps=${result.steps.length}, output=${text.length} chars`,
      );

      // Log tool usage if any
      if (result.steps.length > 1) {
        const toolCalls = result.steps.flatMap((s) => s.toolCalls ?? []);
        this.logger?.debug?.(
          `${TAG} Tool calls: ${toolCalls.map((tc) => tc.toolName).join(", ")}`,
        );
      }

      // Metric
      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: effectiveModel,
          inputLength: params.prompt.length,
          outputLength: text.length,
          totalDurationMs: totalMs,
          success: true,
          error: null,
        });
      }

      return text;
    } catch (err) {
      const totalMs = Date.now() - runStartMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger?.error(`${TAG} run() failed after ${totalMs}ms: ${errMsg}`);

      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: effectiveModel,
          inputLength: params.prompt.length,
          outputLength: 0,
          totalDurationMs: totalMs,
          success: false,
          error: errMsg,
        });
      }

      throw err;
    }
  }
}

// ============================
// StandaloneLLMRunnerFactory
// ============================

export interface StandaloneLLMRunnerFactoryOptions {
  /** LLM API configuration. */
  config: StandaloneLLMConfig;
  /** Logger instance. */
  logger?: Logger;
}

/**
 * Factory that creates StandaloneLLMRunner instances.
 *
 * Used by the Gateway and Hermes host adapters.
 */
export class StandaloneLLMRunnerFactory implements LLMRunnerFactory {
  private config: StandaloneLLMConfig;
  private logger?: Logger;

  constructor(opts: StandaloneLLMRunnerFactoryOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const enableTools = opts?.enableTools ?? false;
    const modelRef = opts?.modelRef;

    // Parse "provider/model" → just use the model part for OpenAI-compatible API
    let model = this.config.model;
    if (modelRef) {
      const slashIdx = modelRef.indexOf("/");
      model = slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;
    }

    this.logger?.debug?.(
      `${TAG} Creating StandaloneLLMRunner: model=${model}, tools=${enableTools}`,
    );

    return new StandaloneLLMRunner({
      config: this.config,
      model,
      enableTools,
      logger: this.logger,
    });
  }
}
