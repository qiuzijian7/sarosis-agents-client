/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 平台更新服务 `IUpdateService.State`（12 态）→ app 更新 8 相状态机事件的**唯一映射表**。
 *
 * 为什么抽出来（2026-11-23）：原来这段 switch 长在 `dshHarnessService._onUpdateServiceState()`
 * 里，是「12 态 → 8 相」的唯一映射点但**不可单测**，且 `Overwriting` / `Restarting` 这些
 * 平台专有态没有对应 phase，只能落进 `downloading` / `downloaded`；平台一旦新增 `StateType`，
 * switch 会静默什么都不做 ⇒ UI 停在上一相。改成穷尽映射表后：
 *  · 新增 `StateType` 时 `StateMapperTable` **编译期缺键报错**，不会再静默漂移；
 *  · 每张表都是纯函数 ⇒ 可以用假状态序列跑行为测试（与 `dshUpdateWait.ts` 同口径）。
 *
 * ⚠ 两条必须保留的口径：
 *  ① 普通 `Idle`（没有 `error` / `notAvailable`）返回 `undefined` ⇒ 不迁移，否则一次无关的
 *     空闲回跳会把用户还没点「更新」的 `available` 冲掉 ✗；
 *  ② `Disabled` 映射成 `unsupported`（不是 `error`），文案要说「手动下载安装包覆盖安装」。
 *
 * 本项目 `update.mode=manual`，启动 8s 的静默检查走主进程 HTTP、不经过 `IUpdateService`
 * ⇒ 这里来的状态基本都由用户动作触发，自动状态不会弹卡片 ✓。
 */

import { IUpdate, State, StateType } from '../../../../platform/update/common/update.js';
import { AppUpdateEvent, percentFromBytes } from './appUpdateState.js';

type StateOf<K extends StateType> = Extract<State, { type: K }>;
type StateMapper<K extends StateType> = (state: StateOf<K>, releaseNotes?: string) => AppUpdateEvent | undefined;
type StateMapperTable = { [K in StateType]: StateMapper<K> };

/** `productVersion` 是人可读版本；平台给的 `version` 是 commit，只在缺前者时兜底。 */
const versionOf = (update: IUpdate): string => update.productVersion ?? update.version;

/** 拿不到总字节数时不猜百分比 ⇒ 页面走不确定进度条。 */
const downloading = (percent: number | undefined): AppUpdateEvent =>
	percent === undefined ? { type: 'downloading' } : { type: 'downloading', percent };

const MAPPERS: StateMapperTable = {
	[StateType.Uninitialized]: () => undefined,
	[StateType.Idle]: s => s.error
		? { type: 'error', message: s.error }
		: s.notAvailable ? { type: 'not-available' } : undefined,
	[StateType.Disabled]: () => ({ type: 'unsupported', message: '这个构建不支持自动更新，请手动下载安装包覆盖安装' }),
	[StateType.CheckingForUpdates]: s => ({ type: 'check', manual: s.explicit, source: s.explicit ? 'manual' : 'runtime' }),
	[StateType.AvailableForDownload]: (s, notes) => ({
		type: 'available', version: versionOf(s.update),
		...(notes ? { releaseNotes: notes } : {}),
	}),
	[StateType.Downloading]: s => downloading(percentFromBytes(s.downloadedBytes, s.totalBytes)),
	[StateType.Updating]: s => downloading(percentFromBytes(s.currentProgress, s.maxProgress)),
	[StateType.Overwriting]: () => ({ type: 'downloading' }),
	[StateType.Downloaded]: s => ({ type: 'downloaded', version: versionOf(s.update) }),
	[StateType.Ready]: s => ({ type: 'downloaded', version: versionOf(s.update) }),
	[StateType.Restarting]: s => ({ type: 'downloaded', version: versionOf(s.update) }),
};

/** 诊断 / 守卫用：`StateType` 是 const enum（运行时不存在），只能从表的键取覆盖清单。 */
export const APP_UPDATE_MAPPED_STATE_TYPES: readonly string[] = Object.keys(MAPPERS);

/** 平台状态 → 状态机事件；`undefined` = 不迁移（不是「出错」）。 */
export function mapUpdateServiceState(state: State, releaseNotes?: string): AppUpdateEvent | undefined {
	// 判别联合按 state.type 索引后参数类型会退化成交叉类型；每支 mapper 只处理自己的那一支，
	// 因此这里按 `(State, notes)` 调用是安全的，真正的安全由上面的穷尽映射表保证。
	const mapper = MAPPERS[state.type] as (s: State, notes?: string) => AppUpdateEvent | undefined;
	return mapper(state, releaseNotes);
}
