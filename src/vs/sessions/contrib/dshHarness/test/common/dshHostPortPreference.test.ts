/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `common/dshHostPortPreference.ts` 的契约。
 *
 * 守卫对象：Host 端口的**偏好读写口径** —— 它是"system 提示字节稳定 ⇒ prompt 前缀缓存可命中"
 * 这条链路的第一环（真机证据见该模块头注释：同一会话 6 次请求 system 302 行里 299 行逐字相同、
 * 唯一差异是端口，累计命中率 6.4%）。
 *
 * ⚠ 这些是**容错**断言，不是"正常路径"断言：偏好只是优化，任何脏数据都必须退化成
 * `undefined`（调用方据此回落 `--port 0`），**绝不能**让 Host 起不来。
 *
 * ⚠ 反向突变验证：把 `isValidPort` 改成 `return true`，越界/非整数用例立刻变红；
 * 把 `parseHostPortPreference` 的 catch 去掉，坏 JSON 用例变红。
 */

import assert from 'assert';
import {
	HOST_PORT_PREFERENCE_FILE,
	parseHostPortPreference,
	portOfOrigin,
	serializeHostPortPreference,
} from '../../common/dshHostPortPreference.js';

suite('dshHarness / host port preference', () => {

	test('序列化 → 解析往返（端口与格式都保住）', () => {
		const text = serializeHostPortPreference(1531, 1791987703869);
		assert.deepStrictEqual(JSON.parse(text), { format: 1, port: 1531, updatedAt: 1791987703869 });
		assert.strictEqual(parseHostPortPreference(text), 1531);
	});

	test('序列化拒绝非法端口（写进去就会是个坏偏好）', () => {
		for (const bad of [0, -1, 65536, 1.5, Number.NaN]) {
			assert.throws(() => serializeHostPortPreference(bad, Date.now()), /invalid port/, `port=${String(bad)} 必须被拒`);
		}
	});

	test('解析：任何脏数据一律 undefined（调用方据此回落 --port 0）', () => {
		const bad = [
			undefined,
			'',
			'not json',
			'{}',
			'{"port":0}',
			'{"port":65536}',
			'{"port":1.5}',
			'{"port":"1531"}',
			'{"port":null}',
			'null',
			'[]',
		];
		for (const text of bad) {
			assert.strictEqual(parseHostPortPreference(text), undefined, `text=${String(text)} 应退化成 undefined`);
		}
	});

	test('解析只认端口，不要求 format/updatedAt 存在（向前兼容）', () => {
		assert.strictEqual(parseHostPortPreference('{"port":8080}'), 8080);
	});

	test('portOfOrigin：从 origin 取端口，且与协议/畸形输入的口径固定', () => {
		assert.strictEqual(portOfOrigin('http://127.0.0.1:1531'), 1531);
		assert.strictEqual(portOfOrigin('http://127.0.0.1:1531/?token=abc'), 1531);
		// 空串与 undefined 同义（租约里可能没有 origin）
		assert.strictEqual(portOfOrigin(undefined), undefined);
		assert.strictEqual(portOfOrigin(''), undefined);
		// 没有显式端口 ⇒ 不猜默认端口（猜错会写出一条错误的偏好，比没有更糟）
		assert.strictEqual(portOfOrigin('http://127.0.0.1'), undefined);
		// 非 http(s) 与畸形串一律 undefined
		assert.strictEqual(portOfOrigin('file:///c:/x'), undefined);
		assert.strictEqual(portOfOrigin('127.0.0.1:1531'), undefined);
		assert.strictEqual(portOfOrigin('http://'), undefined);
	});

	test('偏好文件名固定（与 dsh 自己的 host.json 同目录同层）', () => {
		assert.strictEqual(HOST_PORT_PREFERENCE_FILE, 'host-port.json');
	});
});
