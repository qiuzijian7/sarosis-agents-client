#!/usr/bin/env python3
"""探索阶段动作缓存：录制 + 复用前校验（零模型重放的前置闸门）。

生成阶段产出的 .spec.ts 本身就是「录制好的动作」，回归直接 run-e2e 重放即可。
本脚本做两件事：把一次探索动作连同断言写进缓存；在复用前检查缓存有没有失效。

用法：
  python replay_check.py --cache replay-cache.json --repo .
  python replay_check.py --cache replay-cache.json --repo . --record \
      --step 1 --tool mcp__playwright__browser_click \
      --args '{"element":"加入购物车"}' --assertion "toContainText('1')"
  python replay_check.py --self-test

每个录制动作**必须带断言**：没有断言的步骤不允许进入缓存，否则无法证明它达成了目标。
输出：校验时 {"reusable": bool, "reasons": [...], "command": "...", "head": "..."}；
     reusable=false 时必须重新走规划 → 生成，并重新过用例确认的人工门禁。
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile


def head_of(repo):
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True,
            stderr=subprocess.DEVNULL, timeout=10,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def file_digest(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()[:12]


def record(cache_path, repo, step, tool, action_args, assertion):
    """录制一个动作并写回指纹。同一 step 覆盖而不是追加（重跑探索时幂等）。"""
    with open(cache_path, "r", encoding="utf-8") as handle:
        cache = json.load(handle)
    if not isinstance(cache, dict):
        raise ValueError("缓存文件顶层必须是对象")
    if not tool or not assertion:
        raise ValueError("每个动作都要有 tool 与 assertion")
    if not isinstance(action_args, dict):
        raise ValueError("args 必须是 JSON 对象")

    entry = {"step": int(step), "tool": str(tool), "args": action_args, "assertion": str(assertion)}
    actions = cache.setdefault("actions", [])
    if not isinstance(actions, list):
        raise ValueError("缓存的 actions 必须是数组")
    index = next((i for i, item in enumerate(actions)
                  if isinstance(item, dict) and item.get("step") == entry["step"]), None)
    if index is None:
        actions.append(entry)
    else:
        actions[index] = entry

    head = head_of(repo)
    if head:
        cache["appFingerprint"] = head
    spec = str(cache.get("spec", ""))
    spec_path = os.path.join(repo, spec) if spec else ""
    if spec_path and os.path.isfile(spec_path):
        cache["specHash"] = file_digest(spec_path)

    with open(cache_path, "w", encoding="utf-8") as handle:
        json.dump(cache, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return {
        "recorded": entry,
        "actions": len(actions),
        "appFingerprint": cache.get("appFingerprint", ""),
        "specHash": cache.get("specHash", ""),
    }


def check(cache, repo):
    """确定性判定：只读文件与 git HEAD，不执行测试、不调模型。"""
    reasons = []
    fingerprint = str(cache.get("appFingerprint", ""))
    head = head_of(repo)
    if not fingerprint or fingerprint.startswith("填写"):
        reasons.append("appFingerprint 未填写（应写 git HEAD 或被测构建 hash）")
    elif head and fingerprint != head:
        reasons.append("appFingerprint 与当前 HEAD 不一致")

    spec = str(cache.get("spec", ""))
    if not spec:
        reasons.append("缺 spec")
    else:
        spec_path = os.path.join(repo, spec)
        if not os.path.isfile(spec_path):
            reasons.append("spec 不存在：%s" % spec)
        else:
            recorded = str(cache.get("specHash", ""))
            if not recorded:
                reasons.append("未记录 specHash（首次生成后应写回缓存）")
            elif recorded != file_digest(spec_path):
                reasons.append("spec 内容已变")

    seed = (cache.get("seed") or {}).get("storageState")
    if seed and not os.path.isfile(os.path.join(repo, str(seed))):
        reasons.append("storageState 不存在：%s" % seed)

    actions = cache.get("actions")
    if not isinstance(actions, list) or not actions:
        reasons.append("缺 actions（探索阶段没有录制任何动作）")
    else:
        for item in actions:
            if not isinstance(item, dict) or not item.get("assertion"):
                reasons.append("有动作缺断言，不允许进入缓存")
                break

    replay = cache.get("replay") or {}
    if not replay.get("command"):
        reasons.append("缺 replay.command")
    try:
        model_calls = int(replay.get("modelCalls", -1))
    except (TypeError, ValueError):
        model_calls = -1
    if model_calls != 0:
        reasons.append("replay.modelCalls 必须为 0（回归阶段不得调模型）")
    if not replay.get("invalidateWhen"):
        reasons.append("缺 replay.invalidateWhen（缓存失效条件）")

    result = {
        "reusable": not reasons,
        "reasons": reasons,
        "command": replay.get("command", ""),
        "head": head,
    }
    if result["reusable"] and spec:
        result["specHash"] = file_digest(os.path.join(repo, spec))
    return result


def self_test():
    with tempfile.TemporaryDirectory() as repo:
        spec_rel = "tests/web/demo.spec.ts"
        spec_abs = os.path.join(repo, spec_rel)
        os.makedirs(os.path.dirname(spec_abs), exist_ok=True)
        with open(spec_abs, "w", encoding="utf-8") as handle:
            handle.write("test('demo', async () => {});\n")
        seed_rel = ".qa-agent/local/storageState.json"
        seed_abs = os.path.join(repo, seed_rel)
        os.makedirs(os.path.dirname(seed_abs), exist_ok=True)
        with open(seed_abs, "w", encoding="utf-8") as handle:
            handle.write("{}\n")

        digest = file_digest(spec_abs)
        valid = {
            "appFingerprint": "fixed-build-hash",
            "spec": spec_rel,
            "specHash": digest,
            "seed": {"storageState": seed_rel},
            "actions": [{"step": 1, "tool": "mcp__playwright__browser_navigate",
                         "args": {"url": "http://localhost:5173/"},
                         "assertion": "toHaveTitle('demo')"}],
            "replay": {
                "command": "python qa_agent.py run-e2e --repo . --spec " + spec_rel,
                "modelCalls": 0,
                "invalidateWhen": ["appFingerprint 变化"],
            },
        }

        def variant(**changes):
            doc = json.loads(json.dumps(valid))
            doc.update(changes)
            return doc

        cases = [
            ("合法缓存", valid, True),
            ("spec 被删", {**valid, "spec": "tests/web/missing.spec.ts"}, False),
            ("spec 内容变化", variant(specHash="000000000000"), False),
            ("seed 缺失", variant(seed={"storageState": ".qa-agent/local/nope.json"}), False),
            ("调了模型", variant(replay={**valid["replay"], "modelCalls": 1}), False),
            ("缺重放命令", variant(replay={**valid["replay"], "command": ""}), False),
            ("指纹未填", variant(appFingerprint="填写 git HEAD"), False),
            ("没有录制动作", variant(actions=[]), False),
            ("动作缺断言", variant(actions=[{"step": 1, "tool": "x", "args": {}}]), False),
        ]
        for name, doc, want in cases:
            got = check(doc, repo)["reusable"]
            if got != want:
                raise AssertionError("%s: 期望 reusable=%s，实际 %s" % (name, want, got))

        # 录制：同一 step 幂等覆盖，且写回 specHash。
        cache_path = os.path.join(repo, "cache.json")
        with open(cache_path, "w", encoding="utf-8") as handle:
            json.dump(variant(actions=[]), handle, ensure_ascii=False)
        record(cache_path, repo, 1, "mcp__playwright__browser_navigate",
               {"url": "http://localhost:5173/"}, "toHaveTitle('demo')")
        record(cache_path, repo, 1, "mcp__playwright__browser_click",
               {"element": "按钮"}, "toContainText('ok')")
        record(cache_path, repo, 2, "mcp__playwright__browser_click", {}, "toBeVisible()")
        with open(cache_path, "r", encoding="utf-8") as handle:
            saved = json.load(handle)
        if len(saved["actions"]) != 2 or saved["actions"][0]["tool"] != "mcp__playwright__browser_click":
            raise AssertionError("录制未按 step 幂等覆盖")
        if saved.get("specHash") != digest:
            raise AssertionError("录制没有写回 specHash")
        if not check(saved, repo)["reusable"]:
            raise AssertionError("录制后的缓存应可复用")
        cases.append(("录制后缓存可复用", saved, True))
    print("replay_check self-test OK (%d cases)" % len(cases))


def main():
    parser = argparse.ArgumentParser(description="replay 缓存录制与有效性校验")
    parser.add_argument("--cache", help="缓存 JSON 文件")
    parser.add_argument("--repo", default=".", help="仓库根（默认当前目录）")
    parser.add_argument("--record", action="store_true", help="录制一个探索动作并写回缓存")
    parser.add_argument("--step", type=int, help="录制时的步骤号")
    parser.add_argument("--tool", default="", help="录制时的工具名（带 MCP 前缀）")
    parser.add_argument("--args", default="{}", help="录制时的参数 JSON 对象")
    parser.add_argument("--assertion", default="", help="录制时证明该步达成的断言")
    parser.add_argument("--self-test", action="store_true", help="跑内置用例并返回退出码")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0
    if not args.cache:
        parser.error("需要 --cache 或 --self-test")
    if args.record:
        if args.step is None or not args.tool or not args.assertion:
            parser.error("--record 需要 --step / --tool / --assertion（每个动作必须有断言）")
        try:
            action_args = json.loads(args.args)
        except json.JSONDecodeError as error:
            parser.error("--args 不是合法 JSON：%s" % error)
        try:
            result = record(args.cache, args.repo, args.step, args.tool, action_args, args.assertion)
        except (OSError, ValueError) as error:
            parser.error("录制失败：%s" % error)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    with open(args.cache, "r", encoding="utf-8") as handle:
        cache = json.load(handle)
    result = check(cache, args.repo)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["reusable"] else 1


if __name__ == "__main__":
    sys.exit(main())
