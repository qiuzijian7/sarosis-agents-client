/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 技能注册表**同名冲突的告警纪律**（2026-10-13 决策三的降噪半边）。
 *
 * 起因：`_setSkillWithPriority` 对"同级来源（builtin=1 / extension=1、marketplace=2 / user=2）"
 * 此前**一律 warn** ✗ —— 典型现场是同一个技能在多个用户目录里各存一份（本机实测
 * `~/.agents/skills` 与 `~/.claude/skills` 有 **31 个同名、`SKILL.md` 逐字节相同** ⇒ 每次 reload
 * 刷 31 行无信息量告警 ✗）。这正是当初决定停扫生态目录的两个理由之一 ✓。
 *
 * 现在：内容一致 ⇒ 静默取先者 ✓；内容不同 ⇒ **一行** WARN（附两侧路径，见
 * `skillRegistryDuplicateNoise.test.ts` 的断言）✓。
 *
 * 为什么是**源码级**守卫：本仓 `SkillRegistryService` 没有可用的测试脚手架 —— 技能类测试
 * （`skillInjectionBudget` / `skillSourceLabel` / `skillToolsBm25` / `skillVersionService` …）
 * 全部针对 `common/` 里的**纯函数** ✓（2026-10-13 核查过 ✗ 没有构造 service 的先例）。
 * 这里的守卫因此**依赖语句顺序**（`sameContent` 判定 ⇒ 先 return ⇒ 才 warn），
 * 反向突变（删掉静默分支 / 把 return 挪到 warn 之后）会让它变红 ✓。
 * 后续若要更强：把这段判定抽成 `common/` 下的纯函数（`decideSkillOverride`）再补行为用例 ✓。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';

const REL = 'src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts';

suite('SkillRegistry 同名冲突：内容一致静默 / 内容不同才告警', () => {
	const src = (() => {
		const abs = join(process.cwd(), REL);
		return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
	})();

	test('★ 同级来源分支：先比内容 ⇒ 一致就 return ⇒ 不一致才 warn（顺序即语义）', () => {
		assert.ok(src.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）—— 守卫不能空跑`);

		const sameAt = src.indexOf('const sameContent = computeSkillContentHash(');
		assert.ok(sameAt > 0, '同级冲突必须先判内容（用同文件里那个本来就为此写的 computeSkillContentHash ✓）');

		const earlyReturn = src.indexOf('return;', sameAt);
		const warnAt = src.indexOf('内容不同）：保留', sameAt);
		assert.ok(warnAt > 0, '内容不同时的那条 WARN 不见了（改名/改文案就要同步改这条守卫）');
		assert.ok(earlyReturn > sameAt, '内容一致的分支必须**先 return**（否则又会刷无信息量告警 ✗）');
		assert.ok(earlyReturn < warnAt, '静默分支必须在 WARN **之前**（顺序反了 = 静默失效 ✗）');

		// 旧的"同级一律 warn"文案不得复活（它是 31 行刷屏的源头 ✗）
		assert.doesNotMatch(src, /同级来源 \$\{skill\.source\}）：保留/,
			'旧的"同级一律告警"文案不得复活 —— 它是当年 31 行刷屏的源头');
	});

	test('内容指纹用的是同文件里既有的那个纯函数（不另引实现）', () => {
		assert.match(src, /function computeSkillContentHash\(prompt: string\): string \{/,
			'应复用既有的 computeSkillContentHash（它的注释就写着"判断不同目录下同名 skill 是否内容完全一致"）');
	});
});
