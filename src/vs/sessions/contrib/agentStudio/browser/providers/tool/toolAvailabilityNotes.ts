/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具「依赖就绪度」标注 —— 2026-09-24（P1-4）。
 *
 * ## 为什么是**标注**而不是**隐藏**
 *
 * 本仓原本有两套机制，互不接壤：
 *   ① `registration.available?: () => boolean` —— 注册期同步钩子，`toolRegistry` **已经在强制执行**
 *      （`listTools` / `getAllToolDefinitions` 命中就 `continue`）。但全仓只有 1 处使用
 *      （`coreTools` 里一个恒真的环境判断）。
 *   ② `definition.availability?: IToolAvailability[]` + `toolAvailabilityEvaluator.ts`
 *      （评估/过滤/解释三件套，文件头写着"供 BuiltinToolProvider 和 McpToolProvider 使用"）
 *      —— 但**全仓零消费方**，声明了也不生效（本模块就是它的第一个消费方）。
 *
 * 选②做门控语义、但**只标注不隐藏**，理由是产品性的：
 *   · 没有任何 UI 展示"工具为何不可用"（`explainAvailability` 声称供 UI 用，但无消费方）；
 *   · 本产品的依赖（`ffmpeg` / `yt-dlp` / `lark-cli`）都是**可选**的，缺了很常见；
 *   · 一旦隐藏，模型看不到工具、用户也永远学不到"装个 lark-cli 就行"，只会看到助手
 *     "我做不到"或改用 `web_extract` 去撞飞书登录墙（已知的坏降级）。
 * ⇒ 保留工具可见，但把**一行可执行指引**追加到描述里：模型会先告诉用户怎么装，
 *   而不是白撞一次（工具自身在调用时仍会给完整指引，两条路径不冲突）。
 *
 * ## 关键纪律
 *
 * · **fail-open**：事实未知（还没探完 / 非桌面通道 / 条件名不认识）⇒ 视为可用，不标注。
 *   宁可多显示一个工具，也不要因为"探测没跑完"而误标"不可用"。
 * · **不改共享对象**：注册表每次 `listTools` 都返回新对象；本模块对**无缺口**的定义返回
 *   原引用，只有真缺依赖时才做拷贝 + 改描述（`getAllToolDefinitions` 在 agent loop 热路径上）。
 */

import type { IToolDefinition, IToolAvailability } from '../../../common/providers.js';
import {
	evaluateAvailabilityCondition, createAvailabilityContext,
	type IAvailabilityContext,
} from '../../toolAvailabilityEvaluator.js';

// ─── 能力名（写在工具定义的 `availability[].condition` 上）─────────────────────

/** 媒体工具链：`ffmpeg`（抽帧 / 取时长必需）。 */
export const CAP_MEDIA_FFMPEG = 'media.ffmpeg';
/** 媒体工具链：`yt-dlp`（下载远端视频与字幕；只有链接类输入才必需）。 */
export const CAP_MEDIA_YTDLP = 'media.yt-dlp';
/** 飞书官方 CLI `lark-cli`（读飞书文档 / 评论 / 知识库同步）。 */
export const CAP_FEISHU_LARK_CLI = 'feishu.lark-cli';

/** 所有已知能力（用于守卫测试：防止 condition 名拼错后静默失效）。 */
export const KNOWN_CAPABILITIES: readonly string[] = [CAP_MEDIA_FFMPEG, CAP_MEDIA_YTDLP, CAP_FEISHU_LARK_CLI];

/** 标注前缀。同时作为"是否已标注过"的判据（保证幂等）。 */
export const AVAILABILITY_NOTE_PREFIX = '\n\n⚠ 当前不可用：';

// ─── 事实来源 ───────────────────────────────────────────────────────────────

/**
 * 能力事实表（**同步**读取）。
 *
 * 为什么是同步的：`availability` 的评估发生在 `listTools()` 里（agent loop 热路径，每轮都跑），
 * 不能在那里 await 探测。而真实探测必然是异步的（要 spawn `-version`）——
 * ⇒ 分工：探测在后台跑一次，结果落进这张表；评估时只做内存查表。
 * `undefined` = 未知 ⇒ 按可用处理（fail-open）。
 */
export interface IToolCapabilityFacts {
	get(condition: string): boolean | undefined;
}

/** 用一组 `[能力名, 是否就绪]` 建事实表（`undefined` 项会被忽略 ⇒ 保持未知）。 */
export function createCapabilityFacts(
	entries: Iterable<readonly [string, boolean | undefined]>,
): IToolCapabilityFacts {
	const map = new Map<string, boolean>();
	for (const [key, ok] of entries) {
		if (typeof ok === 'boolean') { map.set(key, ok); }
	}
	return { get: (condition: string) => map.get(condition) };
}

/** 空事实表（全部未知 ⇒ 永不标注）。测试与"尚未探测"时用。 */
export const NO_CAPABILITY_FACTS: IToolCapabilityFacts = { get: () => undefined };

/**
 * 把事实表包成评估器上下文。
 *
 * 只接管 `evaluateCustom`（`config`/`env`/`platform` 三类条件仍走评估器原逻辑），
 * 且 `evaluateCustom` 对未知条件返回 **true**（fail-open；评估器自身对无 `evaluateCustom`
 * 也是这个语义，这里保持一致）。
 */
export function availabilityContextFor(facts: IToolCapabilityFacts): IAvailabilityContext {
	return createAvailabilityContext({
		// 本模块不评估 config/env 条件；给一个恒真取值器，使这两类条件退化为"总满足"
		// （本仓目前没有工具声明这两类条件；将来若要支持，在这里接 configurationService 即可）。
		configGetter: () => true,
		envGetter: () => undefined,
		customEvaluator: condition => facts.get(condition) ?? true,
	});
}

// ─── 文案 ───────────────────────────────────────────────────────────────────

/**
 * 条件 → **一行**可执行提示（不可用时的标注）。
 *
 * 为什么只有一行：它会进入**每个**相关工具的描述（schema 每次都发给模型）⇒ 多行会白白吃掉
 * 上下文预算。完整指引（多行、含排查顺序）由工具在真正调用时返回，两处分工明确。
 * 未知条件返回 undefined（调用方退化为通用的"缺少依赖"文案）。
 */
export function unavailableNotice(condition: string): string | undefined {
	switch (condition) {
		case CAP_MEDIA_FFMPEG:
			return '未检测到 ffmpeg（抽帧/取时长必需）。请先让用户安装（Windows `winget install Gyan.FFmpeg` / '
				+ 'macOS `brew install ffmpeg`），或设 `FFMPEG_PATH` 指向已有可执行文件；安装前不要反复调用本工具。';
		case CAP_MEDIA_YTDLP:
			return '未检测到 yt-dlp：**只能处理本地视频文件**，B 站/YouTube 等链接不可用。'
				+ '请先让用户安装（`pipx install yt-dlp`）或设 `YTDLP_PATH`；也可让用户改为直接提供本地文件路径。';
		case CAP_FEISHU_LARK_CLI:
			return '未检测到飞书 CLI（lark-cli）。请让用户执行 `npx @larksuite/cli@latest install` 后重试；'
				+ '**不要**改用 web_extract 抓飞书文档（只能拿到登录墙/骨架）。';
		default:
			return undefined;
	}
}

/** 去掉已有的标注（幂等：重复标注不会叠加）。 */
function stripNotice(description: string | undefined): string {
	const text = description ?? '';
	const at = text.indexOf(AVAILABILITY_NOTE_PREFIX);
	return at >= 0 ? text.slice(0, at) : text;
}

// ─── 标注 ───────────────────────────────────────────────────────────────────

/** 该定义当前缺哪些能力（已就绪 / 无条件 ⇒ 空数组）。 */
export function availabilityGaps(
	conditions: readonly IToolAvailability[] | undefined,
	context: IAvailabilityContext,
): IToolAvailability[] {
	if (!conditions || conditions.length === 0) { return []; }
	return conditions.filter(c => !evaluateAvailabilityCondition(c, context));
}

/**
 * 给定义列表追加「当前不可用」标注。
 *
 * · 无条件 / 已就绪 ⇒ **返回原对象**（热路径零拷贝）；
 * · 有缺口 ⇒ 新对象 + 描述尾部加一行（先用 `stripNotice` 清掉旧标注）。
 */
export function annotateToolAvailability(
	defs: readonly IToolDefinition[],
	facts: IToolCapabilityFacts,
): IToolDefinition[] {
	const context = availabilityContextFor(facts);
	return defs.map(def => {
		const gaps = availabilityGaps(def.availability, context);
		if (gaps.length === 0) {
			// 已就绪：若描述里还残留旧标注（如上一次列表写入后缓存了同一个对象）则清掉
			const stripped = stripNotice(def.description);
			return stripped === def.description ? def : { ...def, description: stripped };
		}
		const lines = gaps.map(g => {
			const condition = g.condition ?? '';
			return unavailableNotice(condition) ?? `缺少依赖${condition ? `（${condition}）` : ''}。`;
		});
		return {
			...def,
			description: `${stripNotice(def.description)}${AVAILABILITY_NOTE_PREFIX}\n  · ${lines.join('\n  · ')}`,
		};
	});
}
