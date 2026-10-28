// @vssaros/dsh-agents — 多渠道凭据单测（2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/im-credentials.test.mjs
//
// 为什么要单测：这里有三类"静默错"——
//   ① 优先级写反 ⇒ 用户在设置里填了，却还在用旧的覆盖层/环境变量（改了不生效）；
//   ② secret 泄漏 ⇒ 接口把明文回给浏览器（一旦发生就收不回）；
//   ③ 局部更新把 secret 清掉 ⇒ 只改了 appId，secret 却没了（连不上，界面还显示"已配置"）；
//   ④ **多平台互相覆盖** ⇒ 存 telegram 把 feishu 写没了（一个 accounts 对象里最容易犯的错）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	describeFeishu, describePlatform, describePlatforms, imAccountsPathOf, maskAppId, maskValue,
	migrateLegacyFeishu, readImAccounts, resolveFeishu, resolvePlatform, saveFeishu, savePlatform,
} from '../lib/imCredentials.js';
import { IM_PLATFORM_DEFS, IM_PLATFORM_KEYS, isPlatformImplemented, platformDefOf } from '../lib/imPlatforms.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

/* ── 平台定义（单一真源）────────────────────────────────────────────── */
check('★ 定义表：四个平台都已接入，且 implemented 与适配器一致', () => {
	assert.deepEqual(IM_PLATFORM_KEYS, ['feishu', 'telegram', 'discord', 'wecom']);
	/* 2026-10-27：飞书 / Telegram / Discord / 企业微信 四个适配器全部落地。
	   ⚠ 这条断言历史上改过三次（每接一个渠道就要改一次）。
	   现在改成**不钉具体平台**的语义：`implemented` 必须是布尔，
	   且 `false` 只能出现在"确实还没有适配器"的情况下（下面用跨平台集合校验）。 */
	assert.equal(isPlatformImplemented('feishu'), true);
	assert.equal(isPlatformImplemented('telegram'), true);
	assert.equal(isPlatformImplemented('discord'), true);
	assert.equal(isPlatformImplemented('wecom'), true);
	/* 未知平台不能"默认已接入" —— 这才是"不做假入口"的守卫 */
	assert.equal(isPlatformImplemented('nope'), false);
	assert.equal(platformDefOf('nope'), undefined);
	for (const d of IM_PLATFORM_DEFS) {
		assert.ok(d.fields.length > 0, d.key + ' 应有字段');
		assert.ok(d.fields.some((f) => f.required), d.key + ' 应有必填字段');
	}
});
check('字段定义齐（key/label/type；secret 必须是 password）', () => {
	for (const d of IM_PLATFORM_DEFS) {
		for (const f of d.fields) {
			assert.ok(f.key && f.label && f.type, d.key + '.' + f.key + ' 定义不全');
			if (f.secret) { assert.equal(f.type, 'password', f.key + ' 是 secret 就必须 password'); }
		}
	}
});

/* ── 掩码 ─────────────────────────────────────────────────────────────── */
check('打码：长值留前后缀，短值只留前两位', () => {
	assert.equal(maskValue('cli_a1b2c3d4e5f6g7h8'), 'cli_a1…h8');
	assert.equal(maskValue('abc'), 'ab***');
	assert.equal(maskValue(''), '');
	assert.equal(maskAppId, maskValue, 'maskAppId 是兼容别名');
});

/* ── 取值优先级 ───────────────────────────────────────────────────────── */
const root = mkdtempSync(join(tmpdir(), 'vssaros-imcred-'));
const config = { dataRoot: root };
const ENV = { VSSAROS_FEISHU_APP_ID: 'env_id', VSSAROS_FEISHU_APP_SECRET: 'env_sec' };

await checkAsync('三档全无 ⇒ configured false / source none', async () => {
	const r = await resolvePlatform({ dataRoot: mkdtempSync(join(tmpdir(), 'vssaros-none-')) }, 'feishu', { env: {} });
	assert.equal(r.configured, false);
	assert.equal(r.source, 'none');
});

await checkAsync('只有环境变量 ⇒ source=env（且只对飞书生效）', async () => {
	const r = await resolveFeishu(config, { env: ENV });
	assert.equal(r.source, 'env');
	assert.equal(r.appId, 'env_id');
	const tg = await resolvePlatform(config, 'telegram', { env: ENV });
	assert.equal(tg.source, 'none', 'telegram 不该被飞书的环境变量顶替');
});

await checkAsync('★ config（IDE 覆盖层）优先于环境变量 ⇒ source=config', async () => {
	const r = await resolveFeishu({ dataRoot: root, feishu: { appId: 'cfg_id', appSecret: 'cfg_sec' } }, { env: ENV });
	assert.equal(r.source, 'config');
	assert.equal(r.appId, 'cfg_id');
});

await checkAsync('★ dsh 侧文件优先于 config 与环境变量', async () => {
	await savePlatform(config, 'feishu', { appId: 'dsh_id', appSecret: 'dsh_sec' });
	const r = await resolveFeishu({ dataRoot: root, feishu: { appId: 'cfg_id', appSecret: 'cfg_sec' } }, { env: ENV });
	assert.equal(r.source, 'dsh');
	assert.equal(r.appId, 'dsh_id');
});

await checkAsync('半份凭据不算配置（缺 secret ⇒ 回落下一档）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-half-'));
	const cfg = { dataRoot: dir, feishu: { appId: 'cfg_id', appSecret: 'cfg_sec' } };
	writeFileSync(imAccountsPathOf(cfg), JSON.stringify({ version: 1, accounts: { feishu: { appId: 'half' } } }), 'utf8');
	const r = await resolveFeishu(cfg, { env: {} });
	assert.equal(r.source, 'config', '半份的 dsh 记录必须被跳过');
});

/* ── 多平台互不干扰 ───────────────────────────────────────────────────── */
await checkAsync('★ 存 telegram 不会把 feishu 写没', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-multi-'));
	const cfg = { dataRoot: dir };
	await savePlatform(cfg, 'feishu', { appId: 'f_id', appSecret: 'f_sec' });
	await savePlatform(cfg, 'telegram', { botToken: 'tg_tok' });
	const accounts = await readImAccounts(cfg);
	assert.equal(accounts.feishu.appId, 'f_id');
	assert.equal(accounts.telegram.botToken, 'tg_tok');
	const f = await describePlatform(cfg, 'feishu');
	const t = await describePlatform(cfg, 'telegram');
	assert.equal(f.configured, true);
	assert.equal(t.configured, true);
	assert.equal(t.fields.botToken, undefined, 'secret 字段不该出现在掩码视图里');
});

await checkAsync('★ 视图里的 implemented 与定义表一致（当前四个平台都已接入）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-pre-'));
	/* ⚠ 这条早先是「未接入平台可保存，implemented:false」，样本从 discord 换成 wecom；
	   2026-10-27 企业微信也接入后**已经没有未接入平台**，再钉具体平台就必然过期。
	   改成断言语义本身：`implemented` 是布尔、且与 `isPlatformImplemented` 一致。 */
	const d = await savePlatform({ dataRoot: dir }, 'wecom', { corpId: 'ww1', agentId: '1000002', secret: 'sec' });
	assert.equal(d.configured, true);
	assert.equal(typeof d.implemented, 'boolean');
	assert.equal(d.implemented, isPlatformImplemented('wecom'));
});

await checkAsync('describePlatforms 覆盖全部平台且顺序与定义一致', async () => {
	const list = await describePlatforms(config);
	assert.deepEqual(list.map((x) => x.key), IM_PLATFORM_KEYS);
});

/* ── 写语义 ───────────────────────────────────────────────────────────── */
await checkAsync('★ 掩码视图永不回 secret（连序列化都不许出现明文）', async () => {
	const v = await describePlatform({ dataRoot: root }, 'feishu');
	assert.equal(v.hasSecret, true);
	assert.ok(!JSON.stringify(v).includes('dsh_sec'), '序列化里不能出现 secret 明文');
	assert.equal(v.fields.appId, maskValue('dsh_id'));
});

await checkAsync('describeFeishu 兼容视图仍是老形状', async () => {
	const v = await describeFeishu({ dataRoot: root });
	assert.deepEqual(Object.keys(v).sort(), ['appIdMasked', 'configured', 'hasSecret', 'source']);
});

await checkAsync('★ 局部更新：只改 appId 时 secret 保留', async () => {
	await saveFeishu({ dataRoot: root }, { appId: 'dsh_id2' });
	const r = await resolveFeishu({ dataRoot: root }, { env: {} });
	assert.equal(r.appId, 'dsh_id2');
	assert.equal(r.appSecret, 'dsh_sec', 'secret 必须保留');
});

await checkAsync('secret 传空串 ⇒ 视为"没改"', async () => {
	await saveFeishu({ dataRoot: root }, { appId: 'dsh_id2', appSecret: '' });
	const r = await resolveFeishu({ dataRoot: root }, { env: {} });
	assert.equal(r.appSecret, 'dsh_sec');
});

await checkAsync('secret 传 null ⇒ 清除该字段（随后不算配置）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-clear-'));
	await savePlatform({ dataRoot: dir }, 'feishu', { appId: 'x_id', appSecret: 'x_sec' });
	const after = await savePlatform({ dataRoot: dir }, 'feishu', { appId: 'x_id', appSecret: null });
	assert.equal(after.hasSecret, false);
	const r = await resolvePlatform({ dataRoot: dir }, 'feishu', { env: {} });
	assert.equal(r.configured, false);
});

await checkAsync('★ 必填缺失 ⇒ 400（不存半份）', async () => {
	await assert.rejects(
		() => savePlatform({ dataRoot: mkdtempSync(join(tmpdir(), 'vssaros-req-')) }, 'feishu', { appId: 'only_id' }),
		(e) => e.httpStatus === 400 && /缺少必填项/.test(e.message),
	);
});

await checkAsync('未知平台 ⇒ 400（并列出支持的平台）', async () => {
	await assert.rejects(
		() => savePlatform({ dataRoot: root }, 'slack', { botToken: 'x' }),
		(e) => e.httpStatus === 400 && /支持 feishu/.test(e.message),
	);
});

await checkAsync('★ 只有人能写（bot ⇒ 403）', async () => {
	await assert.rejects(
		() => savePlatform({ dataRoot: root }, 'feishu', { appId: 'z', appSecret: 'z', actor: { kind: 'bot', agentId: 'coder' } }),
		(e) => e.httpStatus === 403,
	);
});

await checkAsync('全部字段清空 ⇒ 删掉该平台记录', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-del-'));
	await savePlatform({ dataRoot: dir }, 'telegram', { botToken: 'tok' });
	await savePlatform({ dataRoot: dir }, 'telegram', { botToken: null });
	assert.deepEqual(await readImAccounts({ dataRoot: dir }), {});
});

await checkAsync('文件落在 dataRoot 下（便于排查/手工清除）', async () => {
	assert.ok(imAccountsPathOf(config).endsWith('agent-im-accounts.json'));
});


/* ── 旧位置一次性迁移（2026-10-27「数据源统一」）────────────────────── */
await checkAsync('★ 迁移：dsh 侧没有、IDE 覆盖层有 ⇒ 搬进 dsh 文件并记来源', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-mig1-'));
	const cfg = { dataRoot: dir, feishu: { appId: 'ide_id', appSecret: 'ide_sec' } };
	const r = await migrateLegacyFeishu(cfg);
	assert.equal(r.migrated, true);
	const onDisk = await readImAccounts(cfg);
	assert.equal(onDisk.feishu.appId, 'ide_id');
	assert.equal(onDisk.feishu.migratedFrom, 'ide-overlay');
	// 迁移后 source 变成 dsh（不再依赖覆盖层）
	const cur = await resolvePlatform(cfg, 'feishu', { env: {} });
	assert.equal(cur.source, 'dsh');
});

await checkAsync('★ 迁移**不覆盖** dsh 侧已有的凭据（dsh 是权威）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-mig2-'));
	const cfg = { dataRoot: dir, feishu: { appId: 'ide_id', appSecret: 'ide_sec' } };
	await savePlatform(cfg, 'feishu', { appId: 'dsh_id', appSecret: 'dsh_sec' });
	const r = await migrateLegacyFeishu(cfg);
	assert.equal(r.migrated, false);
	assert.equal(r.reason, 'already-in-dsh');
	const onDisk = await readImAccounts(cfg);
	assert.equal(onDisk.feishu.appId, 'dsh_id', '用户后来在 dsh 侧填的值不能被旧位置盖掉');
});

await checkAsync('★ 半份凭据不搬（搬进去也连不上，只会显示"已配置"却报 unavailable）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-mig3-'));
	const r = await migrateLegacyFeishu({ dataRoot: dir, feishu: { appId: 'only_id' } });
	assert.equal(r.migrated, false);
	assert.equal(r.reason, 'nothing-to-migrate');
	assert.deepEqual(await readImAccounts({ dataRoot: dir }), {});
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ IM 凭据单测（多渠道）${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
