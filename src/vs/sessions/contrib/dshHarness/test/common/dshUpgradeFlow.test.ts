/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级链路**端到端数据契约**守卫（2026-11-23）。
 *
 * 前面几轮分别落地了统一版本比较 / 12→8 映射 / seq+job / 策略 / 重启范围 / 断点续传，
 * 各自都有单测，但**串起来**还有一处最容易静默失效的地方：`validateUpgradeState` 是逐字段
 * 白名单 —— 任一新投影忘了放行，宿主算了页面也永远收不到（不报错、日志里也没线索）。
 *
 * 本测试用一份真实形状的更新源响应，走完整条链，最后 JSON 往返 + 主进程白名单重建，
 * 钉住「六个投影一个不少」以及各模块结论互不矛盾。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpgradeFlow
 */

import assert from 'assert';
import { State, UpdateType } from '../../../../../platform/update/common/update.js';
import { acceptResumeResponse, decideResume } from '../../../../../platform/update/common/updateResume.js';
import { initialAppUpdateStatus, reduceAppUpdateStatus } from '../../common/appUpdateState.js';
import { mapUpdateServiceState } from '../../common/appUpdateStateMapping.js';
import { decideAppUpdate, parseAppUpdateResponse } from '../../common/dshAppUpdate.js';
import { compareVersions } from '../../common/dshVersion.js';
import { validateUpgradeState } from '../../common/dshPageBridgeProtocol.js';
import { decideUpgradePolicy } from '../../common/dshUpgradePolicy.js';
import {
	createUpgradeJob, finishUpgradeJob, finishUpgradeJobItem, startUpgradeJobItem,
} from '../../common/dshUpgradeJob.js';
import { decideRestartScope } from '../../common/dshRestartScope.js';

const LOCAL = '2.2.26252';
const REMOTE = '2.2.26301';

suite('dshHarness / 升级链路端到端数据契约', () => {

	test('① 更新源响应 → 防降级闸门 → 策略：三处版本口径一致', () => {
		const parsed = parseAppUpdateResponse({
			version: 'commit-abc', productVersion: REMOTE, url: 'https://update.example/setup.exe',
			sha256hash: 'a'.repeat(64), notes: '· 修复假超时\n· 优化下载',
			minVersion: '2.2.26300', rolloutPercent: 100,
		});
		assert.ok(parsed);
		assert.strictEqual(parsed!.productVersion, REMOTE);
		assert.strictEqual(parsed!.minVersion, '2.2.26300');
		assert.strictEqual(decideAppUpdate(LOCAL, parsed!.productVersion), 'upgrade');
		assert.strictEqual(decideAppUpdate(LOCAL, `${LOCAL}-rc.1`), 'downgrade', '同版本号的预发布不能被当成新版');
		assert.strictEqual(decideAppUpdate(LOCAL, `${REMOTE}-rc.1`), 'upgrade', '更高主版本的预发布仍可升');
		assert.strictEqual(decideAppUpdate(LOCAL, '2.2.26100'), 'downgrade');

		const policy = decideUpgradePolicy({
			local: LOCAL, remote: parsed!.productVersion, channel: 'stable',
			minRequiredVersion: parsed!.minVersion, rolloutPercent: parsed!.rolloutPercent,
			bucket: 'commit-abc', notes: parsed!.notes,
		});
		assert.strictEqual(policy.urgency, 'required', '本地低于最低要求 ⇒ 必须升级');
		assert.strictEqual(policy.notes, parsed!.notes);
		assert.ok(compareVersions(REMOTE, LOCAL) > 0);
		return { parsed, policy };
	});

	test('② 平台 12 态 → 8 相 → 快照：映射与状态机结论对齐', () => {
		const update = { version: 'commit-abc', productVersion: REMOTE } as never;
		const event = mapUpdateServiceState(State.AvailableForDownload(update), '· 修复假超时');
		assert.deepStrictEqual(event, { type: 'available', version: REMOTE, releaseNotes: '· 修复假超时' });
		const status = reduceAppUpdateStatus(initialAppUpdateStatus(LOCAL), event!);
		assert.strictEqual(status.phase, 'available');
		assert.strictEqual(status.availableVersion, REMOTE);
		// 普通 Idle 不迁移：不能把 available 冲掉
		assert.strictEqual(mapUpdateServiceState(State.Idle(UpdateType.Setup)), undefined);
		assert.strictEqual(mapUpdateServiceState(State.Uninitialized), undefined);
		return status;
	});

	test('③ job 串行推进 → 重启范围：含成功随包插件 ⇒ host', () => {
		let job = createUpgradeJob(11, [
			{ kind: 'bundled', key: '@vssaros/dsh-memory', label: '@vssaros/dsh-memory' },
			{ kind: 'bundled', key: '@vssaros/dsh-dashboard', label: '@vssaros/dsh-dashboard' },
			{ kind: 'asset', key: 'mcp/codebase-memory-mcp', label: 'codebase-memory-mcp' },
		]);
		for (const key of ['@vssaros/dsh-memory', '@vssaros/dsh-dashboard', 'mcp/codebase-memory-mcp']) {
			job = startUpgradeJobItem(job, key);
		}
		job = finishUpgradeJobItem(job, '@vssaros/dsh-memory', true);
		job = finishUpgradeJobItem(job, '@vssaros/dsh-dashboard', false, 'profile 锁被占用');
		job = finishUpgradeJobItem(job, 'mcp/codebase-memory-mcp', true);
		job = finishUpgradeJob(job);
		assert.strictEqual(job.done, 3);
		assert.strictEqual(job.failed, 1);
		assert.strictEqual(job.status, 'failed');

		const restart = decideRestartScope({
			appPhase: 'available', jobStatus: job.status, jobDone: job.done,
			jobFailed: job.failed, jobItems: job.items,
		});
		assert.strictEqual(restart.scope, 'host');
		assert.strictEqual(restart.pending, true);
		return { job, restart };
	});

	test('④ 主进程白名单重建：seq / job / policy / restart 一个都不能被静默丢掉', () => {
		const parsed = parseAppUpdateResponse({
			productVersion: REMOTE, notes: '· 修复假超时', minVersion: '2.2.26300', rolloutPercent: 100,
		})!;
		const policy = decideUpgradePolicy({
			local: LOCAL, remote: REMOTE, minRequiredVersion: parsed.minVersion,
			rolloutPercent: parsed.rolloutPercent, bucket: 'commit-abc', notes: parsed.notes,
		});
		let job = createUpgradeJob(12, [
			{ kind: 'bundled', key: '@vssaros/dsh-memory', label: '@vssaros/dsh-memory' },
		]);
		job = finishUpgradeJobItem(startUpgradeJobItem(job, '@vssaros/dsh-memory'), '@vssaros/dsh-memory', true);
		job = finishUpgradeJob(job);
		const restart = decideRestartScope({
			jobStatus: job.status, jobDone: job.done, jobFailed: job.failed, jobItems: job.items,
		});

		const raw = {
			at: Date.now(),
			seq: 87,
			app: {
				current: LOCAL, remote: REMOTE, action: 'upgrade', phase: 'available',
				manual: false, releaseNotes: parsed.notes, percent: 62.4,
			},
			runtime: { current: '0.9.14', channel: 'stable' },
			bundled: [{ name: '@vssaros/dsh-memory', version: '0.3.83', state: 'upgradable' }],
			assets: [{ kind: 'mcp', name: 'codebase-memory-mcp', current: '0.1.0', latest: '0.2.0', via: 'ide' }],
			job, policy, restart,
			injected: 'must-be-dropped',
		};
		// 模拟 IPC 传输：JSON 往返 + 主进程信任边界
		const s = validateUpgradeState(JSON.parse(JSON.stringify(raw)));
		assert.ok(s, '快照必须通过校验');
		assert.strictEqual(s!.seq, 87);
		assert.strictEqual(s!.job?.id, 12);
		assert.strictEqual(s!.job?.status, 'done');
		assert.strictEqual(s!.policy?.urgency, 'required');
		assert.strictEqual(s!.policy?.notes, '· 修复假超时');
		assert.strictEqual(s!.restart?.scope, 'host');
		assert.strictEqual(s!.app.phase, 'available');
		assert.strictEqual(s!.app.percent, 62.4);
		assert.strictEqual(s!.assets[0].via, 'ide');
		assert.strictEqual((s as unknown as Record<string, unknown>).injected, undefined, '外部字段不许穿过桥');
	});

	test('⑤ 续传判据与整条链路不冲突：同一版本可续，换版本必须全量', () => {
		const meta = { url: 'https://update.example/setup.exe', version: 'commit-abc', sha256hash: 'a'.repeat(64) };
		const update = { url: meta.url, version: meta.version, sha256hash: meta.sha256hash };
		const d = decideResume({ partialSize: 100_000_000, meta }, update);
		assert.strictEqual(d.mode, 'resume');
		assert.strictEqual(acceptResumeResponse(206, 'bytes 100000000-499999999/500000000', d.size), true);
		assert.strictEqual(acceptResumeResponse(200, undefined, d.size), false, '服务端不支持 Range ⇒ 回退全量');
		const changed = decideResume({ partialSize: 100_000_000, meta }, { ...update, version: 'commit-def' });
		assert.strictEqual(changed.mode, 'fresh', '换 commit 不许拼旧包');
	});
});
