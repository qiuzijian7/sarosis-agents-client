/*---------------------------------------------------------------------------------------------
 *  TimeoutFix.d.ts — 修复 TS2741: Property '_' is missing in type 'Timeout'
 *  TypeScript 6.x 中 NodeJS.Timeout 类型定义变化导致与 VS Code 代码中的
 *  TimeoutHandle/BrandedTimeout 类型不兼容。通过声明合并为 NodeJS.Timeout
 *  添加 _ 品牌属性，一次性修复所有 TS2741 错误。
 *--------------------------------------------------------------------------------------------*/

declare global {
    namespace NodeJS {
        interface Timeout {
            /** Brand property to make Timeout assignable to TimeoutHandle */
            _: void;
        }
    }
}

export {};
