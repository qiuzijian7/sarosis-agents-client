/**
 * P1 · TeamFlow 纯逻辑内核 JS 化（可重放）。
 *
 * 上游 `G:/CustomWorkspaces/AIProjects/dsh-plugin-teamflow` 的 host/core 是无宿主私有包依赖的
 * TypeScript 纯逻辑；Node 22 的 type stripping 让它的测试可以零构建直跑。这里用 Node 内置的
 * `module.stripTypeScriptTypes` 做**机械剥离**（不重写语义），产物集中到 `port/mirror/<同构路径>`：
 *   - 原 `.ts` 一律保留（上游测试里的静态源码断言要读它）；
 *   - 测试副本 `test/port-<name>.test.js` 与上游 test/ 同级，`from '../xxx.ts'` 改指 mirror；
 *   - 生成 manifest.json 记录上游 commit、源/产物哈希，供 run-check.mjs 做漂移检测。
 *
 * 用法：node port/port-core.mjs   （可重复执行，覆盖产物）
 */
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MIRROR = join(ROOT, 'port', 'mirror');
const UPSTREAM = 'G:\\CustomWorkspaces\\AIProjects\\dsh-plugin-teamflow';

/** 基线：在镜像上零宿主依赖、exit 0 的纯逻辑测试（14 个 / 856 断言）。 */
const TESTS = [
	'journal', 'stages', 'verdict', 'qa-rework-bound', 'evidence', 'pinned-constants',
	'conformance', 'dev-task-id', 'state', 'empty-turn', 'diagnostic', 'locale',
	'cancel', 'clarify-log',
];

const FROM_RE = /(\bfrom\s*['"])([^'"]+)\.ts(['"])/g;
const DYN_RE = /(\bimport\s*\(\s*['"])([^'"]+)\.ts(['"])/g;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const toPosix = (p) => p.split(sep).join('/');
const specifiers = (src, re) => [...src.matchAll(new RegExp(re.source, re.flags))].map((m) => m[2]);

function upstreamHead() {
	try {
		return execFileSync('git', ['-C', UPSTREAM, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}

/** 从测试入口递归收集 .ts 依赖闭包，返回 Map<绝对源路径, 相对 ROOT 的 posix 路径>。 */
function collect() {
	const found = new Map();
	const pending = [];
	for (const name of TESTS) {
		const file = join(ROOT, 'test', `${name}.test.js`);
		if (!existsSync(file)) throw new Error(`缺少基线测试：${file}`);
		const src = readFileSync(file, 'utf8');
		for (const spec of [...specifiers(src, FROM_RE), ...specifiers(src, DYN_RE)]) {
			if (spec.startsWith('.')) pending.push(resolve(join(ROOT, 'test'), `${spec}.ts`));
		}
	}
	while (pending.length) {
		const abs = pending.pop();
		if (found.has(abs)) continue;
		if (!existsSync(abs)) throw new Error(`依赖的 .ts 不存在：${abs}`);
		const src = readFileSync(abs, 'utf8');
		found.set(abs, toPosix(relative(ROOT, abs)));
		for (const spec of [...specifiers(src, FROM_RE), ...specifiers(src, DYN_RE)]) {
			if (spec.startsWith('.')) pending.push(resolve(dirname(abs), `${spec}.ts`));
		}
	}
	return found;
}

/** 模块内部：只把相对 specifier 的 .ts 换成 .js（mirror 内目录同构，路径不变）。 */
function rewriteModule(js) {
	return js
		.replace(new RegExp(FROM_RE.source, FROM_RE.flags), (_, a, spec, c) => `${a}${spec}.js${c}`)
		.replace(new RegExp(DYN_RE.source, DYN_RE.flags), (_, a, spec, c) => `${a}${spec}.js${c}`);
}

/** 测试副本：把任意相对 .ts specifier 指到 ../port/mirror/<rel>.js（静态源码断言的字符串不动）。 */
function rewriteTest(src, fromFile) {
	const map = (all, a, spec, c) => {
		if (!spec.startsWith('.')) return all;
		const abs = resolve(dirname(fromFile), `${spec}.ts`);
		const rel = toPosix(relative(ROOT, abs)).replace(/\.ts$/, '.js');
		return `${a}../port/mirror/${rel}${c}`;
	};
	return src
		.replace(new RegExp(FROM_RE.source, FROM_RE.flags), map)
		.replace(new RegExp(DYN_RE.source, DYN_RE.flags), map);
}

const modules = collect();
const generated = [];
const transformed = [];
const sourceHashes = {};
const outputHashes = {};
const hostDeps = [];

for (const [abs, rel] of modules) {
	const src = readFileSync(abs, 'utf8');
	let js;
	try {
		js = stripTypeScriptTypes(src, { mode: 'strip', sourceUrl: pathToFileURL(abs).href });
	} catch {
		js = stripTypeScriptTypes(src, { mode: 'transform', sourceUrl: pathToFileURL(abs).href });
		transformed.push(rel);
	}
	js = rewriteModule(js);
	for (const m of js.matchAll(/\bfrom\s*['"](@deepseek-ai\/[^'"]+)['"]/g)) hostDeps.push(`${rel} -> ${m[1]}`);
	const out = join(MIRROR, `${rel.replace(/\.ts$/, '.js')}`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, js);
	generated.push(toPosix(relative(ROOT, out)));
	sourceHashes[rel] = sha(src);
	outputHashes[toPosix(relative(ROOT, out))] = sha(js);
}

const testCopies = [];
for (const name of TESTS) {
	const file = join(ROOT, 'test', `${name}.test.js`);
	const portFile = join(ROOT, 'test', `port-${name}.test.js`);
	writeFileSync(portFile, rewriteTest(readFileSync(file, 'utf8'), file));
	testCopies.push(`test/port-${name}.test.js`);
}

const manifest = {
	schema: 1,
	generatedAt: new Date().toISOString(),
	upstreamRepo: UPSTREAM,
	upstreamHead: upstreamHead(),
	strategy: 'node:module.stripTypeScriptTypes (strip, fallback transform)',
	baselineTests: TESTS,
	transformed,
	hostDeps,
	generated,
	testCopies,
	sourceHashes,
	outputHashes,
};
// P2：把同一份内核同步进外部包插件。插件被 pnpm pack 时只带走自己的 files，
// 不能靠跨目录 import；复制由本脚本统一做，run-check 会钉住副本哈希（禁止手改一份）。
const workbenchCopies = [];
const workbenchHashes = {};
if (existsSync(join(ROOT, 'workbench'))) {
	for (const rel of generated) {
		const data = readFileSync(join(ROOT, rel));
		const outRel = `workbench/lib/core/${rel.slice('port/mirror/'.length)}`;
		const out = join(ROOT, outRel);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, data);
		workbenchCopies.push(outRel);
		workbenchHashes[outRel] = sha(data);
	}
}
manifest.workbenchCopies = workbenchCopies;
manifest.workbenchHashes = workbenchHashes;

writeFileSync(join(HERE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[port-core] upstream=${manifest.upstreamHead.slice(0, 12)} modules=${generated.length} tests=${testCopies.length} copies=${workbenchCopies.length} transformed=${transformed.length} hostDeps=${hostDeps.length}`);
console.log(`[port-core] manifest -> port/manifest.json`);
