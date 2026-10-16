# -*- coding: utf-8 -*-
# Saros 知识库：PDF → Markdown（由 kbDocConvertChannel 生成，请勿手改）
import sys, os, json, re, unicodedata, urllib.parse

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

NL = chr(10)


def fail(msg):
    sys.stderr.write('[SAROS-ERROR] ' + str(msg) + NL)
    sys.stdout.write(json.dumps({'ok': False, 'error': str(msg)}, ensure_ascii=False) + NL)
    sys.stdout.flush()
    sys.exit(2)


if len(sys.argv) < 3:
    fail('用法: script.py <pdf> <outDir> [imagePrefix]')

pdf = sys.argv[1]
out_dir = sys.argv[2]
prefix = (sys.argv[3] if len(sys.argv) > 3 else '').strip()

if not os.path.isfile(pdf):
    fail('文件不存在: ' + pdf)
pdf = os.path.abspath(pdf)

os.makedirs(out_dir, exist_ok=True)
img_dir = os.path.join(out_dir, 'images')
os.makedirs(img_dir, exist_ok=True)

# ⚠ 必须切到输出目录：pymupdf4llm 的 image_path 收的是**相对路径**（'images'），
#   而相对路径基于进程 cwd —— 不 chdir，图片会落到别处（实测 images 数为 0）。
#   之所以坚持用相对路径：这样生成的 markdown 里写的是 images/xxx.png，
#   后续「改写为 assets/<素材名>/img-NN.png」才能按前缀匹配到。
os.chdir(out_dir)

md = None
backend = 'pypdf'
pages = 0

# ① 首选 PyMuPDF4LLM：结构化 markdown + 图片导出
try:
    import pymupdf4llm
    import pymupdf
    _doc = pymupdf.open(pdf)
    pages = _doc.page_count
    _doc.close()
    md = pymupdf4llm.to_markdown(pdf, write_images=True, image_path='images',
                                 image_format='png', dpi=150)
    backend = 'pymupdf4llm'
except Exception as e:
    sys.stderr.write('[SAROS-WARN] pymupdf4llm 不可用，回退 pypdf: ' + str(e) + NL)

# ② 回退：pypdf 纯文本（无图片、无结构，仅保证「能出文本」）
if md is None:
    try:
        try:
            from pypdf import PdfReader
        except Exception:
            from PyPDF2 import PdfReader
        _reader = PdfReader(pdf)
        pages = len(_reader.pages)
        _parts = []
        for i, page in enumerate(_reader.pages):
            try:
                t = page.extract_text() or ''
            except Exception:
                t = ''
            t = t.strip()
            if t:
                _parts.append('## 第 %d 页' % (i + 1))
                _parts.append('')
                _parts.append(t)
        md = NL.join(_parts)
    except Exception as e:
        fail('提取失败: ' + str(e))

# ③ NFKC 归一化（修「康熙部首」等兼容码位；代价：中文全角标点变半角，不影响语义）
md = unicodedata.normalize('NFKC', md)

# ④ 清理 U+FFFD 占位符（实测 3 页文档里有 35 个）
#
#   成因：PDF 用**子集字体**且缺少字形到 Unicode 的映射时，PyMuPDF 只能输出 U+FFFD。
#   实测这些位置原本分两类，必须**区别对待**（用旧 pypdf 产物交叉验证得出）：
#     · 词间空格 —— 例 Unreal?Engine?4?中的?UI?优化技巧（pypdf 侧为 UnrealEngine4中的UI优化技巧）；
#       若直接丢弃，整串会黏在一起，可读性反而更差 ⇒ 两侧都是「字母/数字/汉字」时补一个空格；
#     · 项目符号 / 句末符号 —— 例「计算每个节点的大小。?」（原本是实心圆点）、
#       「合理设置Visibility?」（原本是空心圆点）；已无信息可恢复 ⇒ 直接丢弃。
#   ⚠ 用 chr(0xFFFD) 而不是字面量：避免在本 TS 模板字符串里写 unicode 转义（会被 TS 先解析掉）。
REPLACEMENT = chr(0xFFFD)
if REPLACEMENT in md:
    _fixed = []
    _len = len(md)
    for _i, _ch in enumerate(md):
        if _ch != REPLACEMENT:
            _fixed.append(_ch)
            continue
        _prev = md[_i - 1] if _i > 0 else ''
        _next = md[_i + 1] if _i + 1 < _len else ''
        # isalnum() 对汉字返回 True、对「。」「】」「]」等标点返回 False ⇒ 正好用来判定「词间」
        _fixed.append(' ' if (_prev.isalnum() and _next.isalnum()) else '')
    md = ''.join(_fixed)

# ⑤ 图片重命名为安全名，并把 markdown 里的引用改写为 <prefix>/img-NN.ext
try:
    imgs = sorted(f for f in os.listdir(img_dir) if os.path.isfile(os.path.join(img_dir, f)))
except Exception:
    imgs = []

# ⚠ 实测：pymupdf4llm 写进 markdown 的图片引用是**绝对路径**，且与传入的 image_path
#   可能在「大小写 / 8.3 短名」上不一致（实测它写 C:/Users/qiuzijian/…，而传入的是
#   C:/Users/QIUZIJ~1/…）⇒ **任何前缀匹配都不可靠**（曾因此残留绝对路径 ⇒ 预览必裂图）。
#   ⇒ 改为「解析每个链接的 basename → 查表替换」，对前缀形态完全免疫。
mapping = {}
for i, old in enumerate(imgs, 1):
    ext = os.path.splitext(old)[1].lower() or '.png'
    new = 'img-%02d%s' % (i, ext)
    if new != old:
        os.replace(os.path.join(img_dir, old), os.path.join(img_dir, new))
    mapping[old] = (prefix + '/' + new) if prefix else new

if mapping:
    def _fix_link(m):
        url = m.group(1)
        # chr(92) = 反斜杠：避免在本 TS 模板字符串里出现转义歧义
        base = urllib.parse.unquote(os.path.basename(url.replace(chr(92), '/')))
        target = mapping.get(base)
        return '](' + target + ')' if target else m.group(0)
    # ⚠⚠ 两个坑（都实测踩过）：
    #   ① 反斜杠必须写**双份** —— 本脚本嵌在 TS 模板字符串里，单反斜杠 + 括号会被 TS
    #      当转义序列吃掉，生成的 Python 正则会退化成 ](([^)]+)) ⇒ 匹配错乱
    #      （实测产出多一个右括号的图片引用）；
    #   ② 本脚本的注释里**绝对不能出现反引号**（会提前闭合 TS 模板字符串）。
    md = re.sub(r'\]\(([^)]+)\)', _fix_link, md)

with open(os.path.join(out_dir, 'doc.md'), 'w', encoding='utf-8') as f:
    f.write(md)

sys.stdout.write(json.dumps({
    'ok': True, 'backend': backend, 'pages': pages,
    'chars': len(md), 'images': len(imgs),
}, ensure_ascii=False) + NL)
sys.stdout.flush()
