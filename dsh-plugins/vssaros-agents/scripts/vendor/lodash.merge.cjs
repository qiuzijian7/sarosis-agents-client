// vendor/deps/lodash.merge —— 飞书 SDK 用到的 `lodash.merge`（递归深合并）。
//
// ⚠ 只实现 SDK 需要的语义子集，**不是**完整的 lodash.merge：
//   · 普通对象：递归合并（后面的覆盖前面的）
//   · 数组：按下标逐个合并（与 lodash 默认一致）
//   · `undefined` 源值不覆盖（lodash 也这样）
//   · 不做 prototype 污染防护之外的边界处理（这里额外挡掉 `__proto__` / `constructor`）
// SDK 用它合并请求 config / headers，用不到 lodash 的 customizer、symbol 键、TypedArray 分支。
'use strict';

const isObject = (v) => !!v && typeof v === 'object';
const BANNED = new Set(['__proto__', 'constructor', 'prototype']);

function mergeInto(target, source) {
	if (!isObject(source)) { return target; }
	if (Array.isArray(source)) {
		if (!Array.isArray(target)) { return source.slice(); }
		for (let i = 0; i < source.length; i += 1) {
			if (source[i] === undefined) { continue; }
			target[i] = isObject(source[i]) ? mergeInto(isObject(target[i]) ? target[i] : (Array.isArray(source[i]) ? [] : {}), source[i]) : source[i];
		}
		return target;
	}
	for (const key of Object.keys(source)) {
		if (BANNED.has(key)) { continue; }
		const value = source[key];
		if (value === undefined) { continue; }
		if (isObject(value)) {
			target[key] = mergeInto(isObject(target[key]) ? target[key] : (Array.isArray(value) ? [] : {}), value);
		} else {
			target[key] = value;
		}
	}
	return target;
}

module.exports = function merge(object, ...sources) {
	let out = isObject(object) ? object : {};
	for (const src of sources) { out = mergeInto(out, src); }
	return out;
};
module.exports.default = module.exports;
