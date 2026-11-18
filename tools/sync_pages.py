"""把看板文件同步到 GitHub Pages 仓库（Trae 端的唯一写入路径）。

三道守卫（标记清单见 tools/code_guard_marks.json，两端共用，禁止在本脚本硬编码）：
  A. 标记守卫：受保护文件缺少关键功能标记 → 整体拒推（清单有 min_counts 时按出现次数校验，
     避免「标记有多处、只被改坏一处」时被判为通过）。
  B. 整批中止守卫：受保护文件的远端内容在本机基线之后被他人改过 → 本次不写任何文件，
     必须先运行 tools/pull_from_github.py 合并。
  C. 数据时间戳守卫：数据文件允许被任一端覆盖，但 asOf / fetchedAt 不得倒退。

推送前会自动执行一次安全预拉取（复用 pull_from_github.py 的三方比对），
常规情况无需人工先跑 pull；只有两端同时改同一文件（真冲突）才会被 B 守卫拦下要求人工合并。

逃生口：--force-sync --reason "原因" 会跳过全部守卫，并在 tools/guard_bypass.log 留痕。
注意：比对一律使用二进制读取 + git blob 口径，禁止文本模式或 git hash-object（CRLF 会让结果不一致）。
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import requests

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
MARKS_FILE = TOOLS / "code_guard_marks.json"
STATE_FILE = TOOLS / ".sync_state.json"
BYPASS_LOG = TOOLS / "guard_bypass.log"
STATS = ROOT / "daily" / "stats.json"
TOKEN_FILES = [TOOLS / "github.token", ROOT / "daily" / "github.token"]

REPO = "tristarowe/wealth-dashboard"
BRANCH = "main"
API = f"https://api.github.com/repos/{REPO}"
HEADERS = {"Accept": "application/vnd.github+json", "User-Agent": "wealth-dashboard-sync"}

# 本地路径 → 仓库内路径（页面文件与数据一起保持同步）
FILES = [
    ".github/workflows/daily-fetch.yml",
    ".github/workflows/nav-rotate.yml",
    ".github/workflows/add-products.yml",
    ".github/workflows/weekly-expand.yml",
    "assets/data.js",
    "index.html",
    "assets/dashboard.js",
    "assets/library.js",
    "assets/newproducts.js",
    "assets/risk_levels.js",
    "assets/transactions.js",
    "assets/store.js",
    "assets/supabase-config.js",
    "assets/数据说明.pdf",
    "daily/library.json",
    "daily/risk_levels.json",
    "daily/newproducts.json",
    "daily/reg_alias.json",
    "daily/promote_newproducts.py",
    "daily/fetch_newproducts.py",
    "daily/fetch_data.py",
    "daily/fetch_manual.py",
    "daily/build_library.py",
    "daily/backfill_library.py",
    "daily/backfill_risk.py",
    "daily/backfill_byname.py",
    "daily/make_data_pdf.py",
    "daily/refresh_candidates.py",
    "daily/nav_bulk.py",
    "daily/nav_official.py",
    "daily/nav_rotate.py",
    "daily/nav_boc.py",
    "daily/nav_holdings_t1.py",
    "daily/add_products.py",
    "daily/ccb_map.json",
    "daily/np/skill/scripts/rules.py",
    "daily/np/skill/scripts/fetch_notice.py",
    "daily/np/skill/assets/config.json",
    "daily/chinawealth_nv.py",
    "daily/pull_cloud.py",
    "daily/shot.py",
    "daily/notify.py",
    "daily/img_host.py",
    "daily/requirements.txt",
    "tools/sync_pages.py",
    "tools/pull_from_github.py",
    "tools/code_guard_marks.json",
    "PROJECT_NOTES.md",
]


def blob_sha(data):
    """与 GitHub blob sha 同口径：原始字节（含 CRLF）计算。"""
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def load_token():
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        return token
    for f in TOKEN_FILES:
        if f.exists():
            token = f.read_text(encoding="utf-8").strip()
            if token:
                return token
    return ""


def load_marks():
    data = json.loads(MARKS_FILE.read_text(encoding="utf-8"))
    protected = {k: v for k, v in data.get("protected", {}).items() if not k.startswith("_")}
    data_files = {k: v for k, v in data.get("data", {}).items() if not k.startswith("_")}
    # min_counts 是可选顶层键：老清单没有时，每个标记按「至少出现 1 次」校验
    min_counts = {k: v for k, v in (data.get("min_counts") or {}).items() if not k.startswith("_")}
    return protected, data_files, min_counts


def load_state():
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8")).get("files", {})
    except Exception:
        return {}


def save_state(files):
    pending = False
    if STATE_FILE.exists():
        try:
            pending = bool(json.loads(STATE_FILE.read_text(encoding="utf-8")).get("init_pending"))
        except Exception:
            pending = False
    STATE_FILE.write_text(json.dumps(
        {"updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
         "init_pending": pending, "files": files},
        ensure_ascii=False, indent=1), encoding="utf-8")


def as_of():
    if STATS.exists():
        return json.loads(STATS.read_text(encoding="utf-8")).get("asOf", "")
    return ""


def match_time(text, key):
    m = re.search(r'["\']?%s["\']?\s*[:=]\s*["\']([^"\']+)' % re.escape(key), text)
    return m.group(1) if m else ""


def remote_tree(headers):
    resp = requests.get(f"{API}/git/trees/{BRANCH}?recursive=1", headers=headers, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError("读取仓库文件树失败：HTTP %s %s" % (resp.status_code, resp.text[:160]))
    return {i["path"]: i["sha"] for i in resp.json().get("tree", []) if i.get("type") == "blob"}


def remote_content(rel, headers):
    resp = requests.get(f"{API}/contents/{quote(rel)}", headers=headers,
                        params={"ref": BRANCH}, timeout=60)
    if resp.status_code != 200:
        return None
    return base64.b64decode(resp.json()["content"])


def guard_marks(protected, min_counts=None):
    """A. 标记守卫。返回 (是否通过, 问题列表)。

    清单给了 min_counts 里的期望次数时按「出现次数」校验（只判存在会漏掉
    「同一标记有多处、只被改坏一处」的旧版覆盖），没给则按存在 1 次。
    """
    problems = []
    min_counts = min_counts or {}
    for rel, markers in protected.items():
        local = ROOT / rel
        if not markers or not local.exists():
            continue
        text = local.read_bytes().decode("utf-8", "ignore")
        need_map = min_counts.get(rel) or {}
        missing = []
        for m in markers:
            need = int(need_map.get(m, 1) or 1)
            actual = text.count(m)
            if actual >= need:
                continue
            if need > 1:
                missing.append("「%s」需 ≥%d 次，实际 %d 次" % (m, need, actual))
            else:
                missing.append("「%s」" % m)
        if missing:
            problems.append("%s 缺少标记：%s" % (rel, "、".join(missing)))
    return (not problems), problems


def guard_protected(stale, headers, state, initialized):
    """B. 整批中止守卫。stale = {rel: (local_sha, remote_sha)}。"""
    touched = []
    for rel, (lsha, rsha) in stale.items():
        bsha = state.get(rel)
        if rsha is None:
            continue  # 远端还没有该文件，属新增
        if bsha is None:
            if initialized:
                print("  基线未登记，跳过覆盖校验：", rel)
            continue
        if rsha != bsha and rsha != lsha:
            # 远端在本机基线之后被改过，且与本地内容不同 → 推送会覆盖他人改动
            touched.append(rel)
    return touched


def log_bypass(reason, files, state, stale):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    who = os.environ.get("USERNAME") or os.environ.get("USER") or "unknown"
    lines = []
    for rel in files:
        lines.append("%s | %s | %s | %s | 基线 %s | 远端 %s" % (
            ts, who, reason, rel, state.get(rel) or "-",
            (stale.get(rel) or (None, None))[1] or "-"))
    with open(BYPASS_LOG, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def commit_batch(changes, headers, message):
    """整批提交。返回 True=成功，False=失败，"stale"=远端在本流程期间前进（需重取基线）。"""
    ref = requests.get(f"{API}/git/ref/heads/{BRANCH}", headers=headers, timeout=30)
    if ref.status_code != 200:
        print("读取分支失败", ref.status_code, ref.text[:160], file=sys.stderr)
        return False
    head = ref.json()["object"]["sha"]
    base = requests.get(f"{API}/git/commits/{head}", headers=headers, timeout=30).json()["tree"]["sha"]

    tree = []
    for rel, content in changes:
        blob = requests.post(f"{API}/git/blobs", headers=headers, timeout=60,
                             json={"content": base64.b64encode(content).decode("ascii"),
                                   "encoding": "base64"})
        if blob.status_code not in (200, 201):
            print("上传内容失败", rel, blob.status_code, blob.text[:160], file=sys.stderr)
            return False
        tree.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob.json()["sha"]})

    new_tree = requests.post(f"{API}/git/trees", headers=headers, timeout=60,
                             json={"base_tree": base, "tree": tree})
    if new_tree.status_code not in (200, 201):
        print("建立目录树失败", new_tree.status_code, new_tree.text[:160], file=sys.stderr)
        return False

    commit = requests.post(f"{API}/git/commits", headers=headers, timeout=60,
                           json={"message": message, "tree": new_tree.json()["sha"],
                                 "parents": [head]})
    if commit.status_code not in (200, 201):
        print("创建提交失败", commit.status_code, commit.text[:160], file=sys.stderr)
        return False

    update = requests.patch(f"{API}/git/refs/heads/{BRANCH}", headers=headers, timeout=60,
                            json={"sha": commit.json()["sha"], "force": False})
    if update.status_code == 422:
        # 取 head 与 base tree 之间远端前进了：拿同一份旧 base 重试必然失败，必须重取基线
        print("更新分支被拒（远端已前进），需重新读取基线", file=sys.stderr)
        return "stale"
    if update.status_code not in (200, 201):
        print("更新分支失败", update.status_code, update.text[:160], file=sys.stderr)
        return False
    print("已批量提交 %d 个文件：%s" % (len(changes), message))
    for rel, _c in changes:
        print("  已同步：", rel)
    return True


def commit_one(rel, content, sha, headers, message):
    body = {"message": message, "content": base64.b64encode(content).decode("ascii"),
            "branch": BRANCH}
    if sha:
        body["sha"] = sha
    try:
        put = requests.put(f"{API}/contents/{quote(rel)}", headers=headers, json=body, timeout=120)
    except Exception as exc:
        print("同步异常：" + rel, str(exc)[:120], file=sys.stderr)
        return False
    ok = put.status_code in (200, 201)
    print(("已同步：" if ok else "同步失败：") + rel, put.status_code)
    return ok


def collect_changes(tree, headers, state, data_files, force):
    """按远端树逐文件比对，返回 (待推列表, {rel: (本地 sha, 远端 sha)})。"""

    changes, stale = [], {}
    for rel in FILES:
        local = ROOT / rel
        if not local.exists():
            print("本地缺少文件，跳过：", rel)
            continue
        content = local.read_bytes()
        lsha = blob_sha(content)
        rsha = tree.get(rel)
        # Windows 工作区是 CRLF、远端是 LF：仅行尾不同按「已一致」处理，
        # 否则 B 守卫会把纯行尾差异误判成「远端被他人改过」而整批中止
        if rsha is not None and lsha != rsha and b"\r\n" in content:
            if blob_sha(content.replace(b"\r\n", b"\n")) == rsha:
                lsha = rsha
        stale[rel] = (lsha, rsha)
        if rsha == lsha:
            # 本地已与远端一致（如手动覆盖后）：顺手把基线刷新到远端 sha，
            # 否则基线停在覆盖前，下次 B 守卫会把「自己已对齐的文件」误报成远端变更
            if state.get(rel) != rsha:
                state[rel] = rsha
            print("已是最新：", rel)
            continue

        # C. 数据时间戳守卫（逐文件跳过，不整批中止）
        if rel in data_files and rsha:
            remote_bytes = remote_content(rel, headers)
            if remote_bytes is not None:
                rt = remote_bytes.decode("utf-8", "ignore")
                lt = content.decode("utf-8", "ignore")
                backwards = []
                for key in data_files[rel]:
                    rv, lv = match_time(rt, key), match_time(lt, key)
                    if rv and lv and rv > lv:
                        backwards.append("%s %s > %s" % (key, rv, lv))
                if backwards and not force:
                    print("线上数据更新（%s），跳过覆盖：%s" % ("，".join(backwards), rel))
                    state[rel] = rsha
                    continue
        changes.append((rel, content))
    return changes, stale


def push_changes(changes, headers, message):
    """批量提交并重试。返回 True / False / "stale"（远端前进，需重取基线）。"""
    result = False
    for attempt in range(1, 4):
        try:
            result = commit_batch(changes, headers, message)
        except Exception as exc:
            print("批量提交异常（第 %d 次）：%s" % (attempt, str(exc)[:120]), file=sys.stderr)
            result = False
        if result is True or result == "stale":
            return result
        time.sleep(3 * attempt)
    return result


def commit_message(changes):
    """工具/脚本类改动用独立信息，避免与每日数据更新混在一句里，便于事故回溯。"""
    rels = [rel for rel, _c in changes]
    tool_like = ("tools/", ".githooks/")
    if rels and all(r.startswith(tool_like) for r in rels):
        return "chore(tools): 更新推送守卫脚本 %s" % as_of()
    if rels and all(r == "PROJECT_NOTES.md" or r.startswith(tool_like) for r in rels):
        return "docs: 更新守卫清单与交接说明 %s" % as_of()
    return "chore: 更新看板 %s" % as_of()


def pre_pull():
    """推送前自动做一次安全预拉取，免去人工先跑 pull 的指令。

    复用 tools/pull_from_github.py --apply 的三方比对：远端更新过的文件先拉齐、
    本地缺失的按远端恢复；本地未推送的改动会被它跳过（local_dirty / conflict），不会被覆盖。
    预拉取失败不阻断推送——后续 B 守卫会兜底拦截真正的冲突。
    """
    script = TOOLS / "pull_from_github.py"
    try:
        r = subprocess.run([sys.executable, str(script), "--apply"],
                            capture_output=True, text=True, timeout=300)
    except Exception as exc:
        print("预拉取失败（忽略，B 守卫仍会兜底）：%s" % str(exc)[:120], file=sys.stderr)
        return
    lines = (r.stdout or "").strip().splitlines()
    if r.returncode != 0:
        print("预拉取异常（忽略，B 守卫仍会兜底）：", file=sys.stderr)
        for line in lines[-5:]:
            print("  " + line, file=sys.stderr)
        return
    for line in lines:
        print("  预拉取 | " + line)


def main():
    args = sys.argv[1:]
    force = "--force-sync" in args
    reason = ""
    if force and "--reason" in args:
        i = args.index("--reason")
        if i + 1 < len(args):
            reason = args[i + 1]
    if force and not reason:
        reason = "未填写原因"

    token = load_token()
    if not token:
        print("未配置 GitHub 令牌，跳过线上看板同步")
        return 0
    headers = dict(HEADERS, Authorization="Bearer " + token)

    protected, data_files, min_counts = load_marks()

    # 推送前安全预拉取：远端被另一端更新过的文件先自动对齐，常规情况无需人工先跑 pull。
    # --force-sync 时跳过：强制推送是明确要按本地版本覆盖，不做预拉取。
    if not force:
        pre_pull()

    state = load_state()
    initialized = False
    if not state:
        # 预拉取未初始化基线（如网络失败）时在此兜底
        state = dict(remote_tree(headers))
        save_state(state)
        initialized = True
        print("已初始化同步基线（%d 个文件），本次不做覆盖校验。" % len(state))

    # A. 标记守卫
    ok, problems = guard_marks(protected, min_counts)
    if not ok:
        if force:
            print("!! 强制跳过标记守卫：\n  " + "\n  ".join(problems), file=sys.stderr)
        else:
            print("拒推：本地代码缺少关键功能标记（疑似旧版/回退）：", file=sys.stderr)
            for p in problems:
                print("  - " + p, file=sys.stderr)
            print("请从 tools/code_guard_marks.json 核对，或确认无误后使用 --force-sync。", file=sys.stderr)
            return 2

    changes, tree, message = [], {}, ""
    round_no = 0
    while True:
        tree = remote_tree(headers)
        changes, stale = collect_changes(tree, headers, state, data_files, force)

        # B. 整批中止守卫
        touched = guard_protected({k: v for k, v in stale.items() if k in protected},
                                  headers, state, initialized)
        if touched and not force:
            print("拒推：以下受保护文件的远端已被他人修改，必须先合并：", file=sys.stderr)
            for rel in touched:
                print("  - " + rel, file=sys.stderr)
            print("请先运行：python tools/pull_from_github.py --apply", file=sys.stderr)
            print("本次未写入任何文件（整批中止）。", file=sys.stderr)
            return 3
        if touched and force:
            print("!! 强制跳过整批中止守卫：", "、".join(touched), file=sys.stderr)

        if force and changes:
            log_bypass(reason, [r for r, _ in changes], state, stale)

        if not changes:
            save_state(state)
            print("线上已是最新，无需提交")
            return 0

        message = commit_message(changes)
        result = push_changes(changes, headers, message)
        if result is True:
            for rel, content in changes:
                state[rel] = blob_sha(content)
            save_state(state)
            return 0
        if result == "stale" and round_no < 2:
            round_no += 1
            print("远端在本轮期间前进，重新读取基线并重跑守卫（第 %d 次）" % round_no)
            continue
        break

    # 逐文件回退：受保护文件绝不降级，避免留下「部分已更新」的混合状态
    protected_in_changes = [rel for rel, _ in changes if rel in protected]
    if protected_in_changes:
        print("拒推：批量提交失败，且本次待推含受保护文件，禁止逐文件降级：", file=sys.stderr)
        for rel in protected_in_changes:
            print("  - " + rel, file=sys.stderr)
        print("本次未写入任何文件。请重跑 python tools/sync_pages.py；"
              "若仍失败，先运行 python tools/pull_from_github.py --apply 合并。", file=sys.stderr)
        return 4

    print("批量提交失败，退回逐文件提交（仅非受保护文件）", file=sys.stderr)
    failed = []
    for rel, content in changes:
        sha = tree.get(rel)
        okfile = False
        for _ in range(3):
            if commit_one(rel, content, sha, headers, message):
                okfile = True
                state[rel] = blob_sha(content)
                break
            time.sleep(2)
        if not okfile:
            failed.append(rel)
    save_state(state)
    if failed:
        print("同步失败的文件：", "、".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
