"""建设银行代销理财产品净值（NLC164 接口，含建信理财与贝莱德建信）。"""
from datetime import datetime

import requests

BASE = "https://wealth.ccb.com/tran/WCCMainPlatV5"
DETAIL = "https://wealth.ccb.com/cn/finance/products/net_value/detail.html"
COMMON = {"CCB_IBSVersion": "V5", "SERVLET_NAME": "WCCMainPlatV5"}
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
    "Referer": DETAIL,
    "Accept": "application/json, text/javascript, */*; q=0.01",
}


class _Client:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.ready = False

    def init(self):
        resp = self.session.get(
            BASE,
            params={**COMMON, "TXCODE": "NHY000", "jsoncallback": "jsonpCallback"},
            timeout=30,
        )
        if "loginStatus" not in resp.text:
            raise RuntimeError("建行会话初始化失败")
        self.ready = True

    def history(self, ecd, mkt, sale, start, end):
        if not self.ready:
            self.init()
        params = {
            **COMMON,
            "TXCODE": "NLC164",
            "IvsmPd_ECD": ecd,
            "Txn_Mkt_ID": mkt,
            "FndCo_Agnc_Sale_InsID": sale,
            "PD_Grp_ECD": "40",
            "Ctrl_Ind_Cgy": "09",
            "SrtDt": start.replace("-", ""),
            "TmDt": end.replace("-", ""),
            "REC_IN_PAGE": "1000",
            "PAGE_JUMP": "1",
        }
        resp = self.session.get(BASE, params=params, timeout=30)
        text = resp.text.strip()
        # 接口正常时 Content-Type 仍为 text/html，只能按正文判断会话失效
        if text.startswith("<") or "交易失败" in text[:300]:
            self.ready = False
            self.init()
            resp = self.session.get(BASE, params=params, timeout=30)
            text = resp.text.strip()
            if text.startswith("<") or "交易失败" in text[:300]:
                raise RuntimeError("建行接口返回交易失败")
        data = resp.json()
        if str(data.get("SUCCESS")).lower() != "true":
            raise RuntimeError("建行接口失败：%s" % data.get("ERRORMSG"))
        rows = []
        for item in data.get("Index_Group") or []:
            raw = item.get("Qtn_Dt") or ""
            value = item.get("Exp_YldRto")
            if len(raw) != 8 or not value:
                continue
            rows.append({"date": "%s-%s-%s" % (raw[:4], raw[4:6], raw[6:]), "nav": float(value)})
        return rows


_client = None


def fetch(params, start, end):
    global _client
    if _client is None:
        _client = _Client()
    rows = _client.history(
        params["ecd"], params["mkt"], params.get("sale", "005"), start, end
    )
    return [r for r in rows if start <= r["date"] <= end]
