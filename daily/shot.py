"""用无头浏览器导出看板长图与新品预告图，保存到 snapshots/，并只保留最近 7 组。

首页长图用桌面宽度（1440）导出；新品预告图用手机宽度（430）导出，
机构泳道在窄屏下纵向堆叠，微信里字号更大更清楚。
"""
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SNAP = ROOT / "snapshots"
META = Path(__file__).resolve().parent / "shot_meta.json"
KEEP = 7


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
                const d = g('.nr');
                return {date: d.split('-')[0].trim(), name: g('.nm'), quota: g('.na'), risk: g('.rk')};
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
                page = desk.new_page()
                page.goto(index)
                page.wait_for_timeout(1500)
                date = page.evaluate("window.REPORT_DATA.asOf")
                _, income = capture_home(page, date)
                desk.close()

                phone = browser.new_context(
                    viewport={"width": 430, "height": 900},
                    device_scale_factor=2,
                    is_mobile=True,
                    has_touch=True,
                )
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
