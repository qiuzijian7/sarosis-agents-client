/*---------------------------------------------------------------------------------------------
 *  InlineGateway — saros 进程内 TDB-AM 网关。
 *
 *  本文件是一层薄包装，负责：
 *    1. 设置 TDB-AM 真实实现需要的环境变量（端口/数据目录/Knot 桥地址等）
 *    2. 实例化 vendor/tdbam 的 TdaiGateway 并启动
 *    3. 暴露 start() / stop() 接口供 extension.ts 调用
 *
 *  与早期"5KB 内存 Map"占位实现的区别：
 *    - 真正接入 vendor/tdbam 的 L0/L1/L2/L3 完整记忆栈
 *    - LLM 调用通过 saros Knot 桥（OpenAI-compatible，跟随用户当前 Chat 模型）
 *    - 召回走 SQLite FTS5（向量已禁用，对应 Q7=A 决策）
 *
 *  详细路线图：参见 extensions/tdb-am-gateway/vendor/tdbam/COPY_MANIFEST.md
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

// ── 关于 vendor 的引用方式 ──
// saros 顶层 gulpfile 用 tsgo（TypeScript Native Preview）编译扩展，
// 它在处理 vendor/tdbam/** 这种 130+ 文件 + Node16 ESM 的大依赖图时
// 会段错误崩溃（exit code 0xC0000005）。
//
// 解决：
//   1. tsconfig.json 只 include src/**，让 tsgo 看不到 vendor
//   2. 本文件不再 *静态* import vendor 源码，改为运行时动态 import 编译产物
//   3. vendor 由 tsconfig.vendor.json + `npm run compile:vendor` 单独预编译
//
// 类型方面：用本地 minimal interface 替代 TdaiGateway 的真实类型，避免
// 把 vendor 整棵 d.ts 拉进来。
interface TdaiGatewayLike {
	start(): Promise<void>;
	stop(): Promise<void>;
}
type TdaiGatewayCtor = new (config: unknown) => TdaiGatewayLike;

/** 与 vendor TdaiGateway 共用的运行参数。 */
export interface GatewayOptions {
	/** Gateway 自身监听端口（默认 8420）。 */
	port: number;
	/** TDB-AM 数据落盘目录（SQLite + L0 jsonl 等）。 */
	dataDir: string;
	/** 日志回调（写到 OutputChannel）。 */
	logger: (msg: string) => void;

	/**
	 * Knot 桥的 OpenAI-compatible 地址（含 /v1）。
	 * 例：http://127.0.0.1:8421/v1
	 *
	 * 由 tdb-am-viewer 扩展启动 KnotBridge 后注入；若空，TDB-AM 内的 LLM 调用
	 * 会走 vendor 默认的 https://api.openai.com/v1（基本上会失败，便于尽早暴露
	 * "Knot 桥未就绪"的问题）。
	 */
	knotBridgeBaseUrl?: string;

	/**
	 * Knot agent id（被注入到 LLM 请求的 model 字段）。
	 * 与 Knot 桥的 /v1/chat/completions 内 model→agent 映射对齐。
	 */
	knotAgentId?: string;

	/**
	 * 召回策略。Q7=A 决策下应固定为 'keyword'（FTS5）。
	 * 仍允许覆盖以方便未来引入第三方 mem 向量插件。
	 */
	recallStrategy?: 'keyword' | 'hybrid' | 'embedding';
}

/**
 * saros 端 InlineGateway —— vendor TdaiGateway 的薄包装。
 *
 * 维持与早期占位实现一致的对外 API（start / stop），让 extension.ts 不需要变更。
 */
export class InlineGateway {
	private gateway: TdaiGatewayLike | undefined;
	private options: GatewayOptions;
	/** 真实启动时使用的 dataDir（在 start 时确定，便于诊断 / 健康检查）。 */
	private resolvedDataDir = '';

	constructor(options: GatewayOptions) {
		this.options = options;
		// 确保数据目录存在（vendor 内部也会建，但提前建可以更早暴露权限错误）。
		fs.mkdirSync(options.dataDir, { recursive: true });
	}

	async start(): Promise<void> {
		this.resolvedDataDir = path.resolve(this.options.dataDir);

		// ── 注入 TDB-AM 真实实现需要的环境变量 ──
		// 与 vendor 内 src/gateway/config.ts 的 env 读取顺序保持一致：
		//   TDAI_GATEWAY_PORT / TDAI_DATA_DIR / TDAI_LLM_BASE_URL / ...
		//
		// 同时注入 vendor llm-runner 的 saros 适配变量（来自阶段 2 的 Q3/Q4 改造）：
		//   TDBAM_LLM_BASE_URL / TDBAM_LLM_API_KEY / TDBAM_LLM_MODEL
		// 二者并存：vendor gateway 用 TDAI_*，llm-runner 用 TDBAM_* —— 设置两套以兼容。
		this.injectEnv();

		try {
			// 动态 import vendor 预编译产物。
			//
			// 关键背景：
			//   - 本文件被 saros VSCode 扩展宿主以 CommonJS 加载（tsc 输出 CJS）。
			//     out/package.json 显式标记 "type":"commonjs" 以截断向上爬到主仓
			//     "type":"module"。这意味着运行时 __dirname / require 都可用，
			//     而 ESM-only 的 import.meta 在 CJS 中会抛 SyntaxError，绝对不能用。
			//   - vendor 是 ESM 编译输出（out/vendor/package.json 标记 "type":"module"），
			//     所以这里用 dynamic `await import(file://...)` 跨 module 系统加载。
			//
			// vendor 产物可能位于多个候选路径（独立编译 vs saros 主框架部署），
			// 我们逐个探测并取第一个存在的。
			const { pathToFileURL } = await import('url');

			// CJS 全局变量 __dirname：本文件所在目录。
			// 在所有可能的运行环境（vscode ext host、独立 node 测试）下都可用。
			const here = (typeof __dirname !== 'undefined' ? __dirname : '');
			this.options.logger(`vendor 解析: here=${here || '<未知>'}`);

			// ── 候选路径列表 ──
			const candidates: string[] = [];
			if (here) {
				// 候选 1：与本文件同级 ./vendor/...（独立编译产物布局）
				candidates.push(path.join(here, 'vendor', 'tdbam', 'src', 'gateway', 'server.js'));
				// 候选 2：从 here 往上爬若干级，找到 extensions/tdb-am-gateway/out/vendor/...
				// 主框架部署：here = <repo>/out/vs/extensions/tdb-am-gateway/src
				//   → 上 5 级到 <repo>，再拼 extensions/tdb-am-gateway/out/vendor/...
				let probe = here;
				for (let i = 0; i < 8 && probe; i++) {
					const guess = path.join(probe, 'extensions', 'tdb-am-gateway', 'out', 'vendor', 'tdbam', 'src', 'gateway', 'server.js');
					candidates.push(guess);
					const parent = path.dirname(probe);
					if (parent === probe) break;
					probe = parent;
				}
			}

			// 候选 3：通过 process.cwd() 兜底（开发模式 cwd 通常就是工程根）。
			candidates.push(path.join(process.cwd(), 'extensions', 'tdb-am-gateway', 'out', 'vendor', 'tdbam', 'src', 'gateway', 'server.js'));

			// ── 找第一个存在的路径 ──
			let vendorPath = '';
			for (const c of candidates) {
				this.options.logger(`vendor 候选: ${c} ${fs.existsSync(c) ? '✅' : '❌'}`);
				if (!vendorPath && fs.existsSync(c)) {
					vendorPath = c;
				}
			}
			if (!vendorPath) {
				throw new Error(
					`找不到 vendor server.js。请在 extensions/tdb-am-gateway 运行 npm run compile:vendor 后重启。已尝试: ${candidates.join(' | ')}`,
				);
			}
			this.options.logger(`vendor 实际加载: ${vendorPath}`);

			const vendorUrl = pathToFileURL(vendorPath).href;
			const mod = await import(vendorUrl);
			const TdaiGatewayCtor = mod.TdaiGateway as TdaiGatewayCtor;
			if (typeof TdaiGatewayCtor !== 'function') {
				throw new Error(`vendor module 未导出 TdaiGateway；exports=[${Object.keys(mod || {}).join(',') || '<empty>'}]`);
			}

			this.gateway = new TdaiGatewayCtor({
				server: {
					port: this.options.port,
					host: '127.0.0.1',
				},
				data: {
					baseDir: this.resolvedDataDir,
				},
				// llm/memory 字段由 loadGatewayConfig 内部根据环境变量解析
			} /* Partial<GatewayConfig> 的 server/data 子集，其它走环境变量 */);

			await this.gateway.start();
			this.options.logger(`内嵌 TDB-AM 网关启动在端口 ${this.options.port}`);
			this.options.logger(`  数据目录: ${this.resolvedDataDir}`);
			this.options.logger(`  Knot 桥: ${this.options.knotBridgeBaseUrl ?? '(未配置)'}`);
			this.options.logger(`  召回策略: ${this.options.recallStrategy ?? 'keyword'}`);
		} catch (err) {
			const e = err as Error;
			const msg = e?.message ?? String(err);
			const stack = e?.stack ?? '<no stack>';
			this.options.logger(`网关启动失败: ${msg}`);
			this.options.logger(`  Stack: ${stack}`);
			try { console.error('[tdb-am-gateway/inlineGateway] start 失败', err); } catch { /* ignore */ }
			throw err;
		}
	}

	async stop(): Promise<void> {
		if (!this.gateway) return;
		try {
			await this.gateway.stop();
			this.options.logger('网关已关闭');
		} catch (err) {
			this.options.logger(`网关关闭失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.gateway = undefined;
		}
	}

	/**
	 * 写入 vendor TdaiGateway 启动需要的环境变量。
	 *
	 * 注意：所有变量都是 *进程级*，saros 是单进程，因此影响范围仅限本扩展，
	 * 不会污染其他扩展。
	 */
	private injectEnv(): void {
		const knotBaseUrl = this.options.knotBridgeBaseUrl?.trim();
		const knotModel = this.options.knotAgentId?.trim() || 'knot-default';

		// ── vendor gateway/config.ts 的环境变量入口 ──
		process.env.TDAI_GATEWAY_PORT = String(this.options.port);
		process.env.TDAI_GATEWAY_HOST = '127.0.0.1';
		process.env.TDAI_DATA_DIR = this.resolvedDataDir;

		// LLM = Knot 桥（OpenAI 兼容）。Knot 桥未就绪时仍写入占位值，避免 vendor
		// 的 fallback 走真实 OpenAI 域名。
		process.env.TDAI_LLM_BASE_URL = knotBaseUrl || 'http://127.0.0.1:8421/v1';
		process.env.TDAI_LLM_API_KEY = 'saros-knot-bridge-token';
		process.env.TDAI_LLM_MODEL = knotModel;

		// 关闭向量路径（Q7=A）。
		process.env.TDAI_EMBEDDING_PROVIDER = 'none';
		process.env.TDAI_EMBEDDING_ENABLED = 'false';
		process.env.TDAI_STORE_BACKEND = 'sqlite';
		process.env.TDAI_RECALL_STRATEGY = this.options.recallStrategy ?? 'keyword';

		// ── vendor adapters/standalone/llm-runner.ts 的 saros 适配变量 ──
		// 与 TDAI_* 并存：llm-runner 优先读 TDBAM_*，找不到再读 config 里转译过的
		// TDAI_* 值，二者一致即可。
		process.env.TDBAM_LLM_BASE_URL = process.env.TDAI_LLM_BASE_URL;
		process.env.TDBAM_LLM_API_KEY = process.env.TDAI_LLM_API_KEY;
		process.env.TDBAM_LLM_MODEL = process.env.TDAI_LLM_MODEL;
	}

	/** 暴露给 extension.ts 使用：当前实际生效的数据目录。 */
	get dataDir(): string {
		return this.resolvedDataDir || this.options.dataDir;
	}

	/** 暴露给 extension.ts 使用：是否在运行。 */
	get isRunning(): boolean {
		return !!this.gateway;
	}
}
