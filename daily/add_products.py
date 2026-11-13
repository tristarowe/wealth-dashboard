"""把清单里的产品补进产品库（支持按产品名检索登记编码，或直接指定登记编码/建信 ecd）。

用法示例：
  python daily/add_products.py --name "招银理财招睿添利日开25号固定收益类理财计划" --reg Z7001626000675
  python daily/add_products.py --name "建信理财嘉鑫（数字人民币专享）固收类最低持有30天产品" \
      --reg Z7000722001276 --ecd JXJXZDCY30D111001 --org "建信理财有限责任公司" --risk R2

抓不到净值时仍会先占位入库（无净值），后续 nav_rotate 会继续补。
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nav_bulk  # noqa: E402
import nav_official  # noqa: E402
import promote_newproducts as promo  # noqa: E402


def search_reg(name):
    import chinawealth_nv as cw

    client = cw.ChinaWealthClient(delay=2.5)
    client.init_license()
    data = client.search_products(name=name, size=50) or {}
    rows = data.get("list") or []
    if not rows:
        return None
    for it in rows:
        prod = (it.get("prodName") or "").strip()
        if prod == name or name in prod or prod in name:
            return {
                "reg": (it.get("prodRegCode") or "").strip(),
                "name": prod,
                "org": (it.get("orgName") or "").strip(),
                "risk": (it.get("riskLevel") or it.get("riskLevelName") or "").strip(),
            }
    print("  候选：", [it.get("prodName") for it in rows[:8]], flush=True)
    return None


def short_of(name, org_short):
    s = name
    for pre in (org_short, org_short.replace("理财", "")):
        if pre and s.startswith(pre):
            s = s[len(pre):]
            break
    for tail in ("理财产品", "理财计划", "产品"):
        if s.endswith(tail):
            s = s[: -len(tail)]
    return s.strip(" -_") or name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--reg", default="")
    ap.add_argument("--org", default="")
    ap.add_argument("--ecd", default="")
    ap.add_argument("--risk", default="")
    ap.add_argument("--sale", default="")
    a = ap.parse_args()

    lib = promo.load_json(promo.LIB_JSON, {"items": []})
    items = lib.get("items") or []
    reg = a.reg.strip()
    name = a.name.strip()
    org = a.org.strip()
    risk = a.risk.strip()

    if not reg:
        hit = search_reg(name)
        if not hit:
            print("未检索到登记编码：%s" % name, flush=True)
            return 1
        reg, name = hit["reg"], hit["name"]
        org = org or hit["org"]
        risk = risk or hit["risk"]

    exist = next((x for x in items if str(x.get("regCode")) == reg), None)

    rows = []
    if a.ecd:
        rows = nav_official.chart_rows(a.ecd)
    else:
        try:
            rows, meta = nav_bulk.fetch(reg)
            risk = risk or (meta or {}).get("risk") or ""
            org = org or (meta or {}).get("org") or ""
        except Exception as exc:
            print("  净值抓取失败：%s" % str(exc)[:120], flush=True)

    if exist is not None:
        if not rows:
            print("已在产品库且暂无新净值：%s %s" % (reg, exist.get("name")), flush=True)
            return 0
        fresh = promo.to_item({"regCode": reg, "name": exist.get("name") or name,
                               "short": exist.get("short") or short_of(name, ""),
                               "org": exist.get("org") or org, "risk": exist.get("risk") or risk,
                               "saleChannel": exist.get("saleChannel") or a.sale}, rows)
        exist.update({k: fresh[k] for k in ("dates", "nav", "per10k", "latestDate", "latestNav")})
        exist["inception"] = exist.get("inception") or fresh["inception"]
        promo.save(items)
        print("已补净值：%s %s | 共 %d 条 | 最新 %s"
              % (reg, exist.get("name"), len(rows), rows[-1]["date"]), flush=True)
        promo.commit_in_ci()
        return 0

    org = org or ""
    org_short = promo._org_short(org)
    p = {
        "regCode": reg,
        "name": name,
        "short": short_of(name, org_short),
        "org": org,
        "risk": risk,
        "saleChannel": a.sale,
        "inception": rows[0]["date"] if rows else "",
    }
    item = promo.to_item(p, rows)
    items.append(item)
    promo.save(items)
    print("已入库：%s %s | 净值 %d 条 | 最新 %s"
          % (reg, item["name"], len(item["dates"]), item["latestDate"] or "无"), flush=True)
    promo.commit_in_ci()
    return 0


if __name__ == "__main__":
    sys.exit(main())
