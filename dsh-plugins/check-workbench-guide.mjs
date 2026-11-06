#!/usr/bin/env node
// check-workbench-guide.mjs ★ 工作台开发规范守卫（防"规范与实现各说各话"）
//
// 为什么必须有（对齐 dsh-desktop 的 `test/workbench-guide-sync.test.mjs`）：
//   规范一旦变成手维护的散文，就会在实现改动后**静默过期**：
//   文档说"repository 必填"，实现已经支持本地身份 ⇒ Agent 照文档写，被拒绝还找不到原因。
//   所以这里同时守三件事：
//     ① **副本不漂移**：随包副本必须逐字等于 `scripts/build-workbench-guide.mjs` 的生成结果；
//     ② **关键口径不退化成旧说法**：分栏/身份/安装五态/容器查询等必须真的写在规范里；
//     ③ **规范说的能力真的在代码里**：反过来也查一遍（文档超前于实现同样是坑）。
//
// 跑法：node dsh-plugins/check-workbench-guide.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGuideFromSource, SOURCE, TARGET } from '../scripts/build-workbench-guide.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let problems = 0;
const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

// ── ① 副本 ↔ 源：逐字一致 ────────────────────────────────────────────────
const guide = read(TARGET);
const expected = renderGuideFromSource();
if (guide !== expected) {
	fail(`${TARGET} 与 ${SOURCE} 不一致 ⇒ 跑 node scripts/build-workbench-guide.mjs`);
} else {
	ok(`${TARGET} 与源文件逐字一致`);
}

// ── ② 规范必须写明的能力（措辞退化/删段 ⇒ 红）────────────────────────────
const MUST_SAY = [
	['customFrame', '整页工作台的注册字段'],
	['splitConversation', '标准分栏的逃生门（新能力，不许只在代码里有）'],
	['local:<npm 包名>', '本地身份（本地开发不许再要求建仓库）'],
	['install_local_workbench', 'Agent 侧安装工具'],
	['restart-required', '五态之一（安装结果必须按它决定下一步）'],
	['local-installs.json', '安装证据落点（事后排查"装过什么"）'],
	['replace_not_authorized', '已装未授权的覆盖会被拦下（Agent 要知道该怎么接）'],
	['replaceCheck', '覆盖检测的结论字段（unknown ≠ 没有冲突）'],
	['check_local_workbench', '安装前干跑（先于 install_local_workbench）'],
	['不等于「装上能跑」', '干跑的边界（不许把结构通过说成已验证可用）'],
	['install-status', '生效态接口（restart-required 之后怎么确认“是否已加载”）'],
	['--mode external', '外部包脚手架（0 处宿主改动的入口命令）'],
	['@container', '按容器宽度响应（不许用 @media）'],
	['不擅自重启', 'Agent 行为纪律'],
];
for (const [token, why] of MUST_SAY) {
	if (!guide.includes(token)) { fail(`规范里缺「${token}」（${why}）`); }
}
if (!problems) { ok(`规范关键口径齐全（${MUST_SAY.length} 项）`); }

// ── ②b 验收清单的**责任划分**（对齐 dsh-desktop：每条标"宿主负责 / 插件负责"）──────
// 为什么：没有责任列时，出了问题插件作者和宿主互相推（"是你的布局" / "是你的分栏"），
//   最后每个工作台各自绕一遍宿主 bug。有标签 ⇒ 【宿主】项失败时有明确的反馈对象。
{
	const sec = /## 8\. 验收清单([\s\S]*?)(?=\n## 9\.)/.exec(guide);
	if (!sec) {
		fail('规范里找不到「## 8. 验收清单」段（责任列检查空跑）');
	} else {
		const items = sec[1].split('\n').filter(l => /^- \[ \]/.test(l));
		const untagged = items.filter(l => !/^- \[ \] 【(宿主|插件|共同)】/.test(l));
		if (items.length < 12) { fail(`验收清单只有 ${items.length} 条（期望 ≥12，段落被截断？）`); }
		else if (untagged.length) { fail(`验收清单有 ${untagged.length} 条没标责任（【宿主】/【插件】/【共同】）：${untagged.map(l => l.slice(0, 40)).join(' | ')}`); }
		else { ok(`验收清单 ${items.length} 条都标了责任`); }
		const tags = new Set(items.map(l => /【(宿主|插件|共同)】/.exec(l)?.[1]));
		if (!tags.has('宿主') || !tags.has('插件')) { fail('验收清单里【宿主】与【插件】必须都至少出现一次（全标一边 = 划分没有意义）'); }
		for (const must of ['不要在插件里绕', '不得把前者表述成“全部验收通过”']) {
			if (!sec[1].includes(must)) { fail(`验收清单图例缺「${must}」（责任划分的使用规则）`); }
		}
	}
}

// 旧说法必须已被清除（否则 Agent 会照旧口径写）
const MUST_NOT_SAY = [
	'P1 暂按整页渲染',
	'仍切到原生对话',
	'repository 必填',
];
for (const stale of MUST_NOT_SAY) {
	if (guide.includes(stale)) { fail(`规范里还留着过期说法「${stale}」`); }
}

// ── ③ 规范引用的文件必须存在（死链会让 Agent 停在半路）──────────────────
const CITED = [
	'doc/workbench-authoring-standard.md',
	'doc/workbench-carrier-consolidation.md',
	'doc/skill-authoring-standard.md',
	'dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/SKILL.md',
	'dsh-plugins/README.md',
	'dsh-plugins/vssaros-workbenches/lib/client.ui.js',
];
for (const file of CITED) {
	if (!exists(file)) { fail(`规范引用了不存在的文件：${file}`); }
}
if (!problems) { ok(`规范引用的 ${CITED.length} 个文件都存在`); }

// ── ④ 反向：规范说的能力必须真的在实现里 ────────────────────────────────
const clientSrc = read('dsh-plugins/vssaros-workbenches/lib/client.js');
const stateSrc = read('dsh-plugins/vssaros-workbenches/lib/state.js');
const serverSrc = read('dsh-plugins/vssaros-workbenches/lib/index.js');
const pkg = JSON.parse(read('dsh-plugins/vssaros-workbenches/package.json'));

const IMPLEMENTED = [
	['client.js 支持本地身份', clientSrc.includes('LOCAL_SCHEME') && clientSrc.includes('PACKAGE_RE')],
	['client.js 有标准分栏', clientSrc.includes('splitConversation') && clientSrc.includes('conversationMode')],
	['client.js 有左栏停靠点', clientSrc.includes('registerSplitDock')],
	['state.js 接受 local: 身份', stateSrc.includes('LOCAL_ID_RE')],
	['服务端挂载规范路由', serverSrc.includes('development-guide')],
	['服务端挂载生效态路由', serverSrc.includes('install-status') && serverSrc.includes('pendingRestartRecords')],
	['服务端注册干跑工具', serverSrc.includes("name: 'check_local_workbench'") && serverSrc.includes('tools.register(checkLocalWorkbenchTool())')],
	['Host 有覆盖授权闸（已装 + 没授权 ⇒ 拦）', serverSrc.includes("code: 'replace_not_authorized'") && serverSrc.includes("existing.status === 'present' && !replacing")],
	['Host 把覆盖信息交给 IDE（replacing{from,to}）', serverSrc.includes('replacing: { from: existing.installed, to: prepared.version }')],
	['IDE 确认框如实写“覆盖”（唯一会拦人的那一道）', (() => {
		const ide = read('src/vs/sessions/contrib/dshHarness/common/dshIdeCapabilities.ts');
		return ide.includes('覆盖已安装的工作台') && ide.includes("confirmLabel: replacing ? '覆盖' : '安装'");
	})()],
	['脚手架支持 --mode external', (() => {
		const s = read('dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/scripts/scaffold_workbench.mjs');
		return s.includes("flag('mode'") && s.includes("'external'") && s.includes('local:');
	})()],
	['启动器消费生效态（提示用户重启）', read('dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js').includes('data-vssaros-restart-pending')],
	['package.json files 含随包规范', Array.isArray(pkg.files) && pkg.files.includes('lib/workbench-standard.zh.md')],
];
for (const [label, pass] of IMPLEMENTED) {
	if (!pass) { fail(`实现缺失：${label}`); }
}
if (!problems) { ok(`规范描述的 ${IMPLEMENTED.length} 项能力都能在实现里找到`); }

// ── ④b 「制作我的工作台」入口提示词（商城页 `developmentPromptText()`）─────────────────
// 为什么必须守：这段文案是用户**复制给 Agent 的第一句话**，却曾经完全没有守卫 ⇒ 悄悄过期：
//   2026-11-02 之前它要求「公开 GitHub 仓库 + repository 指回本仓库」，而那时本地身份
//   （local:<包名>）已经落地 ⇒ 照它做的 Agent 会去向用户要仓库，甚至编一个仓库地址。
// 两个维度：
//   A. 旧的错误前提不许回来（FORBIDDEN）；
//   B. 提示词里点名的工具 / 路由 / 回执态，必须在 Host 实现里真实存在（不然 Agent 会去调一个不存在的东西）。
{
	const marketSrc = read('dsh-plugins/vssaros-chat-surface/lib/client.market.js');
	const at = marketSrc.indexOf('function developmentPromptText()');
	// 不依赖缩进：以下一个函数 `submissionPromptText` 的声明为界（两者相邻；缩进随外层包装变，不能写死）
	const end = at < 0 ? -1 : marketSrc.indexOf('function submissionPromptText', at);
	if (at < 0 || end < 0) {
		fail('client.market.js 里找不到 developmentPromptText()（入口提示词的守卫会空跑）');
	} else {
		const prompt = marketSrc.slice(at, end);
		const before = problems;

		const FORBIDDEN = [
			['公开 GitHub 仓库', '本地开发不需要仓库（local:<包名> 已落地）'],
			['repository 指回', '本地包不写 repository'],
			['仓库根目录', '同上：别让用户为本地开发建仓库'],
			['暂不支持 monorepo', '那是上架要求，不是本地开发要求'],
			['并带许可证', '同上'],
		];
		for (const [bad, why] of FORBIDDEN) {
			if (prompt.includes(bad)) { fail(`入口提示词里还留着过期说法「${bad}」（${why}）`); }
		}

		// 必须出现的纪律（缺哪条都会让 Agent 回到旧行为）
		const MUST = [
			['development-guide', '先取随包规范（路由常量 GUIDE_PATH 的名字也算）'],
			['x-workbench-guide-version', '规范版本要能报出来（否则“按哪版做的”不可验证）'],
			['check_local_workbench', '先干跑'],
			['install_local_workbench', '再安装'],
			['restart-required', '按回执态决定下一步'],
			['replace_not_authorized', '同名已装时的拦截（Agent 要先问用户，不自己决定覆盖）'],
			['不要擅自重启', 'Agent 行为纪律'],
			['install-status', '用生效态接口确认加载，不靠猜'],
			['local:<包名>', '本地身份'],
			['每次只问一个', '需求澄清纪律'],
			['业务语言', '对用户的表述纪律'],
			['不等于装上能跑', '干跑边界'],
		];
		for (const [token, why] of MUST) {
			// development-guide 在常量里，提示词正文引用的是 GUIDE_PATH ⇒ 两处任一出现即可
			const present = token === 'development-guide'
				? (prompt.includes('GUIDE_PATH') && marketSrc.includes('/api/vssaros-workbenches/development-guide'))
				: prompt.includes(token);
			if (!present) { fail(`入口提示词缺「${token}」（${why}）`); }
		}

		// 收尾三点：必须是 1/2/3 且在提示词的最后
		const tail = prompt.slice(prompt.lastIndexOf('【收尾必须是这三点】'));
		if (!tail.includes('【收尾必须是这三点】')) { fail('入口提示词缺「收尾三点」要求'); }
		else if (!/1\. 开发结果/.test(tail) || !/2\. 如何重启/.test(tail) || !/3\. 去哪里打开/.test(tail)) {
			fail('入口提示词的收尾三点不全（开发结果 / 如何重启 / 去哪里打开）');
		}

		// B. 点名的东西必须真实存在
		const serverSrc2 = read('dsh-plugins/vssaros-workbenches/lib/index.js');
		const REAL = [
			['check_local_workbench', serverSrc2.includes("name: 'check_local_workbench'")],
			['install_local_workbench', serverSrc2.includes("name: 'install_local_workbench'")],
			['/install-status 路由', serverSrc2.includes('${PREFIX}/install-status')],
			['/development-guide 路由', serverSrc2.includes('${PREFIX}/development-guide')],
			// 规范的机器可读版本：路由要真的把响应头发出去，干跑回执也要带上
			['x-workbench-guide-version 响应头', serverSrc2.includes("'x-workbench-guide-version'")],
			['干跑回执带 guideVersion', serverSrc2.includes('guideVersion: guide.version')],
		];
		// 规范里要写明这个头的含义（否则 Agent 看到了也不知道那是什么）
		if (!guide.includes('x-workbench-guide-version')) { fail('规范里没说明响应头 x-workbench-guide-version 的含义'); }
		for (const [label, exists2] of REAL) {
			if (!exists2) { fail(`入口提示词点名了「${label}」，但 Host 实现里没有它`); }
		}
		// ── 回执态**双向**核对（2026-11-02）──────────────────────────────────────
		// 为什么改成双向：之前这里是写死的五个词，其中 `overridden` **代码从不返回**
		// （没有“被更高优先级包覆盖”这条路径）。文档和提示词都跟着它写 ⇒ Agent 会去处理一个
		// 永远不发生的取值，而真出错时的分类反而模糊。真源只能是代码里导出的那份常量。
		const { INSTALL_APPLICATIONS, INSTALL_BLOCK_CODES } = await import('./vssaros-workbenches/lib/index.js');
		const allowedStates = new Set(INSTALL_APPLICATIONS);
		const allowedCodes = new Set(INSTALL_BLOCK_CODES);
		if (!Array.isArray(INSTALL_APPLICATIONS) || INSTALL_APPLICATIONS.length === 0) {
			fail('vssaros-workbenches/lib/index.js 没有导出 INSTALL_APPLICATIONS（回执态核对会空跑）');
		}
		// ① 代码会返回的每个 application 都要在提示词里被解释（否则 Agent 不知道怎么办）
		for (const state of allowedStates) {
			if (!prompt.includes(state)) { fail(`入口提示词没提回执态「${state}」（Agent 会把非 applied 的当成成功）`); }
		}
		// ② 提示词里**不许**出现代码不返回的取值。用一份“像回执态的候选词”做反向扫描：
		//    这类词的共同形态是小写连字符短标识符，靠人去记一定会漏 ⇒ 列出来逐个查。
		const NOT_RETURNED = ['overridden', 'superseded', 'skipped', 'noop', 'unknown'];
		for (const bad of NOT_RETURNED) {
			if (allowedStates.has(bad) || allowedCodes.has(bad)) { continue; }   // 哪天真的支持了，自动放行
			if (prompt.includes(bad)) { fail(`入口提示词点名了「${bad}」，但工具从不返回它（代码里没有这条路径）`); }
		}
		// ③ 两类“被拦下”的 code 也要在提示词里说清怎么办
		for (const code of allowedCodes) {
			if (!prompt.includes(code)) { fail(`入口提示词没提拦截 code「${code}」（Agent 会把它当成安装器故障）`); }
		}
		// ④ 规范 §7 的回执态表必须与代码逐一对应（多一个 = 文档写了不存在的东西；少一个 = 漏了解释）
		const sec7 = /## 7\.([\s\S]*?)(?=\n## 8\.)/.exec(guide)?.[1] ?? '';
		if (!sec7) {
			fail('规范里找不到「## 7.」段（回执态表核对会空跑）');
		} else {
			const tableStates = [...sec7.matchAll(/^\|\s*`([a-z][a-z-]*)`\s*\|/gm)].map(m => m[1]).filter(name => !allowedCodes.has(name));
			const missing = [...allowedStates].filter(s => !tableStates.includes(s));
			const extra = tableStates.filter(s => !allowedStates.has(s));
			if (missing.length) { fail(`规范 §7 的回执态表缺：${missing.join(' / ')}`); }
			if (extra.length) { fail(`规范 §7 的回执态表写了代码不会返回的取值：${extra.join(' / ')}（会误导 Agent）`); }
			for (const code of allowedCodes) {
				if (!sec7.includes(code)) { fail(`规范 §7 没写拦截 code「${code}」`); }
			}
		}
		// C. 提示词 ⊆ 规范：提示词里要求的每条纪律，规范 §1 里必须有同名的条目。
		//   为什么：两处各写一份，改一处忘另一处就会让「从商城复制的 Agent」和「直接读规范的 Agent」行为不同。
		//   规范是唯一流程源 ⇒ 提示词只能是它的子集，不能自己长出新规矩。
		const sec1 = /## 1\. 执行原则（Agent 行为）([\s\S]*?)(?=\n## 2\.)/.exec(guide)?.[1] ?? '';
		if (!sec1) { fail('规范里找不到「## 1. 执行原则（Agent 行为）」段（提示词⊆规范的对账会空跑）'); }
		const PROMPT_TO_GUIDE = [
			['【先读规范，别凭记忆】', '先读规范，再动手'],
			['【先问清楚再动手】', '需求先于代码'],
			['【说业务语言】', '业务语言'],
			['【本地开发不需要仓库】', '本地优先'],
			['【装之前先干跑，再安装】', '先干跑，再安装'],
			['【不要擅自重启】', '不擅自重启'],
			['【如实汇报】', '如实汇报'],
			['【收尾必须是这三点】', '收尾固定三点'],
		];
		for (const [inPrompt, inGuide] of PROMPT_TO_GUIDE) {
			if (!prompt.includes(inPrompt)) { fail(`入口提示词缺小节「${inPrompt}」`); }
			else if (sec1 && !sec1.includes(inGuide)) { fail(`入口提示词有「${inPrompt}」，但规范 §1 里没有对应的「${inGuide}」（提示词不许自己长出新规矩）`); }
		}
		// 收尾三点在规范里也要写全
		for (const part of ['开发结果', '如何重启', '去哪里打开']) {
			if (sec1 && !sec1.includes(part)) { fail(`规范 §1「收尾固定三点」缺「${part}」`); }
		}
		if (problems === before) { ok(`「制作我的工作台」入口提示词：无过期前提 / ${MUST.length} 条纪律齐 / 点名的工具与路由都真实存在 / ${PROMPT_TO_GUIDE.length} 个小节都能在规范 §1 找到对应`); }
	}
}

// ── ④c 文档/技能不许留"身份必填 repository"的旧说法（2026-11-02 本地身份落地后）──────
// 为什么：SKILL.md 与 references 里的示例都写着 `repository: … // 必填`。照抄的作者会去建仓库、
// 甚至编一个地址（入口提示词那边已经因此重写过一次）。技能文档同样是"Agent 会照做"的东西，必须一起守。
{
	const docs = [
		'dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/SKILL.md',
		'dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/references/manifest-and-registration.md',
		'dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/references/verification.md',
	];
	const OLD = /repository[^\n]{0,20}必填|必填[^\n]{0,20}Invalid workbench repository/;
	const scaffoldSrc = read('dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/scripts/scaffold_workbench.mjs');
	for (const rel of docs) {
		const text = read(rel);
		if (OLD.test(text)) { fail(`${rel} 仍写着「repository 必填」（本地包用 package，不写 repository）`); }
		if (!text.includes('package:')) { fail(`${rel} 没提 package 身份写法（本地包的唯一身份来源）`); }
	}
	if (OLD.test(scaffoldSrc)) { fail('脚手架仍生成/包含「repository 必填」的说法（external 模式写的是 package）'); }
	if (!scaffoldSrc.includes('local:<包名>')) { fail('脚手架没说明 external 模式的身份是 local:<包名>'); }
}

// ── ④d 注册失败必须在界面上看得见（2026-11-02）────────────────────────────────
// register() 失败只抛给调用方的 ctx.effect ⇒ 只进 console ⇒ 用户看到"装了却没有"。
// 宿主已把失败记进快照，这里守"快照有它 + 启动器真的显示它"。
{
	const hostSrc = read('dsh-plugins/vssaros-workbenches/lib/client.js');
	const navSrc = read('dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js');
	const ok1 = hostSrc.includes('registrationFailures') && /recordRegistrationFailure\(/.test(hostSrc);
	const ok2 = navSrc.includes('registrationFailures') && navSrc.includes('data-vssaros-wb-registration-failed');
	if (!ok1) { fail('宿主没有把注册失败记进快照（registrationFailures）⇒ 界面上看不到失败原因'); }
	if (!ok2) { fail('启动器没有显示注册失败（data-vssaros-wb-registration-failed）⇒ 用户只知道"装了没出现"'); }
	if (ok1 && ok2) { ok('注册失败可见：宿主记进快照 + 启动器显示包名/阶段/原因'); }
}

// ── ④e 单一入口：不许存在第二套流程（2026-11-02 收口）──────────────────────────
// 为什么必须守：`.codebuddy/skills/dsh-workbench-authoring/` 曾是与运行期技能并存的**第二套流程**
// （5 个同名 reference 里 4 个内容不一致；SKILL.md 里还留着"描述符漏 repository"的旧口径，
// 且完全没有提到 development-guide / check_local_workbench / install_local_workbench）。
// 用那个入口做出来的工作台，流程与规范不一致，而且没人会发现。
// 现在它只能是**指针**：内容全部指向 resources 那一份。
{
	const CB = '.codebuddy/skills/dsh-workbench-authoring';
	const RES = 'dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring';
	const cbSkill = read(`${CB}/SKILL.md`);
	// ① 指针必须指向真源
	for (const must of [RES, 'development-guide', 'check_local_workbench', 'install_local_workbench']) {
		if (!cbSkill.includes(must)) { fail(`${CB}/SKILL.md 是指针，但没指向「${must}」`); }
	}
	// ② 指针里不许留旧流程 / 旧口径（出现就说明有人在往里补细节）
	const CB_FORBIDDEN = [
		[/Invalid workbench repository/, '旧口径：身份必填 repository'],
		[/audit_workbench\.mjs <包目录>/, '旧流程：指向本地体检脚本（已改为转发壳）'],
	];
	for (const [re, why] of CB_FORBIDDEN) {
		if (re.test(cbSkill)) { fail(`${CB}/SKILL.md 里还有${why}（指针不许带流程细节）`); }
	}
	// ③ 同名 reference 必须是指针（含真源路径），不许是第二份内容
	const SHARED = ['embedding-ai-assistant', 'manifest-and-registration', 'panel-agent-and-chrome-pitfalls', 'ui-tokens-and-primitives', 'verification'];
	for (const name of SHARED) {
		const rel = `${CB}/references/${name}.md`;
		let text;
		try { text = read(rel); } catch { fail(`${rel} 不存在（要么给指针，要么别留空壳）`); continue; }
		if (!text.includes(`${RES}/references/${name}.md`)) { fail(`${rel} 没有指向真源（它还是第二份内容）`); }
		// 指针不该长：超过 40 行基本说明有人在往里补细节
		if (text.split('\n').length > 40) { fail(`${rel} 仍是一份完整副本（${text.split('\n').length} 行），应改成指针`); }
	}
	// ④ 脚本只能是转发壳（真源路径出现在文件里）
	for (const script of ['scaffold_workbench.mjs', 'audit_workbench.mjs']) {
		const rel = `${CB}/scripts/${script}`;
		let text;
		try { text = read(rel); } catch { fail(`${rel} 不存在`); continue; }
		if (!text.includes(`${RES}/scripts/${script}`)) { fail(`${rel} 不是转发壳（它有自己的实现 ⇒ 两边会各自演进）`); }
	}
	// ⑤ 规范里的「文档地图」必须真的覆盖这些文档，且每份文档头部有状态标记
	const MAP_DOCS = [
		'workbench-authoring-standard.md', 'workbench-carrier-consolidation.md', 'workbench-refactor-plan.md',
		'workbench-official-alignment-plan.md', 'workbench-standard-compliance.md', 'workbench-framework-conformance.md',
		'workbench-react-mounting.md', 'third-party-workbenches-survey.md',
	];
	const TAG = /文档状态：\s*\*\*【(规范|参考|历史|计划)/;
	for (const name of ['workbench-development-standard.md', ...MAP_DOCS]) {
		const rel = `doc/${name}`;
		let text;
		try { text = read(rel); } catch { fail(`${rel} 不存在（文档地图里点了名）`); continue; }
		if (!TAG.test(text.split('\n').slice(0, 12).join('\n'))) { fail(`${rel} 头部缺「文档状态：**【规范|参考|历史|计划】」标记`); }
		if (name !== 'workbench-development-standard.md' && !guide.includes(name)) { fail(`规范 §0 文档地图里没列 ${name}`); }
	}
	if (!/## 0\. 文档地图/.test(guide)) { fail('规范缺「## 0. 文档地图」（Agent 会去读历史/计划文档当流程）'); }
}

// ── ⑤ 生成脚本本身可用（防"生成器坏了但没人发现"）──────────────────────
if (typeof renderGuideFromSource !== 'function') { fail('build-workbench-guide.mjs 没有导出 renderGuideFromSource'); }

console.log(problems === 0
	? '\n[check-workbench-guide] 全部通过'
	: `\n[check-workbench-guide] ${problems} 项未通过`);
process.exit(problems === 0 ? 0 : 1);
