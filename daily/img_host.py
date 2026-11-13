"""上传看板长图并返回可在微信中显示的图片直链。

主通道：GitHub 仓库 + jsDelivr CDN（国内访问快，文件按日期命名不会命中旧缓存）；
CDN 未就绪时回退 GitHub Pages 直链，再失败回退匿名图床 qu.ax。
"""
import base64
import os
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = Path(__file__).resolve().parent / "github.token"
OWNER = "tristarowe"
REPO = "wealth-dashboard"
BRANCH = "main"
SITE = f"https://{OWNER}.github.io/{REPO}/"
CDN = f"https://cdn.jsdelivr.net/gh/{OWNER}/{REPO}@{BRANCH}/"
API = f"https://api.github.com/repos/{OWNER}/{REPO}/contents/"


def _token():
    # GitHub Actions 中直接使用内置令牌，本地读 github.token 文件
    tok = os.environ.get("GITHUB_TOKEN", "").strip()
    if not tok and TOKEN_FILE.exists():
        tok = TOKEN_FILE.read_text(encoding="utf-8").strip()
    return tok


def commit(p):
    """把图片提交到仓库 snapshots/，成功返回相对路径。"""
    tok = _token()
    if not tok:
        print("未配置 GitHub 令牌，跳过自有图床")
        return None
    rel = f"snapshots/{p.name}"
    headers = {"Authorization": f"token {tok}", "Accept": "application/vnd.github+json"}
    body = {
        "message": f"chore: 推送图 {p.name}",
        "content": base64.b64encode(p.read_bytes()).decode("ascii"),
        "branch": BRANCH,
    }
    try:
        cur = requests.get(API + rel, headers=headers, params={"ref": BRANCH}, timeout=30)
        if cur.status_code == 200:
            body["sha"] = cur.json()["sha"]
        resp = requests.put(API + rel, headers=headers, json=body, timeout=180)
        if resp.status_code not in (200, 201):
            print("自建图床上传失败：", resp.status_code, resp.text[:150])
            return None
        return rel
    except Exception as exc:  # noqa: BLE001
        print("自建图床上传异常：", exc)
        return None


def upload_self(p):
    """优先返回 jsDelivr CDN 直链，未就绪时回退 GitHub Pages 直链。"""
    rel = commit(p)
    if not rel:
        return None
    # 同名文件重传时清掉 CDN 旧缓存
    try:
        requests.get(f"https://purge.jsdelivr.net/gh/{OWNER}/{REPO}@{BRANCH}/{rel}", timeout=20)
    except Exception:  # noqa: BLE001
        pass
    cdn = CDN + rel
    for _ in range(7):
        try:
            if requests.get(cdn, timeout=20).ok:
                print("长图已上传（jsDelivr）：", cdn)
                return cdn
        except Exception:  # noqa: BLE001
            pass
        time.sleep(3)
    pages = SITE + rel
    try:
        if requests.get(pages, timeout=30).ok:
            print("长图已上传（GitHub Pages）：", pages)
            return pages
    except Exception:  # noqa: BLE001
        pass
    print("CDN 与 Pages 均未就绪：", rel)
    return None


def upload_quax(p):
    ext = p.suffix.lower() or ".png"
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png"
    try:
        resp = requests.post(
            "https://qu.ax/upload.php",
            files={"files[]": (p.name, p.read_bytes(), mime)},
            timeout=120,
        )
        name = resp.json()["files"][0]["file_name"]
        url = f"https://qu.ax/x/{name}{ext}"
        chk = requests.get(url, headers={"Referer": "https://sct.ftqq.com/"}, timeout=60)
        if chk.ok and chk.headers.get("Content-Type", "").startswith("image"):
            print("长图已上传（qu.ax）：", url)
            return url
        print("qu.ax 直链校验失败：", chk.status_code, chk.headers.get("Content-Type"))
    except Exception as exc:  # noqa: BLE001
        print("qu.ax 上传失败：", exc)
    return None


def upload(image_path):
    """返回 (内嵌显示用直链, 微信可直接打开的原图链接)。

    内嵌图走 jsDelivr/Pages，加载快；原图链接走 qu.ax，微信未拦截。
    """
    p = Path(image_path)
    inline = upload_self(p)
    link = upload_quax(p)
    if not (inline or link):
        return None, None
    return inline or link, link or inline
