#!/usr/bin/env python3
"""视觉四档判据的 ①/② 档：把观察数据变成确定性结论。

① 几何/DOM：browser_evaluate 取回的元素 rect / visible / overflow / viewport。
② 像素基线：接收外部 PNG diff 的结果（仓库 visual.spec.mjs 的 comparePng 产出），
   只判数值与证据路径，不重造 PNG 解码器。

**只有 verdict=pass 才能作为放行依据**；模型看图的结论另行标注为「观察」，不参与放行。
verdict=undetermined 表示证据不足，必须写「未取证」，不许当作通过。

用法：
  python visual_check.py --input geometry.json --case-id CASE-001
  python visual_check.py --self-test

输入 JSON：
{
  "viewport": {"width": 1280, "height": 800, "dpr": 1},
  "elements": [
    {"id": "toolbar", "group": "row-1",
     "rect": {"x": 0, "y": 0, "width": 280, "height": 40},
     "visible": true,
     "overflow": {"scrollWidth": 280, "clientWidth": 280}}
  ],
  "pixelDiff": [
    {"id": "toolbar", "baselinePath": "visual/baseline/toolbar.png",
     "actualPath": "visual/actual/toolbar.png",
     "ratio": 0.003, "tolerance": 0.005,
     "sizeMismatch": false, "decodeFailed": false}
  ]
}

`group` 相同才会做两两重叠比较 —— 父子元素天然重叠，不做分组会大量误报。
输出：{"caseId", "verdict": pass|fail|undetermined, "findings", "assertions"}
"""
import argparse
import json
import os
import sys
import tempfile

TOL = 1.0
MAX_ELEMENTS = 200
DEFAULT_PIXEL_TOLERANCE = 0.005
UNDETERMINED_CODES = frozenset({
    "NO_ELEMENTS", "TOO_MANY_ELEMENTS", "BASELINE_MISSING", "ACTUAL_MISSING",
    "NO_DIFF_DATA", "DECODE_DEGRADED",
})


def _num(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _area(rect):
    return max(0.0, _num(rect.get("width"))) * max(0.0, _num(rect.get("height")))


def _overlap(a, b):
    ax, ay = _num(a.get("x")), _num(a.get("y"))
    bx, by = _num(b.get("x")), _num(b.get("y"))
    w = min(ax + _num(a.get("width")), bx + _num(b.get("width"))) - max(ax, bx)
    h = min(ay + _num(a.get("height")), by + _num(b.get("height"))) - max(ay, by)
    return max(0.0, w) * max(0.0, h)


def check(doc):
    """确定性判定：不连浏览器、不调模型；只检查数值与证据路径是否真实存在。"""
    findings = []
    doc = doc if isinstance(doc, dict) else {}
    elements = doc.get("elements")
    if not isinstance(elements, list):
        elements = []
    pixel_items = doc.get("pixelDiff") or []
    if not isinstance(pixel_items, list):
        pixel_items = []

    if not elements and not pixel_items:
        return {
            "verdict": "undetermined",
            "findings": [{"code": "NO_ELEMENTS", "detail": "没有几何或像素数据，不能判定；请标为「未取证」"}],
            "assertions": [],
        }
    if len(elements) > MAX_ELEMENTS:
        return {
            "verdict": "undetermined",
            "findings": [{"code": "TOO_MANY_ELEMENTS", "detail": "元素超过 %d 个，请缩小到当前步骤相关的区域" % MAX_ELEMENTS}],
            "assertions": [],
        }

    # ① 几何/DOM
    viewport = doc.get("viewport") or {}
    vw, vh = _num(viewport.get("width")), _num(viewport.get("height"))
    for element in elements:
        if not isinstance(element, dict):
            continue
        eid = str(element.get("id", "?"))
        rect = element.get("rect") or {}
        visible = element.get("visible", True) is not False
        width, height = _num(rect.get("width")), _num(rect.get("height"))

        if visible and (width <= TOL or height <= TOL):
            findings.append({"code": "ZERO_SIZE", "id": eid, "detail": "可见元素宽或高为 0"})
        if visible and _area(rect) <= 0.0:
            findings.append({"code": "NO_AREA", "id": eid, "detail": "可见元素没有可点击面积"})

        overflow = element.get("overflow") or {}
        if overflow and _num(overflow.get("scrollWidth")) > _num(overflow.get("clientWidth")) + TOL:
            findings.append({"code": "TEXT_OVERFLOW", "id": eid, "detail": "内容宽度超出容器，文字可能被裁切"})

        if vw > 0 and vh > 0 and visible:
            x, y = _num(rect.get("x")), _num(rect.get("y"))
            if x + width > vw + TOL or y + height > vh + TOL or x < -TOL or y < -TOL:
                findings.append({"code": "OUT_OF_VIEWPORT", "id": eid, "detail": "可见元素超出视口范围"})

    # 同组两两重叠：只比较都可见、面积为正、且显式声明了同一 group 的元素。
    for i, left in enumerate(elements):
        if not isinstance(left, dict):
            continue
        group = left.get("group")
        if not group or left.get("visible", True) is False or _area(left.get("rect") or {}) <= 0:
            continue
        for right in elements[i + 1:]:
            if not isinstance(right, dict) or right.get("group") != group:
                continue
            if right.get("visible", True) is False or _area(right.get("rect") or {}) <= 0:
                continue
            shared = _overlap(left.get("rect") or {}, right.get("rect") or {})
            smaller = min(_area(left.get("rect") or {}), _area(right.get("rect") or {}))
            if smaller > 0 and shared / smaller > 0.05:
                findings.append({
                    "code": "OVERLAP",
                    "id": "%s|%s" % (left.get("id", "?"), right.get("id", "?")),
                    "detail": "同组元素重叠 %.1f%%" % (shared / smaller * 100),
                })

    # ② 像素基线 diff：数值由外部 comparePng 给出；这里判容差与证据真实性。
    for shot in pixel_items:
        if not isinstance(shot, dict):
            continue
        label = str(shot.get("id", "?"))
        for key, code in (("baselinePath", "BASELINE_MISSING"), ("actualPath", "ACTUAL_MISSING")):
            path = str(shot.get(key, ""))
            if not path or not os.path.isfile(path):
                findings.append({"code": code, "id": label,
                                 "detail": "%s 不存在：%s —— 不要编造证据路径" % (key, path or "(空)")})
        if shot.get("decodeFailed"):
            findings.append({"code": "DECODE_DEGRADED", "id": label,
                             "detail": "PNG 解码降级，像素差不可信，标为未取证"})
        elif shot.get("sizeMismatch"):
            findings.append({"code": "SIZE_MISMATCH", "id": label,
                             "detail": "基线与实际截图尺寸不同"})
        else:
            ratio = shot.get("ratio")
            tolerance = _num(shot.get("tolerance"), DEFAULT_PIXEL_TOLERANCE)
            if ratio is None:
                findings.append({"code": "NO_DIFF_DATA", "id": label, "detail": "缺 ratio，无法判定像素差"})
            elif _num(ratio, -1) > tolerance:
                findings.append({"code": "PIXEL_DIFF", "id": label,
                                 "detail": "像素差 %.2f%% > 容差 %.2f%%" % (_num(ratio) * 100, tolerance * 100)})

    codes = {item["code"] for item in findings}
    if codes & UNDETERMINED_CODES:
        verdict = "undetermined"
    elif findings:
        verdict = "fail"
    else:
        verdict = "pass"

    assertions = []
    if not findings:
        parts = []
        if elements:
            parts.append("%d 个元素通过尺寸/面积/溢出/视口/同组重叠" % len(elements))
        if pixel_items:
            parts.append("%d 张截图通过像素基线容差且证据路径真实存在" % len(pixel_items))
        assertions.append("；".join(parts))
    return {"verdict": verdict, "findings": findings, "assertions": assertions}


def self_test():
    def el(eid, x, y, w, h, **extra):
        data = {"id": eid, "rect": {"x": x, "y": y, "width": w, "height": h}, "visible": True}
        data.update(extra)
        return data

    viewport = {"width": 1280, "height": 800, "dpr": 1}
    cases = [
        ("正常布局", {"viewport": viewport, "elements": [el("a", 0, 0, 100, 40), el("b", 110, 0, 100, 40)]}, "pass"),
        ("零高度", {"viewport": viewport, "elements": [el("a", 0, 0, 100, 0)]}, "fail"),
        ("文字溢出", {"viewport": viewport, "elements": [el("a", 0, 0, 100, 40, overflow={"scrollWidth": 160, "clientWidth": 100})]}, "fail"),
        ("超出视口", {"viewport": viewport, "elements": [el("a", 1200, 0, 200, 40)]}, "fail"),
        ("同组重叠", {"viewport": viewport, "elements": [
            el("a", 0, 0, 100, 40, group="row"), el("b", 50, 0, 100, 40, group="row"),
        ]}, "fail"),
        ("父子天然重叠不误报", {"viewport": viewport, "elements": [
            el("parent", 0, 0, 300, 200), el("child", 10, 10, 100, 40),
        ]}, "pass"),
        ("缺证据数据", {"viewport": viewport}, "undetermined"),
        ("元素过多", {"viewport": viewport, "elements": [el(str(i), 0, 0, 10, 10) for i in range(MAX_ELEMENTS + 1)]}, "undetermined"),
    ]

    with tempfile.TemporaryDirectory() as tmp:
        base = os.path.join(tmp, "base.png")
        actual = os.path.join(tmp, "actual.png")
        for path in (base, actual):
            with open(path, "wb") as handle:
                handle.write(b"\x89PNG\r\n\x1a\n")

        def shot(**changes):
            data = {"id": "toolbar", "baselinePath": base, "actualPath": actual,
                    "ratio": 0.003, "tolerance": 0.005}
            data.update(changes)
            return data

        geometry = {"viewport": viewport, "elements": [el("a", 0, 0, 100, 40)]}
        cases += [
            ("像素差在容差内", {**geometry, "pixelDiff": [shot()]}, "pass"),
            ("像素差超容差", {**geometry, "pixelDiff": [shot(ratio=0.02)]}, "fail"),
            ("基线路径不存在", {**geometry, "pixelDiff": [shot(baselinePath="/nope/base.png")]}, "undetermined"),
            ("尺寸不一致", {**geometry, "pixelDiff": [shot(sizeMismatch=True)]}, "fail"),
            ("PNG 解码降级", {**geometry, "pixelDiff": [shot(decodeFailed=True)]}, "undetermined"),
            ("只做像素判定", {"pixelDiff": [shot()]}, "pass"),
        ]

        # 断言必须留在临时目录还活着的块内：路径证据会被 os.path.isfile 真检查，
        # 目录一删就会被判成「证据缺失」（这里踩过一次）。
        for name, doc, want in cases:
            got = check(doc)["verdict"]
            if got != want:
                raise AssertionError("%s: 期望 %s，实际 %s" % (name, want, got))
        print("visual_check self-test OK (%d cases)" % len(cases))


def main():
    parser = argparse.ArgumentParser(description="几何/DOM + 像素基线视觉判据（确定性）")
    parser.add_argument("--input", help="观察数据 JSON 文件（elements / pixelDiff）")
    parser.add_argument("--case-id", default="", help="关联的用例 ID，写进输出")
    parser.add_argument("--self-test", action="store_true", help="跑内置用例并返回退出码")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0
    if not args.input:
        parser.error("需要 --input 或 --self-test")
    with open(args.input, "r", encoding="utf-8") as handle:
        doc = json.load(handle)
    result = check(doc)
    result["caseId"] = args.case_id
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
