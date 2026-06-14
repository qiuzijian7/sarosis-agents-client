/**
 * TDAI Adapters — barrel re-export for host adapter implementations.
 *
 * saros 本地化构建中只保留 standalone 适配器（OpenClaw 适配器已剔除）。
 * 详见 vendor/tdbam/COPY_MANIFEST.md 第 2 节。
 *
 * Directory structure:
 *   adapters/
 *   └── standalone/    — Gateway / saros sidecar (HTTP, OpenAI-compatible API)
 */

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";
