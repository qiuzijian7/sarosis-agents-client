#!/usr/bin/env node
// run-checks.mjs — 把 `npm run check:dsh-plugins` 的 `&&` 长链跑成「全跑完再汇总」。
//
// 为什么：那条脚本是 60 多条守卫用 `&&` 串起来的。链首任何一条红（哪怕是与本次改动无关的既有失败），
// 后面所有守卫都**不会执行**——看起来只有 1 个失败，实际上 60 条都没验证。
//
// 单一清单：命令列表**直接从 package.json 的 `check:dsh-plugins` 解析**，不另存一份，
// 所以往链里加/删守卫照旧只改那一处，本运行器自动跟上。
//
// 用法：
//   node dsh-plugins/scripts/run-checks.mjs                 # 逐条全跑，最后汇总，有失败退出码 1
//   node dsh-plugins/scripts/run-checks.mjs --jobs 4        # 并行（守卫多为只读；默认 1 = 串行，最稳）
//   node dsh-plugins/scripts/run-checks.mjs --only bots,rooms   # 只跑命令里含这些片段的
//   node dsh-plugins/scripts/run-checks.mjs --script check:xxx  # 换一条 && 链脚本
//   node dsh-plugins/scripts/run-checks.mjs --list          # 只列出会跑什么
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 解析 `a && b && c` 为命令数组；只支持本仓库这种纯 `&&` 串联，遇到 `||` / `;` / 管道直接报错，不猜。 */
export function splitChain(script) {
	const text = String(script ?? '').trim();
	if (!text) { return []; }
	if (/\|\||;|(?<![&|])\|(?!\|)/.test(text)) {
		throw new Error('只支持纯 && 串联的脚本（发现 || / ; / 管道）');
	}
	return text.split('&&').map(part => part.trim()).filter(Boolean);
}

/** `node path/to/x.mjs args` → 进程参数；首词必须是 node（全仓的守卫都是），其余原样传。 */
export function toArgv(command) {
	const words = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(w => w.replace(/^["']|["']$/g, '')) ?? [];
	if (words[0] !== 'node') { throw new Error(`只支持 node 命令：${command}`); }
	return words.slice(1);
}

/**
 * 会**改动工作区**的检查：并行时必须独占（先单独跑完，再并行跑其余）。
 * `vssaros-superagent/dev/scripts/build.mjs --check` 会删掉 `lib/` 重建再还原——与 check-plugin-files 等并行会读到「lib 不存在」。
 */
// test-gate.mjs（2026-11-06）：SuperAgent 全量测试本身就占满全部核；与别的检查并行会互相拖慢、把超时算成失败 ⇒ 独占。
export const EXCLUSIVE = [/\/build\.mjs\b/, /run-dshharness-tests\.mjs/, /check-dsh-release\.mjs/, /\/test-gate\.mjs\b/];
export const isExclusive = (command) => EXCLUSIVE.some(re => re.test(command.replace(/\\/g, '/')));

/** 失败行摘要：去掉 ANSI，取含 ✗ / FAIL / Error 的前几行，供汇总表显示。 */
export function failureLines(output, max = 3) {
	const clean = String(output ?? '').replace(/\x1b\[[0-9;]*m/g, '');
	const hits = clean.split(/\r?\n/).map(line => line.trim()).filter(line => /✗|^FAIL\b|\bFAIL\b|Error:|AssertionError/.test(line));
	return (hits.length ? hits : clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-2)).slice(0, max)
		.map(line => line.length > 200 ? `${line.slice(0, 200)}…` : line);
}

function run(command) {
	return new Promise(resolve => {
		const started = Date.now();
		let output = '';
		let child;
		try {
			child = spawn(process.execPath, toArgv(command), { cwd: repo, env: { ...process.env, NODE_OPTIONS: '' }, windowsHide: true });
		} catch (error) {
			resolve({ command, code: -1, ms: 0, output: String(error?.message ?? error) });
			return;
		}
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { output += chunk; });
		child.on('error', error => { output += String(error?.message ?? error); });
		child.on('close', code => resolve({ command, code: code ?? -1, ms: Date.now() - started, output }));
	});
}

async function main(argv) {
	const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
	const scriptName = arg('--script') ?? 'check:dsh-plugins';
	const jobs = Math.max(1, Number(arg('--jobs') ?? 1) || 1);
	const only = (arg('--only') ?? '').split(',').map(s => s.trim()).filter(Boolean);
	const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
	const script = pkg.scripts?.[scriptName];
	if (!script) { console.error(`package.json 里没有脚本 ${scriptName}`); return 2; }
	let commands = splitChain(script);
	if (only.length) { commands = commands.filter(c => only.some(o => c.includes(o))); }
	if (argv.includes('--list')) { for (const c of commands) { console.log(c); } return 0; }

	console.log(`${scriptName}：${commands.length} 条，${jobs > 1 ? `并行 ${jobs}（改动工作区的先独占跑）` : '串行'}，失败不中断\n`);
	const results = new Array(commands.length);
	const report = (index, result) => {
		results[index] = result;
		console.log(`${result.code === 0 ? '  ok  ' : '  FAIL'} ${(result.ms / 1000).toFixed(1).padStart(5)}s  ${commands[index]}`);
	};
	const indexes = commands.map((_, index) => index);
	const alone = jobs > 1 ? indexes.filter(i => isExclusive(commands[i])) : [];
	const shared = indexes.filter(i => !alone.includes(i));
	for (const index of alone) { report(index, await run(commands[index])); }
	let next = 0;
	const worker = async () => {
		while (next < shared.length) {
			const index = shared[next++];
			report(index, await run(commands[index]));
		}
	};
	await Promise.all(Array.from({ length: Math.min(jobs, shared.length) }, worker));

	const failed = results.filter(r => r.code !== 0);
	console.log(`\n${scriptName}：${results.length - failed.length} 通过 / ${failed.length} 失败（共 ${results.length}）`);
	for (const r of failed) {
		console.log(`\n✗ ${r.command}  (exit ${r.code})`);
		for (const line of failureLines(r.output)) { console.log(`    ${line}`); }
	}
	return failed.length ? 1 : 0;
}

const same = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
	process.exitCode = await main(process.argv.slice(2));
}
