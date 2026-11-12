"""仅刷新新品候选清单（不写 library.js），用于查漏补缺比对。"""
import sys
from argparse import Namespace
from datetime import datetime

sys.path.insert(0, r"C:\Users\luomeiting\Documents\Trae-CN\default\wealth-3-products\daily")

from build_library import collect  # noqa: E402

if __name__ == "__main__":
    t0 = datetime.now()
    items = collect(Namespace(days=112, max_pages=430, limit=400, gap=0.4))
    print("候选 %d 条，用时 %s" % (len(items), datetime.now() - t0), flush=True)
