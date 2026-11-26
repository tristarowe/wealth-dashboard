"""用无头浏览器导出看板长图与新品预告图，保存到 snapshots/，并只保留最近 7 组。

首页长图用桌面宽度（1440）导出；新品预告图用手机宽度（430）导出，
机构泳道在窄屏下纵向堆叠，微信里字号更大更清楚。
"""
import json
import os
import sys
from pathlib import Path

# 依赖缺失时把原因写进 shot_error.txt，推送里能直接看到，不用翻流水线日志
try:
    from playwright.sync_api import sync_playwright
    from PIL import Image
except ImportError as exc:
    (Path(__file__).resolve().parent / "shot_error.txt").write_text(
        f"缺少依赖：{exc}", encoding="utf-8"
    )
    raise

ROOT = Path(__file__).resolve().parent.parent
SNAP = ROOT / "snapshots"
META = Path(__file__).resolve().parent / "shot_meta.json"
KEEP = 7


# 页面需要加载 assets/library.js（product 库 200+ 只）才能把持仓与产品库对上。
# 2026-11-23 事故：某次长图里「覆盖产品」只剩 2 款、盈亏汇总只有 2 行，
# 而云端交易 16 笔、持仓 15 只都完好——是页面自身只认到 data.js 的 4 只，
# 即产品库没就绪。截图必须等到库齐再注入，宁可重载也不推残缺图。
LIB_MIN_ITEMS = 150


def ensure_library_ready(page, tries=3):
    """等页面产品库加载完成；未就绪则重载重试，仍不就绪直接失败。"""
    n = 0
    for i in range(tries):
        n = page.evaluate(
            "() => ((window.PRODUCT_LIBRARY && window.PRODUCT_LIBRARY.items) || []).length"
        )
        if n >= LIB_MIN_ITEMS:
            print("产品库已就绪", n, "只", flush=True)
            return n
        print(f"产品库未就绪（{n} 只），第 {i + 1} 次重载页面", flush=True)
        page.reload()
        page.wait_for_timeout(2500)
    raise RuntimeError(f"产品库仅加载到 {n} 只（应 ≥{LIB_MIN_ITEMS}），拒绝生成残缺长图")


def inject_live_trades(page):
    """RLS 开启后匿名打开页面读不到交易，截图会是空壳。

    这里用 service_role 从 Supabase 拉全量交易，只在截图浏览器内存里注入
    window.TRANSACTIONS，再调页面现成的 DASHBOARD_REFRESH() 重算并重绘。
    公开底稿与 RLS 权限都不动——注入仅存在于无头浏览器的当前页面。
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from pull_cloud import supabase_trades
        items = supabase_trades()
    except Exception as exc:  # noqa: BLE001
        print("截图前读取云端交易失败：", exc, flush=True)
        items = []
    if not items:
        raise RuntimeError("未取到云端交易（检查 SUPABASE_SERVICE_ROLE_KEY）；拒绝生成空壳长图")

    page.evaluate(
        """items => {
            window.TRANSACTIONS = { items: items };
            if (window.DASHBOARD_REFRESH) window.DASHBOARD_REFRESH();
        }""",
        items,
    )
    page.wait_for_timeout(1500)
    print("已注入云端交易", len(items), "笔用于截图", flush=True)

    # 注入后校验：能对上产品的持仓数应与「当前实际有份额的产品数」一致。
    # 2026-11-26 净份额口径：清仓产品不计入应识别持仓
    # 原口径用「去重后的申购产品数」，把已全额赎回清仓的产品
    # 也算进应识别数——云端 16 只申购里有 3 只已清仓，实际持仓本就只有 13 只，
    # 却被误判成「只认出 13/16」而反复重试、长图失败。改按每只 pid 的申购−赎回
    # 净份额 >0 计算应持仓数；清仓产品不再计入。真正漏识别（净持仓>0 但没认出
    # 哪怕一只）才判失败。诊断同时打印缺失 pid，便于下次定位映射问题。
    net_shares = {}
    for t in items:
        pid = t.get("pid")
        if not pid or t.get("status") not in (None, "", "已确认"):
            continue
        typ = t.get("type") or "申购"
        sh = float(t.get("shares") or 0)
        if typ == "申购":
            net_shares[pid] = net_shares.get(pid, 0.0) + sh
        elif typ in ("赎回", "清仓"):
            net_shares[pid] = net_shares.get(pid, 0.0) - sh
    held_pids = {p for p, v in net_shares.items() if v > 1e-6}
    want = len(held_pids)
    detail = page.evaluate(
        """() => ({
            got: (window.DASHBOARD_HOLDINGS || []).filter(h => h.shares > 1e-6).length,
            pids: (window.DASHBOARD_HOLDINGS || []).filter(h => h.shares > 1e-6)
                    .map(h => (h.tx && h.tx.pid) || (h.product && h.product.id) || ''),
            lib: (window.DASHBOARD_LIBRARY || []).length
        })"""
    )
    got, lib = detail["got"], detail["lib"]
    print(f"注入后持仓 {got} 只（应为 {want} 只），产品库模型 {lib} 只", flush=True)
    if want and got < max(1, want - 1):
        missing = sorted(held_pids - set(detail["pids"]))
        raise RuntimeError(
            f"持仓只认出 {got}/{want} 只（产品库模型 {lib} 只），"
            f"未识别 pid：{missing}；长图会残缺；转重试"
        )


def capture_home(page, date):
    today_income = page.inner_text("#metric-today").replace("元", "").strip()
    print("今日收益：", today_income, flush=True)

    home = SNAP / f"{date}.png"
    with page.expect_download(timeout=60000) as dl:
        page.click("#export-shot")
    dl.value.save_as(str(home))
    print("saved", home, home.stat().st_size, "bytes", flush=True)

    # 长图压成适配手机查看的尺寸并转 JPEG，微信里打开更快
    img = Image.open(home).convert("RGB")
    if img.width > 1400:
        img = img.resize((1400, round(img.height * 1400 / img.width)), Image.LANCZOS)
    jpg = home.with_suffix(".jpg")
    img.save(jpg, quality=85, optimize=True)
    home.unlink()
    print("saved", jpg, jpg.stat().st_size, "bytes", flush=True)
    return jpg, today_income


def capture_newprod(page, date):
    page.click('.tab[data-tab="prod"]')
    page.wait_for_timeout(1200)
    page.evaluate("document.fonts && document.fonts.ready")
    section = page.query_selector("#pane-prod section")
    if section is None:
        raise RuntimeError("未找到产品页的新品预告模块")
    newprod = SNAP / f"newprod-{date}.png"
    section.screenshot(path=str(newprod))
    print("saved", newprod, newprod.stat().st_size, "bytes", flush=True)

    groups = page.evaluate(
        """() => Array.from(document.querySelectorAll('#pane-prod .ts-lane')).map(lane => ({
            channel: lane.getAttribute('data-org') || '',
            items: Array.from(lane.querySelectorAll('.nchip')).map(el => {
                const g = s => { const n = el.querySelector(s); return n ? n.innerText.trim() : ''; };
                // 方案C：.nr 现为「11.23」或「11.23→11.26」，取箭头/连字符前的起始日，
                // 供通知按日期排序与展示（newproducts.json 里已是 11.23 这类 md 格式）
                const d = g('.nr').split(/[→\\-－]/)[0].trim();
                return {date: d, name: g('.nm'), quota: g('.na'), risk: g('.rk')};
            })
        })).filter(lane => lane.items.length)"""
    )
    for g in groups:
        g["items"].sort(key=lambda x: x["date"])
    return newprod, groups


def main():
    SNAP.mkdir(exist_ok=True)
    index = (ROOT / "index.html").as_uri()
    last_err = None

    for attempt in range(1, 3):
        try:
            with sync_playwright() as p:
                channel = os.environ.get("PW_CHANNEL")
                browser = p.chromium.launch(channel=channel) if channel else p.chromium.launch()

                desk = browser.new_context(
                    viewport={"width": 1440, "height": 1000},
                    device_scale_factor=2,
                    accept_downloads=True,
                )
                # 页面新增全屏登录墙：未登录会锁住全站。截图是服务端无登录流程，
                # 这里在导航前注入放行标记（仅当前浏览器内存，公开站不受影响）。
                desk.add_init_script("window.__GATE_BYPASS__ = true;")
                page = desk.new_page()
                page.goto(index)
                page.wait_for_timeout(1500)
                ensure_library_ready(page)
                date = page.evaluate("window.REPORT_DATA.asOf")
                inject_live_trades(page)
                _, income = capture_home(page, date)
                desk.close()

                phone = browser.new_context(
                    viewport={"width": 430, "height": 900},
                    device_scale_factor=2,
                    is_mobile=True,
                    has_touch=True,
                )
                phone.add_init_script("window.__GATE_BYPASS__ = true;")
                mp = phone.new_page()
                mp.goto(index)
                mp.wait_for_timeout(1500)
                _, groups = capture_newprod(mp, date)
                phone.close()
                browser.close()

            META.write_text(
                json.dumps({"asOf": date, "todayIncome": income, "newProducts": groups},
                           ensure_ascii=False),
                encoding="utf-8",
            )
            break
        except Exception as exc:
            last_err = str(exc)
            print(f"[重试 {attempt}/2] 截图失败: {last_err}", flush=True)
    else:
        err = Path(__file__).resolve().parent / "shot_error.txt"
        err.write_text(last_err or "未知错误", encoding="utf-8")
        print("截图失败", file=sys.stderr)
        return 1

    err = Path(__file__).resolve().parent / "shot_error.txt"
    if err.exists():
        err.unlink()

    files = sorted(list(SNAP.glob("*.jpg")) + list(SNAP.glob("*.png")))
    homes = [f for f in files if not f.name.startswith("newprod-")]
    for f in homes[:-KEEP]:
        f.unlink()
        for ext in (".png", ".jpg"):
            mate = SNAP / f"newprod-{f.stem}{ext}"
            if mate.exists():
                mate.unlink()
        print("清理旧截图", f.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
