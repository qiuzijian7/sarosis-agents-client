/*---------------------------------------------------------------------------------------------
 *  改名回执通道（页面 → 工作台）的接线契约
 *
 *  背景（2026-10-19，A1 方案第 4 步）：`DSH_PAGE_IPC_RENAME`（工作台 → 页面）是**单向推送**，
 *  调用方（会话侧栏）无从知道改成了没有 ⇒ 只能乐观刷新 = 假成功 ✗。而桥的 invoke **没有语义返回值**
 *  （`dshPageBridgeProtocol.ts:79` 只回 `true` / `'pong'`）⇒ 不能拿它当回执。
 *  ⇒ 补一条反向通道：页面派 `vssaros-dsh-renamed` → preload 上送 → 主进程 fire `kind:'renamed'`。
 *
 *  这类改动最容易**半接通**（常量写了、一端忘了接）⇒ 用源码契约钉住三处：常量名一致、
 *  主进程订阅、服务层转发。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DSH_PAGE_IPC_RENAMED, DSH_PAGE_RENAME_EVENT, DSH_PAGE_RENAMED_EVENT } from '../../common/dshPageBridgeProtocol.js';

/** 源码级读取（路径相对**仓库根**，runner 从仓库根跑 ✓）。 */
function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

const PROTOCOL = 'src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts';
const PRELOAD = 'src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts';
const VIEW_HOST = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';
const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
const PAGE_CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.sessionLabel.js';

suite('改名回执通道 · 常量一致（半接通的第一现场）', () => {

	test('★ IPC 频道名与 DOM 事件名：协议常量 == preload 里的硬编码字符串', () => {
		const proto = read(PROTOCOL);
		assert.ok(proto.includes('export const DSH_PAGE_IPC_RENAMED'), '协议必须导出回执频道 ✗');
		assert.ok(proto.includes("kind: 'renamed'"), '协议里 `DshPageEvent` 必须有 renamed 这一支 ✗');
		const preload = read(PRELOAD);
		// preload 用的是本地 const（硬编码），与协议常量漂移就**静默失效**（两端都不报错 ✗）
		assert.ok(preload.includes(`const RENAMED_CH = '${DSH_PAGE_IPC_RENAMED}'`),
			`preload 的上送频道必须是 ${DSH_PAGE_IPC_RENAMED}`);
		assert.ok(preload.includes(`const RENAMED_EVENT = '${DSH_PAGE_RENAMED_EVENT}'`),
			`preload 监听的 DOM 事件必须是 ${DSH_PAGE_RENAMED_EVENT}`);
	});

	test('★ 下发的 DOM 事件名与页面插件派发/监听的名字逐字相同', () => {
		const chunk = read(PAGE_CHUNK);
		// 页面侧（client.sessionLabel.js）用的是字面量 ⇒ 这里按字面量核对，不 import 页面代码
		assert.strictEqual(DSH_PAGE_RENAME_EVENT, 'vssaros-dsh-rename', '下发事件名（工作台 → 页面）');
		assert.strictEqual(DSH_PAGE_RENAMED_EVENT, 'vssaros-dsh-renamed', '回执事件名（页面 → 工作台）');
		assert.ok(chunk.includes('vssaros-dsh-rename'), '页面必须监听下发事件');
		assert.ok(chunk.includes('vssaros-dsh-renamed'), '页面必须派发回执事件');
	});
});

suite('改名回执通道 · 接线', () => {

	test('★ 主进程订阅回执并 fire `kind: renamed`（带 viewId，调用方才能对回是哪一页）', () => {
		const host = read(VIEW_HOST);
		assert.ok(host.includes('DSH_PAGE_IPC_RENAMED'), '主进程必须 import 该常量 ✗');
		assert.ok(host.includes('wc.ipc.on(DSH_PAGE_IPC_RENAMED'), '必须订阅回执频道 ✗');
		assert.ok(/kind: 'renamed'/.test(host), '必须 fire kind: renamed ✗');
	});

	test('★ 服务层：把回执单独转发成 `onDidDshSessionRenamed`，并且只认本 renderer 的视图', () => {
		const svc = read(SERVICE);
		assert.ok(svc.includes('onDidDshSessionRenamed'), '服务层要有该事件 ✗');
		assert.ok(/e\.kind === 'renamed'/.test(svc), '必须从页面事件里挑 renamed 转发 ✗');
		assert.ok(svc.includes('async renameDshSession('), '要有按 sessionId 改名的入口 ✗');
	});

	test('★ `renameDshSession` 靠 `listViews` 解析视图（侧栏只有 sessionId，不能直接调 renameSession）', () => {
		const svc = read(SERVICE);
		const at = svc.indexOf('async renameDshSession(');
		assert.ok(at > 0);
		const body = svc.slice(at, at + 900);
		assert.ok(body.includes('listViews'), '必须先解析视图 ✗');
		assert.ok(body.includes('surface === \'chat\''), '只挑 chat 视图（对 full / plugin-page rebind 会顶掉用户正在看的页 ✗）');
		assert.ok(body.includes('_ownViews.has'), '只认本 renderer 的视图 ✗');
		assert.ok(body.includes('return false'), '没有对应视图 ⇒ 返回 false（不许假装成功 ✗）');
	});
});
