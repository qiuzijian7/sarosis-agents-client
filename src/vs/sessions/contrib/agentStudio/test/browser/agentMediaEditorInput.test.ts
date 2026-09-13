/*---------------------------------------------------------------------------------------------
 *  Unit test: AgentMediaEditorInput（2026-09-11 用户需求）
 *
 *  「聊天框显示的图片双击后可在中间编辑器单独 pane 展示」。
 *  输入对象本身是纯逻辑（无 DOM），此处锁定其**去重语义**——它决定重复双击同一张图
 *  是复用同一 tab（期望）还是刷出一堆重复 tab（回归）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentMediaEditorInput } from '../../browser/agentMedia/agentMediaEditorInput.js';

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const FILE_URL = 'vscode-file://vscode-app/C:/tmp/a.png';

suite('AgentMediaEditorInput', () => {

	test('typeId / editorId 指向已注册的媒体 pane', () => {
		const input = new AgentMediaEditorInput({ src: DATA_URL, kind: 'image' });
		assert.strictEqual(input.typeId, AgentMediaEditorInput.ID);
		assert.strictEqual(input.editorId, AgentMediaEditorInput.EDITOR_ID);
		// pane 注册用同一个 ID（agentStudio.contribution 的 registerEditorPane）；
		// 两者不一致会导致「打开后是空白 pane」。
		assert.strictEqual(AgentMediaEditorInput.EDITOR_ID, 'workbench.editor.agentStudio.agentMediaPane');
	});

	test('只读 + 无资源（data URL 没有可依附的文件资源）', () => {
		const input = new AgentMediaEditorInput({ src: DATA_URL, kind: 'image' });
		assert.strictEqual(input.capabilities, 2, '应为 Readonly（不参与保存/脏标记）');
		assert.strictEqual(input.resource, undefined);
	});

	test('★ 去重：同 src 同 kind → matches（复用 tab，不刷屏）', () => {
		const a = new AgentMediaEditorInput({ src: DATA_URL, kind: 'image' });
		const b = new AgentMediaEditorInput({ src: DATA_URL, kind: 'image' });
		assert.strictEqual(a.matches(b), true);
	});

	test('★ 不同 src / 不同 kind → 不 matches（应开新 tab）', () => {
		const base = new AgentMediaEditorInput({ src: DATA_URL, kind: 'image' });
		assert.strictEqual(base.matches(new AgentMediaEditorInput({ src: FILE_URL, kind: 'image' })), false);
		assert.strictEqual(base.matches(new AgentMediaEditorInput({ src: DATA_URL, kind: 'video' })), false);
	});

	test('标题缺省按 kind；显式 title 优先', () => {
		assert.strictEqual(new AgentMediaEditorInput({ src: DATA_URL, kind: 'image' }).getName(), '生成图片');
		assert.strictEqual(new AgentMediaEditorInput({ src: DATA_URL, kind: 'video' }).getName(), '生成视频');
		assert.strictEqual(new AgentMediaEditorInput({ src: DATA_URL, kind: 'audio' }).getName(), '生成音频');
		assert.strictEqual(new AgentMediaEditorInput({ src: DATA_URL, kind: 'unknown' }).getName(), '生成结果');
		assert.strictEqual(new AgentMediaEditorInput({ src: DATA_URL, kind: 'image', title: '参考图' }).getName(), '参考图');
		// 空白 title 视为未提供（否则 tab 会是空白标题）
		assert.strictEqual(new AgentMediaEditorInput({ src: DATA_URL, kind: 'image', title: '   ' }).getName(), '生成图片');
	});

	test('★★ 贡献点确实注册了该 pane 与 input（否则 openEditor 解析不到 → 打开后空白）', () => {
		// 失败模式（用户实测「点开后是空的」的可能成因之一）：pane 未注册 / 注册时 ID 写错 /
		// SyncDescriptor 漏了 input → IEditorService 找不到该 editorId → 落到别的编辑器（空白）。
		// 这里直接扫贡献点源码，锁定「注册了 AgentMediaEditorPane + 绑定了 AgentMediaEditorInput」。
		const contrib = path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts');
		const src = fs.readFileSync(contrib, 'utf8');
		assert.ok(src.includes('AgentMediaEditorPane'), '贡献点应 import 并使用 AgentMediaEditorPane');
		assert.ok(
			/registerEditorPane\([\s\S]{0,400}AgentMediaEditorPane[\s\S]{0,400}new SyncDescriptor\(AgentMediaEditorInput\)/.test(src),
			'应注册 AgentMediaEditorPane 并绑定 new SyncDescriptor(AgentMediaEditorInput)',
		);
	});

	test('★★ 打开时显式 override pane id（防「按类匹配失败 → 回退文本编辑器 → 空白」）', () => {
		// EditorPaneRegistry 按 `editor.constructor === 注册的 SyncDescriptor.ctor` 匹配 pane；
		// 一旦匹配失败，VS Code 回退成文本编辑器 —— tab 标题正确但内容空白 ✗
		// （用户实测「点放大后未显示图像」的形态）。故打开时必须显式 override。
		const p = path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts');
		const src = fs.readFileSync(p, 'utf8');
		assert.ok(
			/override:\s*AgentMediaEditorPane\.ID/.test(src),
			'_openInMainColumn 的 options 应带 `override: AgentMediaEditorPane.ID`',
		);
	});

	test('★★ 编辑器 pane 不得覆写 getContainer()（否则留下空实例 → 同组其它编辑器上方空白）', () => {
		// 契约：基类 `Composite.getContainer()` 返回 `create(parent)` 收到的 `.editor-instance`，
		//   而 `EditorPanes.doShowEditorPane` 会执行
		//   `editorPanesParent.appendChild(assertReturnsDefined(editorPane.getContainer()))`
		//   —— 工作台**把 getContainer() 当作「本 pane 的实例元素」来挂载与显隐**。
		// 后果（2026-09-11 实测两个症状）：覆写成返回内层容器 →
		//   ① 内层容器被搬出 `.editor-instance`，留下空、height:100%、**永不隐藏**的实例
		//      → 同组切换到别的编辑器时**上方一整块空白** ✗；
		//   ② 内层容器成为流式子节点 → 被排到已有实例**下方**（实测 top=1391，图不在视口内）✗。
		const dir = path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser');
		const offenders: string[] = [];
		const walk = (d: string): void => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) { walk(p); continue; }
				if (!/\.ts$/.test(e.name)) { continue; }
				if (/override\s+getContainer\s*\(/.test(fs.readFileSync(p, 'utf8'))) {
					offenders.push(path.relative(dir, p));
				}
			}
		};
		walk(dir);
		assert.deepStrictEqual(
			offenders,
			[],
			`以下文件覆写了 getContainer()（会留下空 editor-instance → 上方空白）: ${offenders.join(', ')}`,
		);
	});

	test('src / kind 原样透出（pane 据此建 img/video/audio）', () => {
		const input = new AgentMediaEditorInput({ src: FILE_URL, kind: 'video' });
		assert.strictEqual(input.src, FILE_URL);
		assert.strictEqual(input.kind, 'video');
	});
});
