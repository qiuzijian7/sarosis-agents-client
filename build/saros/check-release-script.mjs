/*---------------------------------------------------------------------------------------------
 *  check-release-script.mjs — 发布脚本的**口径守卫**（2026-10-21）
 *
 *  ## 它守住什么（一次"静默残桩"的教训）
 *  工蜂（git.woa.com）的 `POST /releases` 在 body **同时带 `name` 和 `description`** 时，
 *  会让 **`name` 覆盖 `description`** ⇒ 建出来的 release 描述 = "VsSaros v2.2.26066"（19 字符）
 *  ⇒ **残桩**（没有 changelog、没有下载链接）✗✗
 *  ⇒ 而 CI 的流水线**照样 success**（POST 返回 200）⇒ 一个月没人发现。
 *
 *  实测结论（2026-10-21，工蜂实机）：
 *   · `POST` body **只带** `description`（不带 `name`）⇒ 描述**正确写入** ✓
 *   · `POST` body 带 `name` + `description` ⇒ 描述被 `name` 顶掉 ⇒ 残桩 ✗
 *   · `PUT /releases/<tag>` ⇒ 描述**正确写入** ✓（按数字 id 反而 404 ⇒ 工蜂只认 tag）
 *   · `POST` 已存在 ⇒ 409；`DELETE` ⇒ 200 但**实际没删**（假成功）⚠
 *
 *  ## 两条不变量
 *   ① 建 release 的 `POST` body **不得带 `name`**（否则描述被顶掉）
 *   ② `POST` 之后**必须**再 `PUT /releases/<tag>` 一次（兜底 + 保证 name/description 都落上）
 *
 *  用法：node build/saros/check-release-script.mjs   （exit 0 = 通过）
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'create-release.cjs'), 'utf8');

const problems = [];

// ① POST 的 body 不带 name
const postIdx = SRC.indexOf("'POST', `${GITLAB_API}/projects/${projectId}/releases`");
if (postIdx < 0) {
	problems.push('找不到创建 release 的 POST 调用（结构变了？）⇒ 守卫自身失效');
} else {
	const window = SRC.slice(postIdx, postIdx + 400);
	const bodyLine = window.split('\n').find(l => l.includes('json:'));
	if (!bodyLine) {
		problems.push('POST 调用里找不到 json body ⇒ 守卫自身失效');
	} else if (/json:\s*\{[^}]*\bname\b/.test(bodyLine)) {
		problems.push(`POST 的 body 里带了 name ⇒ 工蜂会用 name 覆盖 description ⇒ 建出来是残桩 ✗`
			+ `（实测：描述会变成 "VsSaros <tag>"）`);
	} else if (!/description/.test(bodyLine)) {
		problems.push('POST 的 body 里没有 description ⇒ 新建的 release 一定是残桩 ✗');
	}
	// ② POST 之后必须补一次 PUT
	const after = SRC.slice(postIdx, postIdx + 1600);
	if (!/PUT',\s*`\$\{GITLAB_API\}\/projects\/\$\{projectId\}\/releases\/\$\{encodeURIComponent\(tag\)\}`/.test(after)) {
		problems.push('POST 之后没有"按 tag 补一次 PUT"⇒ 万一工蜂又改了行为，描述又会静默丢失 ✗');
	}
}

// ③ 发布后必须回读校验（残桩即失败）
if (!/verifyRelease\(/.test(SRC)) {
	problems.push('脚本里没有回读校验（verifyRelease）⇒ 残桩发布过去也没人知道 ✗');
}

if (problems.length) {
	console.error(`✗ 发布脚本口径检查失败（${problems.length} 项）：`);
	for (const p of problems) { console.error(`  · ${p}`); }
	process.exit(1);
}
console.log('✓ 发布脚本口径检查通过（POST 不带 name + 事后 PUT + 回读校验）');