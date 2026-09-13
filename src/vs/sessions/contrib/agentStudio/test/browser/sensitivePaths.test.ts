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
	sensitiveWriteRejection,
	sensitiveExcludeGlobs,
	isSensitiveName,
	SENSITIVE_DIR_SEGMENTS,
	SENSITIVE_FILE_NAMES,
} from '../../browser/providers/tool/sensitivePaths.js';

suite('sensitivePaths', () => {

	/**
	 * ★★ grep 排除 glob 必须由本模块的**单一真源**派生（2026-09-13）。
	 *
	 * 回归防线：`searchHelpers.DEFAULT_EXCLUDE_GLOBS` 曾**手抄**一份敏感文件表
	 * （P4 2026-07-29），实测落后于本模块 → `file_read` 拒绝读 `.npmrc`，
	 * 而 `search_code "authToken"` 照样把它的内容返回给模型
	 * （`.npmrc` 的 authToken / `.pypirc` 的 password / `.git-credentials` 的 token
	 * 都是**工作区内真实存在**的形态）。本用例钉住「每个表项都有对应排除 glob」。
	 */
	suite('sensitiveExcludeGlobs — 与真源不漂移', () => {

		const globs = sensitiveExcludeGlobs();

		test('★★ 每个凭据文件名都有「本身 + 变体」两条 glob', () => {
			for (const name of SENSITIVE_FILE_NAMES) {
				assert.ok(globs.includes(`**/${name}`), `${name} 缺 '**/${name}'`);
				assert.ok(globs.includes(`**/${name}.*`), `${name} 缺变体 glob`);
			}
		});

		test('★★ 每个凭据目录都有「目录本身 + 目录内容」两条 glob', () => {
			for (const dir of SENSITIVE_DIR_SEGMENTS) {
				assert.ok(globs.includes(`**/${dir}`), `${dir} 缺 '**/${dir}'`);
				assert.ok(
					globs.includes(`**/${dir}/**`),
					`${dir} 缺内容 glob —— ripgrep 里 !**/${dir} 只排除目录节点，其下文件仍需 !**/${dir}/**`,
				);
			}
		});

		test('★ 本次修复覆盖的工作区凭据文件形态', () => {
			for (const g of ['**/.npmrc', '**/.pypirc', '**/.git-credentials', '**/auth.json']) {
				assert.ok(globs.includes(g), `缺 ${g}`);
			}
			assert.ok(globs.includes('**/.config/gcloud/**'), '多段目录 .config/gcloud 必须带内容 glob');
		});

		test('★ 传统密钥变体仍覆盖（`.ssh/` 之外的散落副本）', () => {
			for (const g of ['**/id_rsa', '**/id_rsa.*', '**/id_ed25519.*']) {
				assert.ok(globs.includes(g), `缺 ${g}`);
			}
		});

		test('★ 无重复项（派生表可能因「本身 + 变体」交叉产生重复）', () => {
			const dup = globs.filter((g, i) => globs.indexOf(g) !== i);
			assert.deepStrictEqual([...new Set(dup)], [], `重复项：${dup.join(', ')}`);
		});
	});

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

/**
 * 「写敏感路径」统一入口（2026-09-13 新增）。
 *
 * 缺口：本模块契约写明「凭据路径：**写恒拦**」，但此前**只有 `file_write` 落实** ——
 * `patch` 完全没有这一步 → 同一份敏感路径，`file_write` 硬拒、`patch` 只需用户点一次
 * 「允许」就能写。且 `writeDenyList` 只覆盖 userHome / appData **之下**，**工作区内的**
 * `auth.json` / `.git-credentials` / `.npmrc` / `.pypirc` 与 `/dev/` `/proc/` `/sys/`
 * 都不在其中。
 */
suite('sensitiveWriteRejection — 写敏感路径的统一拒绝入口', () => {

	test('★ 设备路径恒拦（写）', () => {
		for (const p of ['/dev/sda', '/dev/random', '/proc/self/environ', '/sys/kernel/x']) {
			const r = sensitiveWriteRejection(p);
			assert.ok(r, `应拦：${p}`);
			assert.strictEqual(r.kind, 'device', p);
			assert.ok(r.message.includes('Device'), p);
		}
	});

	test('★ 工作区内的凭据文件名也恒拦（writeDenyList 覆盖不到的部分）', () => {
		for (const p of [
			'/repo/auth.json',
			'/repo/.git-credentials',
			'/repo/.npmrc',
			'/repo/.pypirc',
			'/repo/.anthropic_oauth.json',
			'/repo/.env.local',
		]) {
			const r = sensitiveWriteRejection(p);
			assert.ok(r, `应拦：${p}`);
			assert.ok(r.message.includes('Cannot write'), p);
		}
	});

	test('★ 凭据目录恒拦（任意层级）', () => {
		for (const p of ['/home/u/.ssh/id_rsa', 'C:/Users/u/.aws/credentials', '/home/u/.kube/config']) {
			assert.ok(sensitiveWriteRejection(p), `应拦：${p}`);
		}
	});

	test('★★ 控制组：普通路径不得误伤', () => {
		for (const p of [
			'/repo/src/foo.ts',
			'/repo/.env.example',         // 文档化的模板文件，刻意不在表里
			'/repo/docs/readme.md',
			'/repo/src/env.ts',
			'/repo/my.ssh-backup/x.txt',  // 目录项要求前后分隔符，避免子串误伤
		]) {
			assert.strictEqual(sensitiveWriteRejection(p), undefined, `不应拦：${p}`);
		}
	});

	test('空路径不崩', () => {
		assert.strictEqual(sensitiveWriteRejection(''), undefined);
	});
});

/**
 * ★★ `isSensitiveName` —— **目录遍历侧**的单名判定（2026-09-13 新增）。
 *
 * 供代码库索引扫描器使用（索引里存的是**文件内容**，且跨会话持久化，
 * 泄露面比一次 `file_read` 更大）。
 *
 * 与 `sensitiveExcludeGlobs()` 分工：那个产出 glob（ripgrep 用），
 * 本函数做单名精确匹配（逐目录遍历用）—— **同一对真源表**派生。
 */
suite('isSensitiveName — 索引遍历侧的单名判定', () => {

	test('★ 凭据文件名命中（大小写不敏感）', () => {
		for (const n of ['.env', '.env.local', '.git-credentials', 'auth.json', '.npmrc', '.pypirc', 'AUTH.JSON']) {
			assert.strictEqual(isSensitiveName(n), true, n);
		}
	});

	test('★ 凭据目录名命中（多段表项取最后一段）', () => {
		for (const n of ['.ssh', '.aws', '.kube', 'gcloud']) {
			assert.strictEqual(isSensitiveName(n), true, n);
		}
	});

	test('★★ 控制组：普通源码名不得误伤', () => {
		for (const n of [
			'src', 'node_modules', 'index.ts', 'auth.ts',      // 名字含 auth 但不是凭据文件
			'credentials.ts', 'secrets.ts', 'env.ts',          // 有扩展名 → 不误伤
			'auth.json.bak', '.env.example',                   // 变体/模板
		]) {
			assert.strictEqual(isSensitiveName(n), false, n);
		}
	});

	test('空名不崩', () => {
		assert.strictEqual(isSensitiveName(''), false);
	});
});
