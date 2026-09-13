/*---------------------------------------------------------------------------------------------
 *  test/globals.d.ts — 测试全局（mocha --ui=tdd 子集）类型声明
 *
 *  由 scripts/run-unit-tests.mjs 在运行时注入同名全局函数。
 *  此前各测试文件内联 declare，部分文件漏声明 suiteSetup/suiteTeardown → tsc 报 TS2304/TS2593。
 *  集中声明于此（函数声明合并，与文件内既有 declare 签名一致，不冲突）。
 *--------------------------------------------------------------------------------------------*/

declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;
declare function suiteSetup(fn: () => void | Promise<void>): void;
declare function suiteTeardown(fn: () => void | Promise<void>): void;
