/*---------------------------------------------------------------------------------------------
 *  写黑名单（writeDenyList）单元测试
 *
 *  分两大块：
 *   [DENY]  必须拦住的攻击面（apiKey / 会话历史 / 记忆 / 扩展 / ssh / .env …）
 *   [ALLOW] ★★ 放行控制组 —— 与拦截用例同等重要。`~/.vssaros` 下有大量 agent
 *           合法写入位置（tmp 落盘 / skills / plans / memory …），漏放行任何一个
 *           都是功能回归。项目已有教训：只测「能拦住」会把误伤放进生产。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { isWindows } from '../../../../../base/common/platform.js';
import {
	checkWriteDenied,
	WriteDeniedError,
	type IWriteDenyContext,
} from '../../common/writeDenyList.js';

/** 跨平台构造测试路径：Windows 用 G:\ 前缀，posix 用 / 前缀。 */
const P = (...segs: string[]) => (isWindows ? 'G:\\' : '/') + segs.join(isWindows ? '\\' : '/');

const HOME = P('Users', 'tester');
const APPDATA = P('Users', 'tester', '.vssaros');
const WORKSPACE = P('repo', 'myproject');

const CTX: IWriteDenyContext = { userHome: HOME, appDataRoot: APPDATA };
const j = (...segs: string[]) => segs.join(isWindows ? '\\' : '/');

const denied = (p: string, ctx: IWriteDenyContext = CTX) => checkWriteDenied(p, ctx);
const isDenied = (p: string, ctx: IWriteDenyContext = CTX) => denied(p, ctx) !== undefined;

suite('writeDenyList', () => {

	suite('[DENY] 凭据 —— 本护栏的首要目标', () => {
		test('★ provider apiKey 所在的 User/settings.json', () => {
			const v = denied(j(APPDATA, 'User', 'settings.json'));
			assert.ok(v, 'settings.json 必须拒绝（provider apiKey 就在这里）');
			assert.strictEqual(v!.reason, 'credential');
			assert.strictEqual(v!.rule, 'appdata:User');
		});

		test('整个 User/ 子树都拒（profiles / globalStorage / workspaceStorage / mcp.json）', () => {
			for (const rel of [
				j('User', 'mcp.json'),
				j('User', 'profiles', 'default', 'settings.json'),
				j('User', 'globalStorage', 'state.vscdb'),
				j('User', 'workspaceStorage', 'abc', 'state.vscdb'),
			]) {
				assert.ok(isDenied(j(APPDATA, rel)), `${rel} 应拒绝`);
			}
		});

		test('auth.json / machineid', () => {
			assert.strictEqual(denied(j(APPDATA, 'auth.json'))!.reason, 'credential');
			assert.strictEqual(denied(j(APPDATA, 'machineid'))!.reason, 'credential');
		});

		test('~/.ssh 子树与常见凭据文件', () => {
			assert.ok(isDenied(j(HOME, '.ssh', 'id_rsa')));
			assert.ok(isDenied(j(HOME, '.ssh', 'authorized_keys')));
			assert.ok(isDenied(j(HOME, '.ssh', 'config')));
			assert.ok(isDenied(j(HOME, '.aws', 'credentials')));
			assert.ok(isDenied(j(HOME, '.gnupg', 'secring.gpg')));
			assert.ok(isDenied(j(HOME, '.kube', 'config')));
			assert.ok(isDenied(j(HOME, '.docker', 'config.json')));
			assert.ok(isDenied(j(HOME, '.azure', 'credentials')));
			assert.ok(isDenied(j(HOME, '.git-credentials')));
			assert.ok(isDenied(j(HOME, '.netrc')));
			assert.ok(isDenied(j(HOME, '.npmrc')));
			assert.ok(isDenied(j(HOME, '.pypirc')));
			assert.ok(isDenied(j(HOME, '.pgpass')));
		});

		test('~/.config/gh 与 gcloud（多段相对路径）', () => {
			assert.ok(isDenied(j(HOME, '.config', 'gh', 'hosts.yml')));
			assert.ok(isDenied(j(HOME, '.config', 'gcloud', 'credentials.db')));
		});

		test('★ .env 家族在任意位置都拒（含工作区内 —— 改前完全放行）', () => {
			for (const name of ['.env', '.env.local', '.env.production', '.env.test.local', '.envrc']) {
				const v = denied(j(WORKSPACE, name));
				assert.ok(v, `${name} 应拒绝`);
				assert.strictEqual(v!.reason, 'credential');
				assert.ok(v!.rule.startsWith('env:'), v!.rule);
			}
			// 深层子目录同样命中（与位置无关的规则）
			assert.ok(isDenied(j(WORKSPACE, 'packages', 'api', '.env')));
		});
	});

	suite('[DENY] 应用状态与代码载荷', () => {
		test('会话历史 / 记忆 / 备份 / 上下文存储', () => {
			assert.strictEqual(denied(j(APPDATA, 'chat-history', 's1.json'))!.reason, 'app-state');
			assert.strictEqual(denied(j(APPDATA, '.agentmemory', 'db.sqlite'))!.reason, 'app-state');
			assert.strictEqual(denied(j(APPDATA, 'Backups', 'x'))!.reason, 'app-state');
			assert.strictEqual(denied(j(APPDATA, 'context-storage', 'snap.json'))!.reason, 'app-state');
			assert.strictEqual(denied(j(APPDATA, 'pending-approvals', 'a.json'))!.reason, 'app-state');
		});

		test('Electron / Chromium 内部状态', () => {
			for (const rel of ['Local Storage', 'Session Storage', 'WebStorage', 'Service Worker', 'Network', 'Crashpad']) {
				assert.ok(isDenied(j(APPDATA, rel, 'anything')), `${rel} 应拒绝`);
			}
			for (const rel of ['Local State', 'Preferences', 'argv.json', 'workspaces.json', 'installed-packages.json']) {
				assert.ok(isDenied(j(APPDATA, rel)), `${rel} 应拒绝`);
			}
		});

		test('extensions/ 归类为 code-payload（写入=任意代码执行）', () => {
			const v = denied(j(APPDATA, 'extensions', 'evil', 'extension.js'));
			assert.ok(v);
			assert.strictEqual(v!.reason, 'code-payload');
		});
	});

	suite('[ALLOW] ★★ 放行控制组 —— agent 合法写入位置绝不能被误伤', () => {
		test('execOutputSpill 的落盘目录 tmp/', () => {
			assert.ok(!isDenied(j(APPDATA, 'tmp', 'exec-20260822-101010-001-001.log')));
		});

		test('plan 模式唯一允许的写入 plans/', () => {
			assert.ok(!isDenied(j(APPDATA, 'plans', 'plan-abc.md')));
		});

		test('skill_manage 写用户技能 skills/', () => {
			assert.ok(!isDenied(j(APPDATA, 'skills', 'my-skill', 'SKILL.md')));
		});

		test('其余 agent 数据目录全部放行', () => {
			for (const rel of [
				'agents', 'memory', 'knowledge-base', 'workflows', 'dashboard',
				'codebase-graph', 'favorites', 'media', 'logs', 'evolution',
			]) {
				assert.ok(!isDenied(j(APPDATA, rel, 'file.json')), `${rel} 不应被拦`);
			}
		});

		test('工作区内普通文件放行', () => {
			assert.ok(!isDenied(j(WORKSPACE, 'src', 'index.ts')));
			assert.ok(!isDenied(j(WORKSPACE, 'package.json')));
			assert.ok(!isDenied(j(WORKSPACE, '.gitignore')));
		});

		test('★ .env.example / .sample / .template 必须放行（文档化的形状替代品）', () => {
			assert.ok(!isDenied(j(WORKSPACE, '.env.example')));
			assert.ok(!isDenied(j(WORKSPACE, '.env.sample')));
			assert.ok(!isDenied(j(WORKSPACE, '.env.template')));
			assert.ok(!isDenied(j(WORKSPACE, 'env.ts')), '不含点号的 env.ts 是普通源文件');
		});

		test('★ 兄弟目录不得被前缀误伤（isEqualOrParent 按段比较，非 startsWith）', () => {
			assert.ok(!isDenied(j(HOME, '.ssh-backup', 'notes.md')), '.ssh-backup 不是 .ssh 的子路径');
			assert.ok(!isDenied(j(APPDATA, 'User-notes', 'a.md')), 'User-notes 不是 User 的子路径');
			assert.ok(!isDenied(j(APPDATA, 'extensions-dev', 'x.js')));
			assert.ok(!isDenied(j(HOME, '.awsome', 'x')), '.awsome 不是 .aws 的子路径');
		});

		test('主目录下的普通文件放行', () => {
			assert.ok(!isDenied(j(HOME, 'notes.md')));
			assert.ok(!isDenied(j(HOME, 'Documents', 'a.txt')));
		});
	});

	suite('边界与健壮性', () => {
		test('空路径 → 放行（不崩）', () => {
			assert.strictEqual(checkWriteDenied('', CTX), undefined);
		});

		test('ctx 缺失 userHome/appDataRoot 时只剩位置无关规则', () => {
			const empty: IWriteDenyContext = {};
			assert.ok(!isDenied(j(APPDATA, 'User', 'settings.json'), empty), 'appDataRoot 未知则无法判定');
			assert.ok(isDenied(j(WORKSPACE, '.env'), empty), '.env 规则与位置无关，仍生效');
		});

		test('目录本身（等于黑名单根）也拒绝', () => {
			assert.ok(isDenied(j(APPDATA, 'User')));
			assert.ok(isDenied(j(HOME, '.ssh')));
		});

		test('message 含替代方案且明确「无法通过确认卡片放行」', () => {
			const v = denied(j(APPDATA, 'User', 'settings.json'))!;
			assert.ok(v.message.includes('无法通过确认卡片放行'), '必须告知模型这不是可授权的越界');
			assert.ok(v.message.includes('不要重试'), '必须阻止无效重试');
		});

		test('三类 reason 的文案各不相同（分类有意义）', () => {
			const a = denied(j(APPDATA, 'User', 'settings.json'))!.message;
			const b = denied(j(APPDATA, 'chat-history', 'x'))!.message;
			const c = denied(j(APPDATA, 'extensions', 'x'))!.message;
			assert.notStrictEqual(a, b);
			assert.notStrictEqual(b, c);
			assert.notStrictEqual(a, c);
		});
	});

	suite('WriteDeniedError 契约', () => {
		test('★★ isSandboxViolation 必须为 false（否则会弹授权卡片，黑名单形同虚设）', () => {
			const e = new WriteDeniedError('/x', 'credential', 'r', 'm');
			assert.strictEqual(e.isSandboxViolation, false);
			assert.strictEqual(e.isWriteDenied, true);
		});

		test('标记为不可重试（确定性失败）', () => {
			const e = new WriteDeniedError('/x', 'credential', 'r', 'm');
			assert.strictEqual(e.isNonRetryableToolError, true);
		});

		test('是 Error 子类且保留 message / name', () => {
			const e = new WriteDeniedError('/x', 'app-state', 'rule-x', 'msg-y');
			assert.ok(e instanceof Error);
			assert.strictEqual(e.message, 'msg-y');
			assert.strictEqual(e.name, 'WriteDeniedError');
			assert.strictEqual(e.rule, 'rule-x');
			assert.strictEqual(e.reason, 'app-state');
		});
	});
});
