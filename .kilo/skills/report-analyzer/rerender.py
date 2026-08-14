#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rerender.py — 报告重渲染工具(离线模式)
==========================================

对已有 records JSON(抓取导出/历史缓存)重新回算统计并渲染 HTML 报告,
不经过 AdsPower + Playwright 抓取。与 report-analyzer.py 共用同一套
统计/渲染管线(calculate_stats / generate_html_report / write_html),
保证 rerender 结果与在线模式完全一致。

典型用法
--------
  # 1) 先用 report-analyzer 在线抓取并导出记录 JSON:
  #    python report-analyzer.py --members 全员 --start-date 2026-07-01 \
  #        --end-date 2026-07-31 --output records-2026-07.json

  # 2) 对已有 JSON 回算 + 重渲染 HTML:
  python rerender.py --input records-2026-07.json --html report-2026-07.html

  # 3) v2.0 老 JSON 自动回补 project-metadata/快照/编制字段(--no-backfill-v2 关闭):
  python rerender.py --input old.json --html new.html --project-metadata project-metadata.json

兼容输入形态(load_records_from_json):
  1) 顶层数组                                    —— record 列表
  2) {"records": [...]}                         —— 包裹形态
  3) {"statistics": {"records": [...]}}         —— report-analyzer --output 产物

v2.0 差异
---------
- 默认开启字段回算(backfill v2.0 增量字段);--no-backfill-v2 保持旧字段原样
- 三数据源:--project-metadata / --monthly-snapshot-dir / --headcount-target
- --no-cache:忽略同目录缓存,强制全量重算(预留;当前实现恒全量重算)
"""

import argparse
import importlib.util
import logging
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
LOG = logging.getLogger("rerender")

# ---------------------------------------------------------------------
# 加载同目录 report-analyzer.py(文件名含连字符,不能直接 import;
# 用 importlib 从文件路径加载,复用统计/渲染/回算管线)
# ---------------------------------------------------------------------
_RA_PATH = Path(__file__).resolve().parent / "report-analyzer.py"
_spec = importlib.util.spec_from_file_location("report_analyzer", _RA_PATH)
RA = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(RA)  # noqa: 执行模块级定义(常量/函数/解析器)


def build_arg_parser() -> argparse.ArgumentParser:
    """构造 rerender CLI 解析器。"""
    parser = argparse.ArgumentParser(
        prog="rerender",
        description="对已有 records JSON 回算统计并重新渲染 HTML(离线,无抓取)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  python rerender.py --input records.json --html report.html\n"
            "  python rerender.py --input records.json --json-out stats.json --html report.html\n"
            "  python rerender.py --input old.json --html new.html --no-backfill-v2\n"
        ),
    )
    parser.add_argument(
        "--input", required=True,
        help="输入 records JSON 路径(数组 / {records} / {statistics.records})",
    )
    parser.add_argument(
        "--json-out", default=None,
        help="输出回算后的统计 JSON(默认: 不写)",
    )
    parser.add_argument(
        "--html", default=None,
        help="输出重渲染 HTML 路径(默认: report-{start}_to_{end}.html)",
    )
    parser.add_argument(
        "--no-backfill-v2", action="store_true",
        help="跳过 v2.0 字段回算(project-metadata/月度快照/编制缺口)",
    )
    parser.add_argument(
        "--no-cache", action="store_true",
        help="忽略缓存强制全量重算(预留开关;当前实现恒全量重算)",
    )
    parser.add_argument(
        "--project-metadata", default=None,
        help="project-metadata.json 路径(v2.0,默认 report-analyzer 同目录)",
    )
    parser.add_argument(
        "--monthly-snapshot-dir", default=None,
        help="月度快照目录(v2.0,默认 ./monthly-snapshots/)",
    )
    parser.add_argument(
        "--headcount-target", default=None,
        help="headcount-target.json 路径(v2.0,默认 report-analyzer 同目录)",
    )
    parser.add_argument(
        "--quiet", "-q", action="store_true",
        help="不打印终端摘要(仅写文件)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="输出 DEBUG 日志",
    )
    return parser


def main(argv=None) -> int:
    """rerender 主入口:load_records_from_json → rerender_from_records_path。"""
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    LOG.info("%s rerender %s 启动(离线模式)", RA.APP_NAME, RA.APP_VERSION)
    if args.no_cache:
        LOG.info("--no-cache: 忽略缓存,强制全量重算")
    try:
        stats, paths, meta = RA.rerender_from_records_path(
            records_path=args.input,
            project_metadata=RA.load_project_metadata(args.project_metadata),
            monthly_snapshots=RA.load_monthly_snapshots(args.monthly_snapshot_dir),
            headcount_target=RA.load_headcount_target(args.headcount_target),
            no_backfill=args.no_backfill_v2,
            json_out=args.json_out,
            html_out=args.html,
            quiet=args.quiet,
        )
    except ValueError as exc:
        LOG.error(str(exc))
        return 2
    if stats is None:
        return 1
    LOG.info("rerender 完成: JSON=%s HTML=%s", paths.get("json"), paths.get("html"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
