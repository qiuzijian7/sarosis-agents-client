#!/usr/bin/env python3
"""
codicon 子集化 + base64 内联（知识库 dsh 页面专用）。

产出：lib/codiconSubset.js —— 一个只含 @font-face（woff2 以 data URI 内联）
与本页用到的那些 .dsh-cod-* 规则的 CSS 文本常量。页面把它拼进自己的 CSS，
即可在 dsh 自托管页里用上与原资料库（IDE 侧）同一套 codicon 字形。

为什么要自己生成：
  · dsh 自托管页不在 VS Code 的 DOM 里，拿不到 codicon 字体与文件图标主题；
  · 本仓 src/vs/base/browser/ui/codicons/codicon/codicon.css 只有 899 B，
    只声明 @font-face，图标类的 content 是运行时由 iconsStyleSheet.ts 动态生成的
    （该文件第 25 行明写）⇒ 必须自己从 codiconsLibrary.ts 取码位。

许可（照抄本仓 ThirdPartyNotices.txt:3062 的口径，别改写）：
  vscode-codicons 0.0.46-0 —— MIT and Creative Commons Attribution 4.0
  字体侧是 CC BY 4.0 ⇒ 随包分发需保留署名（见 lib/codiconSubset.js 头部注释）。

重跑：改下面的 NAMES，然后
  python dsh-plugins/vssaros-kb/scripts/build-codicon-subset.py
"""

import base64
import io
import re
import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]  # dsh-plugins/vssaros-kb/scripts -> 仓库根
TTF = ROOT / 'src/vs/base/browser/ui/codicons/codicon/codicon.ttf'
LIB_TS = ROOT / 'src/vs/base/common/codiconsLibrary.ts'
OUT_JS = HERE.parent / 'lib/codiconSubset.js'

# 本页实际用到的字形（加图标只需往这里加，再重跑本脚本）
NAMES = [
    'file',              # 文件行图标（真源无图标主题时的基础类就是 codicon-file）
    'folder',            # 目录行
    'folder-opened',     # 余量：展开态目录（真源用同一枚 + 主题着色）
    'chevron-right',     # 分区头箭头（展开由 CSS rotate(90deg)）
    'chevron-down',      # vault 下拉 caret
    'new-file',          # 行内「新建笔记」
    'new-folder',        # 行内「新建文件夹」
    'trash',             # 行内「删除」
    'pencil',            # 行内「重命名」（与 codicon-edit 同一码位）
    'search',            # 搜索框 / 标签搜索
    'close',             # 搜索清除（与 codicon-x 同一码位）
    'book',              # 「库」分区 + vault 图标
    'note',              # 「笔记」分区
    'tag',               # 「标签分类」分区
    'check',             # 菜单勾选位（替代原先 CSS content 打勾）
    'ellipsis',          # 更多
    'refresh',           # 刷新
    'gear',              # 知识库设置
    'graph',             # 关系图谱
    'type-hierarchy',    # 思维导图
    'list-tree',         # 文件树视图
    'sort-precedence',   # 排序
    'add',               # 「配置文件夹为知识库…」
    'clock',             # 余量：待构建 / 时间类徽标
    'cloud-upload',      # 「同步飞书」分区头按钮（真源用的就是 codicon-cloud-upload ✓ 2026-10-19）
]

FAMILY = 'vsaros-codicon'


def load_library():
    """从 codiconsLibrary.ts 取 图标名 -> 码位（文件里有别名，同名不同码位不会出现）。"""
    text = LIB_TS.read_text(encoding='utf-8')
    table = {}
    for m in re.finditer(r"register\('([^']+)',\s*0x([0-9a-fA-F]+)\)", text):
        name, code = m.group(1), int(m.group(2), 16)
        table.setdefault(name, code)
    return table


def main():
    if not TTF.exists():
        print('源字体不存在: %s' % TTF)
        return 1
    lib = load_library()
    missing = [n for n in NAMES if n not in lib]
    if missing:
        print('codiconsLibrary.ts 里找不到: %s' % ', '.join(missing))
        return 1

    codes = sorted({lib[n] for n in NAMES})
    font = TTFont(str(TTF))
    before = Path(TTF).stat().st_size

    opts = Options()
    opts.drop_tables += ['DSIG']
    opts.notdef_outline = True
    opts.recalc_bounds = True
    sub = Subsetter(options=opts)
    sub.populate(unicodes=codes)
    sub.subset(font)

    buf = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buf)
    woff2 = buf.getvalue()
    b64 = base64.b64encode(woff2).decode('ascii')

    rules = []
    rules.append('@font-face{font-family:"%s";src:url(data:font/woff2;base64,%s) format("woff2");font-display:block}'
                 % (FAMILY, b64))
    rules.append('.dsh-cod{font:normal normal normal 16px/1 %s;display:inline-block;'
                 'text-decoration:none;text-rendering:auto;text-align:center;text-transform:none;'
                 '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;'
                 'user-select:none;-webkit-user-select:none}' % FAMILY)
    for n in NAMES:
        rules.append(r'.dsh-cod-%s::before{content:"\\%s"}' % (n, format(lib[n], '04x')))

    css = '\n'.join(rules)
    glyph_list = ', '.join("'%s'" % n for n in NAMES)

    js = '''/**
 * 自动生成 —— 请勿手改。改图标清单请编辑 scripts/build-codicon-subset.py 后重跑。
 *
 * codicon 子集（%d 个字形）以 woff2 + base64 内联，供知识库 dsh 页面（/x/kb/）自用。
 * 目的：dsh 自托管页不在 VS Code 的 DOM 里、拿不到 codicon 字体 ⇒ 把字形随包带来，
 * 让页面的文件/目录/箭头/动作图标与原资料库（IDE 侧 kbView）逐字一致。
 *
 * 许可：vscode-codicons 0.0.46-0 —— MIT and Creative Commons Attribution 4.0
 *      （口径照抄本仓 ThirdPartyNotices.txt:3062）。字体侧 CC BY 4.0 带署名义务，
 *      随包分发时本注释即为署名载体，勿删。
 * 来源字体：src/vs/base/browser/ui/codicons/codicon/codicon.ttf
 * 码位来源：src/vs/base/common/codiconsLibrary.ts
 */
export const CODICON_SUBSET_NAMES = [%s];

export const CODICON_FONT_CSS = `%s`;

/**
 * 渲染一枚图标（服务端拼 HTML 用）。
 * ⚠ 返回的 span 是**空元素**，字形由 ::before 的 content 给出 ⇒ 不要往里塞文本。
 */
export function codicon(name) {
\treturn '<span class="dsh-cod dsh-cod-' + name + '" aria-hidden="true"></span>';
}
''' % (len(NAMES), glyph_list, css)

    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    OUT_JS.write_text(js, encoding='utf-8')

    print('字形        : %d / 全量 %d' % (len(NAMES), len(lib)))
    print('源 ttf      : %d B' % before)
    print('子集 woff2  : %d B' % len(woff2))
    print('base64      : %d B' % len(b64))
    print('产物        : %s (%d B)' % (OUT_JS, OUT_JS.stat().st_size))
    return 0


if __name__ == '__main__':
    sys.exit(main())
