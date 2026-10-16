// @vssaros/dsh-codebase — `bin/vendor-assets.mjs`：把 tree-sitter 运行时 + 选定语言的 grammar
// **搬进插件自己的 `vendor/`**（= 决策 2「wasm 资产怎么交付」的可执行件 ✓）。
//
// ## 为什么要有它（而不是"运行时去宿主 app 的 node_modules 找"✗）
//
//   · 去宿主目录找 = **壳耦合**（换壳就坏，而且"找到别人的 wasm"是静默错 ✗）；
//   · 随包交付 ⇒ `lib/parser/resolve.js` 的第三级候选命中，插件**自足** ✓。
//
// ## ⚠ 一条不能忘的纪律：运行时**必须改名 `.cjs`**
//
//   仓库根/插件包的 `"type": "module"` 会让原样拷进来的 `tree-sitter.js` 被当 **ESM** 求值
//   （Node 22.12+ 的 `require(esm)` 会"成功"）⇒ UMD 走 globalThis 分支、`__filename` 未定义
//   ⇒ 报一句看不出根因的 `Unable to determine script URL` ✗✗（P0 实测，见 `lib/parser/resolve.js` 文件头）。
//   本脚本**只写 `.cjs`** ✓，并且 `--check` 会把"只有 `.js`"判成不合格 ✓。
//
// ## 用法
//
//   node dsh-plugins/vssaros-codebase/bin/vendor-assets.mjs                 # 默认 6 语言档（≈5.2MB）
//   node dsh-plugins/vssaros-codebase/bin/vendor-assets.mjs --all            # **全量档**（源目录里有什么就给什么；实测 21.1MB）
//   node dsh-plugins/vssaros-codebase/bin/vendor-assets.mjs --languages typescript,tsx
//   node dsh-plugins/vssaros-codebase/bin/vendor-assets.mjs --from <另一份 wasm 目录>
//   node dsh-plugins/vssaros-codebase/bin/vendor-assets.mjs --check         # 只校验，不写（非零退出 = 不合格）
//
// ⚠ 它**不**自动跑：资产要不要进包是**产品决策**（大小 vs 覆盖）⇒ 由人显式执行一次 ✓。
// **2026-10-12 决策 2 = 全量档**（用户拍板：覆盖面优先于体积）⇒ 交付的就是 19 个 grammar ≈21.1MB ✓；
// `vendor/` 随之进包（`files` 必须列它，脚本会**先查再写** ✓）。
// ⚠ 体积的代价**如实说**：① 每次 `plugin add file:<staged>` 都要拷这 21MB（本仓探针是"拷包装"套路 ⇒ 变慢 ✓）；
//   ② `dsh-plugins/` 目前**既没被跟踪也没被忽略**（`git ls-files` = 0）⇒ 这 21MB 进的是**待交付目录**、
//   不是 git 历史 ✓；真要入库得先想清楚（包体积 vs 仓库体积是两件事 ✓）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const DEFAULT_FROM = resolve(PLUGIN_ROOT, '..', '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
/** 推荐档：常用 6 语言（实测 ≈5.2MB，见 doc/codebase-index-to-dsh-plan.html §9 决策 2 ✓）。 */
const DEFAULT_LANGUAGES = ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust'];
/** 运行时：**上游名 → 我们包里的名**（`.cjs` 是纪律，不是口味 ✓）。 */
const RUNTIME = { from: 'tree-sitter.js', to: 'tree-sitter.cjs' };
const RUNTIME_WASM = 'tree-sitter.wasm';

const args = process.argv.slice(2);
const flagOf = name => {
	const index = args.indexOf(name);
	return index >= 0 ? (args[index + 1] ?? '') : undefined;
};
const from = resolve(flagOf('--from') || DEFAULT_FROM);
const dir = resolve(flagOf('--dir') || join(PLUGIN_ROOT, 'vendor'));
const check = args.includes('--check');
const all = args.includes('--all');

/** 源目录里**实际有的**全部 grammar 语言（`--all` 用；不手打名字 ⇒ 不会漏、不会拼错 ✓）。 */
function allLanguages() {
	return readdirSync(from).filter(name => /^tree-sitter-.*\.wasm$/.test(name))
		.map(name => name.replace(/^tree-sitter-/, '').replace(/\.wasm$/, '')).sort();
}

/**
 * 本次要交付哪些语言（三种来源，**优先级明确** ✓）：
 *   ① `--languages a,b`（显式）→ ② `--all`（源目录枚举）→ ③ **交付清单**（`vendor/LANGUAGES.txt`，只在 `--check` 时读）
 *   → ④ 推荐 6 语言档（缺省）。
 * ⚠ `--check` 缺省走 ③ 而不是 ④：那种「我交付了全量、`--check` 却按 6 语言档判」的错会**静默漏掉 13 个语言** ✗
 *   （"校验了但校验的是另一份东西"是本仓的老朋友 ✓）。清单也没有 ⇒ 退回 ④ ✓。
 */
function resolveLanguages() {
	const explicit = flagOf('--languages');
	if (explicit) {
		return explicit.split(',').map(name => name.trim()).filter(Boolean);
	}
	if (all) {
		return allLanguages();
	}
	if (check) {
		try {
			const listed = readFileSync(join(dir, 'LANGUAGES.txt'), 'utf8')
				.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
			if (listed.length) {
				return listed;
			}
		} catch { /* 没有清单 ⇒ 按缺省档判 ✓ */ }
	}
	return [...DEFAULT_LANGUAGES];
}

const fail = message => {
	console.error(`✗ ${message}`);
	process.exitCode = 1;
};

/**
 * ⚠ 一条**静默失效**的防线：资产进了 `vendor/`，但 `package.json` 的 `files` 没写 `vendor`
 * ⇒ 装出来的包里**没有资产**，而本地一切正常 ✗（本仓"漏 files ⇒ 插件加载即失败"是同类事故的既有先例 ✓）。
 * 所以这里**先查 files 再动手** ✓（写盘前失败，不留半成品 ✓）。
 */
function assertFilesIncludeVendor() {
	try {
		const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
		const listed = Array.isArray(manifest.files) && manifest.files.some(entry => entry === 'vendor' || entry === 'vendor/');
		if (!listed) {
			fail('package.json 的 `files` 里没有 `vendor` ⇒ 装出来的包**不会带资产**（本地却一切正常 ✗）。请先加上 `"vendor"`。');
			return false;
		}
		return true;
	} catch (e) {
		fail(`读不到 package.json：${String(e?.message ?? e)}`);
		return false;
	}
}
const bytes = path => statSync(path).size;
const mb = value => `${(value / 1024 / 1024).toFixed(2)}MB`;

/** 期望的资产清单（源路径 → 目标名 ✓）。 */
function plan(languages) {
	return [
		{ from: join(from, RUNTIME.from), to: join(dir, RUNTIME.to), why: '运行时（**改名 .cjs**：见文件头 ✓）' },
		{ from: join(from, RUNTIME_WASM), to: join(dir, RUNTIME_WASM), why: '运行时 wasm' },
		...languages.map(language => ({
			from: join(from, `tree-sitter-${language}.wasm`),
			to: join(dir, `tree-sitter-${language}.wasm`),
			why: `${language} grammar`,
		})),
	];
}

if (check) {
	const languages = resolveLanguages();
	const wanted = plan(languages);
	const missing = wanted.filter(entry => !existsSync(entry.to));
	// ⚠ "只有 .js"必须判不合格 ✗（否则真机上会以"脚本 URL 未知"这种话失败，没人能联想到打包 ✓）
	const wrongName = existsSync(join(dir, RUNTIME.from)) && !existsSync(join(dir, RUNTIME.to));
	// 本脚本自己写的清单文件不算"多余" ✓
	const extra = existsSync(dir) ? readdirSync(dir).filter(name => name !== 'LANGUAGES.txt' && !wanted.some(entry => entry.to.endsWith(name))) : [];
	if (missing.length || wrongName) {
		fail(`vendor 目录不合格（${dir}）：`
			+ (wrongName ? `运行时是 \`${RUNTIME.from}\` —— 必须叫 \`${RUNTIME.to}\`（否则会被当 ESM 求值 ✗）；` : '')
			+ (missing.length ? `缺 ${missing.length} 个文件：${missing.map(entry => entry.to.split(/[\\/]/).pop()).join(', ')}` : ''));
	} else if (assertFilesIncludeVendor()) {
		const total = wanted.reduce((sum, entry) => sum + bytes(entry.to), 0);
		console.log(`✓ vendor 合格：${wanted.length} 个文件 / ${mb(total)}（语言 ${languages.length} 个：${languages.join(', ')}）`
			+ (extra.length ? `\n  ⚠ 目录里还有 ${extra.length} 个未列入本次计划的文件（多语言不算错 ✓，但请确认是有意的）：${extra.join(', ')}` : ''));
	}
} else {
	if (!existsSync(from)) {
		fail(`源目录不存在：${from}\n  提示：先 \`npm i\`（或显式给 --from <wasm 目录>）`);
	} else {
		const languages = resolveLanguages();
		const wanted = plan(languages);
		const absent = wanted.filter(entry => !existsSync(entry.from));
		if (absent.length) {
			fail(`源目录里缺 ${absent.length} 个文件（**不静默跳过** ✗）：`
				+ `${absent.map(entry => entry.from.split(/[\\/]/).pop()).join(', ')}\n  可用语言（该目录里实际有的）：${readdirSync(from).filter(name => /^tree-sitter-.*\.wasm$/.test(name)).map(name => name.replace(/^tree-sitter-|\.wasm$/g, '')).join(', ')}`);
		} else if (assertFilesIncludeVendor()) {
			mkdirSync(dir, { recursive: true });
			let copied = 0;
			let reused = 0;
			for (const entry of wanted) {
				const same = existsSync(entry.to) && bytes(entry.to) === bytes(entry.from) && readFileSync(entry.to).equals(readFileSync(entry.from));
				if (same) {
					reused += 1;
					continue;
				}
				// 原子替换（避免"拷到一半失败"留下半个 wasm ✗）
				const temp = `${entry.to}.tmp-${process.pid}`;
				copyFileSync(entry.from, temp);
				rmSync(entry.to, { force: true });
				copyFileSync(temp, entry.to);
				rmSync(temp, { force: true });
				copied += 1;
			}
			const total = wanted.reduce((sum, entry) => sum + bytes(entry.to), 0);
			// 顺手把"这批资产对应哪几个语言"写成一行清单（人看/守卫看都方便；**不是**运行时依赖 ✓）
			writeFileSync(join(dir, 'LANGUAGES.txt'), `# 由 bin/vendor-assets.mjs 写入（勿手改）：本次交付的语言\n${languages.join('\n')}\n`, 'utf8');
			console.log(`✓ vendor 就绪：新拷 ${copied} / 已是同一份 ${reused} / 共 ${wanted.length} 个文件 / ${mb(total)}（${dir}）\n`
				+ `  语言：${languages.join(', ')}\n`
				+ `  ⚠ 记忆点：运行时是 \`${RUNTIME.to}\`（改名不是洁癖 —— 原样 \`.js\` 会被当 ESM 求值 ✗，见脚本文件头）`);
		}
	}
}
