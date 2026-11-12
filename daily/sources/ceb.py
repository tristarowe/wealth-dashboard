"""光大理财官网净值（页面动态渲染，需浏览器；页头提供当日最新净值）。"""
import re

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")


def fetch(params, start, end):
    from playwright.sync_api import sync_playwright

    url = params["url"]
    rows = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(
                channel="chrome",
                headless=True,
                args=["--disable-blink-features=AutomationControlled"],
            )
        except Exception:
            browser = p.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled"],
            )
        try:
            ctx = browser.new_context(locale="zh-CN", user_agent=UA,
                                      viewport={"width": 1440, "height": 1000})
            page = ctx.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_selector(".hot_yqnh b", timeout=30000)
            nav_text = page.inner_text(".hot_yqnh b").strip()
            label = page.inner_text(".hot_yqnh span").strip()
            page.wait_for_timeout(6000)
            page.click("#product_ul a.a2")
            table = page.frame_locator("#fundValueframe").locator("#data_list table.lsjz_table tr")
            table.first.wait_for(state="attached", timeout=40000)
            cells = table.evaluate_all(
                "els => els.map(tr => Array.from(tr.cells).map(td => td.textContent.trim()))"
            )
        finally:
            browser.close()

    body = " ".join(r[0] for r in cells if r)
    if len(cells) <= 1 or "没有找到" in body:
        raise RuntimeError("光大净值表为空")
    for row in cells[1:]:
        if len(row) >= 2 and re.match(r"^\d{4}-\d{2}-\d{2}$", row[0]):
            rows.append({"date": row[0], "nav": float(row[1])})
    match = re.search(r"(\d{4}-\d{2}-\d{2})", label)
    if match and nav_text:
        rows.append({"date": match.group(1), "nav": float(nav_text)})
    return [r for r in rows if start <= r["date"] <= end]
