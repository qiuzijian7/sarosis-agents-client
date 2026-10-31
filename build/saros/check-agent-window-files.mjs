/*
 * 守卫：**「用外部工具 / 文件关联打开文件时，必须在当前 Agents 窗口里打开」**。
 *
 * 起因（2026-10-31，用户要求「选择外部工具打开时，vssaros.exe 即当前工具的 ide 窗口」）：
 *   Windows 的「打开方式」面板是**系统原生**的（不是我们渲染），菜单项由注册表决定 ⇒
 *   第二个实例被拉起后要靠**单实例转发**把目标交给已在跑的那个实例。实测事故链：
 *
 *     ① `launchMainService.startOpenWindow`：只在 `--new-window` 且位置参数**恰好 1 个**时
 *        剥离 Electron 的 app 路径 ⇒ `[appPath, 文件]` 的转发漏掉 ⇒ 路径被当成"已打开的文件夹"；
 *     ② `windowsMainService.ensureAgentsWindow`：只有「工作区文件 / 文件夹 / 记住的工作区」
 *        三个分支 ⇒ **单独的文件无处可落** ⇒ 掉进"复用记住的工作区"⇒ 文件被丢弃
 *        （真机日志：`cli._=["…\\poc\\card-demo\\alpha.js"]` 而 `urisToOpen=[]`）。
 *
 *   ⇒ 两处都补了。本守卫同时钉住**筛选规则**（跑真实代码）与**调用方接线**（静态断言），
 *     任何一处回退都会红。
 *
 * 跑法：node build/saros/check-agent-window-files.mjs
 *   （纯逻辑部分 import 的是 `out/` 产物 ⇒ 没编译过会明确 FAIL，不会假绿 ✗）
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const SRC_WINDOWS = path.join(ROOT, 'src/vs/platform/windows/electron-main/windowsMainService.ts');
const SRC_LAUNCH = path.join(ROOT, 'src/vs/platform/launch/electron-main/launchMainService.ts');
const OUT_CANDIDATES = path.join(ROOT, 'out/vs/platform/windows/electron-main/requestedFileCandidates.js');

const problems = [];
let pass = 0;
const ok = (name) => { pass += 1; console.log('PASS  ' + name); };
const bad = (name, why) => { problems.push(name + ' — ' + why); console.log('FAIL  ' + name + '  — ' + why); };

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ── 一、纯逻辑：跑真实代码（候选文件筛选规则）────────────────────────────────
if (!fs.existsSync(OUT_CANDIDATES)) {
	bad('纯逻辑（collectRequestedFileCandidates）', `缺编译产物 ${path.relative(ROOT, OUT_CANDIDATES)} ⇒ 先跑一次编译（watch 会自动产出）`);
} else {
	const mod = await import(pathToFileURL(OUT_CANDIDATES).href);
	const fn = mod.collectRequestedFileCandidates;
	if (typeof fn !== 'function') {
		bad('纯逻辑（collectRequestedFileCandidates）', '模块没有导出该函数');
	} else {
		const cases = [
			['基本：位置参数里的文件要收', { positional: ['/repo/a.js'] }, ['/repo/a.js']],
			['① 空串 / 空白不收', { positional: ['', '   '] }, []],
			['② 开关（`-n` / `--goto`）不是路径', { positional: ['/repo/a.js', '-n', '--goto'] }, ['/repo/a.js']],
			['③ `.code-workspace` 归工作区分支，这里不认领', { positional: ['/repo/w.code-workspace', '/repo/a.js'] }, ['/repo/a.js']],
			['④ 去重：`--file-uri` 与位置参数同一路径只收一次', { fileUriFlags: ['/repo/a.js'], positional: ['/repo/a.js'] }, ['/repo/a.js']],
			['顺序：`--file-uri` 在前', { fileUriFlags: ['/x.js'], positional: ['/y.js'] }, ['/x.js', '/y.js']],
		];
		for (const [name, input, want] of cases) {
			let got;
			try { got = fn(input); } catch (e) { bad(name, '抛异常：' + (e && e.message || e)); continue; }
			const same = Array.isArray(got) && got.length === want.length && got.every((v, i) => v === want[i]);
			if (same) { ok(name); } else { bad(name, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
		}
	}
}

// ── 二、调用方接线（静态）：任何一处回退都会让"文件打不开"复发 ────────────────
const srcWindows = read(SRC_WINDOWS);
const srcLaunch = read(SRC_LAUNCH);
if (!srcWindows || !srcLaunch) {
	bad('调用方接线', '读不到源文件：' + (!srcWindows ? SRC_WINDOWS : '') + ' ' + (!srcLaunch ? SRC_LAUNCH : ''));
} else {
	// ① 文件分支必须存在，且把 `fileUri` 真正放进 `urisToOpen`
	const hasBranch = /requestedFiles\.length/.test(srcWindows) && /urisToOpen\.push\(\{\s*fileUri\s*\}\)/.test(srcWindows);
	if (hasBranch) { ok('ensureAgentsWindow 有"单独文件"分支且把 fileUri 放进 urisToOpen'); }
	else { bad('ensureAgentsWindow 有"单独文件"分支', '缺 `requestedFiles.length` 或 `urisToOpen.push({ fileUri })` ⇒ 转发来的文件又会被丢弃 ✗'); }

	// ② 必须用纯函数（否则筛选规则无法被上面那一节钉住）
	if (srcWindows.includes('collectRequestedFileCandidates')) { ok('_findRequestedFiles 走纯函数 collectRequestedFileCandidates'); }
	else { bad('_findRequestedFiles 走纯函数', '没有调用 collectRequestedFileCandidates ⇒ 筛选规则散在方法里、无法单测 ✗'); }

	// ③ 只认真正的文件（`stat().isFile`）—— dev 链的 app 路径是文件夹，必须被排除
	if (/\.isFile/.test(srcWindows)) { ok('_findRequestedFiles 用 stat().isFile 过滤（app 路径是文件夹会被排除）'); }
	else { bad('_findRequestedFiles 用 stat().isFile 过滤', '缺 isFile 判断 ⇒ app 路径会被当工作区打开（2026-09-14 的坑）✗'); }

	// ④ 文件分支必须**先于**"复用记住的工作区"（否则先 return，文件永远没机会）
	//    ⚠ 锚点用**代码行**而不是日志文案：`reopening remembered` 也出现在 ②b 的注释里
	//    （解释事故时用到了它）⇒ 拿它当锚点会误判顺序 ✗（本次第一版就踩了）。
	const iFiles = srcWindows.indexOf('requestedFiles.length');
	const iRemembered = srcWindows.indexOf('const remembered = await this._readRememberedWorkspaceFile();');
	if (iFiles > 0 && iRemembered > iFiles) { ok('文件分支排在"复用记住的工作区"之前'); }
	else { bad('文件分支排在"复用记住的工作区"之前', `顺序反了（iFiles=${iFiles}, iRemembered=${iRemembered}）⇒ 先命中 remembered 就 return，文件打不开 ✗`); }

	// ⑤ launchMainService：剥离 appPath **不能**再要求 `--new-window`
	const stripped = /args\._ = args\._\.slice\(1\)/.test(srcLaunch);
	const stillGated = /args\['new-window'\]\s*&&\s*args\._\.length/.test(srcLaunch);
	if (stripped && !stillGated) { ok('launchMainService 无条件剥离位置参数里的 app 路径'); }
	else { bad('launchMainService 无条件剥离 app 路径', stillGated ? '仍在 `--new-window` 门控内 ⇒ `[appPath, 文件]` 转发漏掉 ✗' : '缺 `args._.slice(1)` ✗'); }
}

console.log('\n' + (problems.length ? `✗ ${problems.length} 项失败 / 共 ${pass + problems.length} 项` : `✓ 全部 ${pass} 项通过`));
if (problems.length) { process.exit(1); }
