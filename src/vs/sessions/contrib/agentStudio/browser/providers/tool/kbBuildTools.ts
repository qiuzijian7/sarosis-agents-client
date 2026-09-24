/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `kb_build` —— 让 agent 能**发起知识库构建**（★ 2026-09-24）。
 *
 * ## 为什么需要
 *
 * 构建（把「库」里的素材归纳成「笔记」）此前**只有 UI 入口**：
 * 「知识库视图 → 库分区 → 批量构建库」或素材右键「构建为笔记」。
 * 于是任何「素材先落库、再构建」的链路走到最后一步都会卡住 —— 典型是技能
 * `kb-game-teardown`：拆解报告落进 `库/raw` 之后，agent 只能叫用户自己去点按钮
 * （甚至因为"我没有触发构建的工具"而干脆不写素材、直接在聊天里输出一段结论）。
 *
 * ## 语义（两个 mode，默认只读）
 *
 * · `mode:'preview'`（默认）：只列出**待构建素材**（口径与真实构建完全一致，见
 *   `KbImportController.previewPendingSources`），**不启动任何会话**。
 *   用途：回答「要不要构建到笔记」之前先给出准确数量与清单。
 * · `mode:'build'`：真正发起构建 —— 走 `buildPendingAsAgentSession`（与 UI 按钮同一条路径：
 *   在「知识库专家」agent 里**新建一个聊天会话**，agent 自己 `file_read` 素材、`file_write`
 *   笔记，随后补链/门控/导航）。
 *
 * ## 为什么 `build` 立即返回（不 await）
 *
 * 构建是**分钟级**长任务（每份素材都是若干轮 LLM 往返，单批上限 20 份）。若在工具里 await：
 * 调用方那一轮对话会被卡住数分钟（用户只看到转圈），且发生在**另一个** agent 会话里的进度
 * 完全看不到。故：**发起即返回**，把「已开始 + 张数 + 去哪看进度」如实回报，由调用方转述给
 * 用户；完成/失败由控制器自己发通知（`buildPendingAsAgentSession` 内部已负责），
 * 本工具另在 `.then/.catch` 里补一条日志与失败通知（避免"失败了没人知道"）。
 *
 * ## 两道护栏
 *
 * · **前置检查**：`kbAgentConfigState === 'missing'`（知识库专家没配 Provider/模型）⇒
 *   直接拒绝并给出可执行指引，而不是让用户在几分钟后看到"没有产出"；
 * · **互斥**：`KbImportController.buildInFlight` 为真 ⇒ 拒绝重复发起（UI 按钮与工具
 *   同时发起会各建一个会话、互相覆盖构建缓存与导航文档）。
 */

import type { URI } from '../../../../../../base/common/uri.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import type { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { Severity } from '../../../../../../platform/notification/common/notification.js';
import type { IAgentStudioService } from '../../../../../common/agentStudioService.js';
import { ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent } from '../../../common/providers.js';
import type { IBuiltinToolRegistration } from './toolRegistry.js';
import { KbImportController } from '../../kbImportController.js';

export const KB_BUILD_TOOL_NAME = 'kb_build';

/** 一次构建调用的结果（`start` 的返回值；与控制器 `buildPendingAsAgentSession` 同形）。 */
export interface IKbBuildRunResult {
	readonly pending: number;
	readonly built: number;
	readonly skipped: number;
	readonly systemDoc: string | null;
	readonly usedFallback: boolean;
}

/**
 * 构建运行器 —— 宿主装配（真实装配在 `BuiltinToolProvider._registerKbBuildTools`），
 * 单测注入桩。刻意**只暴露这两个能力**：工具不需要知道 KbImportController 的 9 个依赖。
 */
export interface IKbBuildRunner {
	/** 只读预检：待构建素材（相对「库」的路径）。 */
	preview(): Promise<string[]>;
	/** 发起构建（会等待整批完成 —— 调用方负责不阻塞：见文件头「为什么立即返回」）。 */
	start(): Promise<IKbBuildRunResult>;
	/** 构建是否正在进行（跨 UI 按钮与工具的全局标记）。 */
	isInFlight(): boolean;
}

export interface IKbBuildToolContext {
	register(registration: IBuiltinToolRegistration): void;
	logService: ILogService;
	configurationService: IConfigurationService;
	notificationService: INotificationService;
	studioService: IAgentStudioService;
	/** 解析当前知识库 vault 根（与其它 kb_* 工具同一套；未配置 ⇒ undefined）。 */
	resolveVaultRoot: () => Promise<URI | undefined>;
	/** 造一个构建运行器（每次调用新建 ⇒ 不跨调用共享"本次构建"状态）。 */
	createRunner: (vaultRoot: URI) => IKbBuildRunner;
}

/** 展示用的清单截断：多素材时不要把整个列表灌进上下文。 */
const MAX_LISTED = 20;

export function registerKbBuildTools(ctx: IKbBuildToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
	const fmtList = (items: readonly string[]): string => {
		const head = items.slice(0, MAX_LISTED).map(p => `· ${p}`).join('\n');
		return items.length > MAX_LISTED ? `${head}\n…（共 ${items.length} 份，此处只列前 ${MAX_LISTED} 份）` : head;
	};

	ctx.register({
		definition: {
			name: KB_BUILD_TOOL_NAME,
			description: [
				'把知识库「库」里的素材**构建成笔记**（归纳到「笔记」区，并补链 / 门控 / 维护导航与知识体系）。',
				'',
				'· `mode:"preview"`（**默认**，只读）：列出待构建素材，不启动任何会话 ——',
				'  在问用户「要不要构建到笔记」之前先用它拿到准确数量与清单。',
				'· `mode:"build"`：真正发起构建。它会在「知识库专家」agent 里**新建一个聊天会话**执行',
				'  （与知识库视图的「批量构建库」按钮同一条路径），**发起后立即返回**，',
				'  进度/结果在那个会话与系统通知里可见 —— 你不需要（也无法）在这里等它跑完。',
				'',
				'前置条件：知识库专家已配置 Provider 与模型；否则本工具会拒绝并说明去哪配置。',
				'一次构建只处理「库」中待构建的素材（已构建过的、导航文件会被自动跳过；单批上限 20 份）。',
				'典型用法：素材落库（如拆解报告写进 `库/raw/`）之后 —— 先 preview 汇报，问用户是否构建，',
				'用户同意后再 `mode:"build"`。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					mode: {
						type: 'string',
						enum: ['preview', 'build'],
						description: '"preview"（默认，只读，列出待构建素材）或 "build"（发起构建；长任务，立即返回）',
					},
				},
			},
			category: 'knowledge',
			source: 'saros.builtin-tools',
			// 会在「笔记」区批量写入并由另一个 agent 会话执行 ⇒ 与 kb_organize 同为 Cautious
			securityLevel: ToolSecurityLevel.Cautious,
		},

		handler: async (args, _signal, _agentId) => {
			const mode = args['mode'] === 'build' ? 'build' : 'preview';

			const vaultRoot = await ctx.resolveVaultRoot();
			if (!vaultRoot) {
				return text('未找到知识库：请先在「知识库」视图里选择或新建一个库（或检查 `agentStudio.kb.kbDir` 配置）。');
			}

			const runner = ctx.createRunner(vaultRoot);

			if (mode === 'preview') {
				const pending = await runner.preview();
				if (!pending.length) {
					return {
						content: text('「库」中没有待构建的素材（已构建过的笔记与 index/overview/insights/知识体系 等导航文件会被自动跳过）。'),
						details: { mode, pending: 0 },
					};
				}
				return {
					content: text([
						`待构建素材 ${pending.length} 份：`,
						'',
						fmtList(pending),
						'',
						'如需构建到笔记，请让用户确认后调用本工具（`mode:"build"`）。',
					].join('\n')),
					details: { mode, pending: pending.length, items: pending },
				};
			}

			// ── build ──
			// ① 前置检查：知识库专家没配模型 ⇒ 拒绝（跑起来也只会"没有产出"，用户看不懂）
			if (KbImportController.kbAgentConfigState(ctx.studioService, ctx.configurationService) === 'missing') {
				KbImportController.warnKbAgentNotConfigured(ctx.notificationService, '构建笔记');
				return text('无法构建：「知识库专家」尚未配置 Provider 与模型。\n'
					+ '请在设置里为知识库专家选择可用的模型（与多模态读图用的是同一份配置）后重试。');
			}

			// ② 互斥：已有构建在进行 ⇒ 拒绝重复发起（与视图按钮共享标记）
			if (runner.isInFlight()) {
				return text('已有一个知识库构建正在进行中 —— 请等它跑完（进度在「知识库专家」的聊天会话里），不要重复发起。');
			}

			// ③ 先预检：没有素材就没必要建会话（也就不会弹控制器那条"没有待构建素材"的通知）
			const pending = await runner.preview();
			if (!pending.length) {
				return {
					content: text('「库」中没有待构建的素材，未发起构建。\n'
						+ '（可用「导入链接 / URL」或把素材文件放进 `库/raw` 后再试。）'),
					details: { mode, pending: 0, started: false },
				};
			}

			// ④ 发起（**不 await** —— 见文件头；完成/失败由控制器发通知，这里补日志兜底）
			ctx.logService.info(`[${KB_BUILD_TOOL_NAME}] starting build: pending=${pending.length} vault=${vaultRoot.fsPath}`);
			void runner.start().then(res => {
				ctx.logService.info(
					`[${KB_BUILD_TOOL_NAME}] build finished: pending=${res.pending} built=${res.built}`
					+ `${res.skipped ? ` skipped=${res.skipped}` : ''}${res.usedFallback ? ' (fallback)' : ''}`,
				);
			}).catch((err: unknown) => {
				const reason = err instanceof Error ? err.message : String(err);
				ctx.logService.error(`[${KB_BUILD_TOOL_NAME}] build failed: ${reason}`);
				ctx.notificationService.notify({
					severity: Severity.Error,
					message: `知识库构建失败：${reason}`,
					source: 'kb-build',
				});
			});

			return {
				content: text([
					`已发起知识库构建：${pending.length} 份素材。`,
					'',
					'它在「知识库专家」agent 的新会话里执行（agent 会自己读素材、写笔记，然后补链/门控/维护知识体系），',
					'**耗时可能几分钟** —— 进度在那个会话里可见，完成后会弹系统通知。',
					`（本次最多处理该批素材；若系统提示还有剩余，可再次调用 ${KB_BUILD_TOOL_NAME}。）`,
				].join('\n')),
				details: { mode, pending: pending.length, started: true, vaultRoot: vaultRoot.fsPath },
			};
		},
	});

	ctx.logService.info(`[KbBuildTools] Registered ${KB_BUILD_TOOL_NAME} tool`);
}
