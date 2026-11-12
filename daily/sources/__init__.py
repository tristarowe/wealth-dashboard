"""净值数据源适配器集合。

每个适配器暴露 fetch(params, start, end) -> [{"date": "YYYY-MM-DD", "nav": float}]。
统一由 fetch_data.py 按产品配置的优先级合并。
"""
import importlib

LABELS = {
    "ccb": "建设银行代销净值",
    "bocom": "交银理财官网",
    "ceb": "光大理财官网",
    "boc": "中银理财官网",
    "chinawealth": "中国理财网",
}


def fetch(name, params, start, end):
    module = importlib.import_module("." + name, __package__)
    return module.fetch(params or {}, start, end)


def label(name):
    return LABELS.get(name, name)
