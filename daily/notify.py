"""通过 Server酱 把看板长图 + 当日摘要推送到个人微信。"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from img_host import upload

ROOT = Path(__file__).resolve().parent.parent
STATS = Path(__file__).resolve().parent / "stats.json"
META = Path(__file__).resolve().parent / "shot_meta.json"
# 2026-11-26：排查报告不再单独推微信，改由 06:00 自动化写入本文件并在数据推送里附一行摘要
BUGCHECK = Path(__file__).resolve().parent / "bugcheck_last.md"

KEY = os.environ.get("SERVERCHAN_SENDKEY", "").strip()
KEY_FILE = Path(__file__).resolve().parent / "serverchan.key"
if not KEY and KEY_FILE.exists():
    KEY = KEY_FILE.read_text(encoding="utf-8").strip()

# 实线分隔符：直接用文字线，颜色随正文字体，和正文一致
DIVIDER = "─" * 22

# 2026-11-24：用户要求取消「夜间新品预告推送」。
# nightly 这一轮（北京 21:50 GitHub cron / 22:00 Gitee dispatch）保留了看板长图与当日收益，
# 只不再发「新品预告」那条；早间那轮（07:20/07:30）照常发新品预告。
# 用北京时间判断而非 event.schedule，因 Gitee 走 workflow_dispatch 无 schedule 字段。
NIGHT_SKIP_NEWPROD = True
BJ_TZ = timezone(timedelta(hours=8))


def is_night_run():
    """是否夜间轮次：北京时间 20:00–23:59。可设 NP_FORCE_NEWPROD=1 强制发、=0 强制跳过。"""
    force = os.environ.get("NP_FORCE_NEWPROD", "").strip()
    if force == "1":
        return False
    if force == "0":
        return True
    return 20 <= datetime.now(BJ_TZ).hour <= 23


def bugcheck_line():
    """取当日排查结论首行（供数据推送附带）。非当日或无文件则返回空串。"""
    if not BUGCHECK.exists():
        return ""
    try:
        text = BUGCHECK.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    if not text:
        return ""
    m = re.search(r"(20\d{2}-\d{2}-\d{2})", text)
    if not m or m.group(1) != datetime.now(BJ_TZ).strftime("%Y-%m-%d"):
        return ""
    first = text.splitlines()[0].strip().lstrip("#").strip()
    first = re.sub(r"^全站排查\s*", "", first)
    return first[:60]


def compose(stats, img_url, income, img_link=None):
    title = "理财产品收益看板"
    lines = [
        f"**当日收益总计**：{income or '—'} 元",
        f"**本月产品表现**：正收益 {stats['pos']} · 回撤 {stats['neg']} · 挂0 {stats['flat']}",
    ]
    if img_url:
        lines += [
            "",
            DIVIDER,
            f"![看板长图]({img_url})",
            f"[点此查看原图（可放大）]({img_link or img_url})",
        ]
    return title, "\n\n".join(lines)


def compose_new_products(groups, img_url, img_link=None):
    blocks = []
    groups = sorted(
        groups,
        key=lambda g: min((it.get("date", "") for it in g.get("items") or []), default=""),
    )
    for g in groups:
        lines = [g.get("channel", "")]
        for i, it in enumerate(g.get("items") or [], 1):
            parts = [
                f"（{i}）{it.get('date', '')}",
                it.get("name", ""),
                it.get("risk", ""),
                it.get("quota", ""),
            ]
            lines.append("，".join(p for p in parts if p and p != "—"))
        blocks.append("\n\n".join(lines))
    desp = "\n\n".join(blocks)
    if img_url:
        desp += f"\n\n{DIVIDER}\n\n"
        desp += f"![新品预告]({img_url})"
        desp += f"\n\n[点此查看原图（可放大）]({img_link or img_url})"
    return "新品预告", desp


def fallback_groups():
    """截图元数据缺失时，用页面底稿拼出新品预告分组（只保留未成立的产品）。"""
    path = ROOT / "assets" / "newproducts.js"
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    try:
        data = json.loads(text[text.index("=") + 1:].strip().rstrip(";"))
    except ValueError:
        return []
    today = time.strftime("%Y-%m-%d")
    groups = []
    for lane in data.get("lanes") or []:
        items = []
        for p in lane.get("products") or []:
            if (p.get("establish") or "") < today:
                continue
            start = p.get("raiseStart") or ""
            items.append({
                "date": start[5:].replace("-", ".") if len(start) == 10 else start,
                "name": p.get("name") or "",
                "quota": f"{p['quotaWan']:g}万" if p.get("quotaWan") else "",
                "risk": p.get("risk") or "",
            })
        if items:
            groups.append({"channel": lane.get("channel") or "", "items": items})
    return groups


def send(title, desp):
    resp = requests.post(
        f"https://sctapi.ftqq.com/{KEY}.send",
        data={"title": title[:32], "desp": desp},
        timeout=30,
    )
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    print("Server酱返回：", resp.status_code, data)
    if resp.status_code != 200 or data.get("code") not in (0, None):
        raise SystemExit(f"推送失败：{resp.text[:200]}")


def main():
    # 微信推送只允许 GitHub Actions 触发，避免本地/Gitee 流水线重复推送
    if os.environ.get("GITHUB_ACTIONS") != "true" and os.environ.get("FORCE_PUSH") != "1":
        print("非 GitHub Actions 环境，跳过微信推送（本地测试可设 FORCE_PUSH=1）")
        return 0

    if not KEY:
        print("未配置 SERVERCHAN_SENDKEY，跳过推送")
        return 0

    if "--fail" in sys.argv:
        msg = os.environ.get("FAIL_MSG", "任务失败，请查看运行日志")
        send("万收看板更新失败", f"**{msg}**")
        return 0

    if not STATS.exists():
        print("缺少 stats.json，跳过推送", file=sys.stderr)
        return 1
    stats = json.loads(STATS.read_text(encoding="utf-8"))
    income = ""
    if META.exists():
        income = json.loads(META.read_text(encoding="utf-8")).get("todayIncome", "")

    img_url = None
    img_link = None
    snap = ROOT / "snapshots" / f"{stats['asOf']}.jpg"
    if not snap.exists():
        snap = ROOT / "snapshots" / f"{stats['asOf']}.png"
    if snap.exists():
        img_url, img_link = upload(snap)
        if img_url:
            img_url = f"{img_url}?t={int(time.time())}"
        else:
            print("长图上传失败，回退文字推送", file=sys.stderr)
    else:
        print("缺少长图，回退文字推送：", snap, file=sys.stderr)

    title, desp = compose(stats, img_url, income, img_link)
    bc = bugcheck_line()
    if bc:
        desp += f"\n\n**今日排查**：{bc}"
    if not img_url:
        desp += "\n\n（长图生成失败，已回退文字推送）"
        err = Path(__file__).resolve().parent / "shot_error.txt"
        if err.exists():
            desp += f"\n\n截图错误：{err.read_text(encoding='utf-8').strip()[:180]}"
    if "--test" in sys.argv:
        title = "【测试】" + title
    send(title, desp)

    # 夜间轮次只发收益长图，跳过新品预告那条（用户 2026-11-24 要求）
    if NIGHT_SKIP_NEWPROD and is_night_run():
        print("夜间轮次：跳过新品预告推送（早间轮次照常）", file=sys.stderr)
        # 2026-11-24：长图缺失时已回退文字推送且 Server酱 返回成功，不应再判整体失败
        return 0

    newprod_url = None
    newprod_link = None
    newprod = ROOT / "snapshots" / f"newprod-{stats['asOf']}.png"
    if newprod.exists():
        newprod_url, newprod_link = upload(newprod)
        if newprod_url:
            newprod_url = f"{newprod_url}?t={int(time.time())}"
        else:
            print("新品预告图上传失败，跳过该条推送", file=sys.stderr)
    else:
        print("缺少新品预告图：", newprod, file=sys.stderr)

    np_items = []
    if META.exists():
        np_items = json.loads(META.read_text(encoding="utf-8")).get("newProducts") or []
    if not np_items:
        np_items = fallback_groups()
        if np_items:
            print("截图元数据缺失，改用页面底稿生成新品预告", file=sys.stderr)
    if np_items:
        np_title, np_desp = compose_new_products(np_items, newprod_url, newprod_link)
        if not newprod_url:
            np_desp += "\n\n（新品预告图片生成失败，本条仅文字）"
        if "--test" in sys.argv:
            np_title = "【测试】" + np_title
        send(np_title, np_desp)
    else:
        print("无新品预告数据，跳过该条推送", file=sys.stderr)

    # 2026-11-24：推送本身成功（send 未抛异常即成功）就返回 0；
    # 长图/新品图缺失已回退文字推送，不能让整条 CI 误报 failure
    # （2026-11-24 早晨两条 Server酱均 200 SUCCESS 却因缺图返回 1）。
    return 0


if __name__ == "__main__":
    sys.exit(main())
