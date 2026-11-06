// @vssaros/dsh-skill-bundle — 纯数据插件入口。
//
// 技能**不在这里注册**：`cordis.patch.yml` 把包内 `skills/` 挂成官方
// `dsh-skill-filesystem` 的 `bundledSkillDir`（rank 600），由 Host 自己发现。
// 本文件只为满足 dsh 插件「必须有可 import 的入口」这条契约
// （`check-plugin-files.mjs` 会真跑一次 import）；故意不导出 `apply`
// ⇒ `tools-snapshot.mjs` 抽工具面时自然跳过，快照里不会出现一个空插件。

export const name = '@vssaros/dsh-skill-bundle';

/** 空 apply：本行只为满足「patch 插入自己」的装配契约，不注册工具 / 页面 / 服务。 */
export function apply() {}
