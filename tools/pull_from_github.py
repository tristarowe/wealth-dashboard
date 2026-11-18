"""从 GitHub 仓库拉取最新文件到本机，带三方比对，绝不冲掉本地未推送的改动。

三方：本地文件 / 本机基线（tools/.sync_state.json 记录的"上次对齐时的远端 sha"）/ 远端当前 sha。

判定规则（逐文件）：
  1. 本地 == 远端                → 已一致，只刷新基线
  2. 本地 == 基线、远端 ≠ 基线    → 远端更新，安全覆盖
  3. 远端 == 基线、本地 ≠ 基线    → 本地有未推送改动，跳过并告警
  4. 双方 ≠ 基线 且 本地 ≠ 远端   → 冲突，跳过并提示人工处理
  5. 本地缺失                    → 按远端恢复（本地没有内容会被冲掉；也避免把
                                    "尚未拉取过的文件"误判成"本地删除"）
  6. 基线里没有该文件（新增）且与远端不同 → 按本地改动保留，跳过并提示

首次运行（基线文件不存在或为空）：
  以当前远端 HEAD 的逐文件 sha 初始化基线，本次不做任何覆盖，打印提示后退出。

用法：
  python tools/pull_from_github.py            # 预览（默认 dry-run）
  python tools/pull_from_github.py --apply    # 备份后真正拉取
"""
import base64
import hashlib
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import requests

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
STATE_FILE = TOOLS / ".sync_state.json"
TOKEN_FILES = [TOOLS / "github.token", ROOT / "daily" / "github.token"]
CRED_FILE = ROOT / ".git" / "git-credentials"

REPO = "tristarowe/wealth-dashboard"
BRANCH = "main"
API = f"https://api.github.com/repos/{REPO}"
HEADERS = {"Accept": "application/vnd.github+json", "User-Agent": "wealth-dashboard-pull"}


def blob_sha(data):
    """与 GitHub blob sha 同口径：对原始字节（含 CRLF）计算，禁止文本模式读取。"""
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def load_token():
    """令牌来源依次为：环境变量 GITHUB_TOKEN → tools/github.token → daily/github.token
    → .git/git-credentials（WorkBuddy 侧本机凭据，不进版本库）。"""
    token = (os.environ.get("GITHUB_TOKEN") or "").strip()
    if token:
        return token
    for f in TOKEN_FILES:
        if f.exists():
            token = f.read_text(encoding="utf-8").strip()
            if token:
                return token
    if CRED_FILE.exists():
        m = re.search(r"gh[pous]_[A-Za-z0-9]+",
                      CRED_FILE.read_text(encoding="utf-8", errors="ignore"))
        if m:
            return m.group(0)
    raise RuntimeError("未找到 github.token（也不在环境变量/凭据文件里），无法读取仓库")


def remote_tree(headers):
    resp = requests.get(f"{API}/git/trees/{BRANCH}?recursive=1", headers=headers, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError("读取仓库文件树失败：HTTP %s %s" % (resp.status_code, resp.text[:160]))
    data = resp.json()
    if data.get("truncated"):
        print("警告：文件树过大，结果可能不完整", file=sys.stderr)
    return {i["path"]: i["sha"] for i in data.get("tree", []) if i.get("type") == "blob"}


def load_state():
    """返回 (基线文件表, 是否处于"刚初始化、尚未首次对齐"状态)。"""
    if not STATE_FILE.exists():
        return {}, False
    try:
        raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}, False
    return raw.get("files", {}), bool(raw.get("init_pending"))


def save_state(files, init_pending=False):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(
        {"updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
         "init_pending": init_pending, "files": files},
        ensure_ascii=False, indent=1), encoding="utf-8")


def classify(rel, lsha, rsha, bsha, init_pending=False, lnorm=None):
    """返回 (动作, 说明)。动作：same / pull / local_dirty / conflict / new。

    lnorm：本地内容把 CRLF 归一成 LF 后的 blob sha。Windows 侧工作区是 CRLF、
    远端是 LF，同一份内容会算出不同 sha；不认这一层就会把几十个文件误判成"待拉取"，
    一 --apply 就把整个工作区改成 LF（假 diff 满地）。内容等价时直接判 same，不下载。
    """
    if lsha is None:
        # 本地缺失一律按远端恢复：没有本地内容可被冲掉，且避免首次初始化基线后
        # 把"尚未拉取过的文件"误判成"本地删除"
        return "new", "本地缺失，按远端恢复"
    if lsha == rsha:
        return "same", "已一致"
    if lnorm is not None and lnorm == rsha:
        return "same", "仅行尾差异（工作区 CRLF / 远端 LF），内容一致"
    if bsha is None:
        # 基线里没有：多为本机新加的文件（远端已有同名内容不同）。
        # 此时无法判断谁更新，按"本地改动"保留，避免静默覆盖。
        return "local_dirty", "未登记基线且与远端不同，按本地改动保留"
    if lsha == bsha:
        return "pull", "远端已更新"
    if rsha == bsha:
        # 基线刚由远端初始化时，"本地旧、远端新"与"本地有改动"无法区分，
        # 按远端恢复（有备份），首次对齐完成后不再走这个分支。
        if init_pending:
            return "pull", "基线初始化后首次对齐，按远端恢复"
        return "local_dirty", "本地有未推送改动"
    return "conflict", "双方均有改动"


def main():
    apply = "--apply" in sys.argv
    token = load_token()
    headers = dict(HEADERS, Authorization="Bearer " + token)
    remote = remote_tree(headers)
    state, init_pending = load_state()

    if not state:
        save_state(remote, True)
        print("已初始化同步基线（%d 个文件）：%s" % (len(remote), STATE_FILE))
        print("本次未做任何覆盖校验与下载；下次拉取起生效。")
        return 0

    plan, skipped = [], []
    for rel, rsha in sorted(remote.items()):
        local = ROOT / rel
        raw = local.read_bytes() if local.exists() else None
        lsha = blob_sha(raw) if raw is not None else None
        lnorm = None
        if raw is not None and lsha != rsha and b"\r\n" in raw:
            lnorm = blob_sha(raw.replace(b"\r\n", b"\n"))
        action, why = classify(rel, lsha, rsha, state.get(rel), init_pending, lnorm)
        if action == "pull" or action == "new":
            plan.append((rel, rsha, why))
        elif action in ("local_dirty", "conflict"):
            skipped.append((rel, why))

    if not plan and not skipped:
        if apply and state != remote:
            save_state(remote, False)
        print("本地与 GitHub 仓库一致，无需拉取。")
        return 0

    if plan:
        print("可安全拉取 %d 个文件：" % len(plan))
        for rel, _sha, why in plan:
            print("  [%s] %s" % (why, rel))
    if skipped:
        print("\n跳过 %d 个文件（不会覆盖本地）：" % len(skipped))
        for rel, why in skipped:
            print("  [%s] %s" % (why, rel))
        print("  处理方式：先确认本地改动，推送后再拉取；冲突文件需人工合并。")

    if not apply:
        print("\n[dry-run] 未改动任何文件。确认后运行：python tools/pull_from_github.py --apply")
        return 0
    if not plan:
        return 0

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = ROOT / ("_backup_before_pull_" + stamp)
    updated = 0
    for rel, rsha, _why in plan:
        resp = requests.get(f"{API}/git/blobs/{rsha}", headers=headers, timeout=120)
        if resp.status_code != 200:
            print("  下载失败，跳过：%s（HTTP %s）" % (rel, resp.status_code), file=sys.stderr)
            continue
        content = base64.b64decode(resp.json()["content"])
        dst = ROOT / rel
        if dst.exists():
            bak = backup / rel
            bak.parent.mkdir(parents=True, exist_ok=True)
            bak.write_bytes(dst.read_bytes())
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(content)
        state[rel] = rsha
        updated += 1
        print("  已更新：", rel)
    save_state(state, False)
    print("\n拉取完成，共更新 %d 个文件；备份目录：%s" % (updated, backup.name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
