/*---------------------------------------------------------------------------------------------
 *  诊断用 ESM loader hook：在**加载期**给 `dsh-app-boot` 追加插桩（磁盘上的依赖产物一个字节不动）。
 *
 *  为什么必须是"加载期改源码"：本机对依赖产物（`node_modules/`、`poc/dsh-p0/.runtime/`）的写入会被
 *  **静默回滚**（README 4.57 实测两次：编辑工具报成功、文件里却没有痕迹）⇒ 想插桩只能在自己的
 *  preload 里用 `module.register()` 的 loader hook 改**加载进来的源码**。
 *
 *  目的（README 4.55 的"下一步"）：把"`dsh: profile reload requires the root Include entry` 到底是
 *  注册没发生、还是查询换了棵上下文树"一次问清——为此打印两处拿到的 `ctx` 身份（自建 WeakMap 编号，
 *  同一对象才会得到同一编号）、`ctx.root === ctx`、以及 `bootstrapIncludes.get(ctx)` 命中与否。
 *
 *  用法（仅测试）：设 `VSSAROS_DSH_HOST_PRELOAD=<dshHostInstrument.preload.mjs 的绝对路径>`；
 *  输出行以 `[vssaros-instr]` 开头，写 stderr，并在设了 `VSSAROS_DSH_INSTR_LOG` 时同时追加到该文件。
 *--------------------------------------------------------------------------------------------*/
import { readFile } from 'node:fs/promises';

/** 只拦这一个模块：它是唯一同时持有 `bootstrapIncludes` 与那两个函数的地方。 */
const TARGET = 'dsh-app-boot/lib/index.js';

const INJECT = `
// ─── VsSaros 诊断插桩（加载期追加；磁盘上的依赖产物未被改动）───────────────────────────
const { appendFileSync: __vsAppend } = await import('node:fs');
const __vsLogFile = process.env.VSSAROS_DSH_INSTR_LOG;
// 每次**加载**给一个实例号：同一个文件被加载两次（两份模块实例 = 两个 bootstrapIncludes WeakMap）
// 会得到两个不同的实例号 —— 这正是"命中/未命中交替"最可能的解释，必须能分辨。
const __vsInstance = Math.random().toString(36).slice(2, 7);
const __vsSeen = new WeakMap();
let __vsSeq = 0;
function __vsTag(ctx) {
	let tag = __vsSeen.get(ctx);
	if (tag === void 0) { tag = ++__vsSeq; __vsSeen.set(ctx, tag); }
	return tag;
}
function __vsLog(fn, ctx, detail) {
	let isRoot = 'n/a';
	try { isRoot = ctx?.root === ctx; } catch { /* 代理拒绝读就留 n/a */ }
	const line = \`[vssaros-instr] pid=\${process.pid} inst=\${__vsInstance} url=\${import.meta.url} \${fn} ctx=#\${__vsTag(ctx)} ctxIsRoot=\${isRoot} \${detail}\`;
	try { process.stderr.write(line + '\\n'); } catch { /* 忽略 */ }
	if (__vsLogFile) { try { __vsAppend(__vsLogFile, line + '\\n'); } catch { /* 忽略 */ } }
}
const __vsMount = mountRootInclude;
mountRootInclude = async function (ctx, absoluteConfigPath, patches = [], bareModuleBaseUrl, binName = 'dsh') {
	const result = await __vsMount.call(this, ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName);
	__vsLog('mountRootInclude', ctx, \`patches=\${patches.length} loader=\${ctx.get('loader') === void 0 ? 'undefined' : 'ok'} entry=\${bootstrapIncludes.get(ctx) === void 0 ? 'MISS（未注册）' : 'hit（已注册）'}\`);
	return result;
};
const __vsReconcile = reconcileProfilePatches;
reconcileProfilePatches = async function (ctx, patches, binName, requiredIds = []) {
	__vsLog('reconcileProfilePatches', ctx, \`entry=\${bootstrapIncludes.get(ctx) === void 0 ? 'MISS' : 'hit'}\`);
	return __vsReconcile.call(this, ctx, patches, binName, requiredIds);
};
`;

export async function load(url, context, nextLoad) {
	if (!url.includes(TARGET)) {
		return nextLoad(url, context);
	}
	const result = await nextLoad(url, context);
	const source = typeof result.source === 'string' ? result.source : await readFile(new URL(url), 'utf8');
	return { ...result, format: 'module', source: `${source}\n${INJECT}`, shortCircuit: true };
}
