"""交银理财官网净值（queryJylcProductDetail / queryJylcBreakDetail，纯 HTTP）。"""
import json
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
BASE = "https://www.bocommwm.com"


def _post(path, body, referer):
    message = json.dumps(
        {"REQ_HEAD": {"TRAN_PROCESS": "", "TRAN_ID": ""}, "REQ_BODY": body},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    data = urllib.parse.urlencode({"REQ_MESSAGE": message}).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": BASE,
        "Referer": referer,
        "Accept": "application/json, text/javascript, */*; q=0.01",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    head = payload.get("RSP_HEAD") or {}
    if head.get("TRAN_SUCCESS") != "1":
        raise RuntimeError("交银接口失败：%s %s" % (head.get("ERROR_CODE"), head.get("ERROR_MESSAGE")))
    return payload["RSP_BODY"].get("result") or {}


def _dashed(raw):
    raw = (raw or "").strip()
    if len(raw) == 8 and raw.isdigit():
        return "%s-%s-%s" % (raw[:4], raw[4:6], raw[6:])
    return raw


def fetch(params, start, end):
    fundcode = params["fundcode"]
    referer = (BASE + "/BankCommSite/shtml/jylc/cn/2503327/2503412/list.shtml"
               "?channelId=2503327&c_fundcode=" + fundcode)
    detail = _post(
        "/SITE/queryJylcProductDetail.do",
        {"c_fundcode": fundcode, "c_productcode": "undefined"},
        referer,
    ).get("jylcProductBo") or {}
    history = _post(
        "/SITE/queryJylcBreakDetail.do",
        {"c_fundcode": fundcode, "c_interestway": "0", "c_productcode": "undefined",
         "type": "max", "queryList": 1},
        referer,
    ).get("profitList") or []

    rows = []
    for item in history:
        value = item.get("f_netvalue")
        if value:
            rows.append({"date": _dashed(item.get("d_cdate")), "nav": float(value)})
    if detail.get("d_date") and detail.get("f_netvalue"):
        rows.append({"date": _dashed(detail["d_date"]), "nav": float(detail["f_netvalue"])})
    return [r for r in rows if start <= r["date"] <= end]
