// vendor/deps/lodash.pickby —— 飞书 SDK 用到的 `lodash.pickby`（按谓词筛对象键）。
// 口径与 lodash 一致：`pickBy(obj, [predicate = identity])`，只返回**自身可枚举**且谓词为真的键。
'use strict';

module.exports = function pickBy(object, predicate) {
	const out = {};
	if (!object || typeof object !== 'object') { return out; }
	const pred = typeof predicate === 'function' ? predicate : (v) => !!v;
	for (const key of Object.keys(object)) {
		const value = object[key];
		if (pred(value, key)) { out[key] = value; }
	}
	return out;
};
module.exports.default = module.exports;
