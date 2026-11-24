/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ★ **配对守卫**（2026-10-16）：宿主侧的"拥有者心跳"与桥插件侧的"孤儿看门狗"是**跨语言、跨包**的
 * 一对（TS ↔ `dsh-plugins/vssaros-bridge/lib/index.js`），任何一侧单独改动都**不会**编译报错，
 * 故障形态全是**静默**的：
 *   · 心跳没了 ⇒ 插件把"活着的宿主"当孤儿 ⇒ **刻意常驻的 Host 被分钟内收掉** ⇒ 热启动白做 ✗；
 *   · 阈值调太小 ⇒ 同上（正常抖动就误判）✗；
 *   · 握手字段名两侧对不上 ⇒ 看门狗**永远不工作**（孤儿继续攥着会话写租约到 12h TTL）✗；
 *   · 优雅分离忘了标记 ⇒ 正常退出被当成崩溃 ⇒ 又是"收掉常驻 Host"✗。
 * 所以这里逐条把"两侧必须同时存在、且必须成对"钉住 ✓。
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { HOST_RUN_OWNERSHIP_HEARTBEAT_MS } from '../../common/dshHostRunOwnership.js';

const PLUGIN = 'dsh-plugins/vssaros-bridge/lib/index.js';
const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';
const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
const PROTOCOL = 'src/vs/sessions/contrib/dshHarness/common/dshBridgeProtocol.ts';

/** 读仓库内文件（与 `dshHostConfig.test.ts` 同一套定位法：dev 以仓库根为 cwd ✓）。 */
function read(relative: string): string {
	const file = path.join(process.cwd(), relative);
	assert.ok(fs.existsSync(file), `${relative} 不存在 ⇒ 定位仓库根失败（本测试假定以仓库根为 cwd 运行）`);
	return fs.readFileSync(file, 'utf8');
}

/** 源码守卫排除注释，避免说明文字里的旧写法造成假红。 */
function code(relative: string): string {
	return read(relative).replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
}

suite('dshHarness / owner watchdog pairing (host ↔ bridge plugin)', () => {

	test('插件侧的陈旧阈值必须 ≥ 3× 宿主心跳间隔（否则正常心跳之间就误判失联 ✗）', () => {
		const source = read(PLUGIN);
		const match = /const OWNER_STALE_MS = (\d+)\s*\*\s*([\d_]+);/.exec(source);
		assert.ok(match, '插件里找不到 `OWNER_STALE_MS = <n> * <n>` —— 看门狗可能被整块删掉了 ✗');
		const staleMs = Number(match[1]) * Number(match[2].replace(/_/g, ''));
		assert.ok(staleMs >= 3 * HOST_RUN_OWNERSHIP_HEARTBEAT_MS,
			`插件阈值 ${staleMs}ms 必须 ≥ 3× 宿主心跳 ${HOST_RUN_OWNERSHIP_HEARTBEAT_MS}ms（改了任一侧都要来复审另一侧）`);
		assert.ok(staleMs <= 10 * HOST_RUN_OWNERSHIP_HEARTBEAT_MS,
			`阈值 ${staleMs}ms 相对心跳 ${HOST_RUN_OWNERSHIP_HEARTBEAT_MS}ms 太大 ⇒ 宿主崩了要等太久才自退（写租约一直被攥着）`);
	});

	test('载体必须是握手的 `ownerRecord`，且协议 / 宿主 / 插件三处齐全', () => {
		assert.ok(read(PROTOCOL).includes('ownerRecord?: string'),
			'`IClientRegisterParams` 必须带可选 `ownerRecord` —— 它是"当前拥有者是谁"的唯一表达 ✗');
		assert.ok(read(SUPERVISOR).includes('ownerRecord: this._ownershipFile'),
			'宿主必须把自己那份**拥有者记录路径**随每次注册给下去（spawn 路与接管路都要 ✓）');
		assert.ok(read(PLUGIN).includes('req.params.ownerRecord'),
			'插件必须从握手读它 —— 否则看门狗永远没有目标（静默不工作 ✗）');
	});

	test('插件不许在"没给路径"时清掉已有目标（接管后会静默失效 ✗）', () => {
		const source = read(PLUGIN);
		assert.ok(/if \(typeof req\.params\.ownerRecord === 'string' && req\.params\.ownerRecord\)/.test(source),
			'必须是"**给了才替换**"的条件写法：接管/非 VsSaros 托管的客户端不给路径，无条件赋值会把目标清成 undefined ✗');
	});

	test('看门狗的三条判据一个都不能少（缺任一条 ⇒ 要么误杀要么漏杀）', () => {
		const source = read(PLUGIN);
		assert.ok(source.includes('clients.size > 0'), '① 有 IDE 客户端时**必须不动**（否则会打断正在用的 Host）');
		assert.ok(source.includes('statSync(ownerRecordPath).mtimeMs'),
			'② 必须按记录 **mtime** 判陈旧 —— 只看 pid 存活会被 **pid 复用**骗过 ✗');
		assert.ok(/owner heartbeat stale/.test(source) && source.includes('process.exit(0)'),
			'③ 判定成立后要自退（进程退出 = 内核放掉 `session.lock` ✓）');
	});

	test('★ 优雅分离必须在 keepAlive 两条分支里都被标记（spawn / 接管 Host）', () => {
		const source = read(SUPERVISOR);
		const start = source.indexOf('if (this._keepAlive && child && child.exitCode === null)');
		assert.ok(start >= 0, '找不到 `dispose()` 里 spawn Host 的 keepAlive 分支 —— 结构变了，这条守卫要一起复审');
		const firstSuper = source.indexOf('super.dispose();', start);
		const branch = source.slice(start, firstSuper);
		assert.ok(branch.includes('this._markOwnershipDetachedSync();'),
			'常驻分离前必须把记录标记成"已优雅分离"⇒ 不标记的话桥插件会把这次退出当崩溃、把刻意常驻的 Host 收掉 ✗');

		const adopted = source.indexOf('if (this._keepAlive) {', firstSuper);
		assert.ok(adopted > firstSuper, '找不到接管 Host（`_child` 为空）的 keepAlive 分支；退出时会把复用中的 Host 误判成崩溃 ✗');
		const adoptedSuper = source.indexOf('super.dispose();', adopted);
		const adoptedBranch = source.slice(adopted, adoptedSuper);
		assert.ok(adoptedBranch.includes('this._markOwnershipDetachedSync();'), '接管 Host 退出时同样必须标记优雅分离');

		// 反向对照：这个标记**不该**出现在"杀进程"那条路上（那里 Host 真的没了，标记只会掩盖事实 ✗）
		const killPath = source.slice(adoptedSuper);
		assert.ok(!killPath.includes('_markOwnershipDetachedSync'),
			'非 keepAlive（真杀 Host）那条路不许标记"优雅分离" ✗');
	});

	test('★ keepAlive 只由真正启动/接管 Host 的那次 options 决定', () => {
		const src = code(SUPERVISOR);
		const startAt = src.indexOf('start(options: IDshHostStartOptions = {})');
		const doStartAt = src.indexOf('private async _doStart(options: IDshHostStartOptions)');
		assert.ok(startAt > 0 && doStartAt > startAt, '找不到 start() / _doStart()');
		assert.ok(!/this\._keepAlive\s*=/.test(src.slice(startAt, doStartAt)),
			'运行/启动途中再来一次 start({}) 不许把预热时的 keepAlive:true 降成 false ✗');
		assert.match(src.slice(doStartAt, doStartAt + 260), /this\._keepAlive = options\.keepAlive === true;/,
			'新起 Host 时必须按本次 options 设置 keepAlive');
		const adoptAt = src.indexOf('private async _adoptLease(');
		assert.ok(adoptAt > 0, '找不到 _adoptLease()');
		assert.match(src.slice(adoptAt, adoptAt + 360), /this\._keepAlive = options\.keepAlive === true;/,
			'接管既有 Host 时同样要按本次 options 设置 keepAlive');
		assert.match(src, /_adoptLease\(existing, generation, profile, dshHome, t0, options\)/);
		assert.match(src, /_adoptLease\(leaseFromLock, generation, profile, dshHome, t0, options\)/);
	});

	test('★ B 壳 Bootstrap 空选项必须沿用预热/落盘选项并记住 keepAlive', () => {
		const src = code(CHANNEL);
		assert.match(src, /private _persistedStartOptions\(/, '必须有统一的持久化选项合成入口');
		assert.match(src, /keepAlive: s\[DshHarnessSettings\.HostKeepAlive\] !== false/, 'keepAlive 必须按当前用户设置合成');
		assert.match(src, /const opts: IDshHostStartOptions = this\._persistedStartOptions\(persisted, s\);/, '预热必须复用同一份选项');
		assert.match(src, /const start = this\._bootstrapStartOptions\(args\.start\);/, 'Bootstrap 不许直接把空 args.start 交给 supervisor');
		assert.match(src, /this\._rememberStart\(start\);/, '首次 B 启动也要落盘有效选项，供下次预热');
		assert.match(src, /return this\._supervisor\.start\(start\);/, '必须用合成后的完整选项启动');
	});

	test('★ P0/P1：lease 记录插件内容指纹，URL 行直接下发视图连接', () => {
		// 读原文：这两个文件的注释含片段化块注释标记，剥离正则可能吞掉后续代码。
		const sup = read(SUPERVISOR);
		assert.match(sup, /const hash = createHash\('sha1'\)/, '必须计算随包服务端插件内容指纹');
		assert.match(sup, /pluginFingerprint: newestPluginFile\.fingerprint/, 'Host 租约必须写入插件内容指纹');

		assert.match(sup, /const fireEarlyAuth = \(conn: IDshHostConnection\) =>/, 'URL 行与 bridge hello 必须共用一个去重下发入口');
		assert.match(sup, /fireEarlyAuth\(\{ origin: hello\.host\.origin, authUrl: hello\.host\.authUrl \}\)/, 'bridge hello 必须比 ready 更早下发连接');

		const ch = read(CHANNEL);
		assert.match(ch, /onEarlyAuth\(conn => this\._views\.setConnection\(conn\)\)/, '早连接必须下发到视图层并触发加载');
		assert.doesNotMatch(ch, /onEarlyAuth\(conn => this\._views\.prefetchAuth\(conn\)\)/, '不许只预热 cookie 而不加载视图');
		assert.match(ch, /state === 'stopped' \|\| state === 'stopping' \|\| state === 'error'/, '只有终态才允许清空 earlyAuth 连接');
	});
});
