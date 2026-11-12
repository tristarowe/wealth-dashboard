"""中国理财网净值批量抓取（绕开容易触发人机验证的详情接口）。

链路：getProductList 取产品主档（风险等级 / 默认份额 / 最新净值）
      → getNetValueList 按份额拉全量历史净值（单页 50 条）。
详情接口 getProductDetail 在查询频次高时会返回人机验证，本模块不调用它。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from chinawealth_nv import ChinaWealthClient  # noqa: E402

RISK_MAP = {"01": "R1", "02": "R2", "03": "R3", "04": "R4", "05": "R5"}

_CLIENT = None
CURRENT_DELAY = 1.2

# 最近一次抓取到的产品主档：regCode -> {risk, share, latestDate, latestNav, name}
LAST_META = {}


def client(delay=None):
    global _CLIENT, CURRENT_DELAY
    if delay is not None and delay != CURRENT_DELAY:
        _CLIENT = None
        CURRENT_DELAY = delay
    if _CLIENT is None:
        _CLIENT = ChinaWealthClient(delay=CURRENT_DELAY)
        _CLIENT.init_license()
    return _CLIENT


def reset_client():
    global _CLIENT
    _CLIENT = None


def _call(fn):
    """签名会话到期时服务端返回「验证失败」，重新握手后重试一次。

    fn 必须是「调用时才取 client」的闭包，否则重试仍会用到已失效的会话。
    """
    try:
        return fn()
    except Exception as exc:
        if "验证" not in str(exc):
            raise
        reset_client()
        return fn()


def product_meta(reg, c=None):
    data = _call(lambda: client().search_products(reg_code=reg, page=1, size=10)) or {}
    items = data.get("list") or []
    if not items:
        return {}
    it = items[0]
    meta = {
        "risk": RISK_MAP.get(str(it.get("prodRiskLevel") or ""), ""),
        "share": it.get("subShareCode") or "",
        "latestDate": it.get("subShareDate") or "",
        "latestNav": it.get("subShareValue") or "",
        "name": it.get("prodName") or "",
    }
    LAST_META[reg] = meta
    return meta


def history(reg, share=""):
    rows, page = [], 1
    while page <= 40:
        data = _call(lambda: client().get_net_value_list(reg, share, "1", page, 50)) or {}
        items = data.get("list") or []
        rows.extend(items)
        total = data.get("total") or 0
        if not items or len(rows) >= total:
            break
        page += 1
    dedup = {}
    for r in rows:
        dt, val = r.get("netValueDate"), r.get("shareNetVal")
        if dt and val:
            dedup[dt] = float(val)
    return [{"date": k, "nav": dedup[k]} for k in sorted(dedup)]


def fetch(reg):
    """返回 (净值序列, 产品主档)；主档同时写入 LAST_META。"""
    meta = product_meta(reg)
    rows = history(reg, meta.get("share") or "")
    if not rows:
        rows = history(reg, "")
    return rows, meta
