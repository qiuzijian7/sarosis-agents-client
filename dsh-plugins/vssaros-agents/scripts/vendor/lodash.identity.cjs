// vendor/deps/lodash.identity —— 飞书 SDK 用到的 `lodash.identity`（一行）。
// 为什么手写而不是 vendor 真包：见 vendor-lark-sdk.mjs 头注释（npm 打包会剥掉 node_modules，
// 而依赖包再互相 require 时也只能靠 node_modules 解析 ⇒ 只挑"能被几十行替换"的用 shim）。
'use strict';
module.exports = function identity(value) { return value; };
module.exports.default = module.exports;
