"""把 WorkBuddy「每日全站排查」的报告正文通过 Server酱推送到微信。

由 .github/workflows/bugcheck-report.yml 的 workflow_dispatch 触发；sendkey 只存在于
GitHub Actions Secret，本地不落盘。标题/正文来自环境变量 PUSH_TITLE / PUSH_REPORT。
直接复用 notify.send()，不经过 notify.main() 的 GITHUB_ACTIONS 环境闸门。
"""
import os
import sys

from notify import send


def main():
    title = (os.environ.get("PUSH_TITLE") or "全站排查报告").strip()
    report = (os.environ.get("PUSH_REPORT") or "").strip()
    if not report:
        print("报告正文为空，跳过推送")
        return 0
    send(title, report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
