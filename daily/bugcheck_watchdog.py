"""06:00 全站排查看门狗：本地自动化若被限流/中断而没有发出微信推送，
由 GitHub Actions 独立发一条告警，避免任务失联。

工作背景：2026-11-25 06:00 的「全站每日排查与修复」在本地第一轮模型调用即遇到
平台 429（使用量超限，09:11 才重置），任务没有执行到第五步的 workflow_dispatch，
用户因此完全收不到推送。看门狗只依赖 GitHub Actions + Server酱 Secret，
不依赖本地 WorkBuddy 运行环境，能在当天 07:30 发现漏推并告警。
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

from notify import send

BJ_TZ = timezone(timedelta(hours=8))
REPO = "tristarowe/wealth-dashboard"
WF = "bugcheck-report.yml"


def main():
    key = os.environ.get("SERVERCHAN_SENDKEY", "").strip()
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not key or not token:
        print("缺少 SERVERCHAN_SENDKEY 或 GITHUB_TOKEN，跳过")
        return 0

    now = datetime.now(BJ_TZ)
    r = requests.get(
        f"https://api.github.com/repos/{REPO}/actions/workflows/{WF}/runs",
        params={"per_page": 15, "event": "workflow_dispatch"},
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        },
        timeout=30,
    )
    r.raise_for_status()

    # 06:00 排查正常应在 05:50–07:30（北京）之间 dispatch；只看是否发出，
    # 不看 conclusion——Actions 排队造成 conclusion 迟到不属于漏推。
    start = now.replace(hour=5, minute=50, second=0, microsecond=0)
    # 手动补跑/延迟触发也算已送达：窗口上界取 max(07:30, 当前时刻)。
    end = max(now.replace(hour=7, minute=30, second=0, microsecond=0), now)
    hits = []
    for run in r.json().get("workflow_runs", []):
        t = datetime.strptime(run["created_at"], "%Y-%m-%dT%H:%M:%SZ")
        t = t.replace(tzinfo=timezone.utc).astimezone(BJ_TZ)
        if start <= t <= end:
            hits.append((t.isoformat(), run.get("conclusion")))
    if hits:
        print("当天已发出排查报告，跳过告警：", hits[:2])
        return 0

    title = f"全站排查未送达告警 {now:%Y-%m-%d}"
    desp = "\n\n".join([
        f"**{now:%Y-%m-%d %H:%M} 北京时间**",
        "今早 06:00 的全站排查自动化没有产生微信推送。常见原因是 WorkBuddy 平台限流（429）"
        "或任务在本地第一步即中断，导致排查报告没有触发 GitHub Actions 推送。",
        "请到 WorkBuddy「自动化」查看今早运行记录；需要补跑时可手动触发"
        "「全站每日排查与修复」，或在对话中要求立即排查。",
        "本告警由 GitHub Actions 看门狗独立发出，不依赖本地 WorkBuddy 运行环境。",
    ])
    send(title, desp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
