/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * sensitivePaths 单测。
 *
 * 回归目标（2026-08-17 修复的真实缺口）：
 *  - 读、写共享同一张表 → `~/.ssh/id_rsa`、`~/.aws/credentials`、`.env.local`
 *    此前可被 file_read 读取（读表只挡 /dev /proc /sys），现在必须命中。
 *  - `.git-credentials` 此前被错放进「目录前缀」表，靠 includes 侥幸生效；
 *    现在应作为文件名正确命中。
 *  - 匹配语义统一（目录要求前后都有分隔符，避免 `my.ssh-backup` 误伤）。
 */

import assert from 'assert';
import {
	detectDevicePath,
	detectSensitivePath,
	SENSITIVE_DIR_SEGMENTS,
	SENSITIVE_FILE_NAMES,
} from '../../browser/providers/tool/sensitivePaths.js';

suite('sensitivePaths', () => {

	suite('detectDevicePath', () => {
		test('命中 /dev/ /proc/ /sys/ 前缀', () => {
			for (const p of ['/dev/random', '/proc/self/environ', '/sys/kernel/x']) {
				const hit = detectDevicePath(p);
				assert.ok(hit, `${p} 应命中设备路径`);
				assert.strictEqual(hit!.kind, 'device');
			}
		});

		test('普通路径不命中', () => {
			assert.strictEqual(detectDevicePath('/home/x/project/src/dev/main.ts'), undefined);
			assert.strictEqual(detectDevicePath('C:\\work\\proc\\a.ts'), undefined);
		});

		test('空输入安全返回', () => {
			assert.strictEqual(detectDevicePath(''), undefined);
		});
	});

	suite('detectSensitivePath — 凭据目录', () => {
		test('★ 回归：~/.ssh/id_rsa 必须命中（此前可被读取）', () => {
			const hit = detectSensitivePath('C:/Users/alice/.ssh/id_rsa');
			assert.ok(hit, '.ssh/id_rsa 应命中');
			assert.strictEqual(hit!.kind, 'directory');
			assert.strictEqual(hit!.matched, '.ssh');
		});

		test('★ 回归：~/.aws/credentials 必须命中（此前可被读取）', () => {
			const hit = detectSensitivePath('/home/alice/.aws/credentials');
			assert.ok(hit);
			assert.strictEqual(hit!.matched, '.aws');
		});

		test('★ 回归：~/.kube/config 必须命中（此前可被读取）', () => {
			const hit = detectSensitivePath('/home/alice/.kube/config');
			assert.ok(hit);
			assert.strictEqual(hit!.matched, '.kube');
		});

		test('嵌套目录 .config/gcloud 命中', () => {
			const hit = detectSensitivePath('/home/alice/.config/gcloud/creds.db');
			assert.ok(hit);
			assert.strictEqual(hit!.matched, '.config/gcloud');
		});

		test('Windows 反斜杠归一化后命中', () => {
			const hit = detectSensitivePath('C:\\Users\\alice\\.ssh\\known_hosts');
			assert.ok(hit);
			assert.strictEqual(hit!.kind, 'directory');
		});

		test('大小写不敏感命中', () => {
			assert.ok(detectSensitivePath('C:/Users/Alice/.SSH/id_rsa'));
		});

		test('相似但不同的目录名不误伤', () => {
			// `my.ssh-backup` 不是 `.ssh` 目录
			assert.strictEqual(detectSensitivePath('/home/x/my.ssh-backup/notes.md'), undefined);
			// 文件名含 .ssh 但不是目录
			assert.strictEqual(detectSensitivePath('/home/x/project/readme.ssh.md'), undefined);
		});
	});

	suite('detectSensitivePath — 凭据文件名', () => {
		test('★ 回归：.env.local 必须命中（此前可被读取）', () => {
			const hit = detectSensitivePath('/repo/.env.local');
			assert.ok(hit, '.env.local 应命中');
			assert.strictEqual(hit!.kind, 'filename');
			assert.strictEqual(hit!.matched, '.env.local');
		});

		test('★ 回归：.git-credentials 作为文件名命中（此前错放在目录表）', () => {
			const hit = detectSensitivePath('/home/alice/.git-credentials');
			assert.ok(hit);
			assert.strictEqual(hit!.kind, 'filename');
			assert.strictEqual(hit!.matched, '.git-credentials');
		});

		test('表内所有文件名都能命中', () => {
			for (const name of SENSITIVE_FILE_NAMES) {
				const hit = detectSensitivePath(`/repo/sub/${name}`);
				assert.ok(hit, `${name} 应命中`);
				assert.strictEqual(hit!.matched, name);
			}
		});

		test('basename 全等而非前缀匹配（不误伤 .env.example）', () => {
			// `.env.example` 不在表里，是常见的可公开模板文件
			assert.strictEqual(detectSensitivePath('/repo/.env.example'), undefined);
			// `env.ts` 不是 `.env`
			assert.strictEqual(detectSensitivePath('/repo/src/env.ts'), undefined);
		});
	});

	suite('读写共享同一真源', () => {
		test('目录表与文件名表非空且无重叠语义混用', () => {
			assert.ok(SENSITIVE_DIR_SEGMENTS.length > 0);
			assert.ok(SENSITIVE_FILE_NAMES.length > 0);
			// 目录表不应包含以 '/' 结尾的项（语义已统一为纯 segment）
			for (const seg of SENSITIVE_DIR_SEGMENTS) {
				assert.ok(!seg.endsWith('/'), `目录项 "${seg}" 不应带尾斜杠`);
			}
		});

		test('设备路径不由 detectSensitivePath 负责（策略分离）', () => {
			// 设备恒拦、凭据读可配置放行，因此判定函数必须分开
			assert.strictEqual(detectSensitivePath('/dev/random'), undefined);
			assert.ok(detectDevicePath('/dev/random'));
		});
	});
});
