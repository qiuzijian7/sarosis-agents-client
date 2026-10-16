# 0004 patch 覆写行寻址不存在的 id 静默忽略

**日期**：2026-10（dsh 技能体系对账期确认）
**状态**：规则已立（见 doc/dsh-patch-semantics.html §2 语义 4）

## 现象
`cordis.patch.yml` 里覆写官方行的 config 没有生效，无任何报错。

## 根因
patch 语义：按 `id` 寻址，**行不存在时静默忽略**；且覆写是整份 config 替换。上游官方行改名（或 id 拼错）后，我们的覆写行成为死配置。同名对经正文 hash 实测为静默。

## 修复
- 确立规则：覆写官方行是例外（现仅 agents 覆写 `agent-preset-registry` 一处先例），必须重述整份 config
- 覆写行必须配守卫：断言目标 id 的行在 base/bundle patch 中存在

## 永久守卫 / 教训
- patch 语义已文档化：`doc/dsh-patch-semantics.html`（五条核心语义 + 行级 inject 门控 + disabled 语义）
- **教训**：组合层的「静默」是默认行为（静默忽略、静默 pending、静默不渲染）；凡依赖 patch 生效的功能，都要有一处能断言「它真的生效了」的探针。
