"""中银理财官网净值（getNetWorthByCode JSON 接口）。"""
import requests

URL = "https://www.bocwm.cn/webApi/cms/productNetWorth/getNetWorthByCode"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
    "Referer": "https://www.bocwm.cn/",
}


def fetch(params, start, end):
    resp = requests.get(
        URL,
        params={"productCode": params["productCode"], "pageNo": 1, "pageSize": 2000},
        headers=HEADERS,
        timeout=30,
    )
    payload = resp.json()
    if payload.get("code") != 200 or not payload.get("result", True):
        raise RuntimeError("中银接口失败：%s" % str(payload)[:120])
    rows = []
    for item in payload.get("data") or []:
        date = item.get("releaseDate")
        value = item.get("shareNetWorth")
        if date and value:
            rows.append({"date": date, "nav": float(value)})
    return [r for r in rows if start <= r["date"] <= end]
