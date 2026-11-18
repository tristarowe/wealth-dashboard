"""代理 502 时的 API 推送（WorkBuddy 侧兜底写入路径），带与 pre-push 相同的三道守卫。

用法：
  python tools/api_push.py "提交信息" <文件1> <文件2> ...
  python tools/api_push.py "提交信息" --check <文件...>          # 只跑守卫，不推送
  python tools/api_push.py "提交信息" --force --reason "原因" <文件...>   # 逃生口，跳过守卫并留痕

推送前自动执行一次安全预拉取（复用 tools/pull_from_github.py --apply 的三方比对）：
远端更新过的文件先拉齐、本地缺失的按远端恢复；本地未推送的改动会被它跳过，不会被覆盖。
预拉取失败不阻断推送，由 B 守卫兜底。--check / --force 不触发预拉取。

守卫（清单见 tools/code_guard_marks.json，与 .githooks/pre-push、Trae 的 sync_pages.py 共用）：
  A. 标记守卫：受保护文件缺标记，或出现次数少于 min_counts → 整批拒推。
  B. 陈旧基线守卫：受保护文件"本机上次同步的远端 sha"与当前远端不同 → 整批拒推，要求先 pull。
     没有基线时退回用本地 HEAD 比，防止拿旧副本覆盖远端。API 推送的 parent 是远端 HEAD，
     这类推送会把远端较新的内容盖掉，所以必须在推之前拦。
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
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CRED = ROOT / ".git" / "git-credentials"
MARKS = ROOT / "tools" / "code_guard_marks.json"
REPO = "tristarowe/wealth-dashboard"
BRANCH = "main"
API = f"https://api.github.com/repos/{REPO}"
SHRINK_RATIO = 0.6


def req(method, url, timeout=60, **kw):
    """代理不稳定时自动重试（502/连接被掐）。只读与幂等上传都可安全重试。"""
    last = None
    for attempt in range(3):
        try:
            return requests.request(method, url, timeout=timeout, **kw)
        except Exception as exc:
            last = exc
            time.sleep(2 * (attempt + 1))
    raise last


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


def pre_pull():
    """推送前自动做一次安全预拉取，免去人工先跑 pull。

    复用 tools/pull_from_github.py --apply 的三方比对：远端更新过的文件先拉齐、本地缺失的
    按远端恢复；本地未推送的改动会被它跳过（local_dirty / conflict），不会被覆盖。
    预拉取失败不阻断推送——后面的 B 守卫会兜底拦下真正的冲突。
    """
    script = ROOT / "tools" / "pull_from_github.py"
    if not script.exists():
        return
    try:
        r = subprocess.run((sys.executable, str(script), "--apply"), cwd=ROOT,
                           capture_output=True, text=True, timeout=300,
                           encoding="utf-8", errors="replace")
    except Exception as exc:
        print("预拉取失败（忽略，B 守卫仍会兜底）：%s" % str(exc)[:120], file=sys.stderr)
        return
    out = (r.stdout or "").strip()
    if out:
        print("[pre_pull] " + out.replace("\n", "\n[pre_pull] "))
    if r.returncode != 0:
        print("预拉取返回 %d（忽略）：%s" % (r.returncode, (r.stderr or "").strip()[:200]),
              file=sys.stderr)


def load_state():
    """本机同步基线（pull_from_github.py 维护），记录每个文件上次对齐时的远端 blob sha。"""
    p = ROOT / "tools" / ".sync_state.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("files", {})
    except Exception:
        return {}


def save_state(files):
    """推送成功后把基线刷新为刚推上去的 sha，避免下次预拉取把自己的推送误报成冲突。"""
    p = ROOT / "tools" / ".sync_state.json"
    try:
        raw = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except Exception:
        raw = {}
    raw.setdefault("files", {}).update(files)
    raw["updated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    raw.setdefault("init_pending", False)
    p.write_text(json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")


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

    if not (check_only or force):
        pre_pull()

    protected, min_counts = load_marks()
    state = load_state()
    h = {"Accept": "application/vnd.github+json", "Authorization": "Bearer " + token(),
         "User-Agent": "wealth-dashboard-api-push"}

    head = req('GET', f"{API}/git/ref/heads/{BRANCH}", timeout=30, headers=h).json()["object"]["sha"]
    base = req('GET', f"{API}/git/commits/{head}", timeout=30, headers=h).json()["tree"]["sha"]
    tree = req('GET', f"{API}/git/trees/{head}?recursive=1", timeout=60, headers=h).json()
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
            bsha = state.get(rel)
            if bsha is None:
                hsha = head_blob(rel)
                if hsha and hsha != rsha:
                    problems.append("%s 未登记同步基线且本地 HEAD 与远端不同，无法确认不是陈旧副本"
                                    % rel)
            elif bsha != rsha:
                problems.append("%s 远端在本机上次同步后已变更（基线 %s ≠ 远端 %s），请先 pull 再合并"
                                % (rel, bsha[:8], rsha[:8]))
            r = req('GET', f"{API}/git/blobs/{rsha}", timeout=60, headers=h)
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
        r = req('POST', f"{API}/git/blobs", timeout=60, headers=h, json={"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
        if r.status_code not in (200, 201):
            print("上传失败", rel, r.status_code, r.text[:160], file=sys.stderr)
            return 1
        if r.json()["sha"] != lsha:
            print("blob sha 不一致", rel, file=sys.stderr)
            return 1
        mode = "100755" if rel.startswith(".githooks/") else "100644"
        entries.append({"path": rel, "mode": mode, "type": "blob", "sha": lsha})
        print("  ", rel, lsha[:8])

    nt = req('POST', f"{API}/git/trees", timeout=60, headers=h, json={"base_tree": base, "tree": entries})
    if nt.status_code not in (200, 201):
        print("建树失败", nt.status_code, nt.text[:160], file=sys.stderr)
        return 1
    cm = req('POST', f"{API}/git/commits", timeout=60, headers=h, json={"message": message, "tree": nt.json()["sha"], "parents": [head]})
    if cm.status_code not in (200, 201):
        print("建提交失败", cm.status_code, cm.text[:160], file=sys.stderr)
        return 1
    new = cm.json()["sha"]
    up = req('PATCH', f"{API}/git/refs/heads/{BRANCH}", timeout=60, headers=h, json={"sha": new, "force": False})
    if up.status_code not in (200, 201):
        print("更新分支失败", up.status_code, up.text[:200], file=sys.stderr)
        return 1
    save_state({rel: sha for rel, _d, sha in payload})
    print("已推送", new[:8], "->", message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
