/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { RETRIEVAL_COMPACTION_ENABLED, RETRIEVAL_BUDGET_RATIO } from '../../common/contextManager.js';

suite('ContextManager — Retrieval Context (default-on contract)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('RETRIEVAL_COMPACTION_ENABLED defaults to ON (no env override)', () => {
		// 检索式上下文默认开启：消除 compressContext 内同步 LLM 摘要导致的 37s 卡顿。
		// 仅当 AGENT_OS_RETRIEVAL_COMPACTION=0 时关闭（需在进程启动时设置，模块加载即定）。
		// 测试环境未设置该 env，故应为 true。
		assert.strictEqual(RETRIEVAL_COMPACTION_ENABLED, true);
	});

	test('RETRIEVAL_BUDGET_RATIO is 0.15', () => {
		// 检索上下文占模型上下文窗口的预算比例，供 getCompactContext/recall 的 token 上限参考。
		assert.strictEqual(RETRIEVAL_BUDGET_RATIO, 0.15);
	});
});
