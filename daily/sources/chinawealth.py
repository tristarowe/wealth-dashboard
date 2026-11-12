"""中国理财网兜底净值（按登记编码 + 份额代码）。"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "chinawealth_nv.py"


def _fetch_rows(reg_code, share_code):
    """调用抓取脚本，返回该份额的净值记录（按日期升序）。"""
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "nv.json"
        cmd = [sys.executable, str(SCRIPT), "netvalue", "--code", reg_code]
        if share_code:
            cmd += ["--share", share_code]
        cmd += ["--format", "json", "--out", str(out)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=240,
                              encoding="utf-8", errors="replace")
        if proc.returncode != 0 or not out.exists():
            raise RuntimeError((proc.stderr or proc.stdout or "抓取失败").strip()[-300:])
        rows = json.loads(out.read_text(encoding="utf-8"))

    rows = [r for r in rows if r.get("份额净值")]
    if share_code:
        rows = [r for r in rows if r.get("份额代码") == share_code]
    elif rows:
        # 未指定份额时，选择记录最多、日期最新的份额
        groups = {}
        for r in rows:
            groups.setdefault(r.get("份额代码", ""), []).append(r)
        best = max(groups.values(), key=lambda g: (max(x["净值日期"] for x in g), len(g)))
        rows = best

    rows.sort(key=lambda r: r["净值日期"])
    dedup = {}
    for r in rows:
        dedup[r["净值日期"]] = r
    return [dedup[k] for k in sorted(dedup)]


def fetch(params, start, end):
    rows = _fetch_rows(params["regCode"], params.get("shareCode") or "")
    out = [{"date": r["净值日期"], "nav": float(r["份额净值"])} for r in rows]
    return [r for r in out if start <= r["date"] <= end]
