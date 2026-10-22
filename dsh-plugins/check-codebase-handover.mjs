#!/usr/bin/env node
// 甲档·所有权交接的**不变量守卫**（2026-10-21）。
//
// 为什么要有这个：交接与两轮性能优化的正确性，靠的是**十几条不变量**（见
// `doc/codebase-handover-measurements.md` §4）。把它们只写在注释里 ⇒ 下一个改代码的人看不到、
// 改掉了也没人知道 ⇒ **图谱变旧**（比慢更糟 ✗✗）。本守卫把其中**可静态判定**的那些变成**会红的断言** ✓。
//
// 判据一律**读源码**（不启动 Host、不碰真机数据 ⇒ 任何时候都能跑 ✓）；每条都写清"为什么"，
// 让失败的人知道自己在破坏什么，而不是只知道"红了一行"。
//
// 用法：node dsh-plugins/check-codebase-handover.mjs   （退出码 0 = 全部守住）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');

const results = [];
/**
 * 一条不变量。
 * @param {string} label 人读的名字
 * @param {boolean} ok 是否守住
 * @param {string} why 破坏后会怎样（写清"为什么"⇒ 失败的人不用猜）
 * @param {string} where 证据位置（file:line 风格，便于直接跳过去看）
 */
function must(label, ok, why, where) {
	results.push({ label, ok: !!ok, why, where });
}

const overlaySrc = read('src/vs/sessions/contrib/dshHarness/common/dshCli.ts');
const pluginIndex = read('dsh-plugins/vssaros-codebase/lib/index.js');
const service = read('dsh-plugins/vssaros-codebase/lib/indexService.js');
const indexer = read('dsh-plugins/vssaros-codebase/lib/indexer.js');
const store = read('dsh-plugins/vssaros-codebase/lib/store.js');
const watcher = read('dsh-plugins/vssaros-codebase/lib/watcher.js');

// ── ① 覆盖层：交接四键 + 显式档位 + 防抖 ────────────────────────────────────────
// 少任何一条都会**静默退化**（目标回影子 / 没人保鲜 / 预算缩图 / 档位被降 / 一直忙）✗
must('覆盖层带 indexTarget: workspace（dsh 才是唯一写者）',
	overlaySrc.includes("'    indexTarget: workspace'"),
	'缺它 ⇒ dsh 写影子目录，IDE 与 dsh 各产一份，IDE 不让路 ⇒ 交接没发生',
	'src/vs/sessions/contrib/dshHarness/common/dshCli.ts');
must('覆盖层带 indexWatch: true（否则交接后没人保鲜）',
	overlaySrc.includes("'    indexWatch: true'"),
	'缺它 ⇒ dsh 不监听文件变化 ⇒ 图会停在最后一次建图，而"变旧"判据是 7 天才报',
	'src/vs/sessions/contrib/dshHarness/common/dshCli.ts');
must('覆盖层带 indexMaxFiles: 20000（预算小于工作区文件数会把全量图缩掉）',
	overlaySrc.includes("'    indexMaxFiles: 20000'"),
	'缺它 ⇒ watcher 用默认 1500 ⇒ 增量按 1500 扫描 ⇒ 39 万节点的图被缩成 1500 个文件 ✗✗',
	'src/vs/sessions/contrib/dshHarness/common/dshCli.ts');
must('覆盖层钉死 parser: treesitter（auto 会按规模静默降成 regex）',
	overlaySrc.includes("'    parser: treesitter'"),
	'缺它 ⇒ auto 分支按"上次文件数 > 3000"降档 ⇒ 39.3 万节点被覆盖成 9.9 万（方法/调用边整族消失）✗✗',
	'src/vs/sessions/contrib/dshHarness/common/dshCli.ts');
must('覆盖层带 debounceMs（多人并发编辑时 5s 会让 watcher 一直忙）',
	overlaySrc.includes("'    debounceMs: 15000'"),
	'缺它 ⇒ 5s 防抖 + 单次十几秒 ⇒ 几乎一直忙（不是错，但很吵）',
	'src/vs/sessions/contrib/dshHarness/common/dshCli.ts');

// ── ② 插件侧：交接安全闸 ────────────────────────────────────────────────────────
must('插件有"首次交接安全闸"（IDE 产的图还在时 watcher 不许覆盖它）',
	service.includes('handoverNeedsInitialBuild') && pluginIndex.includes('handoverNeedsInitialBuild'),
	'缺它 ⇒ watcher 第一次运行就用增量预算覆盖 IDE 的完整图，再写上 producer ⇒ IDE 永远让路 ⇒ 一次误触发就毁图 ✗✗',
	'dsh-plugins/vssaros-codebase/lib/indexService.js');

// ── ③ 档位：不让它被静默降级 ───────────────────────────────────────────────────
must('auto 档会**沿用上次档位**（treesitter 不因规模降档）',
	service.includes("previousParser === 'treesitter'"),
	'缺它 ⇒ 上次是 treesitter 也可能被规模阈值降成 regex ⇒ 图悄悄变矮 ✗',
	'dsh-plugins/vssaros-codebase/lib/indexService.js');

// ── ④ 缓存：被拒是最坏的失败形态（慢但没错）────────────────────────────────────
must('缓存根比较在 win32 上忽略大小写（否则增量被静默降级成全量）',
	indexer.includes("process.platform === 'win32'") && indexer.includes('toLowerCase()'),
	'缺它 ⇒ 同一目录只差 g:/G: 就被判"属于别的工作区" ⇒ 缓存被拒 ⇒ 每次全量重解析（13k 文件真解析 ~90s）而且不报错 ✗✗',
	'dsh-plugins/vssaros-codebase/lib/indexer.js');
must('缓存根比较在非 win32 上仍逐字比较（那里大小写是真差异）',
	indexer.includes("process.platform === 'win32'"),
	'若改成全局忽略大小写 ⇒ Linux 上两个不同目录会被当成同一个 ⇒ 边算错且看不出来 ✗✗',
	'dsh-plugins/vssaros-codebase/lib/indexer.js');

// ── ⑤ A 档优化：指纹 + 配方版本 + 大小闸 ───────────────────────────────────────
must('索引器导出 GRAPH_RECIPE_VERSION（提取语义变了必须 +1）',
	indexer.includes('export const GRAPH_RECIPE_VERSION'),
	'缺它 ⇒ "代码变了但文件没变"会被判成"图没变" ⇒ 图谱停在旧语义上（比慢更糟）✗✗',
	'dsh-plugins/vssaros-codebase/lib/indexer.js');
must('索引器导出 graphFingerprintOf（内容指纹）',
	indexer.includes('export function graphFingerprintOf'),
	'缺它 ⇒ 无法在编码前判"图有没有变" ⇒ 每次空跑都白做 4.7s 的 gzip ✗（只是慢）',
	'dsh-plugins/vssaros-codebase/lib/indexer.js');
must('跑索引时把指纹与配方版本写进 meta（下一轮要靠它判"没变"）',
	service.includes('graphFingerprint: fingerprint') && service.includes('graphRecipe: GRAPH_RECIPE_VERSION'),
	'缺它 ⇒ 永远判不出"没变" ⇒ 优化形同虚设（只是慢）',
	'dsh-plugins/vssaros-codebase/lib/indexService.js');
must('跳编码的第二道闸：图文件大小必须与 meta 记的一致（防盘上那份被动过）',
	service.includes('previousMetaRun.graphBytes === graphStat.size'),
	'缺它 ⇒ 有人截断/替换了盘上的图，插件仍会"跳过重写"⇒ 留下一份坏图 ✗✗',
	'dsh-plugins/vssaros-codebase/lib/indexService.js');
must('图没变时缓存也不重写（省 135MB 写盘）',
	service.includes('if (graphUnchanged === true && cacheExists)'),
	'缺它 ⇒ 每次空跑都重写 135MB 缓存（只是慢 + 伤盘）',
	'dsh-plugins/vssaros-codebase/lib/indexService.js');

// ── ⑥ watcher：预算与防抖都要来自 config ───────────────────────────────────────
must('watcher 的 maxFiles 来自 config.indexMaxFiles（不是写死的默认 1500）',
	pluginIndex.includes('config.indexMaxFiles'),
	'缺它 ⇒ 甲档下增量按默认 1500 扫描 ⇒ 全量图被缩掉 ✗✗',
	'dsh-plugins/vssaros-codebase/lib/index.js');
must('watcher 的防抖来自 config.debounceMs',
	pluginIndex.includes('config.debounceMs') && watcher.includes('debounceMs'),
	'缺它 ⇒ 防抖写死 5s ⇒ 并发编辑时 watcher 几乎一直忙（不是错，但很吵）',
	'dsh-plugins/vssaros-codebase/lib/index.js');

// ── ⑦ 多根语义：显式给的数组就是"没有" ─────────────────────────────────────────
must('relatedRoots：显式给了数组（哪怕空）就以它为准（不回落到 overlay 兜底）',
	store.includes('Array.isArray(config?.relatedRoots)') && !store.includes('config?.relatedRoots.length > 0'),
	'缺它 ⇒ 探针/临时工作区传了空数组也会被真机 overlay 的相关根接管 ⇒ 临时工作区读到**别人的图**（1185 节点）✗✗',
	'dsh-plugins/vssaros-codebase/lib/store.js');

// ── ⑧ 文本搜索：二进制判据与预算 ────────────────────────────────────────────────
must('二进制判据用 NUL 密度（不是"出现过一次 NUL"）',
	store.includes('countNulBytes') && !store.includes("text.includes('\\u0000')"),
	'缺它 ⇒ 源码里合法的字面 NUL（复合键分隔符）让整份文件被跳过 ⇒ 371KB 关键文件搜不到 ✗✗',
	'dsh-plugins/vssaros-codebase/lib/store.js');

// ── 输出 ────────────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) {
	console.log(`${r.ok ? '✓' : '✗'} ${r.label}`);
	if (!r.ok) {
		console.log(`    破坏后会怎样：${r.why}`);
		console.log(`    证据位置：${r.where}`);
	}
}
console.log(`\n交接不变量：${results.length - failed.length}/${results.length} 守住`);
if (failed.length) {
	console.log('⇒ 交接的正确性靠这些不变量撑着；破坏其中任何一条 ⇒ 图谱可能"变旧"（比慢更糟）✗');
	process.exitCode = 1;
}
