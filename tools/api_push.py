"""代理 502 时的 API 推送（WorkBuddy 侧兜底写入路径），带与 pre-push 相同的三道守卫。

用法：
  python tools/api_push.py "提交信息" <文件1> <文件2> ...
  python tools/api_push.py "提交信息" --force --reason "原因" <文件...>

守卫（清单见 tools/code_guard_marks.json，与 .githooks/pre-push、Trae 的 sync_pages.py 共用）：
  A. 标记守卫：受保护文件缺标记，或出现次数少于 min_counts → 整批拒推。
  B. 陈旧基线守卫：受保护文件在本地 HEAD 里与远端不同（本地没跟上远端）→ 整批拒推，
     因为 API 推送的 parent 是远端 HEAD，这种推送会把远端较新的内容覆盖掉。
  C. 体量守卫：受保护文件行数比远端骤减（<60%）→ 判为旧版覆盖，整批拒推。

推送方式：blob -> tree(base_tree=远端 HEAD 的树) -> commit(parent=远端 HEAD) -> PATCH ref(force=false)。
任一步失败即中止，不做部分写入。
"""
import base64
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CRED = ROOT / ".git" / "git-credentials"
MARKS = ROOT / "tools" / "code_guard_marks.json"
REPO = "tristarowe/wealth-dashboard"
BRANCH = "main"
API = f"https://api.github.com/repos/{REPO}"
SHRINK_RATIO = 0.6


def token():
    s = CRED.read_text(encoding="utf-8").strip()
    m = re.search(r"(gh[pous]_[A-Za-z0-9]+)", s)
    if not m:
        raise RuntimeError("凭据里没找到令牌：%s" % CRED)
    return m.group(1)


def blob_sha(data: bytes) -> str:
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def load_marks():
    data = json.loads(MARKS.read_text(encoding="utf-8"))
    protected = {k: v for k, v in data.get("protected", {}).items() if not k.startswith("_")}
    min_counts = {k: v for k, v in (data.get("min_counts") or {}).items() if not k.startswith("_")}
    return protected, min_counts


def head_blob(path):
    r = subprocess.run(("git", "rev-parse", "HEAD:%s" % path), cwd=ROOT,
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def line_count(text):
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def log_bypass(reason, paths, problems):
    """逃生口留痕：仅本机文件（已 gitignore），记录时间/操作人/原因/命中项。"""
    import os
    from datetime import datetime
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    who = os.environ.get("USERNAME") or os.environ.get("USER") or "unknown"
    with open(ROOT / "tools" / "guard_bypass.log", "a", encoding="utf-8") as fh:
        fh.write("%s | %s | api_push | %s | 文件 %s | 命中 %s\n"
                 % (ts, who, reason or "未填写", ",".join(paths), "；".join(problems)))


def main():
    args = sys.argv[1:]
    force = "--force-sync" in args or "--force" in args
    check_only = "--check" in args
    reason = ""
    if "--reason" in args:
        i = args.index("--reason")
        if i + 1 < len(args):
            reason = args[i + 1]
    pos = [a for i, a in enumerate(args) if a not in ("--force", "--force-sync", "--reason", "--check")
           and not (i and args[i - 1] == "--reason")]
    if len(pos) < 2:
        print(__doc__.strip().splitlines()[2])
        return 1
    message, paths = pos[0], pos[1:]

    protected, min_counts = load_marks()
    h = {"Accept": "application/vnd.github+json", "Authorization": "Bearer " + token(),
         "User-Agent": "wealth-dashboard-api-push"}

    head = requests.get(f"{API}/git/ref/heads/{BRANCH}", headers=h, timeout=30).json()["object"]["sha"]
    base = requests.get(f"{API}/git/commits/{head}", headers=h, timeout=30).json()["tree"]["sha"]
    tree = requests.get(f"{API}/git/trees/{head}?recursive=1", headers=h, timeout=60).json()
    remote = {i["path"]: i["sha"] for i in tree.get("tree", []) if i.get("type") == "blob"}
    print("远端 HEAD", head[:8])

    problems, payload = [], []
    for rel in paths:
        data = (ROOT / rel).read_bytes()
        lsha, rsha = blob_sha(data), remote.get(rel)
        payload.append((rel, data, lsha))
        if rel not in protected:
            continue
        text = data.decode("utf-8", "ignore")
        for m in protected[rel] or []:
            need = int((min_counts.get(rel) or {}).get(m, 1) or 1)
            got = text.count(m)
            if got < need:
                problems.append("%s 缺少标记「%s」（需 ≥%d 次，实际 %d 次）" % (rel, m, need, got))
        if rsha and rsha != lsha:
            hsha = head_blob(rel)
            if hsha and hsha != rsha:
                problems.append("%s 本地 HEAD 与远端不同（本地未跟上远端），API 推送会覆盖远端较新内容"
                                % rel)
            r = requests.get(f"{API}/git/blobs/{rsha}", headers=h, timeout=60)
            if r.status_code == 200:
                old = base64.b64decode(r.json()["content"]).decode("utf-8", "ignore")
                lo, ln = line_count(old), line_count(text)
                if lo > 50 and ln < lo * SHRINK_RATIO:
                    problems.append("%s 行数骤减（远端 %d → 本地 %d，<%.0f%%），疑似旧版覆盖"
                                    % (rel, lo, ln, SHRINK_RATIO * 100))

    if problems:
        if force:
            print("!! 强制跳过守卫（原因：%s）：" % (reason or "未填写"), file=sys.stderr)
            for p in problems:
                print("   - " + p, file=sys.stderr)
            log_bypass(reason, paths, problems)
        else:
            print("!! 拒绝推送（整批不写）：", file=sys.stderr)
            for p in problems:
                print("   - " + p, file=sys.stderr)
            print("确认无误可加 --force --reason \"说明\"。", file=sys.stderr)
            return 2

    entries = []
    if check_only:
        print("校验通过（未推送）。", "本次将推送 %d 个文件。" % len(payload))
        return 0
    for rel, data, lsha in payload:
        r = requests.post(f"{API}/git/blobs", headers=h, timeout=60,
                          json={"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
        if r.status_code not in (200, 201):
            print("上传失败", rel, r.status_code, r.text[:160], file=sys.stderr)
            return 1
        if r.json()["sha"] != lsha:
            print("blob sha 不一致", rel, file=sys.stderr)
            return 1
        mode = "100755" if rel.startswith(".githooks/") else "100644"
        entries.append({"path": rel, "mode": mode, "type": "blob", "sha": lsha})
        print("  ", rel, lsha[:8])

    nt = requests.post(f"{API}/git/trees", headers=h, timeout=60,
                       json={"base_tree": base, "tree": entries})
    if nt.status_code not in (200, 201):
        print("建树失败", nt.status_code, nt.text[:160], file=sys.stderr)
        return 1
    cm = requests.post(f"{API}/git/commits", headers=h, timeout=60,
                       json={"message": message, "tree": nt.json()["sha"], "parents": [head]})
    if cm.status_code not in (200, 201):
        print("建提交失败", cm.status_code, cm.text[:160], file=sys.stderr)
        return 1
    new = cm.json()["sha"]
    up = requests.patch(f"{API}/git/refs/heads/{BRANCH}", headers=h, timeout=60,
                        json={"sha": new, "force": False})
    if up.status_code not in (200, 201):
        print("更新分支失败", up.status_code, up.text[:200], file=sys.stderr)
        return 1
    print("已推送", new[:8], "->", message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
