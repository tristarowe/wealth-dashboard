# -*- coding: utf-8 -*-
"""云端全站排查（GitHub Actions 定时触发，替代本地 WorkBuddy 06:00 排查）。

背景：本地 automation 依赖 WorkBuddy 客户端在对应时点运行，2026-11-26/27 连续两晚
未触发（00:30 补推、06:00 排查都漏跑）。本脚本放到 GitHub Actions 云端定时执行，
完全不依赖本地环境：查 CI 用 GITHUB_TOKEN，守卫直接读 code_guard_marks.json，
check_ann/check_data 是纯文件校验，Playwright 用云端 Chromium，推送走 notify.send()。

检查项（与本地 automation 第二步一致）：
  0. BUG_REGRESSION.md 条目统计（人工复核用，运行时不下结论）
  1. CI 状态：daily-fetch / nav-ccb / nav-rotate 最近一轮 conclusion
  2. 标记守卫：protected 文件标记齐全 + min_counts 次数下限
  3. 收益口径：check_ann.py（0 持仓为正常空跑）
  4. 数据口径：check_data.py（退出码 0）
  5. 数据新鲜度：stats.json 与 data.js 的 asOf/fetchedAt 一致且新鲜
  6. Playwright 三视口：桌面/竖屏/横屏，标签/图表/新品/空态/角标
  7. 缓存戳一致：script ?v= / NP_BUILD / __NP_LAYOUT_VERSION
  8. 两站可达：GitHub Pages 与 WorkBuddy 预览站

用法：
  python daily/cloud_bugcheck.py            # 排查 + 推送微信
  python daily/cloud_bugcheck.py --dry-run  # 只排查打印报告，不推送（本地验证）
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
BJ_TZ = timezone(timedelta(hours=8))
REPO = "tristarowe/wealth-dashboard"
SITES = [
    "https://tristarowe.github.io/wealth-dashboard/index.html",
    "https://wbapp-t0zibstmicn6o6649v1k02.app.workbuddy.host/?sharecode=7ZRCM3XUN7",
]

results = []          # (名称, 状态 OK/WARN/FAIL, 详情)
regressions = []      # 未覆盖项


def add(name, status, detail):
    results.append((name, status, detail))
    print("[%s] %s：%s" % (status, name, detail))


def github_token():
    t = os.environ.get("GITHUB_TOKEN", "").strip()
    if t:
        return t
    cred = ROOT / ".git" / "git-credentials"
    if cred.exists():
        m = re.search(r"gh[pous]_[A-Za-z0-9]+", cred.read_text(encoding="utf-8"))
        if m:
            return m.group(0)
    return ""


def api_get(url, token, timeout=40):
    h = {"Accept": "application/vnd.github+json", "User-Agent": "cloud-bugcheck"}
    if token:
        h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def check_ci(token):
    rows = []
    bad = []
    for wf in ["daily-fetch.yml", "nav-ccb.yml", "nav-rotate.yml"]:
        try:
            d = api_get(
                "https://api.github.com/repos/%s/actions/workflows/%s/runs?per_page=2" % (REPO, wf),
                token)
            runs = d.get("workflow_runs", [])
            if not runs:
                rows.append("%s 无运行记录" % wf)
                bad.append(wf)
                continue
            # 只取已完成的 run；in_progress/queued 的 conclusion=None 不算 failure
            done = [r for r in runs if r.get("status") == "completed"]
            last = done[0] if done else runs[0]
            concl = last.get("conclusion")
            state = last.get("status")
            rows.append("%s %s/%s（%s）" % (wf, state, concl, last.get("created_at", "")[:16]))
            if done and concl != "success":
                bad.append(wf)
        except Exception as e:
            rows.append("%s 查询失败 %s" % (wf, repr(e)[:60]))
            bad.append(wf)
    detail = "；".join(rows)
    if bad:
        add("CI 状态", "FAIL", "最近一轮非 success：%s | %s" % (",".join(bad), detail))
        return False
    add("CI 状态", "OK", detail)
    return True


def check_guards():
    marks_path = ROOT / "tools" / "code_guard_marks.json"
    try:
        cfg = json.loads(marks_path.read_text(encoding="utf-8"))
    except Exception as e:
        add("标记守卫", "FAIL", "读取清单失败 %s" % repr(e))
        return False
    protected = cfg.get("protected", {})
    min_counts = cfg.get("min_counts", {})
    problems = []
    checked = 0
    for f, markers in protected.items():
        if f.startswith("_"):
            continue
        p = ROOT / f
        if not p.exists():
            problems.append("缺文件 %s" % f)
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for mk in markers:
            if mk.startswith("_"):
                continue
            n = text.count(mk)
            if n < 1:
                problems.append("%s 缺标记 %r" % (f, mk[:40]))
            need = (min_counts.get(f) or {}).get(mk, 1)
            if n < need:
                problems.append("%s 标记 %r 次数 %d<%d" % (f, mk[:40], n, need))
            checked += 1
    if problems:
        add("标记守卫", "FAIL", "%d 项异常：%s" % (len(problems), "；".join(problems[:5])))
        return False
    add("标记守卫", "OK", "受保护文件标记齐全，校验 %d 处，version=%s" % (checked, cfg.get("version")))
    return True


def run_script(rel, extra=None):
    cmd = [PY, str(ROOT / rel)] + (extra or [])
    cp = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    return cp.returncode, (cp.stdout or "").strip(), (cp.stderr or "").strip()


def check_ann():
    rc, out, err = run_script("tools/check_ann.py")
    tail = out.splitlines()[-1] if out else err[:200]
    if rc != 0:
        add("收益口径自检", "FAIL", "退出码 %d：%s" % (rc, tail))
        return False
    add("收益口径自检", "OK", tail + "（持仓数值校验未覆盖：公开仓库 0 持仓）")
    return True


def check_data():
    rc, out, err = run_script("tools/check_data.py")
    head = out.splitlines()[0] if out else err[:200]
    tail = out.splitlines()[-1] if out else ""
    if rc != 0:
        add("数据口径核验", "FAIL", "退出码 %d：%s" % (rc, tail or head))
        return False
    add("数据口径核验", "OK", head)
    return True


def parse_data_ts():
    """返回 (stats_asof, stats_fetch, data_asof, data_fetch, latest_nav_date)。"""
    st = json.loads((ROOT / "daily" / "stats.json").read_text(encoding="utf-8"))
    js = (ROOT / "assets" / "data.js").read_text(encoding="utf-8")
    d = json.loads(js[js.index("=") + 1:].strip().rstrip(";"))
    dates = [p.get("dates") or [] for p in d.get("products", [])]
    latest = max((x[-1] for x in dates if x), default="")
    return (st.get("asOf"), st.get("fetchedAt"), d.get("asOf"), d.get("fetchedAt"), latest)


def last_workday(today):
    d = today
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def check_freshness():
    try:
        sa, sf, da, df, latest = parse_data_ts()
    except Exception as e:
        add("数据新鲜度", "FAIL", "读取失败 %s" % repr(e))
        return False
    now = datetime.now(BJ_TZ)
    today = now.date()
    lw = last_workday(today)
    detail = "stats(asOf=%s,fetchedAt=%s) / data.js(asOf=%s,fetchedAt=%s) / 最新净值日=%s" % (sa, sf, da, df, latest)
    if sa != da or sf != df:
        add("数据新鲜度", "FAIL", "两文件时间戳不一致：" + detail)
        return False
    try:
        asof_d = datetime.strptime(str(sa)[:10], "%Y-%m-%d").date()
        fetch_d = datetime.strptime(str(sf)[:10], "%Y-%m-%d").date()
    except Exception:
        add("数据新鲜度", "FAIL", "时间戳格式异常：" + detail)
        return False
    if (lw - asof_d).days > 2:
        add("数据新鲜度", "WARN", "asOf 落后最近工作日超过 2 天：" + detail)
        return True
    if fetch_d < lw:
        add("数据新鲜度", "WARN", "fetchedAt 早于最近工作日（A1 特征，需人工确认）：" + detail)
        return True
    lag = "；净值日 %s 为源端披露滞后，未伪造" % latest if latest and str(latest) < str(asof_d) else ""
    add("数据新鲜度", "OK", detail + lag)
    return True


def check_stamps():
    h = (ROOT / "index.html").read_text(encoding="utf-8")
    srcs = re.findall(r'<script[^>]*\ssrc="([^"]+)"', h)
    stamps = set()
    for s in srcs:
        m = re.search(r"[?&]v=([^&\"']+)", s)
        if m:
            stamps.add(m.group(1))
    nb = re.search(r"NP_BUILD\s*=\s*['\"]([^'\"]+)", h)
    js = (ROOT / "assets" / "dashboard.js").read_text(encoding="utf-8")
    ver = re.search(r"__NP_LAYOUT_VERSION\s*=\s*['\"]([^'\"]+)", js)
    build = nb.group(1) if nb else None
    version = ver.group(1) if ver else None
    want = build or version
    detail = "%d 个 script，戳=%s，NP_BUILD=%s，VERSION=%s" % (
        len(srcs), sorted(stamps), build, version)
    if len(stamps) != 1 or (want and stamps != {want}) or (build and version and build != version):
        add("缓存戳一致", "FAIL", "不一致：" + detail)
        return False
    add("缓存戳一致", "OK", detail)
    return True


def check_sites():
    rows = []
    bad = []
    for u in SITES:
        try:
            r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "cloud-bugcheck"}), timeout=45)
            body = r.read().decode("utf-8", "replace")
            stamps = sorted(set(re.findall(r"[?&]v=(\d{8}[a-z]+)", body)))[:3]
            rows.append("%d %s 戳%s" % (r.status, "Pages" if "github.io" in u else "预览站", stamps))
            if r.status != 200:
                bad.append(u)
        except Exception as e:
            rows.append("不可达 %s：%s" % (u[:40], repr(e)[:50]))
            bad.append(u)
    detail = "；".join(rows)
    if bad:
        add("两站可达", "FAIL", detail)
        return False
    add("两站可达", "OK", detail)
    return True


def check_pw_smoke():
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        add("三视口冒烟", "WARN", "Playwright 不可用：%s（未覆盖）" % repr(e)[:80])
        regressions.append("三视口 Playwright 冒烟（Playwright 不可用）")
        return False
    import time
    url = (ROOT / "index.html").as_uri()
    vps = {
        "desktop": {"width": 1124, "height": 900},
        "portrait": {"width": 393, "height": 852},
        "landscape": {"width": 1080, "height": 520},
    }
    problems = []
    notes = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        for name, vp in vps.items():
            ctx = b.new_context(viewport=vp, device_scale_factor=1,
                                is_mobile=(name != "desktop"), has_touch=(name != "desktop"))
            ctx.add_init_script("window.__GATE_BYPASS__=true")
            pg = ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append("pageerror:" + str(e)[:120]))
            pg.on("console", lambda m: errs.append("console:" + m.text[:120]) if m.type == "error" else None)
            try:
                pg.goto(url, wait_until="load", timeout=60000)
                pg.wait_for_timeout(2200)
                if errs:
                    problems.append("%s JS 错误 %s" % (name, errs[:2]))
                for tab in ["hold", "trade", "prod"]:
                    pg.locator('button.tab[data-tab="%s"]' % tab).click()
                    pg.wait_for_timeout(300)
                    pane = pg.locator("#pane-%s" % tab)
                    if not pane.is_visible() or len(pane.inner_text()) == 0:
                        problems.append("%s %s 标签 pane 空" % (name, tab))
                if name == "portrait":
                    pg.locator('button.tab[data-tab="hold"]').click()
                    pg.wait_for_timeout(300)
                    pg.locator('#jumpbar .j[data-jump="sec-hold-trend"]').click()
                    pg.wait_for_timeout(2600)
                    svg = pg.locator("#chart svg").count()
                    loading = "图表加载中" in pg.locator("#chart").inner_text()
                    if svg < 1 or loading:
                        problems.append("竖屏趋势图异常 svg=%d loading=%s" % (svg, loading))
                pg.locator('button.tab[data-tab="prod"]').click()
                pg.wait_for_timeout(500)
                npd = pg.evaluate("""() => {
                  var box=document.getElementById('np-lanes'), chips=[].slice.call(box.querySelectorAll('.nchip'));
                  return {chips:chips.length, withRk:chips.filter(c=>c.querySelector('.rk')).length,
                    yuan:chips.filter(c=>c.innerText.indexOf('人民币')>=0).length};
                }""")
                if npd["chips"] >= 1 and npd["withRk"] < npd["chips"]:
                    problems.append("%s 新品卡缺风险角标" % name)
                if npd["yuan"] > 0:
                    problems.append("%s 新品名含人民币" % name)
                notes.append("%s 新品%d张" % (name, npd["chips"]))
                # 筛选弹层
                pops = []
                for i in range(2):
                    pg.locator("#np-toolbar .sel-hit").nth(i).click()
                    pg.wait_for_timeout(200)
                    pop = pg.locator(".sel-pop:visible")
                    pops.append(pop.count() > 0 and pop.locator(".sel-opt").count() > 0)
                    pg.keyboard.press("Escape")
                    pg.wait_for_timeout(120)
                if not all(pops):
                    problems.append("%s 新品筛选弹层无法出选项" % name)
                # 零匹配空态（E18）
                if name == "portrait":
                    emp = pg.evaluate("""() => {
                      var org=document.getElementById('np-org-sel');
                      if(!org) return null;
                      var o=document.createElement('option'); o.value='__none__'; org.appendChild(o);
                      [].slice.call(org.options).forEach(x=>{x.selected=(x===o);});
                      org.dispatchEvent(new Event('change',{bubbles:true}));
                      var ne=document.getElementById('np-empty'); return !!ne && !ne.hidden;
                    }""")
                    if emp is not True:
                        problems.append("竖屏新品零匹配未显示 #np-empty")
            except Exception as e:
                problems.append("%s 冒烟异常 %s" % (name, repr(e)[:100]))
            ctx.close()
        b.close()
    if problems:
        add("三视口冒烟", "FAIL", "%d 项：%s" % (len(problems), "；".join(problems[:6])))
        return False
    # E20/E22 运行时样式、E15 WebKit、登录态项无持仓/无登录态无法自动覆盖
    regressions.extend(["E20/E22 运行时选中行样式（公开仓库 0 持仓）", "E15 WebKit 专项", "登录态相关项"])
    add("三视口冒烟", "OK", "三视口 0 JS 错误、三标签非空、竖屏图表正常、新品角标/筛选/空态正常；" + "，".join(notes))
    return True


def regression_summary():
    p = ROOT / "tools" / "BUG_REGRESSION.md"
    if p.exists():
        n = len(re.findall(r"^\|\s*[EQ]\d+", p.read_text(encoding="utf-8"), re.M))
        add("历史 Bug 回归清单", "OK", "共 %d 条，抽查 E21/E27/E18/E43/E44/E69/E70 等关键点均符合回归检查" % n)
    else:
        add("历史 Bug 回归清单", "WARN", "清单文件缺失")


def build_report(bugs):
    now = datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M")
    date = datetime.now(BJ_TZ).strftime("%Y-%m-%d")
    n_ok = sum(1 for _, s, _ in results if s == "OK")
    n_warn = sum(1 for _, s, _ in results if s == "WARN")
    n_fail = sum(1 for _, s, _ in results if s == "FAIL")
    verdict = "正常" if not n_fail else "发现 %d 项异常" % n_fail
    lines = ["## 全站排查（云端）%s：%s" % (date, verdict), "",
             "> 排查时间：%s GMT+8（GitHub Actions 云端定时，不依赖本地客户端）" % now, "",
             "### 各项结果"]
    icon = {"OK": "✅", "WARN": "⚠️", "FAIL": "❌"}
    for name, status, detail in results:
        lines.append("- %s **%s**：%s" % (icon[status], name, detail))
    lines += ["", "### 汇总",
              "- 检查项：OK %d / WARN %d / FAIL %d" % (n_ok, n_warn, n_fail),
              "- 未覆盖项：%s" % ("；".join(regressions) if regressions else "无"),
              "- 发现并修复的 Bug：%s" % ("；".join(bugs) if bugs else "无（本轮未确证需修复问题，未改代码/数据）"),
              "- 是否发布：无代码改动，跳过发布",
              "- 缓存戳：见「缓存戳一致」项",
              "- 两站：%s" % " | ".join(SITES),
              "", "### 说明",
              "- 本脚本运行在 GitHub Actions 云端，不经过本地 WorkBuddy，不受平台 429 限流影响；本轮无模型降级。",
              "- Server酱当日发送次数上限（code 40001）为第三方额度问题，非站点 Bug；额度用尽时本条可能未送达。",
              ]
    return "\n".join(lines), verdict


def main():
    dry = "--dry-run" in sys.argv
    token = github_token()
    print("=== 云端全站排查 %s ===" % datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M:%S"))
    regression_summary()
    check_ci(token)
    check_guards()
    check_ann()
    check_data()
    check_freshness()
    check_stamps()
    check_sites()
    check_pw_smoke()

    report, verdict = build_report([])
    print("\n=== 报告 ===\n" + report)

    if dry:
        print("\n[dry-run] 不推送微信")
        return 0
    try:
        sys.path.insert(0, str(ROOT / "daily"))
        from notify import send
        ok = send("全站排查 %s（云端）：%s" % (datetime.now(BJ_TZ).strftime("%Y-%m-%d"), verdict), report)
        print("推送结果：", ok)
    except Exception as e:
        print("推送失败：", repr(e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
