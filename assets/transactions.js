/* 交易底稿：来源为用户提供的 4 张交易详情截图（金额、申请日、确认日均为截图原值）。
 * 份额 = 购买金额 ÷ 确认净值；新发产品按初始面值 1.000000 确认。
 * 交易类型统一为：申购 / 赎回 / 清仓；全部由人工录入维护。
 * 净值与万收来自 assets/data.js，不在此文件重复存储。
 */
window.TRANSACTIONS = {
  "asOf": "2026-11-10",
  "items": [
    {
      "id": "TX2026082002",
      "pid": "p2218",
      "type": "申购",
      "applyDate": "2026-08-20",
      "confirmDate": "2026-08-25",
      "amount": 23503.52,
      "confirmNav": 1,
      "status": "已确认",
      "saleChannel": "建设银行",
      "source": "人工录入 · 申购 23,503.52 元"
    },
    {
      "id": "TX2026082501",
      "pid": "p1090",
      "type": "申购",
      "applyDate": "2026-08-25",
      "confirmDate": "2026-08-26",
      "amount": 26000,
      "confirmNav": 1,
      "status": "已确认",
      "saleChannel": "建设银行",
      "source": "人工录入 · 申购 26,000.00 元"
    },
    {
      "id": "TX2026092903",
      "pid": "p0157",
      "type": "申购",
      "applyDate": "2026-09-29",
      "confirmDate": "2026-09-30",
      "amount": 22222,
      "confirmNav": 1.018889,
      "status": "已确认",
      "saleChannel": "建设银行",
      "source": "人工录入 · 申购 22,222.00 元"
    },
    {
      "id": "TX2026110401",
      "pid": "LZ7005126000175",
      "type": "申购",
      "applyDate": "2026-11-03",
      "confirmDate": "2026-11-04",
      "amount": 10000,
      "shares": 9982.03,
      "confirmNav": 1.0018,
      "saleChannel": "建设银行",
      "status": "已确认",
      "source": "人工录入"
    },
    {
      "id": "TX2026111002",
      "pid": "p2150",
      "type": "申购",
      "applyDate": "2026-11-05",
      "confirmDate": "2026-11-06",
      "amount": 10000,
      "shares": 9997,
      "confirmNav": 1.0003,
      "saleChannel": "建设银行",
      "status": "已确认",
      "source": "人工录入"
    },
    {
      "id": "TX2026110901",
      "pid": "LZ7005126000175",
      "type": "清仓",
      "applyDate": "2026-11-06",
      "confirmDate": "2026-11-09",
      "amount": 10000,
      "shares": 9982.03,
      "confirmNav": 1.0018,
      "saleChannel": "建设银行",
      "status": "已确认",
      "source": "人工录入"
    },
    {
      "id": "TX2026111001",
      "pid": "p2218",
      "type": "申购",
      "applyDate": "2026-11-09",
      "confirmDate": "2026-11-10",
      "amount": 1007,
      "shares": 1000,
      "confirmNav": 1.007,
      "saleChannel": "建设银行",
      "status": "已确认",
      "source": "人工录入"
    },
    {
      "id": "TX2026111003",
      "pid": "p1090",
      "type": "赎回",
      "applyDate": "2026-11-09",
      "confirmDate": "2026-11-10",
      "amount": 10000,
      "shares": 9951.24,
      "confirmNav": 1.0049,
      "saleChannel": "建设银行",
      "status": "已确认",
      "source": "人工录入"
    },
    {
      "id": "TX2026111004",
      "pid": "p2150",
      "type": "申购",
      "applyDate": "2026-11-09",
      "confirmDate": "2026-11-10",
      "amount": 10000,
      "shares": 9997,
      "confirmNav": 1.0003,
      "saleChannel": "建设银行",
      "status": "已确认",
      "source": "人工录入"
    },
    {
      "id": "TX2026111101",
      "pid": "LZ7000726002174",
      "type": "申购",
      "applyDate": "2026-11-10",
      "confirmDate": "2026-11-11",
      "amount": 10000,
      "shares": 9935.23,
      "confirmNav": 1.006519,
      "saleChannel": "建设银行",
      "status": "已确认",
      "source": "人工录入"
    },
    {
      "id": "TX2026111201",
      "pid": "p1090",
      "type": "申购",
      "applyDate": "2026-11-11",
      "confirmDate": "2026-11-12",
      "amount": 10049,
      "shares": 10000,
      "confirmNav": 1.0049,
      "saleChannel": "建设银行",
      "status": "已确认",
      "source": "人工录入"
    },
    {
      "id": "TX2026111202",
      "pid": "LZ7000726001958",
      "type": "申购",
      "applyDate": "2026-11-11",
      "confirmDate": "2026-11-12",
      "amount": 20000,
      "shares": 19910.92,
      "confirmNav": 1.004474,
      "saleChannel": "建设银行",
      "status": "已确认",
      "source": "人工录入"
    }
  ]
};
