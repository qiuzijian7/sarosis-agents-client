// @vssaros/dsh-pele 自检（进程内，不启 Host、不联网）：
//   node dsh-plugins/vssaros-pele/test/run-pele-check.mjs
//
// 覆盖三件事：**产物在**（漏打包是最容易犯也最难发现的错）、**渲染对**（同步出 SVG、主题变量真的内联进去了）、
// **失败面有指引**（空 / 不认识的图种要带回能照着改的 hint，而不是一句 tool failed）。
//
// ⚠ 断言口径：这里用的是**夹具源码**（我们自己写的固定 Mermaid）⇒ 可以钉绝对期望值；
//   真机数据（模型随手写的图）不可控，别在这里写死"能渲染 N 张"那种断言（本仓已栽过两次 ✗）。

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { renderDiagram, withThemeVars } from '../lib/core/render.js';
import { themeNames, themeVars } from '../lib/core/theme.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

// ── 1. 随包产物 ────────────────────────────────────────────────────────────
{
	const file = join(root, 'assets', 'pele.global.js');
	const exists = existsSync(file);
	check('1a. assets/pele.global.js 随包存在', exists, file);
	if (exists) {
		const text = readFileSync(file, 'utf8');
		// 666 KB 量级；小于 100KB 基本能断定打错了入口 / 只打了一部分 ✗
		check('1b. 产物体积合理（>100KB）', text.length > 100 * 1024, `${(text.length / 1024).toFixed(1)} KB`);
		check('1c. 产物带上游版本 banner', /Pele \d+\.\d+\.\d+ \| MIT License/u.test(text), text.slice(0, 80));
		check('1d. 产物声明全局 pele', /\bvar\s+pele\s*=/u.test(text), 'esbuild iife + globalName');
	}
	// 精简包是**可选产物**（`build-pele.mjs --slim`）：要么都不在，要么**两个都在**——
	// 只有 js 没有 types.json ⇒ 谁也不知道它认哪些图种（用错就是一堆 unsupported-diagram ✗）。
	const slimJs = existsSync(join(root, 'assets', 'pele.slim.global.js'));
	const slimTypes = existsSync(join(root, 'assets', 'pele.slim.types.json'));
	check('1g. 精简包与其图种清单同进同出（默认不打 ⇒ 都应不存在）', slimJs === slimTypes, `js=${slimJs} types=${slimTypes}`);

	const themeFile = join(root, 'assets', 'pele-theme.json');
	check('1e. assets/pele-theme.json 随包存在（IDE 侧也读它）', existsSync(themeFile), themeFile);
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const files = pkg.files ?? [];
	check('1f. package.json 的 files 含 assets（漏了 ⇒ 装上去没有引擎 ✗）',
		files.includes('assets/pele.global.js') && files.includes('assets/pele-theme.json'), files.join(','));
}

// ── 1b. 落盘（`saveTo`）：dsh 聊天里让用户看到图的唯一通路 ──────────────────
// 背景：dsh 聊天页**不渲染** mermaid 围栏（运行时里 mermaid 只出现在 Shiki 语言表），
// 官方 `present` 的范式是「先建文件再交付」⇒ 本工具必须能把 SVG 真的写到盘上。
{
	const { apply } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
	/** 用最小假 ctx 抓工具定义（与 tools-snapshot.mjs 同手法，不启 Host ✓）。
	 *  ⚠ 假 ctx 必须跟上 `apply()` 的真实调用面：2026-10-20 加了落盘审批闸
	 *  `ctx.effect(() => ctx.on('tools/pre-execute', …))` ⇒ 只给 `inject` 时这里会
	 *  `ctx.effect is not a function` 直接抛（2026-10-22 实测红），工具一条都取不到。
	 *  字段与 tools-snapshot.mjs 的 fake ctx 同源，改那边记得同步。 */
	function grabTool() {
		const tools = [];
		const ctx = {
			effect: fn => { fn(); return () => { }; },
			on: () => () => { },
			tools: { register: d => { tools.push(d); return () => { }; } },
			inject: (deps, cb) => {
				const wanted = Array.isArray(deps) ? deps : [deps];
				if (wanted.every(d => d === 'tools')) { cb(ctx); }
				return { dispose: () => { } };
			},
		};
		apply(ctx, {});
		return tools[0];
	}
	const tool = grabTool();
	check('1b-0. 工具定义可取出', !!tool?.execute, '');

	const outDir = join(tmpdir(), `pele-saveto-${Date.now()}`);
	const target = join(outDir, 'nested', 'flow.svg');
	const saved = await tool.execute({ source: 'flowchart LR\n  A --> B', saveTo: target });
	check('1b-1. saveTo 会真的写出文件（含自动建目录）', saved?.ok === true && existsSync(target), String(saved?.savedTo ?? saved?.saveError ?? ''));
	if (existsSync(target)) {
		const text = readFileSync(target, 'utf8');
		check('1b-2. 落盘内容是 pele 的 SVG（不是空壳）', text.startsWith('<svg') && text.includes('class="pele'), text.slice(0, 60));
		check('1b-3. 落盘 SVG 带主题变量（深色也认）', text.includes('--pele-fg:'), '');
	}
	const dark = await tool.execute({ source: 'flowchart LR\n  A --> B', theme: 'dark', saveTo: join(outDir, 'dark.svg') });
	const darkText = existsSync(join(outDir, 'dark.svg')) ? readFileSync(join(outDir, 'dark.svg'), 'utf8') : '';
	check('1b-4. theme=dark 落盘用的是深色变量', dark?.ok === true && darkText.includes('--pele-fg:#d4d4d4'), darkText.includes('--pele-fg:#d4d4d4') ? '' : darkText.slice(0, 60));

	// ★ 写盘失败必须回 saveError 而不是静默成功：否则模型会拿着一个不存在的路径去调 present ✗
	const bad = await tool.execute({ source: 'flowchart LR\n  A --> B', saveTo: '' });
	check('1b-5. saveTo 为空 ⇒ 不当成 save 请求（不报假错误，走默认路径）', bad?.ok === true && !bad?.saveError, JSON.stringify(bad).slice(0, 80));
	const broken = await tool.execute({ source: 'flowchart LR\n  A --> B', saveTo: '   ' });
	check('1b-6. saveTo 只有空白 ⇒ 同样不走落盘', broken?.ok === true && !broken?.saveError, JSON.stringify(broken).slice(0, 80));

	try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── 2. 主题预设 ────────────────────────────────────────────────────────────
{
	const names = themeNames();
	check('2a. 预设含 default 与 dark', names.includes('default') && names.includes('dark'), names.join(','));
	const vars = themeVars('dark');
	const keys = Object.keys(vars);
	check('2b. 预设键全部是 --pele-* 变量（拼错的键名会静默走兜底色 ✗）',
		keys.length > 0 && keys.every(k => k.startsWith('--pele-')), keys.slice(0, 3).join(' '));
	check('2c. dark 与 default 的前景不同（两份预设不是复制粘贴）',
		themeVars('dark')['--pele-fg'] !== themeVars('default')['--pele-fg'],
		`${themeVars('default')['--pele-fg']} vs ${themeVars('dark')['--pele-fg']}`);
	// 未知主题 ⇒ default（与 renderDiagram 同口径，不抛 ✗）
	check('2d. 未知主题回落到 default', themeVars('nope') === themeVars('default'), 'nope');
}

// ── 3. 渲染（同步、零 DOM）──────────────────────────────────────────────────
const FLOW = `flowchart LR
  A[Mermaid text] --> B[SVG]`;

{
	const r = renderDiagram(FLOW, { theme: 'dark' });
	check('3a. flowchart 渲染成功', r.ok === true, r.message ?? '');
	check('3b. 回图种与尺寸', r.ok && r.type === 'flowchart' && r.width > 0 && r.height > 0, r.ok ? `${r.type} ${r.width}x${r.height}` : '');
	check('3c. SVG 是 pele 的形状', r.ok && r.svg.startsWith('<svg') && r.svg.includes('class="pele'), r.ok ? r.svg.slice(0, 60) : '');
	// ★ 主题必须**内联在 SVG 里**：聊天卡片把 SVG 放进 <img src="blob:">，那是独立文档，
	//   宿主页面的 CSS 变量传不进去 ⇒ 只写在父元素上会"深色下还是白底" ✗。
	check('3d. dark 变量内联进根 svg 的 style', r.ok && /<svg\b[^>]*style="[^"]*--pele-fg:#d4d4d4/u.test(r.svg), r.ok ? 'has --pele-fg:#d4d4d4' : '');
	const light = renderDiagram(FLOW, { theme: 'default' });
	check('3e. default 变量内联进根 svg 的 style', light.ok && /<svg\b[^>]*style="[^"]*--pele-fg:#1f1f1f/u.test(light.svg), light.ok ? 'has --pele-fg:#1f1f1f' : '');
	check('3f. 两主题产出不同的 SVG', r.ok && light.ok && r.svg !== light.svg, 'dark != default');
	// 渲染是**纯字符串**：Node 里没有 document 也出得来（这正是能替掉隐藏 webview 的前提 ✓）
	check('3g. 无 DOM 环境可渲染（typeof document === undefined）', typeof globalThis.document === 'undefined' && r.ok, `document=${typeof globalThis.document}`);
	// ★ maxWidth：pele 相对 mermaid 的核心差别是窄容器下**改排版**而不是等比缩小 ⇒ 必须真的传下去。
	//   不传 ⇒ 侧栏那种窄地方得到一张缩到看不清的图 ✗（实测：796x64 的横向图在 maxWidth=500 下变 100x640）
	const wide = 'flowchart LR\n  A[开始] --> B[鉴权] --> C[拉数据] --> D[渲染] --> E[落库] --> F[结束]';
	const wideFull = renderDiagram(wide, { theme: 'default' });
	const wideNarrow = renderDiagram(wide, { theme: 'default', maxWidth: 500 });
	check('3h. maxWidth 生效：窄容器下改排版（横 → 竖），不是等比缩小',
		wideFull.ok && wideNarrow.ok && wideFull.width > wideFull.height && wideNarrow.height > wideNarrow.width,
		wideFull.ok && wideNarrow.ok ? `${wideFull.width}x${wideFull.height} → ${wideNarrow.width}x${wideNarrow.height}` : 'render failed');
}

// ── 4. 图种覆盖（pele 自称覆盖 Mermaid 12.1.0 全部图种）──────────────────────
{
	const samples = {
		flowchart: 'flowchart TD\n  A --> B',
		sequence: 'sequenceDiagram\n  Alice->>Bob: hi',
		class: 'classDiagram\n  class Animal\n  Animal : +name',
		state: 'stateDiagram-v2\n  [*] --> S1\n  S1 --> [*]',
		er: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
		gantt: 'gantt\n  title P\n  section S\n  T :a1, 2024-01-01, 3d',
		pie: 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
		journey: 'journey\n  title My day\n  section Go\n  Wake up: 5: Me',
		// ⚠ 目录名（src/diagrams/<dir>）与**图种 id**（detect.ts）不是一回事：
		//   `quadrant/` → quadrantChart、`git/` → gitGraph ⇒ 这里的键必须是 detect 的 id ✗
		quadrantChart: 'quadrantChart\n  title Reach\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]',
		mindmap: 'mindmap\n  root((r))\n    a\n    b',
		timeline: 'timeline\n  title T\n  2024 : a\n  2025 : b',
		gitGraph: 'gitGraph\n  commit\n  commit',
		xychart: 'xychart-beta\n  x-axis [1, 2]\n  y-axis 0 --> 5\n  bar [3, 4]',
		block: 'block-beta\n  columns 2\n  a:1\n  b:2',
		c4: 'C4Context\n  title Sys\n  Person(a, "A")\n  System(b, "B")\n  Rel(a, b, "uses")',
		sankey: 'sankey-beta\n  A,B,10\n  A,C,20',
		kanban: 'kanban\n  column Todo\n    task: do it',
		architecture: 'architecture-beta\n  group api(cloud)[API]\n  service db(database)[DB]\n  service s1(server)[S] in api\n  db:R -- L:s1',
	};
	const failed = [];
	for (const [type, src] of Object.entries(samples)) {
		const r = renderDiagram(src, { theme: 'default' });
		if (!r.ok || r.type !== type) { failed.push(`${type}: ${r.ok ? `类型回成 ${r.type}` : `${r.code}/${r.message}`}`); }
	}
	check(`4. ${Object.keys(samples).length} 个图种全部渲染成功且类型对得上`, failed.length === 0, failed.join(' | '));
}

// ── 5. withThemeVars 的两条分支 ────────────────────────────────────────────
{
	const vars = themeVars('dark');
	const noStyle = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
	const added = withThemeVars(noStyle, vars);
	check('5a. 根标签没有 style 时也能加上（不能假设 pele 一定带 style ✗）',
		added.includes('style="--pele-bg:#1f1f1f') && added.startsWith('<svg'), added.slice(0, 90));
	// 突变对照：变量表为空 ⇒ 原样返回（不是"加了个空 style="）
	check('5b. 变量表为空时原样返回', withThemeVars(noStyle, {}) === noStyle, 'no-op');
	check('5c. 非 svg 输入原样返回', withThemeVars('<div></div>', vars) === '<div></div>', 'no-op');
}

// ── 6. 失败面（要带回 code + hint，不是一句 tool failed）─────────────────────
{
	const empty = renderDiagram('   ');
	check('6a. 空源码 ⇒ ok:false 且 code=empty', empty.ok === false && empty.code === 'empty', String(empty.code));
	const junk = renderDiagram('这不是一张图，只是几句中文说明。');
	check('6b. 不认识的图种 ⇒ ok:false 且带 hint', junk.ok === false && typeof junk.hint === 'string' && junk.hint.length > 0, `${junk.code}/${junk.message}`);
	const broken = renderDiagram('flowchart LR\n  A[[[ --> B');
	check('6c. 语法错 ⇒ ok:false 且带 hint', broken.ok === false && typeof broken.hint === 'string' && broken.hint.length > 0, `${broken.code}/${broken.message}`);
	// 不是"抛异常"：工具层要把失败当成**可返回的答案**给模型（抛了就只剩 tool failed ✗）
	check('6d. 失败不抛异常（返回可序列化的对象）', (() => {
		try { return JSON.stringify(renderDiagram('nope')) !== '{}'; } catch { return false; }
	})(), 'serializable');
}

// ── 7. 两侧契约（插件 ⇄ IDE 渲染进程）────────────────────────────────────────
// IDE 侧按**路径**找本插件的 assets、按**命令 id** 调渲染器 ⇒ 这两处是**字符串契约**：
// 改名/改目录不会编译报错，只会"所有图表渲染不出来"（症状离真因很远 ✗）⇒ 必须静态钉住。
{
	const repoRoot = resolve(root, '..', '..');
	const rendererPath = join(repoRoot, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'peleDiagramRenderer.ts');
	const rendererSrc = existsSync(rendererPath) ? readFileSync(rendererPath, 'utf8') : '';
	check('7a. IDE 渲染器文件存在', rendererSrc.length > 0, rendererPath);
	if (rendererSrc.length) {
		check('7b. IDE 侧指向的目录名与资产名都存在（改目录/文件名会静默断渲染 ✗）',
			rendererSrc.includes("'dsh-plugins', 'vssaros-pele', 'assets'")
			&& rendererSrc.includes("'pele.global.js'")
			&& rendererSrc.includes("'pele-theme.json'")
			&& existsSync(join(root, 'assets', 'pele.global.js'))
			&& existsSync(join(root, 'assets', 'pele-theme.json')),
			'vssaros-pele/assets/pele.global.js + pele-theme.json');
		// 主题变量必须内联进 SVG（聊天卡片走 <img blob>，父元素 CSS 传不进去）⇒ 两侧都要做这件事
		check('7c. IDE 侧也做主题内联（不是只靠插件侧 ✗）', rendererSrc.includes('withThemeVars'), 'withThemeVars');
	}
	const contributionPath = join(repoRoot, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'agentStudio.contribution.ts');
	const cardPath = join(repoRoot, 'src', 'vs', 'sessions', 'browser', 'agentChat', 'agentChatPanel.mermaidCard.ts');
	const contributionSrc = existsSync(contributionPath) ? readFileSync(contributionPath, 'utf8') : '';
	const cardSrc = existsSync(cardPath) ? readFileSync(cardPath, 'utf8') : '';
	const COMMAND = '_agentStudio.renderDiagramSvg';
	check('7d. 命令 id 三处一致（注册方 / 调用方 / 本守卫）',
		contributionSrc.includes(COMMAND) && cardSrc.includes(COMMAND),
		`注册=${contributionSrc.includes(COMMAND)} 调用=${cardSrc.includes(COMMAND)}`);
	check('7e. 旧的 mermaid 隐藏 webview 渲染器已不存在（不许两套引擎并存 ✗）',
		!existsSync(join(repoRoot, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'mermaidInlineRenderer.ts')),
		'mermaidInlineRenderer.ts');

	// ★ dsh 工具 `render_diagram` 的参数名是 `source`，而聊天卡片派发靠**工具名**命中：
	//   base.ts 的 TOOL_MERMAID_TOOLS 里有 `render_diagram` ⇒ 走 Mermaid 卡片。
	//   卡片只认 markup/diagram 就会读到空串 ⇒ "工具成功但图是空白"，症状离真因很远 ✗。
	const basePath = join(repoRoot, 'src', 'vs', 'sessions', 'browser', 'agentChat', 'agentChatPanel.base.ts');
	const baseSrc = existsSync(basePath) ? readFileSync(basePath, 'utf8') : '';
	check('7f. 聊天卡片认得 render_diagram（工具名派发 ⇒ 名字对不上就是空白卡片 ✗）',
		/render_diagram/.test(baseSrc), 'agentChatPanel.base.ts');
	check('7g. Mermaid 卡片的参数兜底含 source（本插件的 render_diagram 传的是 source）',
		/args\?\.markup \|\| args\?\.diagram \|\| args\?\.source/u.test(cardSrc), 'agentChatPanel.mermaidCard.ts');
	check('7h. render_diagram 不再同时挂在 drawio 族（两个族都挂 = 名单与实现脱节 ✗）',
		!/TOOL_DRAWIO_TOOLS = new Set\([^)]*render_diagram/.test(baseSrc), 'TOOL_DRAWIO_TOOLS');

	// 2026-10-19：模型常无视「用工具画图」直接输出围栏 ⇒ 围栏兜底预览是**用户真正看到图的最后一道**。
	// 只支持 mermaid、漏了 drawio（或反过来）不会报错，只是那个图种永远只剩源码块 ✗ ⇒ 静态钉住。
	const mdPath = join(repoRoot, 'src', 'vs', 'sessions', 'browser', 'agentChat', 'agentChatPanel.markdown.ts');
	const mdSrc = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';
	check('7i. 聊天围栏兜底预览 mermaid 与 drawio 都在（漏一个 ⇒ 那个图种只剩源码块 ✗）',
		/fenceLang === 'mermaid'/u.test(mdSrc) && /fenceLang === 'drawio'/u.test(mdSrc), 'agentChatPanel.markdown.ts');
}

// ── 8. 扩展侧（mermaid-chat-features 的可见 webview）────────────────────────
// 这条链是**独立的 webview**（聊天输出项 + 编辑器预览），它拿引擎的方式与 IDE 渲染进程不同：
// 由 `esbuild.webview.mts` 把同一份产物**拷进** chat-webview-out，再以经典脚本载入。
// ⇒ 同样有"改了这边忘了那边"的风险（尤其：哪天又把 mermaid 装回来 ⇒ 两套引擎并存 ✗）。
{
	const extRoot = join(resolve(root, '..', '..'), 'extensions', 'mermaid-chat-features');
	const webviewSrc = join(extRoot, 'chat-webview-src');
	const readMaybe = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

	const esbuildCfg = readMaybe(join(extRoot, 'esbuild.webview.mts'));
	check('8a. 扩展 webview 构建从 dsh 插件拷 pele（不是第二份源码 ⇒ 单一真源）',
		esbuildCfg.includes("'dsh-plugins', 'vssaros-pele', 'assets', 'pele.global.js'"), 'esbuild.webview.mts');

	const extPkg = readMaybe(join(extRoot, 'package.json'));
	check('8b. 扩展已不再依赖 mermaid（两套引擎并存是"同一个图两个画法"的源头 ✗）',
		extPkg.length > 0 && !/"mermaid"\s*:/.test(extPkg), 'dependencies');

	const webviewFiles = existsSync(webviewSrc)
		? readdirSync(webviewSrc).filter(f => f.endsWith('.ts'))
		: [];
	const stillOnMermaid = webviewFiles.filter(f => /from 'mermaid'/u.test(readMaybe(join(webviewSrc, f))));
	check('8c. webview 源码里没有 import mermaid', webviewFiles.length > 0 && stillOnMermaid.length === 0, stillOnMermaid.join(','));

	// 两个 HTML 模板都要载入 pele（漏一个 ⇒ 那个表面"点了没反应/一片空白" ✗）
	const chatOut = readMaybe(join(extRoot, 'src', 'chatOutputRenderer.ts'));
	const editorMgr = readMaybe(join(extRoot, 'src', 'editorManager.ts'));
	check('8d. 两处 HTML 模板都载入了 pele.global.js',
		chatOut.includes("'pele.global.js'") && editorMgr.includes("'pele.global.js'"),
		`chatOutput=${chatOut.includes("'pele.global.js'")} editorManager=${editorMgr.includes("'pele.global.js'")}`);
	check('8e. 删掉的 index-render（隐藏 webview 通道）确实不存在了',
		!existsSync(join(webviewSrc, 'index-render.ts')), 'index-render.ts');
}

// ── 9. canvas / 思维导图：也要经 pele ────────────────────────────────────────
// `.canvas`（JSON Canvas）不是 Mermaid 文本 ⇒ 多一层**转译**（`canvasToMermaid.ts`），
// 但**结果必须还是 pele 出的**。这两条最容易漂：① 转译层的产出被别的引擎接走；
// ② 旧的自绘渲染器（canvasToSvg / CanvasMiniView）被复活 ⇒ 又是"两张图两个画法" ✗。
{
	const repo = resolve(root, '..', '..');
	const knowledge = join(repo, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'knowledge');
	const webview = join(repo, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'src', 'kbMarkdown', 'components');

	const translator = existsSync(join(knowledge, 'canvasToMermaid.ts')) ? readFileSync(join(knowledge, 'canvasToMermaid.ts'), 'utf8') : '';
	check('9a. 存在 JSON Canvas → Mermaid 的转译层', translator.length > 0, 'canvasToMermaid.ts');

	const pipeline = existsSync(join(knowledge, 'diagramEmbedPipeline.ts')) ? readFileSync(join(knowledge, 'diagramEmbedPipeline.ts'), 'utf8') : '';
	check('9b. 飞书同步的 canvas 分支走 renderMermaid（= pele），不是自绘 SVG',
		pipeline.includes('canvasToMermaidSource') && /renderMermaid\(canvasToMermaidSource/.test(pipeline), 'diagramEmbedPipeline.ts');
	check('9c. 旧的 canvasToSvg（自绘 SVG）已删除', !existsSync(join(knowledge, 'canvasToSvg.ts')), 'canvasToSvg.ts');

	const pane = existsSync(join(repo, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'kbBlocksEditorPane.ts'))
		? readFileSync(join(repo, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'kbBlocksEditorPane.ts'), 'utf8') : '';
	check('9d. 笔记预览的 canvas 走宿主 pele 通道（kbblocks.renderCanvas）',
		pane.includes('kbblocks.renderCanvas') && pane.includes('canvasToMermaidSource'), 'kbBlocksEditorPane.ts');

	const embed = existsSync(join(webview, 'DiagramEmbedComponent.tsx')) ? readFileSync(join(webview, 'DiagramEmbedComponent.tsx'), 'utf8') : '';
	// ⚠ 只判"**还在用**"（组件定义 / JSX 引用），不判"名字出现过"——注释里回顾历史会提到它，
	//   用 `includes` 会把一份**已经删干净**的文件误判为红 ✗。
	check('9e. webview 侧的 CanvasMiniView（第二套自绘）已不再使用',
		embed.length > 0 && !/function\s+CanvasMiniView\b/u.test(embed) && !/<CanvasMiniView\b/u.test(embed), 'DiagramEmbedComponent.tsx');
}

// ── 10. dsh 聊天页「围栏兜底渲染」的 DOM 契约（A 方案的前置）────────────────
//
// 背景：**dsh 官方聊天页不渲染 mermaid**（运行时里 `mermaid` 只出现在 Shiki 的高亮语言表）。
// 要在 dsh 聊天里让围栏出图，只能走「DOM 后处理」：扫官方代码块 → 用 pele 渲染 → 就地替换。
// 这条路**完全依赖官方 DOM 结构**（我们 `client.fileCards.js` 已经踩过一次同类坑：
// 靠读 `aria-describedby` 的隐藏 span 拿路径）。
//
// 2026-10-19 静态探针实测到的官方代码块结构（从 dsh-web-frontend 产物抠出）：
//   <div class="… md-code-block" data-line-numbers data-code-wrap>
//     <div data-code-block-banner> <div class=哈希>mermaid</div> … </div>   ← banner 可关，语言类名是哈希的 ✗
//     <div data-code-block-content> <pre><code>原文</code></pre> </div>      ← ★ 稳定
//   </div>
// ⇒ 可用钩子：`md-code-block`（**字面量**，未进 CSS-module 哈希）+ `data-code-block-content`（**字面量**）。
// ⇒ 语言**不能**靠 DOM 拿（`.infostring` 是哈希类名、banner 还能关）——改由 pele 自己的
//    `detectType()` / `supports()` 判断"这段能不能画"，比读语言标签更可靠 ✓。
//
// 本条只钉**契约**：这两个字面量还在不在。dsh 升级改没了 ⇒ 报红 ⇒ 别等到真机才发现 ✗。
{
	const runtimeRoot = join(resolve(root, '..', '..'), 'dsh-runtime');
	let assetsDir;
	if (existsSync(runtimeRoot)) {
		// 版本目录（如 0.2.1-rc.1）不固定 ⇒ 逐个找，别写死
		for (const v of readdirSync(runtimeRoot, { withFileTypes: true }).filter(d => d.isDirectory())) {
			const candidate = join(runtimeRoot, v.name, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');
			if (existsSync(candidate)) { assetsDir = candidate; break; }
		}
	}
	if (!assetsDir) {
		// ⚠ `dsh-runtime/` 在 .gitignore 且未入库 ⇒ 干净检出/CI 未装时**根本找不到**。
		//   此时既不能报红（会误伤没装 runtime 的环境），也不能算 PASS（那是假绿 ✗）
		//   ⇒ 记为 SKIP 并明确打印，装了就自动生效 ✓。
		console.log('SKIP  10. dsh 聊天页 DOM 契约 —— 未找到 dsh-runtime/*/…/dsh-web-frontend/dist/assets（该目录在 .gitignore 且未入库；装上后本条自动生效）');
	} else {
		const jsFiles = readdirSync(assetsDir).filter(f => f.endsWith('.js') && statSync(join(assetsDir, f)).size < 8 * 1024 * 1024);
		const hits = { block: [], content: [] };
		for (const f of jsFiles) {
			const text = readFileSync(join(assetsDir, f), 'utf8');
			if (text.includes('"md-code-block"')) { hits.block.push(f); }
			if (text.includes('data-code-block-content')) { hits.content.push(f); }
		}
		check('10a. 官方代码块类名 `md-code-block` 仍是字面量（A 方案的挂载点）', hits.block.length > 0, hits.block.join(',') || '未找到 ✗');
		check('10b. 官方代码块内容容器 `data-code-block-content` 仍在（拿原文的入口）', hits.content.length > 0, hits.content.join(',') || '未找到 ✗');
		// 同一文件命中 ⇒ 确认是**同一个渲染组件**的两部分，不是碰巧两处同名字符串
		const same = hits.block.filter(f => hits.content.includes(f));
		check('10c. 两个钩子出现在同一份产物里（同一组件 ⇒ 结构未拆散）', same.length > 0, same.join(',') || `${hits.block.join(',')} vs ${hits.content.join(',')}`);
		// 反向：官方仍不渲染 mermaid —— 这是 A/B 两条方案的前提，哪天变了要重新评估
		const rendererHits = jsFiles.filter(f => /mermaid/i.test(f));
		check('10d. 官方仍不带 mermaid 渲染器产物（前提检查；出现了 ⇒ A/B 的前提要重估）',
			rendererHits.length === 0, rendererHits.join(','));
	}
}

let failed = 0;
for (const r of results) {
	console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail.slice(0, 160)}` : ''}`);
	if (!r.ok) { failed++; }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
