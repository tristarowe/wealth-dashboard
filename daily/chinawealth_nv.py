#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""中国理财网信息披露平台 理财产品净值抓取工具。

数据来源：https://xinxipilu.chinawealth.com.cn/queryMenu/prodType
仅供个人或机构基于非商业目的使用，请控制请求频率。
"""

import argparse
import base64
import csv
import json
import random
import re
import string
import sys
import time
from hashlib import sha256

try:
    import requests
    from Crypto.Cipher import AES, PKCS1_v1_5
    from Crypto.Hash import SHA256 as CRYPTO_SHA256
    from Crypto.PublicKey import RSA
    from Crypto.Signature import pkcs1_15
    from Crypto.Util.Padding import pad
except ImportError as exc:  # pragma: no cover
    sys.exit(
        "缺少依赖：%s\n请先执行：python -m pip install requests pycryptodome" % exc.name
    )

BASE_URL = "https://xinxipilu.chinawealth.com.cn/lcxp-platService"
ORIGIN = "https://xinxipilu.chinawealth.com.cn"
SIGN_KEY = "hold?fish:palm"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
VALID_PAGE_SIZES = (10, 20, 50)


class CaptchaRequired(RuntimeError):
    """服务端要求人机验证。"""


class ApiError(RuntimeError):
    """接口返回业务错误。"""


class ChinaWealthClient:
    def __init__(self, delay=1.5, timeout=30):
        self.delay = delay
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Content-Type": "application/json;charset=UTF-8",
                "Origin": ORIGIN,
                "Referer": ORIGIN + "/queryMenu/prodType",
            }
        )
        self.aes_key = None
        self.license_key = None
        self._last_request = 0.0
        self._handshake()

    # ---------- 底层协议 ----------
    def _throttle(self):
        elapsed = time.time() - self._last_request
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)
        self._last_request = time.time()

    def _handshake(self):
        self._throttle()
        key = RSA.generate(1024)
        public_der = base64.b64encode(key.publickey().export_key(format="DER")).decode()
        resp = self.session.post(BASE_URL + "/m/n", data=public_der, timeout=self.timeout)
        resp.raise_for_status()
        manage_key_b64 = PKCS1_v1_5.new(key).decrypt(base64.b64decode(resp.text.strip()), None)
        if not manage_key_b64:
            raise ApiError("握手失败：无法解密服务端返回的会话密钥")
        self.aes_key = base64.b64decode(manage_key_b64.decode())

    def _encrypt(self, raw):
        cipher = AES.new(self.aes_key, AES.MODE_ECB)
        return base64.b64encode(cipher.encrypt(pad(raw.encode("utf-8"), 16))).decode()

    @staticmethod
    def _normalize_pem(pem):
        body = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace(
            "-----END PRIVATE KEY-----", ""
        )
        body = re.sub(r"\s+", "", body)
        lines = [body[i : i + 64] for i in range(0, len(body), 64)]
        return "-----BEGIN PRIVATE KEY-----\n" + "\n".join(lines) + "\n-----END PRIVATE KEY-----"

    def _request(self, path, payload, retries=3):
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        last_error = None
        for attempt in range(retries):
            self._throttle()
            timestamp = str(int(time.time() * 1000))
            nonce = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
            encrypted = self._encrypt(raw)
            headers = {
                "X-Nonce": nonce,
                "X-Timestamp": timestamp,
                "X-Sign": sha256(
                    ("data=%s&nonce=%s&timestamp=%s&signKey=%s"
                     % (encrypted, nonce, timestamp, SIGN_KEY)).encode("utf-8")
                ).hexdigest(),
            }
            if self.license_key is not None and path != "/product/getInitData":
                signature = pkcs1_15.new(self.license_key).sign(
                    CRYPTO_SHA256.new(raw.encode("utf-8"))
                )
                headers["signature"] = base64.b64encode(signature).decode()

            try:
                resp = self.session.post(
                    BASE_URL + path, data=encrypted, headers=headers, timeout=self.timeout
                )
            except requests.RequestException as exc:
                last_error = exc
                time.sleep(2 * (attempt + 1))
                continue

            if resp.status_code == 503:
                last_error = ApiError("服务端限流（HTTP 503），已重试")
                time.sleep(5 * (attempt + 1))
                continue
            if resp.status_code != 200:
                raise ApiError("HTTP %s：%s" % (resp.status_code, resp.text[:200]))

            try:
                result = json.loads(resp.text)
            except ValueError:
                raise ApiError("接口返回非 JSON：%s" % resp.text[:200])

            code = result.get("code")
            message = result.get("msg") or ""
            if code == 200:
                return result.get("data")
            if "验证" in message:
                raise CaptchaRequired(message)
            raise ApiError("接口错误 %s：%s" % (code, message))
        raise ApiError("请求失败：%s" % last_error)

    # ---------- 业务接口 ----------
    def init_license(self):
        data = self._request("/product/getInitData", {})
        if not data:
            raise ApiError("获取签名私钥失败")
        self.license_key = RSA.import_key(self._normalize_pem(data))

    def search_products(self, name=None, org=None, reg_code=None,
                        status=None, page=1, size=20):
        if size not in VALID_PAGE_SIZES:
            raise ValueError("pageSize 仅支持 10 / 20 / 50")
        payload = {"pageNum": page, "pageSize": size}
        if name:
            payload["prodName"] = name
        if org:
            payload["orgName"] = org
        if reg_code:
            payload["prodRegCode"] = reg_code
        if status:
            payload["prodStatus"] = status
        return self._request("/product/getProductList", payload)

    def get_detail(self, reg_code):
        return self._request("/product/getProductDetail", {"prodRegCode": reg_code})

    def get_net_value_list(self, reg_code, share_code="", time_type="1",
                           page=1, size=10):
        if size not in VALID_PAGE_SIZES:
            raise ValueError("pageSize 仅支持 10 / 20 / 50")
        return self._request(
            "/product/getNetValueList",
            {
                "subShareCode": share_code,
                "timeType": time_type,
                "prodRegCode": reg_code,
                "pageNum": page,
                "pageSize": size,
            },
        )


def fetch_net_values(client, reg_code, share_code=None, time_type="1", size=10):
    """返回 (产品基础信息, 净值记录列表, 份额代码列表)。"""
    basic = {}
    shares = []
    net_vo = {}
    detail_error = None

    if not share_code:
        try:
            detail = client.get_detail(reg_code) or {}
            basic = detail.get("prodBasicInfoVo") or {}
            net_vo = detail.get("productTypeNetValueVo") or {}
            shares = [
                s.get("subShareCode")
                for s in (net_vo.get("subShareList") or [])
                if s.get("subShareCode")
            ]
        except CaptchaRequired as exc:
            # 详情接口被验证拦截时，仍可凭份额代码直接查询净值
            detail_error = exc

    if share_code:
        share_codes = [share_code]
    elif shares:
        share_codes = shares
    else:
        share_codes = [net_vo.get("defaultSubShareCode") or ""]

    records = []
    for code in share_codes:
        if not code:
            continue
        page = 1
        total = None
        fetched = 0
        while True:
            data = client.get_net_value_list(reg_code, code, time_type, page, size) or {}
            rows = data.get("list") or []
            if total is None:
                total = data.get("total") or 0
            records.extend(rows)
            fetched += len(rows)
            if not rows or fetched >= total:
                break
            page += 1
            if page > 500:
                break

    if not records:
        # 部分产品无法按份额代码分页查询，但详情接口会带回完整净值曲线
        records = net_vo.get("netValueLine") or []

    if not records and detail_error is not None:
        raise detail_error

    records.sort(key=lambda r: (r.get("netValueDate") or "", r.get("subShareCode") or ""))
    return basic, records, shares


def row_to_dict(item, basic):
    return {
        "净值日期": item.get("netValueDate"),
        "份额代码": item.get("subShareCode"),
        "份额净值": item.get("shareNetVal"),
        "份额累计净值": item.get("acumltNetVal"),
        "资产净值": item.get("astNetVal"),
        "七日年化收益率(%)": item.get("yieldSevenDay"),
        "每万份收益": item.get("yieldPerMyriad"),
        "认购价格": item.get("priceBuy"),
        "赎回价格": item.get("priceRedeem"),
        "币种": item.get("currency"),
        "产品名称": basic.get("prodName") or item.get("prodName"),
        "产品登记编码": item.get("prodRegCode"),
    }


def write_csv(path, rows):
    if not rows:
        return
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def cmd_netvalue(args):
    client = ChinaWealthClient(delay=args.delay)
    client.init_license()
    basic, records, shares = fetch_net_values(
        client, args.code, args.share, args.time_type, args.page_size
    )
    if not records:
        print("未查询到净值记录（产品可能尚未成立或尚未披露净值）。")
        if basic.get("prodName"):
            print("产品：%s（%s）状态信息请以网站为准。" % (basic["prodName"], args.code))
        return 0

    rows = [row_to_dict(item, basic) for item in records]
    product_name = basic.get("prodName") or rows[0].get("产品名称") or args.code
    print("产品：%s" % product_name)
    print("登记编码：%s" % args.code)
    if shares:
        print("份额代码：%s" % ", ".join(shares))
    print("净值记录：%d 条（%s ~ %s）" % (len(rows), rows[0]["净值日期"], rows[-1]["净值日期"]))

    if args.format == "json":
        output = json.dumps(rows, ensure_ascii=False, indent=2)
    else:
        output = "\n".join(
            "%s\t%s\t%s\t%s" % (r["净值日期"], r["份额代码"], r["份额净值"], r["份额累计净值"])
            for r in rows
        )
    if args.out:
        if args.format == "json":
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(output)
        else:
            write_csv(args.out, rows)
        print("已导出：%s" % args.out)
    else:
        print(output)
    return 0


def cmd_list(args):
    client = ChinaWealthClient(delay=args.delay)
    client.init_license()
    data = client.search_products(
        name=args.name, org=args.org, reg_code=args.reg_code,
        status=args.status, page=args.page, size=args.size,
    ) or {}
    items = data.get("list") or []
    if not items:
        print("没有匹配的产品。")
        return 0
    print("共 %s 条，当前第 %s 页：" % (data.get("total"), args.page))
    for item in items:
        print(
            "%s | %s | %s | %s | 单位净值:%s | 累计净值:%s"
            % (
                item.get("prodRegCode"),
                item.get("prodName"),
                item.get("orgName"),
                item.get("prodStatusName"),
                item.get("prodNetVal") or "-",
                item.get("accumltNetVal") or "-",
            )
        )
    if args.out:
        with open(args.out, "w", newline="", encoding="utf-8-sig") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(items[0].keys()))
            writer.writeheader()
            writer.writerows(items)
        print("已导出：%s" % args.out)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        description="抓取中国理财网理财产品净值（仅供非商业用途）"
    )
    parser.add_argument("--delay", type=float, default=1.5, help="请求间隔秒数，默认 1.5")
    sub = parser.add_subparsers(dest="command", required=True)

    nv = sub.add_parser("netvalue", help="按产品登记编码抓取净值")
    nv.add_argument("--code", required=True, help="产品登记编码，如 Z7001025001229")
    nv.add_argument("--share", help="份额代码，不填则抓取全部份额")
    nv.add_argument("--time-type", default="1", help="净值类型参数，默认 1")
    nv.add_argument("--page-size", type=int, default=10, choices=VALID_PAGE_SIZES)
    nv.add_argument("--format", choices=["csv", "json", "table"], default="table")
    nv.add_argument("--out", help="导出文件路径（csv/json）")
    nv.set_defaults(func=cmd_netvalue)

    ls = sub.add_parser("list", help="按名称/机构/登记编码搜索产品")
    ls.add_argument("--name", help="产品名称关键字")
    ls.add_argument("--org", help="发行机构关键字")
    ls.add_argument("--reg-code", help="产品登记编码")
    ls.add_argument("--status", help="产品状态代码，如 02 募集、03 存续")
    ls.add_argument("--page", type=int, default=1)
    ls.add_argument("--size", type=int, default=20, choices=VALID_PAGE_SIZES)
    ls.add_argument("--out", help="导出 CSV 路径")
    ls.set_defaults(func=cmd_list)
    return parser


def main():
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except CaptchaRequired:
        print(
            "触发网站人机验证：同一 IP 的查询次数过多。\n"
            "处理方式：\n"
            "  1) 已知份额代码时，加 --share <份额代码> 直接抓净值（不经过详情接口）；\n"
            "  2) 等待一段时间后重试；或\n"
            "  3) 用浏览器打开 https://xinxipilu.chinawealth.com.cn/queryMenu/prodType，\n"
            "     手动完成验证并搜索产品，复制“产品登记编码”后再抓取。",
            file=sys.stderr,
        )
        return 2
    except (ApiError, ValueError) as exc:
        print("失败：%s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
