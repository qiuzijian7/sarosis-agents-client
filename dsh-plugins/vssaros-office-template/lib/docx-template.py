"""Word 模板的段落级编辑器 + 版式保留校验（用户自带模板，无模板库依赖）。

来源与改动（MIT）：核心 XOOXML 操作（段落/run 枚举、按 ID 替换、克隆新增、版式比对校验）
派生自 DSH Desktop 的 `packages/dsh-desktop-office/lib/docx-layout.py`（MIT）。
本版去掉了它的三处宿主依赖，使脚本可以只凭"工作区里的一个 docx"工作：
  · 不再接收 base64 的模板库资产（模板就是用户自己的文件）；
  · 不再需要 `profile.issuerHeader`（那是 Desktop 的公文抬头图片转红字模板专用）；
  · 不再提供 `validate` 独立命令（Desktop 用它给 `present` 做前置闸；本仓没有 present）。

命令（stdin 一个 JSON，stdout 一个 JSON）：
  {"command":"prepare","path":"x.docx"}
      → {"sha256":…, "paragraphs":[{id,text,can_remove,runs:[{id,text,fonts,size,bold}]}]}
  {"command":"write","path":"x.docx","output_path":"y.docx","replacements":[…],
   "additions":[…],"removals":[…]}
      → {"path":…, "sha256":…, "checks":[…]}（内部先 edit 再 validate）

安全边界（与上游一致）：路径必须在 cwd（会话工作区）之内、只认 .docx、拒绝符号链接、
包大小与条目数上限、输出用 O_EXCL（不覆盖既有文件）。
"""

import copy
import hashlib
import io
import json
import os
import sys
import zipfile
from collections import Counter
from pathlib import Path

from lxml import etree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W, 'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
Q = lambda name: '{' + W + '}' + name
MAX_BYTES = 64 * 1024 * 1024


def package(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        if len(names) > 5000 or len(names) != len(set(names)) or sum(item.file_size for item in archive.infolist()) > MAX_BYTES:
            raise ValueError('Use a bounded, regular Word package')
        return {name: archive.read(name) for name in names}


def xml(data):
    return ET.fromstring(data, ET.XMLParser(resolve_entities=False, no_network=True))


def serialized(element):
    return ET.tostring(element, xml_declaration=True, encoding='UTF-8', standalone=True)


def document(parts):
    return xml(parts['word/document.xml'])


def text(paragraph):
    return ''.join((node.text or '') if node.tag == Q('t') else '\t' if node.tag == Q('tab') else '\n' if node.tag in [Q('br'), Q('cr')] else '' for node in paragraph.iter())


def set_text(paragraph, value, fragments=None, prototypes=None):
    if not isinstance(value, str) or len(value) > 32768:
        raise ValueError('Use bounded paragraph text')
    runs = paragraph.findall('w:r', NS)
    prototype = next((r for r in runs if r.find('w:t', NS) is not None), runs[0] if runs else None)
    if fragments is None:
        content = [(prototype, value)]
    else:
        if not isinstance(fragments, list) or not 1 <= len(fragments) <= 200:
            raise ValueError('Use a bounded list of native text styles')
        if any(not isinstance(f.get('text'), str) or f.get('source') not in prototypes for f in fragments):
            raise ValueError('Use recorded run IDs and text for mixed typography')
        if ''.join(f['text'] for f in fragments) != value:
            raise ValueError('Keep the complete paragraph text in its native text fragments')
        content = [(prototypes[f['source']], f['text']) for f in fragments]
    for child in list(paragraph):
        if child.tag not in [Q('pPr'), Q('bookmarkStart'), Q('bookmarkEnd')]:
            paragraph.remove(child)
    end = paragraph.find('w:bookmarkEnd', NS)
    for prototype, value in content:
        run = ET.Element(Q('r'))
        if prototype is not None and prototype.find('w:rPr', NS) is not None:
            run.append(copy.deepcopy(prototype.find('w:rPr', NS)))
        for index, line in enumerate(value.split('\n')):
            if index: ET.SubElement(run, Q('br'))
            for position, chunk in enumerate(line.split('\t')):
                if position: ET.SubElement(run, Q('tab'))
                t = ET.SubElement(run, Q('t')); t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve'); t.text = chunk
        if end is not None: end.addprevious(run)
        else: paragraph.append(run)


def save_package(parts):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return output.getvalue()


def protected(p):
    """版式载体：图表、段落边框（红线）、分节属性 —— 只能改文字，不能删段落。"""
    return bool(p.findall('.//w:drawing', NS) or p.findall('.//w:pBdr', NS) or p.findall('.//w:sectPr', NS))


def inventory(parts):
    result = []
    for index, p in enumerate(document(parts).findall('.//w:body//w:p', NS)):
        styles = []
        for position, run in enumerate(p.findall('w:r', NS)):
            size = run.find('w:rPr/w:sz', NS); bold = run.find('w:rPr/w:b', NS)
            styles.append({'id': f'p{index}:r{position}', 'text': text(run),
                           'fonts': ','.join(run.xpath('./w:rPr/w:rFonts/@w:ascii | ./w:rPr/w:rFonts/@w:eastAsia', namespaces=NS)) or 'inherited',
                           'size': size.get(Q('val')) if size is not None else 'inherited',
                           'bold': bold is not None and bold.get(Q('val'), '1') not in ['0', 'false']})
        result.append({'id': f'p{index}', 'text': text(p),
                       'can_remove': p.getparent().tag == Q('body') and not protected(p), 'runs': styles})
    return result


def workspace_path(root, raw, create=False):
    if not isinstance(raw, str) or not raw or len(raw) > 1024:
        raise ValueError('Use a bounded workspace path')
    path = Path(raw)
    if path.is_absolute():
        try: path = path.relative_to(root)
        except ValueError: raise ValueError('Use a document inside the active workspace')
    if any(part in ['..', '.'] for part in path.parts) or path.suffix.lower() != '.docx':
        raise ValueError('Use a .docx path inside the active workspace')
    current = root
    for part in path.parts[:-1]:
        current = current / part
        if create and not current.exists(): current.mkdir(mode=0o700)
        if current.is_symlink() or not current.is_dir(): raise ValueError('Use regular workspace directories')
    target = current / path.name
    if target.is_symlink() or not target.resolve().is_relative_to(root):
        raise ValueError('Use a regular document inside the active workspace')
    return target


def read_document(path):
    if not path.is_file() or path.stat().st_size > MAX_BYTES: raise ValueError('Use a bounded regular Word file')
    return path.read_bytes()


def write_document(path, data, replace=False):
    flags = os.O_WRONLY | (os.O_TRUNC if replace else os.O_EXCL | os.O_CREAT)
    flags |= getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(path, flags, 0o600), 'wb') as stream: stream.write(data)


def canonical(element):
    """比较"展开后的名字"：序列化器合法地换命名空间前缀不算改动。"""
    if element is None: return ('inherited',)
    return (element.tag, tuple(sorted(element.attrib.items())), (element.text or '').strip(), tuple(canonical(c) for c in element))


def validate(source, candidate):
    expected, actual = document(source), document(candidate)
    checks = []
    # ① 嵌入字体 / 页眉页脚 / 字体表：模板的"非内容"资产必须逐字节不变
    for name, data in source.items():
        if name.startswith('word/fonts/') or name.startswith('word/footer') or name.startswith('word/header') or name == 'word/fontTable.xml':
            if candidate.get(name) != data: raise ValueError('Preserve the template embedded fonts, headers and page-number footers')
    checks.append('embedded-fonts-and-running-content')
    # ② 样式 / 设置 / 主题：不许借替换之机改样式定义
    for name in ['word/styles.xml', 'word/settings.xml', 'word/theme/theme1.xml']:
        if name in source and (name not in candidate or canonical(xml(candidate[name])) != canonical(xml(source[name]))):
            raise ValueError('Keep the selected Word style, settings and theme definitions')
    checks.append('style-and-theme-definitions')
    # ③ 页面几何：节属性（纸张、页边距、页眉页脚引用）
    expected_sections, actual_sections = expected.findall('.//w:sectPr', NS), actual.findall('.//w:sectPr', NS)
    if len(expected_sections) != len(actual_sections): raise ValueError('Preserve the template section layout')
    for left, right in zip(expected_sections, actual_sections):
        if canonical(left) != canonical(right):
            raise ValueError('Preserve the template page geometry, section settings and header/footer references')
    checks.append('page-geometry')
    # ④ 边框 / 图形框 / 表格：只允许保留，不允许新增或删除
    for query, message in [('.//w:pBdr', 'Preserve the template paragraph borders and red divider'), ('.//wp:extent', 'Preserve the template drawing frames'), ('.//w:tblPr', 'Preserve the template table layout'), ('.//w:tblGrid', 'Preserve the template table columns')]:
        reference = Counter(canonical(e) for e in expected.findall(query, NS)); proposed = Counter(canonical(e) for e in actual.findall(query, NS))
        if reference - proposed: raise ValueError(message)
    checks.append('borders-and-drawing-frames')
    # ⑤ 字体分配：新文本只能用模板里出现过的字体
    allowed = set(expected.xpath('.//w:rFonts/@w:ascii | .//w:rFonts/@w:hAnsi | .//w:rFonts/@w:eastAsia', namespaces=NS))
    proposed = set(actual.xpath('.//w:rFonts/@w:ascii | .//w:rFonts/@w:hAnsi | .//w:rFonts/@w:eastAsia', namespaces=NS))
    if proposed - allowed: raise ValueError('Use the font assignments from the selected template')
    checks.append('template-font-assignments')
    # ⑥ 段落/run 属性：只允许模板里已存在的组合（clone 原样式即可满足）
    for query, message in [('.//w:body//w:p/w:pPr', 'Use the template paragraph styles and spacing'), ('.//w:body//w:r/w:rPr', 'Use the template text sizes and styles')]:
        allowed_profiles = set(canonical(e) for e in expected.findall(query, NS))
        if any(canonical(e) not in allowed_profiles for e in actual.findall(query, NS)): raise ValueError(message)
    checks.append('paragraph-and-run-styles')
    return checks


def edit(parts, args):
    root = document(parts); paragraphs = root.findall('.//w:body//w:p', NS); lookup = {f'p{i}': p for i, p in enumerate(paragraphs)}
    prototypes = {f'p{i}:r{j}': copy.deepcopy(r) for i, p in enumerate(paragraphs) for j, r in enumerate(p.findall('w:r', NS))}
    replacements, additions, removals = args.get('replacements', []), args.get('additions', []), args.get('removals', [])
    if any(not isinstance(items, list) or len(items) > 1000 for items in [replacements, additions, removals]): raise ValueError('Use a bounded edit plan')
    seen = set()
    for replacement in replacements:
        key = replacement['id']
        if key in seen or key not in lookup: raise ValueError('Use each recorded paragraph ID once')
        seen.add(key); p = lookup[key]
        if p.findall('.//w:drawing', NS): raise ValueError('Edit drawing content with the native Office workflow')
        set_text(p, replacement['text'], replacement.get('runs'), prototypes)
    tails = {}
    for addition in additions:
        after, source = addition['after'], addition['source']
        if after not in lookup or source not in lookup: raise ValueError('Use recorded paragraph IDs for additions')
        origin = lookup[source]
        if protected(origin): raise ValueError('Use a text paragraph as the addition style')
        clone = copy.deepcopy(origin); set_text(clone, addition['text'], addition.get('runs'), prototypes)
        for marker in clone.xpath('.//w:bookmarkStart | .//w:bookmarkEnd', namespaces=NS): marker.getparent().remove(marker)
        anchor = tails.get(after, lookup[after]); anchor.addnext(clone); tails[after] = clone
    for key in removals:
        if key not in lookup or key in seen: raise ValueError('Use distinct recorded paragraph IDs for removals')
        p = lookup[key]
        if p.getparent().tag != Q('body') or protected(p): raise ValueError('Keep the template layout paragraphs and table structure')
        p.getparent().remove(p); seen.add(key)
    parts['word/document.xml'] = serialized(root)
    return parts


def run(payload):
    root = Path.cwd().resolve()
    command = payload['command']
    args = payload.get('args', {})
    if command == 'prepare':
        target = workspace_path(root, args.get('path'))
        source = package(read_document(target))
        return {'sha256': hashlib.sha256(save_package(source)).hexdigest(), 'paragraphs': inventory(source)}
    if command == 'write':
        target = workspace_path(root, args.get('path'))
        output = workspace_path(root, args.get('output_path'), create=True)
        source = package(read_document(target))
        candidate = edit(copy.deepcopy(source), args)
        checks = validate(source, candidate)
        data = save_package(candidate)
        write_document(output, data)
        return {'path': args.get('output_path'), 'sha256': hashlib.sha256(data).hexdigest(), 'checks': checks}
    raise ValueError('Use a supported Word template operation')


def emit(stream, text):
    # 宿主清空了子进程环境 ⇒ Windows 会退回 charmap；这里显式按 UTF-8 写，调用方也按 UTF-8 读。
    stream.buffer.write((text + '\n').encode('utf-8'))


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(90 * 1024 * 1024 + 1)
        if len(raw) > 90 * 1024 * 1024: raise ValueError('Use a bounded Word operation')
        emit(sys.stdout, json.dumps(run(json.loads(raw)), ensure_ascii=False))
    except Exception as error:
        emit(sys.stderr, str(error)); sys.exit(1)
