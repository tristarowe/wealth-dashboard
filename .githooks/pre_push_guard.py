"""WorkBuddy 侧 pre-push 守卫（由 .githooks/pre-push 调用）。

与 Trae 端 tools/sync_pages.py 共用同一份清单 tools/code_guard_marks.json，禁止在本文件硬编码标记。

三道检查（命中任一 → 整批拒绝，退出码非 0，绝不部分推送）：
  A. 删除守卫：受保护文件在本次推送中被删除 → 拒推。
  B. 标记守卫：受保护文件提交后的内容缺少关键标记，或出现次数少于 min_counts → 拒推。
     （2026-11-18 教训：只替换 1 处 daystack → 标记仍在，子串守卫放行，线上样式被改坏。
      所以必须校验出现次数，而不是"是否存在"。）
  C. 体量守卫：受保护文件行数比远端骤减（默认 <60%） → 判为旧版整体覆盖，拒推。
     这条能拦住"标记恰好都还在、但整份文件是旧版"的覆盖。

说明：git 协议本身会拒绝非快进推送（远端有新提交时 push 直接失败），
所以本钩子专注"内容层面"的退化检测，不重复做非快进判断。
"""
import json
import os
import subprocess
import sys

MARKS = os.path.join("tools", "code_guard_marks.json")
SHRINK_RATIO = 0.6


def git(*args, **kw):
    return subprocess.run(("git",) + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kw)


def blobs_of(rev, path):
    """返回 rev 提交里 path 的原始文本；文件不存在返回 None。"""
    r = subprocess.run(("git", "show", "%s:%s" % (rev, path)), capture_output=True)
    if r.returncode != 0:
        return None
    return r.stdout.decode("utf-8", "ignore")


def line_count(text):
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def load_marks(root):
    p = os.path.join(root, MARKS)
    if not os.path.exists(p):
        return {}, {}, {}
    data = json.load(open(p, encoding="utf-8"))
    protected = {k: v for k, v in data.get("protected", {}).items() if not k.startswith("_")}
    min_counts = {k: v for k, v in data.get("min_counts", {}).items() if not k.startswith("_")}
    return protected, min_counts, data


def main():
    root = git("rev-parse", "--show-toplevel").stdout.strip()
    if not root:
        return 0
    protected, min_counts, _data = load_marks(root)
    if not protected:
        print("[guard] 未找到 %s，跳过守卫" % MARKS)
        return 0

    problems = []
    for line in sys.stdin.read().splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        _local_ref, local_sha, _remote_ref, remote_sha = parts[:4]
        if set(local_sha) == {"0"}:
            continue  # 删除分支，与本守卫无关

        base = remote_sha if set(remote_sha) != {"0"} else None
        if base:
            diff = git("diff", "--name-status", "%s..%s" % (base, local_sha))
            rows = [r.split("\t") for r in diff.stdout.splitlines() if r.strip()]
        else:
            # 新分支：不判断变更集，只做删除/标记基线检查
            rows = []

        for row in rows:
            status, path = row[0], row[-1]
            if path not in protected:
                continue
            if status.startswith("D"):
                problems.append("%s 在本次推送中被删除（受保护文件）" % path)
                continue
            text = blobs_of(local_sha, path)
            if text is None:
                problems.append("%s 读取失败，无法校验" % path)
                continue
            markers = protected[path] or []
            counts = min_counts.get(path, {}) or {}
            for m in markers:
                need = int(counts.get(m, 1))
                got = text.count(m)
                if got < need:
                    problems.append("%s 缺少标记「%s」（需要 ≥%d 次，实际 %d 次）"
                                    % (path, m, need, got))
            if base:
                old = blobs_of(base, path)
                if old is not None:
                    lo, ln = line_count(old), line_count(text)
                    if lo > 50 and ln < lo * SHRINK_RATIO:
                        problems.append("%s 行数骤减（远端 %d 行 → 本地 %d 行，<%.0f%%），疑似旧版覆盖"
                                        % (path, lo, ln, SHRINK_RATIO * 100))

    if problems:
        print("", file=sys.stderr)
        print("!! 推送被拒绝：受保护文件出现回退/缺失，本次整批不推送 !!", file=sys.stderr)
        for p in problems:
            print("   - " + p, file=sys.stderr)
        print("", file=sys.stderr)
        print("处理：先 git fetch 对齐远端，确认本地内容正确；标记清单见 %s。" % MARKS, file=sys.stderr)
        print("确属有意变更（例如整块重写）时，用 git push --no-verify 并说明原因。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
