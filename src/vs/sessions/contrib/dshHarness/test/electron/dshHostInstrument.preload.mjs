/*---------------------------------------------------------------------------------------------
 *  诊断用 preload（`node --import <本文件>`）：注册 `dshHostInstrument.hook.mjs` 这个 loader hook。
 *
 *  为什么要分成两个文件：`--import` 只能加载一个模块，而 loader hook 必须通过 `register()` 注册，
 *  「注册」这一步本身要在 preload 里做。两者分开也让 hook 能被单独读/改而不动注入点。
 *
 *  仅测试使用（由 supervisor 的 `VSSAROS_DSH_HOST_PRELOAD` 注入口挂上；生产永不设置）。
 *--------------------------------------------------------------------------------------------*/
import { register } from 'node:module';

register('./dshHostInstrument.hook.mjs', import.meta.url);
