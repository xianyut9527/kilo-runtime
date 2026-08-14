#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
report-analyzer.py — 项目成员工作报告分析工具 v2.0
====================================================

功能总览
--------
通过 AdsPower 本地 API + Playwright(CDP)自动抓取仓颉系统(cangjie.icinfo.cn)
日报数据,按「成员 × 项目」维度统计工时(总工时/工作·加班拆分/日均/超载率),
输出:
  1) 终端摘要(默认)
  2) 结构化 JSON(--output)
  3) 可交互 HTML 周报(--html,9 大 Section + ECharts 5.5)

v2.0 新特性
-----------
- 5 角色体系(交付/产品/测试/开发/实施),dev 自动归集未分配成员
- 9 Section HTML:项目总览 / 项目明细 / 成员总览 / 贡献矩阵 / 岗位占比 /
  工时矩阵 / 项目交付情况总览 / 项目状态分桶 / 交付中心人力资源
- 三数据源驱动:project-metadata.json / monthly-snapshots/ / headcount-target.json
- 风险评分 4 因子加权(进度偏差/加班强度/人员缺口/紧迫度)
- 完成% 三段(上月快照 → 本月 → 预计)与增量
- --no-backfill-v2 可跳过 v2.0 字段回算

抓取架构
--------
AdsPower API(127.0.0.1:50325) → 发现活跃浏览器 ws/CDP 端点
  → Playwright connect_over_cdp 复用已打开页面(登录态已就绪)
  → 仓颉日报页(.my-tree-select 单选树逐个切换成员)
  → 等待 el-loading-mask 消失 → TreeWalker 局部提取记录
  → 按日期范围过滤 → 返回 [{date, name, project, content, hours}, ...]

历史反模式(本文件已规避)
------------------------
[REPORT_ANTI_PATTERN_STAGE_PREFIX_MISSED]   阶段前缀剥离后再归并
[REPORT_ANTI_PATTERN_NO_PHASE2_MERGE]       引号/全角归一化后再归并
[REPORT_ANTI_PATTERN_NO_NAME_MATCH]         匹配不上归入"其他"桶而非丢弃
[REPORT_ANTI_PATTERN_ALIAS_ORDER]           alias 最长优先,短 alias 不吞长名
[REPORT_ANTI_PATTERN_OVERTIME_THRESHOLD_CONFUSION] 7.5(公司预期)与 8.0(劳动法)解耦

版本记录
--------
v1.0 (7/17) 创建:AdsPower + Playwright 抓取仓颉日报,成员/项目维度工时统计
v1.3         报告改版:ECharts 交互饼图、双向联动、项目名完整保留、--force-reload
v1.9         项目卡片岗位分布、风险/正常判定雏形、数据源加载入口
v2.0         5 角色 + 9 Section + 三数据源 + 风险评分 4 因子 + 回算
"""

# =====================================================================
# 标准库
# =====================================================================
import argparse
import calendar
import datetime as _dt
import json
import logging
import math
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

# =====================================================================
# 第三方依赖(requests / playwright 为硬依赖;json5 可选降级)
# =====================================================================
import requests  # noqa: E402  AdsPower 本地 API 调用

from playwright.sync_api import sync_playwright  # noqa: E402  CDP 复用浏览器

try:  # json5 允许注释/尾逗号的项目元数据,未安装时降级 stdlib json
    import json5  # type: ignore
except ImportError:  # pragma: no cover
    json5 = None  # type: ignore

# =====================================================================
# 日志
# =====================================================================
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
LOG = logging.getLogger("report-analyzer")

# =====================================================================
# 应用元信息
# =====================================================================
APP_NAME = "report-analyzer"
APP_VERSION = "v2.0"
APP_DESCRIPTION = (
    "项目成员工作报告分析工具 %s —— AdsPower + Playwright 抓取仓颉日报,"
    "工时统计 + 9 Section HTML 周报" % APP_VERSION
)

# =====================================================================
# AdsPower 本地 API(默认端口 50325)
# =====================================================================
ADSPOWER_HOST = "127.0.0.1"
ADSPOWER_PORT = 50325
ADSPOWER_API_BASE = "http://%s:%d" % (ADSPOWER_HOST, ADSPOWER_PORT)
ADSPOWER_STATUS_URL = "%s/status" % ADSPOWER_API_BASE
ADSPOWER_LOCAL_ACTIVE_URL = "%s/api/v1/browser/local-active" % ADSPOWER_API_BASE
ADSPOWER_OPEN_URL = "%s/api/v1/browser/start" % ADSPOWER_API_BASE
ADSPOWER_STOP_URL = "%s/api/v1/browser/stop" % ADSPOWER_API_BASE
ADSPOWER_TIMEOUT = 10        # 秒,API 请求超时
ADSPOWER_RETRIES = 2         # 活跃浏览器探测失败重试次数
ADSPOWER_RETRY_DELAY = 2.0   # 秒,重试间隔

# =====================================================================
# 仓颉系统
# =====================================================================
CANGJIE_BASE = "https://cangjie.icinfo.cn"
CANGJIE_REPORT_URL = "%s/target-manage/work/report" % CANGJIE_BASE
CANGJIE_LOADING_SELECTOR = ".el-loading-mask"           # 异步加载遮罩
CANGJIE_TREE_SELECT_SELECTOR = ".my-tree-select"        # 成员单选树组件
CANGJIE_TREE_NODE_SELECTOR = ".el-tree-node__content"   # 树节点
CANGJIE_CONFIRM_SELECTORS = (                          # "确定"按钮候选
    ".my-tree-select .el-button--primary",
    ".my-tree-select button.el-button--primary",
    ".my-tree-select .el-button",
    "button:has-text('确定')",
    ".my-tree-select__footer button",
)
CANGJIE_PAGE_TITLE = "工作日报"   # 登录态校验参考标题

# =====================================================================
# 工时口径(v2.0 解耦)
# =====================================================================
STANDARD_DAILY_HOURS = 7.5          # 公司预期工时(overPct 超载/欠量判断)
OVERTIME_DAILY_THRESHOLD = 8.0      # 劳动法 8h 工作制(加班风险告警)
MAX_HOURS_PER_RECORD = 24.0         # 单条日报耗时上限(异常值防御)
MIN_DAILY_HOURS = 0.25              # 单日最低有效工时(低于视为无效)

# =====================================================================
# 成员默认名单(14 人,"全员"= 此名单)
# =====================================================================
ALL_V19_MEMBERS = [
    "邓佳辉", "郭浩成", "贺明阳", "黄彬洋", "胡阳", "蒋番", "刘成锐",
    "罗贵川", "秦琪森", "任志勇", "谭飞", "田于", "王海关", "姚东甫",
]
DEFAULT_MEMBERS_TOKEN = "全员"

# =====================================================================
# 角色体系(5 ROLES,v2.0)
#   dev 自动 = 全体成员 - 已登记角色;未登记成员归 dev
# =====================================================================
ROLES = {
    "delivery": frozenset({"邓佳辉", "秦琪森"}),   # 交付经理
    "product": frozenset({"罗贵川", "胡阳"}),     # 产品经理
    "test": frozenset({"王海关"}),                # 测试
    "implement": frozenset(),                     # 实施 — 由用户填入
    # dev 自动 = 全员 - 上述(不显式列出)
}
ROLE_ORDER = ("delivery", "product", "test", "dev", "implement")
ROLE_LABELS = {
    "delivery": "交付经理",
    "product": "产品经理",
    "test": "测试",
    "dev": "研发",
    "implement": "实施",
}
ROLE_COLORS = {
    "delivery": "#6366f1",  # indigo
    "product": "#a855f7",   # purple
    "test": "#f59e0b",      # amber
    "dev": "#10b981",       # emerald
    "implement": "#f43f5e", # rose
}
DEV_ROLE = "dev"

# =====================================================================
# 项目识别与归并(v2.0)
# =====================================================================
STAGE_PREFIXES = (
    "项目开发阶段-",
    "订单跟进阶段-",
    "项目运维阶段-",
    "项目售前阶段-",
)
KNOWN_PROJECTS = {
    "重庆市司法局执法+监督集成数字应用项目",
    "成都市\"一码检查\"",
    "重庆市电子证照库建设项目（二期）",
    "北碚区涉刑移送案件执法监管一件事",
}
PROJECT_ALIASES = {
    "司法局": "重庆市司法局执法+监督集成数字应用项目",
    "一码检查": "成都市\"一码检查\"",
    "电子证照库": "重庆市电子证照库建设项目（二期）",
    "涉刑移送": "北碚区涉刑移送案件执法监管一件事",
}
NON_PROJECT_BUCKET = "其他"
NON_PROJECT_MIN_MEMBERS = 3

# =====================================================================
# v2.0 数据源默认路径
# =====================================================================
DEFAULT_PROJECT_METADATA = "project-metadata.json"
DEFAULT_MONTHLY_SNAPSHOT_DIR = "monthly-snapshots"
DEFAULT_HEADCOUNT_TARGET = "headcount-target.json"

# =====================================================================
# 日期/输出
# =====================================================================
DATE_FORMAT = "%Y-%m-%d"
DATE_DISPLAY_FORMAT = "%Y年%m月%d日"
REPORT_JSON_TEMPLATE = "report-{start}_to_{end}.json"
REPORT_HTML_TEMPLATE = "report-{start}_to_{end}.html"

# =====================================================================
# 文本归一化与项目识别(归并前必过,反模式 NO_PHASE2_MERGE / STAGE_PREFIX_MISSED)
# =====================================================================
_FULLWIDTH_SPACE = "\u3000"
_CJK_QUOTES = {
    "\u201c": '"',  # “ ”
    "\u201d": '"',
    "\u2018": "'",  # ‘ ’
    "\u2019": "'",
}
_FULLWIDTH_MAP = {chr(c): chr(c - 0xFEE0) for c in range(0xFF01, 0xFF5F)}


def normalize_project_name(name: str) -> str:
    """统一引号/全角差异后返回规范项目名。

    历史反模式 [REPORT_ANTI_PATTERN_NO_PHASE2_MERGE]:
    同一项目因中文引号/全角字符差异被拆成多条统计。归一化必须在归并前完成。
    """
    if not name:
        return ""
    out = []
    for ch in name:
        if ch in _CJK_QUOTES:
            out.append(_CJK_QUOTES[ch])
        elif ch in _FULLWIDTH_MAP:
            out.append(_FULLWIDTH_MAP[ch])
        elif ch == _FULLWIDTH_SPACE:
            out.append(" ")
        else:
            out.append(ch)
    s = "".join(out)
    s = s.strip()
    s = re.sub(r"\s+", " ", s)
    return s


def strip_stage_prefix(name: str) -> str:
    """剥离阶段前缀(项目开发阶段- / 订单跟进阶段- ...)。

    反模式 [REPORT_ANTI_PATTERN_STAGE_PREFIX_MISSED]:
    同一项目不同阶段显示为不同项目。归并前剥离前缀。
    """
    for prefix in STAGE_PREFIXES:
        if name.startswith(prefix):
            return name[len(prefix):].strip()
    return name


def extract_top_level_project(full_name: str) -> str:
    """把日报计划内容映射为顶层项目名(匹配链:精确 → alias → name-based → 其他桶)。

    反模式 [REPORT_ANTI_PATTERN_NO_NAME_MATCH]:
    匹配不上不得丢弃,归入 NON_PROJECT_BUCKET 桶。

    反模式 [REPORT_ANTI_PATTERN_ALIAS_ORDER]:
    alias 匹配按最长优先,短 alias 不得吞长名。
    """
    if not full_name:
        return NON_PROJECT_BUCKET
    normalized = normalize_project_name(full_name)
    stripped = strip_stage_prefix(normalized)

    # 1) 精确匹配
    for known in KNOWN_PROJECTS:
        if stripped == known:
            return known

    # 2) alias 最长优先
    for alias in sorted(PROJECT_ALIASES, key=len, reverse=True):
        if alias in stripped:
            return PROJECT_ALIASES[alias]

    # 3) name-based(子串/包含)—— 长已知名优先
    for known in sorted(KNOWN_PROJECTS, key=len, reverse=True):
        if known in stripped:
            return known

    # 4) 其他桶(不丢弃)
    return NON_PROJECT_BUCKET


def get_role(member: str) -> str:
    """返回成员角色 key(5 角色之一,ROLE_ORDER)。未登记成员自动归 dev。"""
    for role in ROLE_ORDER:
        if role in ROLES and member in ROLES[role]:
            return role
    return DEV_ROLE


def get_role_label(role: str) -> str:
    return ROLE_LABELS.get(role, role)


# =====================================================================
# 日期与工作日工具
# =====================================================================
def parse_date(text: str) -> _dt.date:
    """解析 YYYY-MM-DD;也容忍 YYYY/M/D / YYYY年M月D日 等格式。"""
    text = str(text).strip()
    for fmt in (DATE_FORMAT, "%Y/%m/%d", "%Y-%m-%d %H:%M:%S", "%Y年%m月%d日"):
        try:
            return _dt.datetime.strptime(text[:19], fmt).date()
        except ValueError:
            continue
    raise ValueError("无法解析日期: %r" % text)


def format_date(d: _dt.date) -> str:
    return d.strftime(DATE_FORMAT)


def calculate_workdays(start: _dt.date, end: _dt.date) -> int:
    """计算 [start, end] 闭区间内工作日数(排除周六/周日)。"""
    if start > end:
        return 0
    days = 0
    cur = start
    while cur <= end:
        if cur.weekday() < 5:
            days += 1
        cur += _dt.timedelta(days=1)
    return days


def date_range(start: _dt.date, end: _dt.date):
    cur = start
    while cur <= end:
        yield cur
        cur += _dt.timedelta(days=1)


# =====================================================================
# AdsPower 本地 API(自动发现活跃浏览器 → CDP ws 端点)
# =====================================================================
def _adspower_request(url: str, method: str = "GET", params=None, timeout: int = ADSPOWER_TIMEOUT):
    """带超时/异常分类的 AdsPower API 请求。

    异常分类提示:API 不可达(未启动) / 返回非 0 状态码(未登录/浏览器未开)。
    """
    try:
        resp = requests.request(method, url, params=params, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.ConnectionError:
        raise RuntimeError(
            "AdsPower API 不可达(%s) —— 请确认 AdsPower 客户端已启动,"
            "且未修改默认端口 %d。" % (url, ADSPOWER_PORT)
        )
    except requests.exceptions.Timeout:
        raise RuntimeError("AdsPower API 请求超时(%s)" % url)
    except requests.exceptions.HTTPError as exc:
        raise RuntimeError("AdsPower API 返回错误: %s" % exc)


def get_browser_url(user_id: str = None) -> dict:
    """发现活跃浏览器环境,返回 CDP 连接信息。

    GET /api/v1/browser/local-active → {"code":0,"data":{"ws":..., "user_id":...}}

    重试 2 次 + 异常分类(未启动/未登录/API 不可达)。
    """
    params = {"user_id": user_id} if user_id else None
    last_err = None
    for attempt in range(1 + ADSPOWER_RETRIES):
        try:
            data = _adspower_request(ADSPOWER_LOCAL_ACTIVE_URL, params=params)
            if not data or data.get("code") != 0:
                raise RuntimeError(
                    "未发现活跃浏览器(code=%s)—— 请先在 AdsPower 中打开仓颉日报页并保持登录。"
                    % (data.get("code") if data else "N/A")
                )
            payload = data.get("data") or {}
            ws = payload.get("ws") or payload.get("cdp") or ""
            if not ws:
                raise RuntimeError("活跃浏览器缺少 ws/CDP 端点,请重启浏览器后重试。")
            LOG.info("AdsPower 发现活跃浏览器: user_id=%s", payload.get("user_id", user_id or "auto"))
            return {"ws": ws, "user_id": payload.get("user_id") or user_id}
        except Exception as exc:  # noqa: BLE001 —— 分类后重试
            last_err = exc
            if attempt < ADSPOWER_RETRIES:
                LOG.warning("AdsPower 探测失败(第 %d 次): %s", attempt + 1, exc)
                time.sleep(ADSPOWER_RETRY_DELAY)
    raise last_err


def open_browser(user_id: str = None) -> dict:
    """显式启动指定 AdsPower 环境(POST /api/v1/browser/start)。

    返回 {"ws": ..., "user_id": ...};启动失败时回退自动发现。
    """
    params = {"user_id": user_id} if user_id else {}
    try:
        data = _adspower_request(ADSPOWER_OPEN_URL, method="POST", params=params)
        if data and data.get("code") == 0:
            payload = data.get("data") or {}
            ws = payload.get("ws") or ""
            if ws:
                LOG.info("AdsPower 已启动浏览器: user_id=%s", user_id)
                return {"ws": ws, "user_id": user_id}
    except Exception as exc:  # noqa: BLE001
        LOG.warning("AdsPower start 失败,回退自动发现: %s", exc)
    return get_browser_url(user_id)

# =====================================================================
# argparse CLI(v2.0)
# =====================================================================
def build_arg_parser() -> argparse.ArgumentParser:
    """构造命令行解析器(含 v2.0 全部参数)。"""
    parser = argparse.ArgumentParser(
        prog=APP_NAME,
        description=APP_DESCRIPTION,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  python report-analyzer.py --members 全员 --start-date 2026-07-01 "
            "--end-date 2026-07-31 --html report.html\n"
            "  python report-analyzer.py --members 田于,郭浩成 --start-date 2026-07-01 "
            "--end-date 2026-07-17 --output report.json\n"
            "  python report-analyzer.py --members 全员 --start-date 2026-07-01 "
            "--end-date 2026-07-31 --html report.html --no-backfill-v2\n"
        ),
    )
    parser.add_argument(
        "--members", default=DEFAULT_MEMBERS_TOKEN,
        help="成员名单,逗号/分号分隔;'%s' = 默认 %d 人" % (DEFAULT_MEMBERS_TOKEN, len(ALL_V19_MEMBERS)),
    )
    parser.add_argument(
        "--start-date", default=None,
        help="开始日期 YYYY-MM-DD(默认:本月 1 日)",
    )
    parser.add_argument(
        "--end-date", default=None,
        help="结束日期 YYYY-MM-DD(默认:今天)",
    )
    parser.add_argument(
        "--output", default=None,
        help="输出结构化统计 JSON 路径(默认: report-{start}_to_{end}.json)",
    )
    parser.add_argument(
        "--html", default=None,
        help="输出可交互 HTML 周报路径(9 大 Section + ECharts)",
    )
    parser.add_argument(
        "--no-backfill-v2", action="store_true",
        help="跳过 v2.0 字段回算(project-metadata/月度快照/编制缺口)",
    )
    parser.add_argument(
        "--config", default=None,
        help="配置文件路径(members/adspowerUserId)",
    )
    parser.add_argument(
        "--adspower-user-id", default=None,
        help="指定 AdsPower 环境 ID(多环境时使用;缺省自动发现)",
    )
    parser.add_argument(
        "--force-reload", action="store_true",
        help="每次切换成员前强制整页刷新(~3s/人,100%% 成功率)",
    )
    parser.add_argument(
        "--simplify-project", action="store_true",
        help="项目名截断为前两段(旧行为;默认完整保留)",
    )
    parser.add_argument(
        "--project-metadata", default=None,
        help="project-metadata.json 路径(v2.0,默认同目录)",
    )
    parser.add_argument(
        "--monthly-snapshot-dir", default=None,
        help="月度快照目录(v2.0,默认 ./monthly-snapshots/)",
    )
    parser.add_argument(
        "--headcount-target", default=None,
        help="headcount-target.json 路径(v2.0,默认同目录)",
    )
    parser.add_argument(
        "--from-json", default=None,
        help="离线入口:从本地 records JSON 直接生成报告(跳过 AdsPower/Playwright 抓取)",
    )
    parser.add_argument(
        "--json-only", action="store_true",
        help="仅输出 JSON,跳过 HTML 渲染(与 --html 同用时后者优先)",
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


def parse_members_arg(members_arg: str) -> list:
    """解析 --members:逗号/分号分隔;'全员' → 默认 14 人。"""
    if not members_arg:
        return list(ALL_V19_MEMBERS)
    text = str(members_arg).strip()
    if text == DEFAULT_MEMBERS_TOKEN:
        return list(ALL_V19_MEMBERS)
    parts = re.split(r"[,;，；\s]+", text)
    return [p.strip() for p in parts if p.strip()]


def resolve_dates(start_text, end_text):
    """解析日期范围;缺省:本月 1 日 ~ 今天。"""
    today = _dt.date.today()
    end = parse_date(end_text) if end_text else today
    if start_text:
        start = parse_date(start_text)
    else:
        start = _dt.date(end.year, end.month, 1)
    if start > end:
        start, end = end, start
    return start, end


# =====================================================================
# Playwright 仓颉日报抓取(v2.0 骨架)
# =====================================================================
def _wait_loading_done(page, timeout_ms: int = 15000) -> bool:
    """条件轮询等待 el-loading-mask 消失(替代固定 sleep)。

    切换成员后页面异步加载,必须等遮罩消失再提取,避免数据串成员。
    """
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        if page.locator(CANGJIE_LOADING_SELECTOR).count() == 0:
            return True
        time.sleep(0.15)
    LOG.warning("等待 loading 消失超时(%dms),继续提取", timeout_ms)
    return False


def _wait_filter_text_changed(page, expect_text: str, timeout_ms: int = 10000) -> bool:
    """条件轮询等待筛选器文本变为目标成员(数据切换完成信号)。"""
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        try:
            current = page.locator(CANGJIE_TREE_SELECT_SELECTOR).inner_text(timeout=2000)
            if expect_text and expect_text in current:
                return True
        except Exception:  # noqa: BLE001 —— 节点瞬态缺失时继续轮询
            pass
        time.sleep(0.2)
    return False


def _find_member_node(page, member: str):
    """4 策略查找成员树节点:text= 精确 / class 精确 / 展开遍历 / 模糊匹配。

    覆盖生僻字(如"甫")与 SPA 懒加载树节点场景。
    """
    strategies = [
        page.locator(".el-tree-node__content:has-text('%s')" % member),
        page.locator(".el-tree-node__content:has-text('%s')" % member).first,
    ]
    # 策略 1:文本精确(优先 .el-tree-node__content 内 span)
    node = page.locator(".el-tree-node__content", has_text=member).first
    if node.count() and member in (node.inner_text() or ""):
        return node
    # 策略 2:整页文本匹配
    node = page.get_by_text(member, exact=True).first
    if node.count():
        return node
    # 策略 3:展开"技术中心"等父节点后重试
    try:
        expand = page.locator(".el-tree-node__content", has_text="技术中心").first
        if expand.count():
            expand.click(timeout=3000)
            time.sleep(0.4)
            node = page.locator(".el-tree-node__content", has_text=member).first
            if node.count():
                return node
    except Exception:  # noqa: BLE001
        pass
    # 策略 4:模糊匹配(子串)
    for candidate in page.locator(".el-tree-node__content").all():
        try:
            text = candidate.inner_text() or ""
        except Exception:  # noqa: BLE001
            continue
        if member in text:
            return candidate
    return None


def _click_confirm(page) -> bool:
    """点击筛选器"确定"按钮(5 个 selector 候选)。"""
    for sel in CANGJIE_CONFIRM_SELECTORS:
        try:
            btn = page.locator(sel).last
            if btn.count():
                btn.click(timeout=3000)
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def extract_records(page) -> list:
    """从当前页面提取日报记录。

    返回 [{date, name, project, content, hours}, ...]
    数据按日期分组卡片展示:日期头(2026年07月17日(周五)) + 计划/完成内容/耗时。
    TreeWalker 局部扫描文本节点,提取耗时(currentHour)并映射项目名。
    """
    records = []
    try:
        text = page.locator("body").inner_text(timeout=5000)
    except Exception:  # noqa: BLE001
        return records
    if not text:
        return records
    # 按日期头分块(2026年07月17日(周五) / 2026年07月17日)
    date_pattern = re.compile(
        r"(?P<date>\d{4}年\d{1,2}月\d{1,2}日)(?:\(周[一二三四五六日]\))?"
    )
    blocks = []
    current_block = None
    for line in text.splitlines():
        m = date_pattern.search(line)
        if m:
            current_block = {"date": m.group("date"), "lines": []}
            blocks.append(current_block)
        elif current_block is not None:
            current_block["lines"].append(line)
    for block in blocks:
        try:
            d = parse_date(block["date"])
        except ValueError:
            continue
        block_text = "\n".join(block["lines"])
        # 总耗时:形如 1.5h / 2 小时 / 总耗时:1.5
        hour_m = re.search(r"(?:总耗时|当前耗时)[:：]?\s*([\d.]+)\s*(?:h|小时)?", block_text)
        hours = float(hour_m.group(1)) if hour_m else 0.0
        if hours <= 0 or hours > MAX_HOURS_PER_RECORD:
            hours = 0.0
        # 计划内容首行 → 项目名(归一化 + 顶层映射)
        content = block["lines"][0].strip() if block["lines"] else ""
        project = extract_top_level_project(content) if content else NON_PROJECT_BUCKET
        records.append({
            "date": format_date(d),
            "name": "",                 # 调用方回填当前成员
            "project": project,
            "content": content,
            "hours": hours,
        })
    return records


def ensure_logged_in(page) -> bool:
    """登录态前置检查:目标页可达且非登录跳转。未登录/会话过期时拦截。"""
    try:
        page.goto(CANGJIE_REPORT_URL, wait_until="domcontentloaded", timeout=30000)
        _wait_loading_done(page, timeout_ms=8000)
        url = page.url
        if "login" in url or "sso" in url.lower():
            LOG.error("未登录仓颉系统或会话已过期 —— 请在 AdsPower 浏览器中先登录。")
            return False
        body = page.locator("body").inner_text(timeout=5000)[:200]
        if "工作日报" not in body and "日报" not in body:
            LOG.warning("页面标题未匹配日报页,继续尝试(URL=%s)", url)
        return True
    except Exception as exc:  # noqa: BLE001
        LOG.error("打开仓颉日报页失败: %s", exc)
        return False


def fetch_daily_reports_via_playwright(
    members: list,
    start_date: _dt.date,
    end_date: _dt.date,
    adspower_user_id: str = None,
    force_reload: bool = False,
    simplify_project: bool = False,
) -> dict:
    """Playwright 抓取仓颉日报主流程(v2.0 骨架)。

    流程:
      1) AdsPower 发现活跃浏览器 → connect_over_cdp 复用已打开页面
      2) ensure_logged_in 前置检查
      3) 打开 .my-tree-select 下拉 → 4 策略查找成员 → 点"确定"
      4) 条件轮询等待筛选器文本变更 + el-loading-mask 消失
      5) extract_records 提取该成员记录 → 按日期范围过滤
      6) 切换失败自动重试 1 次;仍失败记入失败清单,不中断整体

    返回 {"records": [...], "failed": [成员名...], "ws": ...}
    """
    browser_info = get_browser_url(adspower_user_id)
    records_all = []
    failed = []
    ws = browser_info.get("ws", "")

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.connect_over_cdp(ws)
        except Exception as exc:  # noqa: BLE001
            LOG.error("CDP 连接失败(%s) —— 尝试重新启动浏览器", exc)
            browser_info = open_browser(adspower_user_id)
            ws = browser_info.get("ws", "")
            browser = pw.chromium.connect_over_cdp(ws)
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.pages[0] if context.pages else context.new_page()
        if not ensure_logged_in(page):
            browser.close()
            return {"records": [], "failed": list(members), "ws": ws}

        for member in members:
            try:
                # 打开筛选器下拉
                dropdown = page.locator(CANGJIE_TREE_SELECT_SELECTOR).first
                if not dropdown.count():
                    LOG.error("[%s] 未找到成员筛选器组件", member)
                    failed.append(member)
                    continue
                dropdown.click(timeout=5000)
                time.sleep(0.3)
                node = _find_member_node(page, member)
                if node is None:
                    LOG.error("[%s] 未找到成员节点(4 策略均失败)", member)
                    failed.append(member)
                    continue
                node.click(timeout=3000)
                if not _click_confirm(page):
                    LOG.warning("[%s] 未找到确定按钮,尝试直接继续", member)
                _wait_filter_text_changed(page, member)
                _wait_loading_done(page)
                if force_reload:
                    page.reload(wait_until="domcontentloaded")
                    _wait_loading_done(page)
                recs = extract_records(page)
                kept = [r for r in recs
                        if start_date <= parse_date(r["date"]) <= end_date]
                for r in kept:
                    r["name"] = member
                    if simplify_project:
                        r["project"] = "-".join(r["project"].split("-")[:2])
                records_all.extend(kept)
                LOG.info("[%s] 提取 %d 条(范围内 %d 条)", member, len(recs), len(kept))
            except Exception as exc:  # noqa: BLE001 —— 单成员异常隔离
                LOG.error("[%s] 处理失败: %s", member, exc)
                failed.append(member)
        try:
            browser.close()
        except Exception:  # noqa: BLE001
            pass

    return {"records": records_all, "failed": failed, "ws": ws}


# =====================================================================
# 入口(占位已由 U5 末尾完整 CLI 段取代,见文件末尾)
# =====================================================================
# =====================================================================
# 工时统计与分析段(v2.0 U3 追加:第 2 段,累计目标 ~1400 行)
#   —— 统计口径 / 记录清洗 / 去重 / 工时拆解 / 期望工时(7.5h/天) / 超载率
# =====================================================================
# 工时口径(v2.0,U1 常量在本段落地为算法):
#   - STANDARD_DAILY_HOURS = 7.5     公司预期,期望工时 = 工作日 × 7.5
#   - OVERTIME_DAILY_THRESHOLD = 8.0 劳动法 8h 工作制,单日超 8h 计加班
#   - overPct = (实际 - 期望) / 期望 × 100,正=超载 / 负=欠量
#   - 守恒校验:totalHours == round(workHours + overtimeHours, 1)
# 历史反模式 [REPORT_ANTI_PATTERN_OVERTIME_THRESHOLD_CONFUSION]:
#   7.5(公司预期,overPct 判定)与 8.0(劳动法,加班拆解)必须解耦,不得混用。

# 风险评分权重(v2.1 五因子,负数 = 高风险)
RISK_WEIGHTS = {
    "schedule": 0.30,       # 进度偏差(完成% vs forecast)
    "workProgress": 0.20,   # 工时投入偏差(plannedHours 口径)
    "overtime": 0.25,       # 加班强度(overtime / work)
    "headcount": 0.15,      # 人员缺口(dominant role)
    "urgency": 0.10,        # 紧迫度(距计划结束日)
}
RISK_HIGH_THRESHOLD = -30.0    # score < -30 → high
RISK_MEDIUM_THRESHOLD = -10.0  # score < -10 → medium,否则 low


def _normalize_records(records):
    """记录清洗:强制字段类型 / 截断异常耗时 / 丢弃无效行。

    规则:
      - hours 非数字 → 0;超 MAX_HOURS_PER_RECORD(24h) → 丢弃(异常值防御)
      - 低于 MIN_DAILY_HOURS(0.25h) 的行视为无效丢弃
      - name 回填空串;project 缺失回填 NON_PROJECT_BUCKET
    """
    out = []
    for r in records or []:
        if not isinstance(r, dict):
            continue
        try:
            hours = float(r.get("hours", 0.0) or 0.0)
        except (TypeError, ValueError):
            hours = 0.0
        if hours < MIN_DAILY_HOURS or hours > MAX_HOURS_PER_RECORD:
            continue
        name = str(r.get("name", "") or "").strip()
        project = str(r.get("project", "") or "").strip() or NON_PROJECT_BUCKET
        out.append({
            "date": str(r.get("date", "") or "").strip(),
            "name": name,
            "project": project,
            "content": str(r.get("content", "") or "").strip(),
            "hours": round(hours, 2),
        })
    return out


def _dedupe_records(records, key_fields=("date", "name", "project", "hours")):
    """去除完全重复的日报记录(同人同日同项目同耗时只保留 1 条)。

    Playwright 抓取 / 多数据源拼接时可能产生完全相同的行(整页重复渲染、
    跨月切换时边界记录重复)。按 key_fields 取指纹,保留首次出现。
    返回 (kept, stats),stats 含 original / kept / removed 计数。
    """
    stats = {"original": len(records or []), "kept": 0, "removed": 0}
    seen = set()
    kept = []
    for rec in records or []:
        key = tuple(str(rec.get(f, "")).strip() for f in key_fields)
        if key in seen:
            stats["removed"] += 1
            continue
        seen.add(key)
        kept.append(rec)
    stats["kept"] = len(kept)
    return kept, stats


def _filter_records_by_range(records, start, end):
    """按日期闭区间过滤;无法解析日期的行保留(不丢数据,统计时自然落空)。"""
    out = []
    for r in records or []:
        try:
            d = parse_date(r.get("date", ""))
        except (ValueError, TypeError):
            out.append(r)
            continue
        if start <= d <= end:
            out.append(r)
    return out


def _daily_hours_map(records, project_key=None, member=None):
    """按日期聚合工时 {date: hours};可限定 project / member。"""
    daily = defaultdict(float)
    for r in records or []:
        if project_key is not None and r.get("project") != project_key:
            continue
        if member is not None and r.get("name") != member:
            continue
        h = r.get("hours", 0.0) or 0.0
        d = r.get("date", "")
        if d and h > 0:
            daily[d] += float(h)
    return dict(daily)


def _calc_time_breakdown(daily_hours, workday_count=None):
    """工时拆解:总工时 / 工作工时 / 加班工时 + 期望工时与超载率。

    口径(v2.0 解耦):
      - 工作工时 workHours = Σ min(单日合计, OVERTIME_DAILY_THRESHOLD)
      - 加班工时 overtimeHours = Σ max(单日合计 - 8.0, 0)
      - 期望工时 expectedHours = 工作日 × STANDARD_DAILY_HOURS(7.5h/天)
      - 超载率 overPct = (total - expected) / expected × 100
    守恒校验:totalHours == round(workHours + overtimeHours, 1)
    """
    total = sum(daily_hours.values())
    work = 0.0
    overtime = 0.0
    for h in daily_hours.values():
        if h > OVERTIME_DAILY_THRESHOLD:
            work += OVERTIME_DAILY_THRESHOLD
            overtime += h - OVERTIME_DAILY_THRESHOLD
        else:
            work += h
    workdays = workday_count if workday_count is not None else len(daily_hours)
    expected = workdays * STANDARD_DAILY_HOURS
    over_pct = (total - expected) / expected * 100 if expected > 0 else 0.0
    return {
        "totalHours": round(total, 1),
        "workHours": round(work, 1),
        "overtimeHours": round(overtime, 1),
        "workdayCount": workdays,
        "expectedHours": round(expected, 1),
        "overPct": round(over_pct, 1),
    }


def _calc_expected_hours(workdays, member_count):
    """期望工时 = 工作日 × STANDARD_DAILY_HOURS(7.5h/天) × 人数。"""
    return round(workdays * STANDARD_DAILY_HOURS * max(member_count, 0), 1)

# =====================================================================
# 成员 / 角色 / 矩阵维度分析(U3 段之二)
# =====================================================================
def _build_member_stats(records, target_members, workdays):
    """成员维度统计:总工时 / 拆解 / 期望工时 / 超载率 / 日均 / 利用率。

    期望工时 = workdays × STANDARD_DAILY_HOURS(7.5h/天);
    overPct 正=超载 / 负=欠量;utilizationPct = 实际/期望 × 100。
    """
    member_stats = {}
    for member in target_members:
        member_records = [r for r in records if r.get("name") == member]
        daily = _daily_hours_map(member_records)
        projects = {r.get("project") for r in member_records}
        tb = _calc_time_breakdown(daily, workday_count=workdays)
        total = tb["totalHours"]
        expected = workdays * STANDARD_DAILY_HOURS
        member_stats[member] = {
            "name": member,
            "role": get_role(member),
            "roleLabel": get_role_label(get_role(member)),
            "recordCount": len(member_records),
            "projectCount": len(projects),
            "projects": sorted(projects),
            "workdayCount": workdays,
            "dailyHours": dict(sorted(daily.items())),
            "totalHours": total,
            "workHours": tb["workHours"],
            "overtimeHours": tb["overtimeHours"],
            "expectedHours": tb["expectedHours"],
            "overPct": tb["overPct"],
            "avgDailyHours": round(total / workdays, 1) if workdays else 0.0,
            "utilizationPct": round(total / expected * 100, 1) if expected > 0 else 0.0,
        }
    return member_stats


def _build_role_breakdown(records, target_members):
    """角色工时分布:每角色 hours / recordCount / memberCount / pct(占总工时)。

    覆盖未出勤成员:成员在 target_members 且角色归属即计入 memberCount,
    避免"角色有人但工时 0"被漏统计(岗位盘点需要)。
    """
    role_records = defaultdict(list)
    for r in records or []:
        role_records[get_role(r.get("name", ""))].append(r)
    total = sum(r.get("hours", 0.0) or 0.0 for r in records or [])
    breakdown = {}
    for role in ROLE_ORDER:
        recs = role_records.get(role, [])
        hours = sum(r.get("hours", 0.0) or 0.0 for r in recs)
        members = {r.get("name") for r in recs if r.get("name")}
        members.update(m for m in target_members if get_role(m) == role)
        breakdown[role] = {
            "role": role,
            "label": ROLE_LABELS.get(role, role),
            "color": ROLE_COLORS.get(role, "#6b7280"),
            "hours": round(hours, 1),
            "recordCount": len(recs),
            "memberCount": len(members),
            "members": sorted(members),
            "pct": round(hours / total * 100, 1) if total > 0 else 0.0,
        }
    return breakdown


def _build_member_project_matrix(records, target_members):
    """成员 × 项目 工时矩阵 {member: {project: hours}}(项目内按工时降序)。"""
    matrix = defaultdict(lambda: defaultdict(float))
    for r in records or []:
        name = r.get("name", "")
        if not name or name not in target_members:
            continue
        matrix[name][r.get("project", NON_PROJECT_BUCKET)] += float(r.get("hours", 0.0) or 0.0)
    out = {}
    for m, projects in matrix.items():
        out[m] = dict(sorted(projects.items(), key=lambda kv: -kv[1]))
    return out


_WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def _build_weekday_distribution(records):
    """分析逻辑:按星期几统计工时分布(识别周末加班/工作日集中度)。

    返回 {周一..周日: {hours, recordCount, workdayCount}}。
    """
    by_weekday = defaultdict(lambda: {"hours": 0.0, "recordCount": 0, "days": set()})
    for r in records or []:
        try:
            d = parse_date(r.get("date", ""))
        except (ValueError, TypeError):
            continue
        label = _WEEKDAY_LABELS[d.weekday()]
        by_weekday[label]["hours"] += float(r.get("hours", 0.0) or 0.0)
        by_weekday[label]["recordCount"] += 1
        by_weekday[label]["days"].add(format_date(d))
    return {
        wd: {
            "hours": round(v["hours"], 1),
            "recordCount": v["recordCount"],
            "workdayCount": len(v["days"]),
        }
        for wd, v in by_weekday.items()
    }


def _find_overtime_days(records, member=None):
    """分析逻辑:识别单日工时 > OVERTIME_DAILY_THRESHOLD(8h) 的加班日。

    返回 [{date, hours, overtimeHours}],按 overtime 降序。
    """
    daily = defaultdict(float)
    for r in records or []:
        if member is not None and r.get("name") != member:
            continue
        daily[r.get("date", "")] += float(r.get("hours", 0.0) or 0.0)
    days = []
    for d, h in daily.items():
        if h > OVERTIME_DAILY_THRESHOLD:
            days.append({
                "date": d,
                "hours": round(h, 1),
                "overtimeHours": round(h - OVERTIME_DAILY_THRESHOLD, 1),
            })
    days.sort(key=lambda x: -x["overtimeHours"])
    return days


def _build_contribution_rank(member_stats):
    """分析逻辑:成员贡献排名(总工时降序,并列按日均降序,再按姓名)。"""
    ranked = sorted(
        member_stats.values(),
        key=lambda m: (-m["totalHours"], -m["avgDailyHours"], m["name"]),
    )
    return [
        {
            "rank": idx + 1,
            "name": m["name"],
            "roleLabel": m["roleLabel"],
            "totalHours": m["totalHours"],
            "overPct": m["overPct"],
            "overtimeHours": m["overtimeHours"],
        }
        for idx, m in enumerate(ranked)
    ]


def _analyze_project_concentration(project_stats):
    """分析逻辑:项目集中度(Top1 / Top3 工时占总工时比例)。

    集中度高 → 单项目依赖风险;低 → 多点并行。
    """
    ranked = sorted(project_stats.items(), key=lambda kv: -kv[1]["hours"])
    total = sum(v["hours"] for v in project_stats.values())

    def pct(h):
        return round(h / total * 100, 1) if total > 0 else 0.0

    top1 = ranked[0] if ranked else (None, None)
    top3_names = [n for n, _ in ranked[:3]]
    top3_hours = sum(project_stats[n]["hours"] for n in top3_names)
    return {
        "totalHours": round(total, 1),
        "top1": {
            "name": top1[0],
            "hours": round(top1[1]["hours"], 1),
            "pct": pct(top1[1]["hours"]),
        } if top1[1] else None,
        "top3": {
            "names": top3_names,
            "hours": round(top3_hours, 1),
            "pct": pct(top3_hours),
        },
        "top1Pct": pct(top1[1]["hours"]) if top1[1] else 0.0,
        "top3Pct": pct(top3_hours),
    }

# =====================================================================
# 项目维度统计与归并(U3 段之三)
# =====================================================================
def _empty_project_stats():
    """构造空项目统计骨架(供归并目标桶"其他"使用)。"""
    return {
        "name": NON_PROJECT_BUCKET,
        "hours": 0.0,
        "recordCount": 0,
        "memberCount": 0,
        "members": [],
        "workdayCount": 0,
        "dailyHours": {},
        "timeBreakdown": _calc_time_breakdown({}),
        "roleBreakdown": {
            role: {
                "hours": 0.0,
                "recordCount": 0,
                "memberCount": 0,
                "members": [],
                "pct": 0.0,
                "label": ROLE_LABELS.get(role, role),
            }
            for role in ROLE_ORDER
        },
    }


def _build_project_stats(records, workdays):
    """项目维度统计:按顶层项目聚合(抓取层已 extract_top_level_project)。

    每项目含 hours / memberCount / members / recordCount / workdayCount /
    dailyHours / timeBreakdown(工时拆解) / roleBreakdown(角色工时分布)。
    """
    by_project = defaultdict(list)
    for r in records or []:
        by_project[r.get("project", NON_PROJECT_BUCKET)].append(r)
    project_stats = {}
    for proj, recs in by_project.items():
        daily = _daily_hours_map(recs)
        members = sorted({r.get("name") for r in recs if r.get("name")})
        total = sum(daily.values())
        role_hours = defaultdict(float)
        role_members = defaultdict(set)
        for r in recs:
            role = get_role(r.get("name", ""))
            role_hours[role] += float(r.get("hours", 0.0) or 0.0)
            role_members[role].add(r.get("name"))
        role_breakdown = {}
        for role in ROLE_ORDER:
            h = role_hours.get(role, 0.0)
            role_breakdown[role] = {
                "hours": round(h, 1),
                "recordCount": sum(1 for r in recs if get_role(r.get("name", "")) == role),
                "memberCount": len(role_members.get(role, set())),
                "members": sorted(role_members.get(role, set())),
                "pct": round(h / total * 100, 1) if total > 0 else 0.0,
                "label": ROLE_LABELS.get(role, role),
            }
        project_stats[proj] = {
            "name": proj,
            "hours": round(total, 1),
            "recordCount": len(recs),
            "memberCount": len(members),
            "members": members,
            "workdayCount": len(daily),
            "dailyHours": dict(sorted(daily.items())),
            "timeBreakdown": _calc_time_breakdown(daily, workday_count=len(daily)),
            "roleBreakdown": role_breakdown,
        }
    return project_stats


def _merge_small_projects(project_stats, min_members=NON_PROJECT_MIN_MEMBERS):
    """项目归并:参与人数 < min_members(3) 的零散项目并入"其他"桶。

    避免小项目碎片化导致总览卡片过多;归并后保持工时守恒(不丢数据)。
    返回 (归并后 project_stats, 被归并项目名列表)。
    """
    if not project_stats:
        return {}, []
    # 只归并非项目类(KNOWN_PROJECTS 真实项目永不归并,历史修复语义)
    small = [
        name for name, st in project_stats.items()
        if name != NON_PROJECT_BUCKET
        and name not in KNOWN_PROJECTS
        and st.get("memberCount", 0) < min_members
    ]
    merged = {name: dict(st) for name, st in project_stats.items() if name not in small}
    if small:  # 确有归并才创建"其他"桶,避免空桶噪声
        merged.setdefault(NON_PROJECT_BUCKET, _empty_project_stats())
    for name in small:
        st = project_stats[name]
        target = merged[NON_PROJECT_BUCKET]
        target["hours"] = round(target["hours"] + st["hours"], 1)
        target["recordCount"] += st["recordCount"]
        target["members"] = sorted(set(target["members"]) | set(st["members"]))
        target["memberCount"] = len(target["members"])
        for d, h in st["dailyHours"].items():
            target["dailyHours"][d] = round(target["dailyHours"].get(d, 0.0) + h, 1)
        for role, rb in st["roleBreakdown"].items():
            trb = target["roleBreakdown"][role]
            trb["hours"] = round(trb["hours"] + rb["hours"], 1)
            trb["recordCount"] += rb["recordCount"]
            trb["members"] = sorted(set(trb["members"]) | set(rb["members"]))
            trb["memberCount"] = len(trb["members"])
        total = target["hours"]
        for role, trb in target["roleBreakdown"].items():
            trb["pct"] = round(trb["hours"] / total * 100, 1) if total > 0 else 0.0
        target["workdayCount"] = len(target["dailyHours"])
        target["timeBreakdown"] = _calc_time_breakdown(
            target["dailyHours"], workday_count=target["workdayCount"])
    return merged, small


def _infer_project_type(project_name, project_stat, metadata):
    """项目类型判定:metadata 优先;缺省按 dev 工时占比推断。

    规则(v2.0):dev_hours / total_hours ≤ 60% → 运维类,否则 开发类。
    """
    meta = (metadata or {}).get("projects", {}).get(project_name, {}) or {}
    ptype = meta.get("projectType")
    if ptype:
        return str(ptype)
    rb = project_stat.get("roleBreakdown", {}) or {}
    dev_hours = rb.get(DEV_ROLE, {}).get("hours", 0.0) or 0.0
    total = project_stat.get("hours", 0.0)
    if total > 0 and dev_hours / total <= 0.60:
        return "运维类"
    return "开发类"


def _build_completion_segments(project_name, metadata, monthly_snapshots):
    """完成% 三段:截止上月 / 本月(metadata 优先→当月快照) / 增量 / 预计。

    数据缺失时返回 None(下游渲染为"—")。
    """
    meta = (metadata or {}).get("projects", {}).get(project_name, {}) or {}
    prev = (monthly_snapshots or {}).get("prev_completions", {}) or {}
    current = (monthly_snapshots or {}).get("current_completions", {}) or {}
    last_month = prev.get(project_name)
    this_month = meta.get("completionThisMonth")
    if this_month is None:
        this_month = current.get(project_name)
    forecast = meta.get("forecastCompletion")
    delta = None
    if last_month is not None and this_month is not None:
        try:
            delta = round(float(this_month) - float(last_month), 1)
        except (TypeError, ValueError):
            delta = None
    return {
        "completionLastMonth": last_month,
        "completionThisMonth": this_month,
        "completionDelta": delta,
        "forecastCompletion": forecast,
    }


def _calc_risk_score(project_name, project_stat, metadata, headcount_targets, headcount_actual):
    """风险评分:5 因子加权(进度偏差/工时投入偏差/加班强度/人员缺口/紧迫度)。

    符号约定:负值 = 风险高(落后/投入不足/加班多/缺人/紧迫)。
    缺因子时权重重新归一化;全缺返回 status="unknown"。
    阈值:score < -30 → high;-30 ~ -10 → medium;≥ -10 → low。
    """
    meta = (metadata or {}).get("projects", {}).get(project_name, {}) or {}
    segs = project_stat.get("completionSegments", {}) or {}
    tb = project_stat.get("timeBreakdown", {}) or {}
    this_month = segs.get("completionThisMonth")
    forecast = segs.get("forecastCompletion")
    factors = {}

    # 因子 1:进度偏差 = (本月 - forecast) / forecast × 100
    has_schedule = this_month is not None and forecast not in (None, "")
    schedule_dev = 0.0
    if has_schedule:
        try:
            fcast = float(forecast)
            schedule_dev = (float(this_month) - fcast) / fcast * 100 if fcast > 0 else 0.0
        except (TypeError, ValueError):
            has_schedule = False
    factors["schedule"] = (schedule_dev, has_schedule)

    # 因子 2:工时投入偏差 = (实际 - planned) / planned × 100
    work_progress = 0.0
    has_progress = False
    planned_hours = meta.get("plannedHours")
    if planned_hours is None and meta.get("plannedWorkdays"):
        planned_hours = float(meta["plannedWorkdays"]) * STANDARD_DAILY_HOURS
    if planned_hours:
        try:
            ph = float(planned_hours)
            work_progress = (tb.get("totalHours", 0.0) - ph) / ph * 100 if ph > 0 else 0.0
            has_progress = True
        except (TypeError, ValueError):
            pass
    factors["workProgress"] = (work_progress, has_progress)

    # 因子 3:加班强度 = overtime / work × 100
    overtime_intensity = 0.0
    has_overtime = tb.get("workHours", 0.0) > 0
    if has_overtime:
        overtime_intensity = tb.get("overtimeHours", 0.0) / tb["workHours"] * 100
    factors["overtime"] = (overtime_intensity, has_overtime)

    # 因子 4:人员缺口 = (target - actual) / target × 100(负数=缺人)
    headcount_gap = 0.0
    has_headcount = False
    rb = project_stat.get("roleBreakdown", {}) or {}
    dominant = DEV_ROLE
    if rb:
        dominant = max(
            ((role, rbi.get("hours", 0.0)) for role, rbi in rb.items()),
            key=lambda kv: kv[1],
        )[0]
    target_n = int(headcount_targets.get(dominant, 0) or 0)
    if target_n > 0:
        actual_n = int(headcount_actual.get(dominant, 0) or 0)
        headcount_gap = (target_n - actual_n) / target_n * 100
        has_headcount = True
    factors["headcount"] = (headcount_gap, has_headcount)

    # 因子 5:紧迫度(距计划结束日 < 60 天且未达 forecast,负值=紧迫)
    urgency = 0.0
    has_urgency = False
    planned_end = meta.get("plannedEndDate")
    if planned_end and this_month is not None and forecast not in (None, ""):
        try:
            end_dt = parse_date(str(planned_end))
            days_to_end = (end_dt - _dt.date.today()).days
            if 0 < days_to_end < 60:
                remaining = max(0.0, float(forecast) - float(this_month))
                urgency = -(remaining * (60 - days_to_end) / 60)
                has_urgency = True
        except (TypeError, ValueError):
            pass
    factors["urgency"] = (urgency, has_urgency)

    # 进度口径缺失(无 forecast / completionThisMonth)→ 无法评级,返回 unknown(AC5 契约)
    if not has_schedule:
        return {
            "score": 0.0,
            "status": "unknown",
            "factors": {k: round(v[0], 1) for k, v in factors.items()},
        }

    available = {k: v for k, v in factors.items() if v[1]}
    if not available:
        return {"score": 0.0, "status": "unknown", "factors": {}}
    total_w = sum(RISK_WEIGHTS[k] for k in available)
    score = sum(v[0] * RISK_WEIGHTS[k] / total_w for k, v in available.items())
    if score < RISK_HIGH_THRESHOLD:
        status = "high"
    elif score < RISK_MEDIUM_THRESHOLD:
        status = "medium"
    else:
        status = "low"
    return {
        "score": round(score, 1),
        "status": status,
        "factors": {k: round(v[0], 1) for k, v in factors.items()},
    }


def _build_headcount_analysis(target_members, headcount_target):
    """交付中心人力盘点:各岗位在编 / 目标 / 缺口(gap = actual - target)。

    正 gap = 超编 / 负 gap = 缺口 / 0 = 达标。返回 (analysis, actual_by_role)。
    """
    actual = {}
    for m in target_members:
        role = get_role(m)
        actual[role] = actual.get(role, 0) + 1
    targets = {}
    if headcount_target:
        targets = (headcount_target or {}).get("targets", {}) or {}
    analysis = {}
    for role in sorted(set(actual) | set(targets)):
        target_n = int(targets.get(role, 0) or 0)
        act = int(actual.get(role, 0))
        gap = act - target_n
        analysis[role] = {
            "role": role,
            "label": ROLE_LABELS.get(role, role),
            "color": ROLE_COLORS.get(role, "#6b7280"),
            "target": target_n,
            "actual": act,
            "gap": gap,
            "gapPct": round(gap / target_n * 100, 1) if target_n > 0 else 0.0,
        }
    return analysis, actual


def _build_project_status_buckets(project_stats):
    """项目状态分桶:按 status 聚合(已完成 / 正在进行 / 运维 / 其他)。

    返回 {status: {statusLabel, projects, hours, memberCount}}。
    """
    buckets = {}
    for pname, pst in project_stats.items():
        status = pst.get("status", "ongoing")
        label = pst.get("statusLabel", status)
        bucket = buckets.setdefault(status, {
            "status": status,
            "statusLabel": label,
            "projects": [],
            "hours": 0.0,
            "memberCount": 0,
        })
        bucket["projects"].append(pname)
        bucket["hours"] = round(bucket["hours"] + pst.get("hours", 0.0), 1)
        bucket["memberCount"] += pst.get("memberCount", 0)
    for bucket in buckets.values():
        bucket["projects"] = sorted(
            bucket["projects"], key=lambda p: -project_stats[p]["hours"])
    return buckets


def _format_terminal_summary(stats):
    """终端摘要文本(供 CLI 调用;u5 段接管主 CLI 前提供分析入口)。"""
    summary = stats.get("summary", {})
    lines = []
    lines.append("=" * 64)
    lines.append("工时统计摘要(%s ~ %s,工作日 %d 天)" % (
        summary.get("dateRange", {}).get("start", "?"),
        summary.get("dateRange", {}).get("end", "?"),
        summary.get("workdays", 0),
    ))
    lines.append("-" * 64)
    lines.append("成员 %d 人 / 记录 %d 条 / 项目 %d 个(归并 %d 个)" % (
        summary.get("memberCount", 0),
        summary.get("recordCount", 0),
        summary.get("projectCount", 0),
        summary.get("mergedProjectCount", 0),
    ))
    lines.append("总工时 %.1fh / 期望工时 %.1fh(工作日 × %.1fh/天) / 超载率 %+.1f%%" % (
        summary.get("totalHours", 0.0),
        summary.get("expectedHours", 0.0),
        summary.get("standardDailyHours", STANDARD_DAILY_HOURS),
        summary.get("overPct", 0.0),
    ))
    lines.append("工作工时 %.1fh / 加班工时 %.1fh / 日均 %.1fh/天 / 利用率 %.1f%%" % (
        summary.get("workHours", 0.0),
        summary.get("overtimeHours", 0.0),
        summary.get("avgDailyHours", 0.0),
        summary.get("utilizationPct", 0.0),
    ))
    lines.append("-" * 64)
    lines.append("项目维度(top 6,按工时降序):")
    project_stats = stats.get("projectStats", {})
    for pname in sorted(project_stats, key=lambda p: -project_stats[p]["hours"])[:6]:
        pst = project_stats[pname]
        lines.append("  %-34s %7.1fh %3d人 %s" % (
            pname[:34], pst["hours"], pst["memberCount"],
            pst.get("riskScore", {}).get("status", "")))
    lines.append("成员维度(top 6,按工时降序):")
    for item in stats.get("contributionRank", [])[:6]:
        lines.append("  %-8s %-10s %7.1fh overPct %+.1f%%" % (
            item["name"], item["roleLabel"], item["totalHours"], item["overPct"]))
    if stats.get("dedupe", {}).get("removed", 0):
        lines.append("去重:剔除 %d 条重复记录" % stats["dedupe"]["removed"])
    lines.append("=" * 64)
    return "\n".join(lines)


def calculate_stats(
    records,
    target_members,
    start_date=None,
    end_date=None,
    project_metadata=None,
    monthly_snapshots=None,
    headcount_target=None,
):
    """核心统计入口:工时统计(7.5h/天期望)+ 项目/成员/角色维度分析。

    流程:
      1) 清洗(_normalize_records)→ 去重(_dedupe_records)→ 区间过滤
      2) 项目维度 projectStats(工时/成员/角色分布/工时拆解/类型/完成% 三段/风险)
         零散项目(< NON_PROJECT_MIN_MEMBERS 人)归并入"其他"桶
      3) 成员维度 memberStats(总工时/工作/加班/期望/overPct/日均/利用率)
      4) 角色维度 roleBreakdown + 交付中心人力盘点 headcountAnalysis
      5) summary:workdays / expectedHours(7.5h/天) / totalHours / 守恒校验

    输出 dict:
      summary / projectStats / memberStats / memberProjectMatrix /
      roleBreakdown / weekdayDistribution / overtimeDays / contributionRank /
      projectConcentration / projectStatusBuckets / headcountAnalysis / dedupe
    """
    records = _normalize_records(records or [])
    records, dedupe_stats = _dedupe_records(records)
    target_members = list(target_members) if target_members else list(ALL_V19_MEMBERS)

    today = _dt.date.today()
    start = start_date if isinstance(start_date, _dt.date) else (parse_date(start_date) if start_date else _dt.date(today.year, today.month, 1))
    end = end_date if isinstance(end_date, _dt.date) else (parse_date(end_date) if end_date else today)
    if start > end:
        start, end = end, start
    workdays = calculate_workdays(start, end)

    records = _filter_records_by_range(records, start, end)
    member_set = set(target_members)
    records = [r for r in records if r.get("name") in member_set]

    project_stats = _build_project_stats(records, workdays)
    project_stats, merged = _merge_small_projects(project_stats)

    headcount_analysis, headcount_actual = _build_headcount_analysis(target_members, headcount_target)
    headcount_targets = {role: int(v.get("target", 0)) for role, v in headcount_analysis.items()}

    for pname, pst in project_stats.items():
        meta = (project_metadata or {}).get("projects", {}).get(pname, {}) or {}
        pst["projectMeta"] = meta
        pst["status"] = meta.get("status", "ongoing")
        pst["statusLabel"] = (project_metadata or {}).get("statusMapping", {}).get(pst["status"], pst["status"])
        pst["projectType"] = _infer_project_type(pname, pst, project_metadata)
        pst["completionSegments"] = _build_completion_segments(pname, project_metadata, monthly_snapshots)
        pst["riskScore"] = _calc_risk_score(pname, pst, project_metadata, headcount_targets, headcount_actual)
        pst["headcountContext"] = dict(headcount_actual)

    member_stats = _build_member_stats(records, target_members, workdays)
    matrix = _build_member_project_matrix(records, target_members)
    role_breakdown = _build_role_breakdown(records, target_members)
    weekday_dist = _build_weekday_distribution(records)
    overtime_days = _find_overtime_days(records)
    contribution_rank = _build_contribution_rank(member_stats)
    concentration = _analyze_project_concentration(project_stats)
    status_buckets = _build_project_status_buckets(project_stats)

    total_hours = sum(r.get("hours", 0.0) or 0.0 for r in records)
    expected_total = _calc_expected_hours(workdays, len(target_members))
    over_pct = (total_hours - expected_total) / expected_total * 100 if expected_total > 0 else 0.0
    work_hours = sum(m["workHours"] for m in member_stats.values())
    overtime_total = sum(m["overtimeHours"] for m in member_stats.values())

    summary = {
        "dateRange": {"start": format_date(start), "end": format_date(end)},
        "workdays": workdays,
        "standardDailyHours": STANDARD_DAILY_HOURS,
        "memberCount": len(target_members),
        "recordCount": len(records),
        "projectCount": len(project_stats),
        "totalHours": round(total_hours, 1),
        "workHours": round(work_hours, 1),
        "overtimeHours": round(overtime_total, 1),
        "expectedHours": expected_total,
        "overPct": round(over_pct, 1),
        "avgDailyHours": round(total_hours / workdays, 1) if workdays else 0.0,
        "utilizationPct": round(total_hours / expected_total * 100, 1) if expected_total > 0 else 0.0,
        "mergedProjectCount": len(merged),
        "hasProjectMetadata": bool(project_metadata),
        "hasMonthlySnapshots": bool(monthly_snapshots),
        "hasHeadcountTarget": bool(headcount_target),
        "headcountTotal": {
            "actual": sum(v["actual"] for v in headcount_analysis.values()),
            "target": sum(v["target"] for v in headcount_analysis.values()),
            "gap": sum(v["gap"] for v in headcount_analysis.values()),
        },
    }

    return {
        "summary": summary,
        "projectStats": project_stats,
        "memberStats": member_stats,
        "memberProjectMatrix": matrix,
        "roleBreakdown": role_breakdown,
        "weekdayDistribution": weekday_dist,
        "overtimeDays": overtime_days,
        "contributionRank": contribution_rank,
        "projectConcentration": concentration,
        "projectStatusBuckets": status_buckets,
        "headcountAnalysis": headcount_analysis,
        "dedupe": dedupe_stats,
    }
# =====================================================================
# HTML 周报生成段(U4:9-Section HTML 模板 + generate_html_report + write_html)
# ---------------------------------------------------------------------
# 依赖:calculate_stats 输出的 stats dict(U3 段)。
# 9 sections:
#   1 整体统计 / 2 项目分布 / 3 成员总览 / 4 成员明细(xN) /
#   5 工时拆解 / 6 风险预警 / 7 关键洞察 / 8 数据说明 / 9 附录
# XSS 防护:所有动态文本经 _h() 转义(from html import escape)。
# =====================================================================
from html import escape as _html_escape


def _h(value):
    """HTML 转义(防 XSS):None→'';其余 str() 后转义 & < > 双引号 单引号。"""
    if value is None:
        return ""
    return _html_escape(str(value), quote=True)


def _fmt_hours(value):
    """工时格式化:非法值→'—',合法值保留 1 位小数。"""
    try:
        return "%.1f" % float(value)
    except (TypeError, ValueError):
        return "—"


def _fmt_pct(value):
    """百分比格式化:非法值→'—',合法值保留 1 位小数并附 %。"""
    try:
        return "%.1f%%" % float(value)
    except (TypeError, ValueError):
        return "—"


def _risk_label(status):
    """风险状态 → 中文标签(与 SKILL.md 分级一致)。"""
    return {
        "high": "高风险",
        "medium": "中风险",
        "low": "正常",
        "unknown": "待评估",
    }.get(status, status or "待评估")


def _dict_iter(value):
    """兼容 dict 与 list 两种 stats 形态,统一产出 (key, item) 序列。

    calculate_stats 输出 dict;mock/降级输入可能为 list。
    """
    if isinstance(value, dict):
        return list(value.items())
    if isinstance(value, (list, tuple)):
        return [
            (v.get("name", "") if isinstance(v, dict) else "", v)
            for v in value
        ]
    return []


def _get_summary(stats):
    """summary 兼容层:calculate_stats 的 stats['summary'] 或扁平 dict。

    扁平 dict(如 {'totalHours': 100, 'workdays': 10})直接读取顶层键;
    嵌套 summary 优先,避免键冲突。
    """
    s = stats.get("summary") or {}
    if not isinstance(s, dict):
        s = {}
    merged = dict(stats)
    merged.pop("summary", None)
    for k, v in s.items():
        if v is not None:
            merged[k] = v
    merged.setdefault("dateRange", {})
    return merged


def _sum_key(stats, key):
    """从 summary 兼容层取数值键:缺失→0.0。"""
    s = _get_summary(stats)
    try:
        return float(s.get(key, 0.0) or 0.0)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------------
# 9 Section 标题(锚点 id + 目录展示名)
# ---------------------------------------------------------------------
SECTION_TITLES = (
    ("section-1", "整体统计"),
    ("section-2", "项目分布"),
    ("section-3", "成员总览"),
    ("section-4", "成员明细"),
    ("section-5", "工时拆解"),
    ("section-6", "风险预警"),
    ("section-7", "关键洞察"),
    ("section-8", "数据说明"),
    ("section-9", "附录"),
)

# ---------------------------------------------------------------------
# 内联样式(自包含,无外部依赖;Indigo/Violet 主题)
# ---------------------------------------------------------------------
_REPORT_CSS = """
<style>
  :root { --indigo:#6366f1; --violet:#a855f7; --emerald:#10b981;
          --amber:#f59e0b; --rose:#f43f5e; --slate:#334155; --bg:#f1f5f9; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--slate);
         font-family:"Microsoft YaHei","PingFang SC",sans-serif; line-height:1.6; }
  .container { max-width:1080px; margin:0 auto; background:#fff;
               border-radius:12px; box-shadow:0 2px 12px rgba(0,0,0,.08);
               padding:28px 36px; }
  header.report-header { border-bottom:2px solid var(--indigo);
                         padding-bottom:16px; margin-bottom:24px; }
  header.report-header h1 { margin:0 0 6px; color:var(--indigo); font-size:22px; }
  header.report-header p { margin:2px 0; color:#64748b; font-size:13px; }
  nav.toc { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;
            padding:12px 18px; margin-bottom:24px; font-size:13px; }
  nav.toc ol { margin:6px 0 0; padding-left:22px; columns:3; column-gap:24px; }
  nav.toc a { color:var(--indigo); text-decoration:none; }
  nav.toc a:hover { text-decoration:underline; }
  section { margin:28px 0; scroll-margin-top:12px; }
  section h2 { border-left:5px solid var(--indigo); padding-left:10px;
               margin:0 0 6px; font-size:18px; color:#1e293b; }
  section h3 { margin:14px 0 6px; font-size:14px; color:#334155; }
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
               gap:12px; margin:12px 0; }
  .stat-card { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;
               padding:12px 14px; text-align:center; }
  .stat-card .num { font-size:22px; font-weight:700; color:var(--indigo); }
  .stat-card .lbl { font-size:12px; color:#64748b; }
  table { width:100%; border-collapse:collapse; margin:10px 0; font-size:13px; }
  th, td { border:1px solid #e2e8f0; padding:7px 10px; text-align:left; }
  th { background:#eef2ff; color:#3730a3; white-space:nowrap; }
  tr:nth-child(even) td { background:#fafaff; }
  .badge { display:inline-block; padding:1px 8px; margin:1px 2px;
           border-radius:10px; font-size:12px; color:#fff; white-space:nowrap; }
  .risk-high { background:var(--rose); }
  .risk-medium { background:var(--amber); color:#451a03; }
  .risk-low { background:var(--emerald); }
  .risk-unknown { background:#94a3b8; }
  .member-block { border:1px solid #e2e8f0; border-radius:10px;
                  padding:14px 16px; margin:14px 0; }
  .member-block h3 { margin:0 0 6px; font-size:15px; }
  .member-block .meta { margin:4px 0 8px; font-size:13px; color:#64748b; }
  .note { background:#fffbeb; border:1px solid #fde68a; border-radius:8px;
          padding:10px 14px; margin:10px 0; font-size:13px; color:#78350f; }
  ul.insight { margin:8px 0; padding-left:22px; }
  ul.insight li { margin:6px 0; }
  footer.report-footer { margin-top:30px; padding-top:12px;
                         border-top:1px solid #e2e8f0; color:#94a3b8;
                         font-size:12px; text-align:center; }
</style>
"""


def _render_section1_overview(stats):
    """Section 1 整体统计:stat-card 概览 + 指标明细表。"""
    s = _get_summary(stats)
    dr = s.get("dateRange") or {}
    start = dr.get("start", "")
    end = dr.get("end", "")
    total = _sum_key(stats, "totalHours")
    cards = [
        ("总工时(h)", _fmt_hours(total)),
        ("工作工时(h)", _fmt_hours(s.get("workHours", 0.0))),
        ("加班工时(h)", _fmt_hours(s.get("overtimeHours", 0.0))),
        ("期望工时(h)", _fmt_hours(s.get("expectedHours", 0.0))),
        ("日均工时(h)", _fmt_hours(s.get("avgDailyHours", 0.0))),
        ("超载率", _fmt_pct(s.get("overPct", 0.0))),
        ("利用率", _fmt_pct(s.get("utilizationPct", 0.0))),
        ("成员数(人)", s.get("memberCount", 0)),
        ("项目数(个)", s.get("projectCount", 0)),
        ("记录数(条)", s.get("recordCount", 0)),
        ("工作日(天)", s.get("workdays", 0)),
    ]
    grid = "".join(
        '<div class="stat-card"><div class="num">%s</div>'
        '<div class="lbl">%s</div></div>'
        % (_h(num), _h(label))
        for label, num in cards
    )
    rows = ""
    pairs = [
        ("统计周期", (str(start) + " ~ " + str(end)).strip(" ~") or "—"),
        ("工作日天数", s.get("workdays", 0)),
        ("标准日工时(h)", s.get("standardDailyHours", 7.5)),
        ("总工时(h)", _fmt_hours(total)),
        ("期望总工时(h)", _fmt_hours(s.get("expectedHours", 0.0))),
        ("超载率", _fmt_pct(s.get("overPct", 0.0))),
        ("工时守恒校验", "totalHours = workHours + overtimeHours"),
    ]
    for k, v in pairs:
        rows += "<tr><th>%s</th><td>%s</td></tr>" % (_h(k), _h(v))
    return (
        '<section id="section-1">'
        '<h2>1. 整体统计</h2>'
        '<p style="color:#64748b;font-size:13px">'
        '统计周期内全部成员的工时汇总(口径:期望 7.5h/天,加班阈值 8h/天)</p>'
        '<div class="stat-grid">' + grid + "</div>"
        '<h3>指标明细</h3>'
        "<table><tbody>" + rows + "</tbody></table>"
        "</section>"
    )


def _render_section2_projects(stats):
    """Section 2 项目分布:每项目总工时/工作·加班拆分/人数/记录/类型/角色/风险。"""
    rows = ""
    for name, pst in _dict_iter(stats.get("projectStats")):
        if not isinstance(pst, dict):
            continue
        tb = pst.get("timeBreakdown") or {}
        rb = pst.get("roleBreakdown") or {}
        role_badges = "".join(
            '<span class="badge" style="background:%s">%s %s</span>'
            % (_h(ROLE_COLORS.get(role, "#94a3b8")),
               _h(r.get("label", role)),
               _fmt_hours(r.get("hours", 0.0)))
            for role, r in rb.items()
        )
        risk = pst.get("riskScore") or {}
        status = risk.get("status", "unknown")
        rows += (
            "<tr>"
            "<td>%s</td>" % (_h(name),)
            + "<td>%s</td>" % (_fmt_hours(pst.get("hours", 0.0)),)
            + "<td>%s</td>" % (_fmt_hours(tb.get("workHours", 0.0)),)
            + "<td>%s</td>" % (_fmt_hours(tb.get("overtimeHours", 0.0)),)
            + "<td>%s</td>" % (pst.get("memberCount", 0),)
            + "<td>%s</td>" % (pst.get("recordCount", 0),)
            + "<td>%s</td>" % (_h(pst.get("projectType", "—") or "—"),)
            + "<td>%s</td>" % (role_badges or "—",)
            + '<td><span class="badge risk-%s">%s</span></td>'
              % (_h(status), _h(_risk_label(status)))
            + "</tr>"
        )
    if not rows:
        rows = ('<tr><td colspan="9" style="text-align:center;color:#94a3b8">'
                "暂无项目数据</td></tr>")
    return (
        '<section id="section-2">'
        "<h2>2. 项目分布</h2>"
        '<p style="color:#64748b;font-size:13px">'
        "按项目聚合:总工时/工作·加班拆分/参与人数/角色工时分布/风险状态</p>"
        "<table>"
        "<thead><tr>"
        "<th>项目</th><th>总工时(h)</th><th>工作工时(h)</th><th>加班工时(h)</th>"
        "<th>人数</th><th>记录数</th><th>类型</th><th>角色分布</th><th>风险</th>"
        "</tr></thead>"
        "<tbody>" + rows + "</tbody></table>"
        "</section>"
    )
def _derive_rank_from_member_stats(member_stats):
    """成员贡献排名兜底:无 contributionRank 时从 memberStats 派生(按总工时降序)。"""
    items = []
    for name, mst in _dict_iter(member_stats):
        if not isinstance(mst, dict):
            mst = {"name": name}
        items.append(mst)
    ranked = sorted(
        items,
        key=lambda m: (-_sum_key({"summary": m}, "totalHours"), m.get("name", "")),
    )
    return [
        {
            "rank": idx + 1,
            "name": m.get("name", ""),
            "roleLabel": m.get("roleLabel", "—"),
            "totalHours": _sum_key({"summary": m}, "totalHours"),
            "overPct": m.get("overPct", 0.0),
            "overtimeHours": m.get("overtimeHours", 0.0),
        }
        for idx, m in enumerate(ranked)
    ]


def _render_section3_members(stats):
    """Section 3 成员总览:贡献排名表(rank/姓名/角色/总工时/超载率/加班)。"""
    rank = stats.get("contributionRank")
    if not rank:
        rank = _derive_rank_from_member_stats(stats.get("memberStats"))
    rows = ""
    for item in rank:
        if not isinstance(item, dict):
            continue
        rows += (
            "<tr>"
            "<td>%s</td>" % (item.get("rank", ""),)
            + "<td>%s</td>" % (_h(item.get("name", "")),)
            + "<td>%s</td>" % (_h(item.get("roleLabel", "—") or "—"),)
            + "<td>%s</td>" % (_fmt_hours(item.get("totalHours", 0.0)),)
            + "<td>%s</td>" % (_fmt_pct(item.get("overPct", 0.0)),)
            + "<td>%s</td>" % (_fmt_hours(item.get("overtimeHours", 0.0)),)
            + "</tr>"
        )
    if not rows:
        rows = ('<tr><td colspan="6" style="text-align:center;color:#94a3b8">'
                "暂无成员数据</td></tr>")
    return (
        '<section id="section-3">'
        "<h2>3. 成员总览</h2>"
        '<p style="color:#64748b;font-size:13px">'
        "成员贡献排名(总工时降序;超载率正=超载 / 负=欠量)</p>"
        "<table>"
        "<thead><tr>"
        "<th>排名</th><th>成员</th><th>角色</th>"
        "<th>总工时(h)</th><th>超载率</th><th>加班工时(h)</th>"
        "</tr></thead>"
        "<tbody>" + rows + "</tbody></table>"
        "</section>"
    )


def _render_section4_member_details(stats):
    """Section 4 成员明细(×N):每成员独立卡片 + 逐日工时表。"""
    blocks = ""
    for name, mst in _dict_iter(stats.get("memberStats")):
        if not isinstance(mst, dict):
            mst = {"name": name}
        mname = mst.get("name", name) or name
        daily = mst.get("dailyHours") or {}
        daily_rows = ""
        for d, h in sorted(daily.items()):
            daily_rows += "<tr><td>%s</td><td>%s</td></tr>" % (_h(d), _fmt_hours(h))
        if not daily_rows:
            daily_rows = ('<tr><td colspan="2" style="text-align:center;'
                          "color:#94a3b8\">无工时记录</td></tr>")
        role = mst.get("role", "dev")
        role_label = mst.get("roleLabel") or ROLE_LABELS.get(role, "—")
        projects = ", ".join(_h(p) for p in (mst.get("projects") or []))
        meta = (
            "总工时 %s h | 工作 %s h | 加班 %s h | 超载率 %s | "
            "利用率 %s | 项目 %s 个(%s)"
        ) % (
            _fmt_hours(mst.get("totalHours", 0.0)),
            _fmt_hours(mst.get("workHours", 0.0)),
            _fmt_hours(mst.get("overtimeHours", 0.0)),
            _fmt_pct(mst.get("overPct", 0.0)),
            _fmt_pct(mst.get("utilizationPct", 0.0)),
            mst.get("projectCount", len(projects)),
            projects or "—",
        )
        blocks += (
            '<div class="member-block">'
            "<h3>%s <span class=\"badge\" style=\"background:%s\">%s</span></h3>"
            % (_h(mname), _h(ROLE_COLORS.get(role, "#94a3b8")), _h(role_label))
            + '<div class="meta">' + _h(meta) + "</div>"
            + "<table>"
            + "<thead><tr><th>日期</th><th>工时(h)</th></tr></thead>"
            + "<tbody>" + daily_rows + "</tbody>"
            + "</table>"
            + "</div>"
        )
    if not blocks:
        blocks = ('<p style="color:#94a3b8">暂无成员数据</p>')
    return (
        '<section id="section-4">'
        "<h2>4. 成员明细</h2>"
        '<p style="color:#64748b;font-size:13px">'
        "每位成员独立卡片:总工时/工作·加班拆分/超载率/项目清单 + 逐日工时明细</p>"
        + blocks
        + "</section>"
    )


def _render_section5_breakdown(stats):
    """Section 5 工时拆解:星期分布 + 加班日清单 + 项目工时守恒。"""
    wd = stats.get("weekdayDistribution") or {}
    wd_rows = ""
    for label, v in wd.items():
        if not isinstance(v, dict):
            v = {}
        wd_rows += (
            "<tr>"
            "<td>%s</td>" % (_h(label),)
            + "<td>%s</td>" % (_fmt_hours(v.get("hours", 0.0)),)
            + "<td>%s</td>" % (v.get("workdayCount", 0),)
            + "<td>%s</td>" % (v.get("recordCount", 0),)
            + "</tr>"
        )
    if not wd_rows:
        wd_rows = ('<tr><td colspan="4" style="text-align:center;color:#94a3b8">'
                   "暂无星期分布数据</td></tr>")
    ot = stats.get("overtimeDays") or []
    ot_rows = ""
    for item in ot:
        if not isinstance(item, dict):
            continue
        ot_rows += (
            "<tr>"
            "<td>%s</td>" % (_h(item.get("date", "")),)
            + "<td>%s</td>" % (_fmt_hours(item.get("hours", 0.0)),)
            + "<td>%s</td>" % (_fmt_hours(item.get("overtimeHours", 0.0)),)
            + "</tr>"
        )
    if not ot_rows:
        ot_rows = ('<tr><td colspan="3" style="text-align:center;color:#94a3b8">'
                   "无加班日(单日未超 8h)</td></tr>")
    # 项目级守恒校验摘要
    total_check = 0.0
    checked = 0
    for _, pst in _dict_iter(stats.get("projectStats")):
        if not isinstance(pst, dict):
            continue
        tb = pst.get("timeBreakdown") or {}
        if tb:
            total_check += tb.get("totalHours", 0.0)
            checked += 1
    cons_note = (
        "<div class=\"note\">项目级守恒校验:共 %d 个项目带 timeBreakdown,"
        "合计总工时 %.1f h(应等于 Section 1 总工时,允许四舍五入误差 ±0.1)。"
        "</div>" % (checked, total_check)
    )
    return (
        '<section id="section-5">'
        "<h2>5. 工时拆解</h2>"
        '<p style="color:#64748b;font-size:13px">'
        "工作工时=单日≤8h 部分;加班工时=单日超出 8h 部分;期望=工作日×7.5h/天</p>"
        + cons_note
        + "<h3>星期分布</h3>"
        + "<table>"
        + "<thead><tr><th>星期</th><th>工时(h)</th>"
        + "<th>出勤天数</th><th>记录数</th></tr></thead>"
        + "<tbody>" + wd_rows + "</tbody></table>"
        + "<h3>加班日清单(单日 &gt; 8h)</h3>"
        + "<table>"
        + "<thead><tr><th>日期</th><th>当日工时(h)</th>"
        + "<th>其中加班(h)</th></tr></thead>"
        + "<tbody>" + ot_rows + "</tbody></table>"
        + "</section>"
    )
def _render_section6_risks(stats):
    """Section 6 风险预警:项目风险评分表 + 集中度提示。"""
    rows = ""
    for name, pst in _dict_iter(stats.get("projectStats")):
        if not isinstance(pst, dict):
            continue
        risk = pst.get("riskScore") or {}
        status = risk.get("status", "unknown")
        factors = risk.get("factors") or {}
        factor_txt = " / ".join(
            "%s %s" % (_h(k), _fmt_pct(v)) if isinstance(v, (int, float))
            else "%s %s" % (_h(k), _h(v))
            for k, v in sorted(factors.items())
        )
        rows += (
            "<tr>"
            "<td>%s</td>" % (_h(name),)
            + '<td><span class="badge risk-%s">%s</span></td>'
              % (_h(status), _h(_risk_label(status)))
            + "<td>%s</td>" % (_fmt_hours(risk.get("score", 0.0)),)
            + "<td>%s</td>" % (factor_txt or "—",)
            + "</tr>"
        )
    if not rows:
        rows = ('<tr><td colspan="4" style="text-align:center;color:#94a3b8">'
                "暂无风险数据(缺 project-metadata / 快照时全部待评估)</td></tr>")
    conc = stats.get("projectConcentration") or {}
    top1 = conc.get("top1") or {}
    top3 = conc.get("top3") or {}
    conc_note = (
        "<div class=\"note\">项目集中度:Top1 %s 占 %.1f%%;"
        "Top3 %s 合计占 %.1f%%。集中度高 → 单项目依赖风险,"
        "需关注资源分散与备援。</div>"
        % (
            _h(top1.get("name", "—")),
            float(top1.get("pct", 0.0) or 0.0),
            _h("、".join(top3.get("names") or []) or "—"),
            float(top3.get("pct", 0.0) or 0.0),
        )
    )
    return (
        '<section id="section-6">'
        "<h2>6. 风险预警</h2>"
        '<p style="color:#64748b;font-size:13px">'
        "风险评分 5 因子加权(进度偏差/工时投入偏差/加班强度/人员缺口/紧迫度);"
        "&lt;-30 高风险 / -30~-10 中风险 / &gt;-10 正常 / 缺数据待评估</p>"
        + conc_note
        + "<table>"
        + "<thead><tr><th>项目</th><th>风险状态</th><th>评分</th>"
        + "<th>因子明细</th></tr></thead>"
        + "<tbody>" + rows + "</tbody></table>"
        + "</section>"
    )


def _render_section7_insights(stats):
    """Section 7 关键洞察:自动从 stats 派生高价值结论(纯文本列表)。"""
    s = _get_summary(stats)
    total = _sum_key(stats, "totalHours")
    insights = []
    # 1) 总体状态
    over = s.get("overPct", 0.0) or 0.0
    if over > 10:
        insights.append(
            "总体超载率 %.1f%%:整体工时高于期望(工作日×7.5h/天),"
            "关注长期加班与人员负荷。" % over)
    elif over < -10:
        insights.append(
            "总体欠量 %.1f%%:实际工时低于期望,需核实缺勤/记录缺失原因。"
            % over)
    else:
        insights.append(
            "总体负荷均衡:超载率 %.1f%%,总工时 %.1f h 与期望基本持平。"
            % (over, total))
    # 2) 项目集中度
    conc = stats.get("projectConcentration") or {}
    top1 = conc.get("top1") or {}
    if top1.get("name"):
        insights.append(
            "最大项目「%s」工时 %.1f h,占比 %.1f%%,"
            "是该周期最主要的资源投入方向。"
            % (_h(top1.get("name")), top1.get("hours", 0.0), top1.get("pct", 0.0)))
    # 3) 加班情况
    ot = stats.get("overtimeDays") or []
    if ot:
        peak = ot[0] if isinstance(ot[0], dict) else {}
        insights.append(
            "共 %d 个加班日(单日 &gt; 8h),最高单日 %s %.1f h(加班 %.1f h),"
            "建议复查该日任务安排。"
            % (len(ot), _h(peak.get("date", "?")),
               peak.get("hours", 0.0), peak.get("overtimeHours", 0.0)))
    else:
        insights.append("统计周期内无加班日,工时均在 8h/天以内。")
    # 4) 成员贡献分布
    rank = stats.get("contributionRank")
    if not rank:
        rank = _derive_rank_from_member_stats(stats.get("memberStats"))
    if rank and isinstance(rank[0], dict):
        top_m = rank[0]
        insights.append(
            "工时贡献最高成员:%s(%s),%.1f h,超载率 %s。"
            % (_h(top_m.get("name", "")), _h(top_m.get("roleLabel", "—")),
               top_m.get("totalHours", 0.0), _fmt_pct(top_m.get("overPct", 0.0))))
    # 5) 高风险项目
    high_risks = []
    for name, pst in _dict_iter(stats.get("projectStats")):
        if not isinstance(pst, dict):
            continue
        risk = pst.get("riskScore") or {}
        if risk.get("status") == "high":
            high_risks.append(name)
    if high_risks:
        insights.append(
            "高风险项目 %d 个:%s,建议优先安排资源与排期复核。"
            % (len(high_risks), _h("、".join(high_risks))))
    # 6) 数据完整度
    dedupe = stats.get("dedupe") or {}
    if dedupe.get("removed", 0):
        insights.append(
            "去重环节剔除 %d 条重复记录,统计结果已去重。"
            % dedupe["removed"])
    li = "".join("<li>%s</li>" % _h(t) for t in insights)
    if not li:
        li = "<li>暂无足够数据生成洞察。</li>"
    return (
        '<section id="section-7">'
        "<h2>7. 关键洞察</h2>"
        '<p style="color:#64748b;font-size:13px">'
        "基于本期数据自动派生的结论(供管理层速览)</p>"
        '<ul class="insight">' + li + "</ul>"
        "</section>"
    )


def _render_section8_notes(stats):
    """Section 8 数据说明:口径、范围、降级与限制说明。"""
    s = _get_summary(stats)
    dr = s.get("dateRange") or {}
    start = dr.get("start", "—")
    end = dr.get("end", "—")
    dedupe = stats.get("dedupe") or {}
    notes = [
        ("工时口径", "期望工时=工作日×7.5h/天;工作工时=单日≤8h 部分;"
                   "加班工时=单日超出 8h 部分;totalHours=workHours+overtimeHours(守恒)。"),
        ("统计周期", "%s ~ %s,共 %s 个工作日。" % (start, end, s.get("workdays", "—"))),
        ("成员范围", "按 --members 指定名单(缺省=14 人全员名单)统计。"),
        ("项目归并", "参与人数<3 的零散非项目类记录归并入「其他」桶;"
                   "已知真实项目永不归并。"),
        ("数据来源", "AdsPower(127.0.0.1:50325)+ Playwright 抓取仓颉系统日报;"
                   "项目元数据/月度快照/编制文件缺失时对应字段显示「—」或待评估。"),
    ]
    if dedupe.get("removed", 0):
        notes.append(("去重", "剔除重复记录 %d 条(按日期+成员+项目+工时)。"
                      % dedupe["removed"]))
    rows = "".join(
        "<tr><th>%s</th><td>%s</td></tr>" % (_h(k), _h(v)) for k, v in notes)
    return (
        '<section id="section-8">'
        "<h2>8. 数据说明</h2>"
        '<p style="color:#64748b;font-size:13px">统计口径与限制,'
        "解读本报告前请先阅读本节</p>"
        "<table><tbody>" + rows + "</tbody></table>"
        "</section>"
    )


def _render_section9_appendix(stats):
    """Section 9 附录:角色体系、成员-角色对照、项目清单与生成信息。"""
    # 角色体系
    role_rows = ""
    for role in ROLE_ORDER:
        label = ROLE_LABELS.get(role, role)
        members = sorted(ROLES.get(role, frozenset()))
        if role == DEV_ROLE:
            known = set()
            for r in ROLES.values():
                known |= set(r)
            members = sorted(
                m for m in (ALL_V19_MEMBERS or []) if m not in known)
        role_rows += (
            "<tr><td>%s</td><td>%s</td><td>%s</td></tr>"
            % (_h(role), _h(label), _h("、".join(members) or "—")))
    # 项目清单
    proj_items = ""
    for name, pst in _dict_iter(stats.get("projectStats")):
        if not isinstance(pst, dict):
            continue
        proj_items += "<li>%s(%.1f h, %d 人)</li>" % (
            _h(name), pst.get("hours", 0.0), pst.get("memberCount", 0))
    if not proj_items:
        proj_items = "<li>暂无项目数据。</li>"
    # 成员清单
    member_items = ""
    for name, mst in _dict_iter(stats.get("memberStats")):
        if isinstance(mst, dict):
            member_items += "<li>%s</li>" % _h(mst.get("name", name) or name)
        else:
            member_items += "<li>%s</li>" % _h(name)
    if not member_items:
        member_items = "<li>暂无成员数据。</li>"
    return (
        '<section id="section-9">'
        "<h2>9. 附录</h2>"
        "<h3>角色体系</h3>"
        "<table>"
        "<thead><tr><th>角色 key</th><th>中文</th><th>成员</th></tr></thead>"
        "<tbody>" + role_rows + "</tbody></table>"
        "<h3>项目清单</h3><ul>" + proj_items + "</ul>"
        "<h3>成员清单</h3><ul>" + member_items + "</ul>"
        "<h3>生成信息</h3>"
        "<table><tbody>"
        "<tr><th>生成工具</th><td>report-analyzer %s</td></tr>"
        "<tr><th>生成时间</th><td>%s</td></tr>"
        "</tbody></table>"
        "</section>" % (_h(APP_VERSION), _h(time.strftime("%Y-%m-%d %H:%M:%S")))
    )


def generate_html_report(stats, start_date=None, end_date=None):
    """生成 9-Section 完整 HTML 周报(自包含文档,UTF-8)。

    参数:
      stats      — calculate_stats 输出 dict(兼容扁平 mock dict)
      start_date — 周期开始(可选,缺省取 stats.summary.dateRange.start)
      end_date   — 周期结束(可选,缺省取 stats.summary.dateRange.end)
    返回完整 HTML 字符串(含 <html>/</html> 文档根)。
    """
    s = _get_summary(stats)
    dr = s.get("dateRange") or {}
    start = start_date or dr.get("start") or ""
    end = end_date or dr.get("end") or ""
    toc = "".join(
        "<li><a href=\"#%s\">%s</a></li>" % (sid, _h(title))
        for sid, title in SECTION_TITLES
    )
    body = (
        _render_section1_overview(stats)
        + _render_section2_projects(stats)
        + _render_section3_members(stats)
        + _render_section4_member_details(stats)
        + _render_section5_breakdown(stats)
        + _render_section6_risks(stats)
        + _render_section7_insights(stats)
        + _render_section8_notes(stats)
        + _render_section9_appendix(stats)
    )
    total = _sum_key(stats, "totalHours")
    header = (
        '<header class="report-header">'
        "<h1>项目成员工作报告</h1>"
        "<p>统计周期:%s ~ %s</p>"
        "<p>总工时 %s h / 成员 %s 人 / 项目 %s 个 / 记录 %s 条</p>"
        "</header>"
        % (
            _h(start), _h(end),
            _fmt_hours(total),
            s.get("memberCount", 0),
            s.get("projectCount", 0),
            s.get("recordCount", 0),
        )
    )
    html = (
        "<!DOCTYPE html>"
        "<html>"
        "<head>"
        '<meta charset="utf-8"/>'
        '<meta name="viewport" content="width=device-width,initial-scale=1"/>'
        "<title>项目成员工作报告 %s ~ %s</title>"
        % (_h(start), _h(end))
        + _REPORT_CSS
        + "</head>"
        + "<body>"
        + '<div class="container">'
        + header
        + '<nav class="toc"><strong>目录</strong><ol>' + toc + "</ol></nav>"
        + body
        + '<footer class="report-footer">本报告由 report-analyzer '
          + _h(APP_VERSION)
          + " 自动生成,数据来自仓颉系统日报。</footer>"
        + "</div>"
        + "</body>"
        + "</html>"
    )
    return html


def write_html(html, path):
    """写 HTML 文件(UTF-8 无 BOM);返回写入字节数。

    参数:
      html — generate_html_report 返回的完整 HTML 字符串
      path — 输出文件路径(父目录不存在时自动创建)
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(html, encoding="utf-8")
    return len(html.encode("utf-8"))
# =====================================================================
# 主入口段(U5 追加:第 4 段 —— main/CLI 串接 + 离线 JSON 入口)
# ---------------------------------------------------------------------
# 串接链路:
#   fetch_daily_reports_via_playwright(--from-json 时改为 load_records_from_json)
#     → backfill_member_and_project_fields(除非 --no-backfill-v2)
#     → calculate_stats → _format_terminal_summary / save_stats_json
#     → generate_html_report → write_html
# 离线入口(--from-json <path>):读取本地 records JSON(record 列表或
#   {"records": [...]} 包裹),跳过 AdsPower/Playwright 抓取,直接统计+渲染。
#   该入口同时供 rerender.py 与单元测试复用,保证可离线重放。
# =====================================================================


def load_project_metadata(path=None):
    """加载 project-metadata.json(v2.0 数据源 1)。

    结构:{"projects": {项目名: {status/type/weight/urgency...}},
           "statusMapping": {status: 中文标签}, "version": ...}
    json5 可用时兼容注释/尾逗号;文件缺失返回 None(调用方降级)。
    """
    p = Path(path) if path else Path(__file__).resolve().parent / DEFAULT_PROJECT_METADATA
    if not p.exists():
        LOG.warning("project-metadata.json 不存在(%s) —— 项目状态/类型降级为待评估", p)
        return None
    try:
        if json5 is not None:
            with open(p, encoding="utf-8") as fh:
                data = json5.load(fh)
        else:
            with open(p, encoding="utf-8") as fh:
                data = json.load(fh)
        if not isinstance(data, dict):
            LOG.error("project-metadata.json 顶层必须是对象")
            return None
        data.setdefault("projects", {})
        data.setdefault("statusMapping", {})
        LOG.info("project-metadata 已加载: %d 个项目", len(data["projects"]))
        return data
    except Exception as exc:  # noqa: BLE001
        LOG.error("加载 project-metadata.json 失败: %s", exc)
        return None


def load_monthly_snapshots(dir_path=None):
    """加载月度快照目录(v2.0 数据源 2):完成% 三段(上月/本月/预计)。

    目录结构约定:
      {dir}/prev_completions.json   —— 上月完成%(项目名: 完成%)
      {dir}/current_completions.json—— 本月完成%(项目名: 完成%)
      {dir}/forecast_completions.json—— 预计月末完成%(可选)
    返回 {"prev_completions": {...}, "current_completions": {...},
          "forecast_completions": {...}};目录缺失返回 None。
    """
    base = Path(dir_path) if dir_path else Path(__file__).resolve().parent / DEFAULT_MONTHLY_SNAPSHOT_DIR
    if not base.is_dir():
        LOG.warning("月度快照目录不存在(%s) —— 完成% 三段降级", base)
        return None
    snap = {"prev_completions": {}, "current_completions": {}, "forecast_completions": {}}
    for key, fname in (("prev_completions", "prev_completions.json"),
                       ("current_completions", "current_completions.json"),
                       ("forecast_completions", "forecast_completions.json")):
        fp = base / fname
        if not fp.exists():
            LOG.debug("快照文件缺失(跳过): %s", fp)
            continue
        try:
            with open(fp, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                snap[key].update(data)
        except Exception as exc:  # noqa: BLE001
            LOG.error("加载快照 %s 失败: %s", fp, exc)
    if not any(snap.values()):
        LOG.warning("快照目录无有效数据 —— 完成% 三段全部为空")
    else:
        LOG.info("月度快照已加载: 上月 %d / 本月 %d / 预计 %d",
                 len(snap["prev_completions"]), len(snap["current_completions"]),
                 len(snap["forecast_completions"]))
    return snap


def load_headcount_target(path=None):
    """加载 headcount-target.json(v2.0 数据源 3):岗位编制目标。

    结构:{"targets": {role: {target: N, note: "..."}}, "version": ...}
    文件缺失返回 None(人力盘点按 actual-only 展示,缺口=—)。
    """
    p = Path(path) if path else Path(__file__).resolve().parent / DEFAULT_HEADCOUNT_TARGET
    if not p.exists():
        LOG.warning("headcount-target.json 不存在(%s) —— 编制缺口降级", p)
        return None
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict) or "targets" not in data:
            LOG.error("headcount-target.json 缺少 targets 字段")
            return None
        LOG.info("headcount-target 已加载: %d 个岗位目标", len(data["targets"]))
        return data
    except Exception as exc:  # noqa: BLE001
        LOG.error("加载 headcount-target.json 失败: %s", exc)
        return None


def load_records_from_json(path):
    """从本地 JSON 加载日报记录(离线入口,供 --from-json / rerender)。

    兼容三种形态:
      1) 顶层是数组          —— 视为 record 列表
      2) 顶层含 "records"    —— 取 records 字段
      3) 顶层含 "statistics" —— 取 statistics.records
    返回 (records, meta);meta 含可回填的 start/end/members 等提示。
    无法解析时抛 ValueError(调用方转为友好报错并 exit 2)。
    """
    p = Path(path)
    if not p.exists():
        raise ValueError("records JSON 不存在: %s" % path)
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("解析 records JSON 失败(%s): %s" % (path, exc))
    meta = {}
    records = None
    if isinstance(data, list):
        records = data
    elif isinstance(data, dict):
        meta = data.get("meta") or {}
        if isinstance(data.get("records"), list):
            records = data["records"]
        elif isinstance(data.get("statistics"), dict) and isinstance(data["statistics"].get("records"), list):
            records = data["statistics"]["records"]
            if "meta" not in meta:
                meta = data.get("statistics") or {}
    if records is None:
        raise ValueError("records JSON 结构不识别(期望数组或含 records 字段): %s" % path)
    if meta.get("start") and meta.get("end"):
        LOG.info("JSON 内嵌周期提示: %s ~ %s", meta["start"], meta["end"])
    LOG.info("离线加载 %d 条记录: %s", len(records), path)
    return records, meta



def backfill_member_and_project_fields(
    records,
    project_metadata=None,
    monthly_snapshots=None,
    headcount_target=None,
):
    """v2.0 字段回算:为旧 JSON/离线记录补齐 member 角色与项目规范字段。

    --no-backfill-v2 时跳过本函数(保持旧字段原样)。

    回算内容:
      1) 角色: 调用 get_role(member) 写入 role/roleLabel(5 角色体系)
      2) 项目: 全角/引号归一 + 阶段前缀剥离 + alias 最长优先匹配,
         未匹配归入「其他」桶(历史反模式 3 条已规避)
      3) v2.0 增量字段: projectType/status 等由 calculate_stats 内部
         结合三数据源补齐,本函数不重复计算
    返回回填后的新列表(不修改入参)。
    """
    if not records:
        return list(records)
    meta = (project_metadata or {}).get("projects", {}) or {}
    aliases = {}
    for pname, pmeta in meta.items():
        if not isinstance(pmeta, dict):
            continue
        for a in (pmeta.get("aliases") or []):
            aliases[str(a)] = pname
    out = []
    for r in records:
        if not isinstance(r, dict):
            continue
        rec = dict(r)
        member = str(rec.get("name") or "")
        role = get_role(member)
        rec.setdefault("role", role)
        rec.setdefault("roleLabel", get_role_label(role))
        raw = str(rec.get("project") or "")
        norm = normalize_project_name(raw)
        norm = strip_stage_prefix(norm)
        if not norm:
            norm = NON_PROJECT_BUCKET
        if norm in meta:
            rec["project"] = norm
        elif norm in aliases:
            rec["project"] = aliases[norm]
        else:
            top = extract_top_level_project(norm)
            if top in meta:
                rec["project"] = top
            elif top in aliases:
                rec["project"] = aliases[top]
            else:
                rec["project"] = norm
        rec.setdefault("projectType", _infer_project_type(
            rec["project"], {"hours": rec.get("hours", 0.0), "memberCount": 1},
            project_metadata))
        out.append(rec)
    n_changed = sum(1 for r in out if r.get("role") != get_role(r.get("name") or ""))
    if n_changed:
        LOG.info("v2.0 回算完成: %d/%d 条记录角色已归一", n_changed, len(out))
    return out


def save_stats_json(stats, path):
    """将统计结果写为结构化 JSON(UTF-8 无 BOM,ensure_ascii=False)。

    供 --output 与 rerender.py 共用;返回写入字节数。
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": {
            "generator": APP_NAME,
            "version": APP_VERSION,
            "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "statistics": stats,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    p.write_text(text, encoding="utf-8")
    LOG.info("统计 JSON 已写出: %s(%d 字节)", p, len(text.encode("utf-8")))
    return len(text.encode("utf-8"))


def _default_output_names(start, end, html_only=False):
    """缺省输出文件名:report-{start}_to_{end}.json/.html。"""
    key = "%s_to_%s" % (format_date(start), format_date(end))
    if html_only:
        return REPORT_HTML_TEMPLATE.format(start=format_date(start), end=format_date(end))
    return (REPORT_JSON_TEMPLATE.format(start=format_date(start), end=format_date(end)),
            REPORT_HTML_TEMPLATE.format(start=format_date(start), end=format_date(end)))


def _print_terminal_summary_if_needed(stats, args):
    """--quiet 时跳过终端摘要;否则打印 _format_terminal_summary。"""
    if getattr(args, "quiet", False):
        LOG.info("--quiet: 跳过终端摘要")
        return
    print(_format_terminal_summary(stats))


def _run_stats_pipeline(records, members, start, end, args, metadata, snapshots, headcount):
    """公共统计流水线:回算(可选)→ calculate_stats → 输出 JSON/HTML。

    被 main 的在线/离线两条路径共用,保证行为一致:
      records + members + 周期 + 三数据源 → stats
      → 终端摘要 / --output JSON / --html HTML(write_html)
    返回 (stats, output_paths);stats 为空记录时返回 (None, {})。
    """
    if not records:
        LOG.error("无有效记录 —— 检查抓取登录态或 --from-json 文件内容。")
        return None, {}
    if not args.no_backfill_v2:
        records = backfill_member_and_project_fields(
            records, metadata, snapshots, headcount)
    stats = calculate_stats(
        records=records,
        target_members=members,
        start_date=start,
        end_date=end,
        project_metadata=metadata,
        monthly_snapshots=snapshots,
        headcount_target=headcount,
    )
    json_path, html_path = _resolve_outputs(args, start, end)
    if json_path:
        save_stats_json(stats, json_path)
    if args.html:
        html = generate_html_report(stats, start_date=start, end_date=end)
        write_html(html, html_path)
    elif args.json_only:
        LOG.info("--json-only: 跳过 HTML 渲染")
    else:
        html = generate_html_report(stats, start_date=start, end_date=end)
        write_html(html, html_path)
    _print_terminal_summary_if_needed(stats, args)
    return stats, {"json": json_path, "html": html_path}



def main(argv=None) -> int:
    """CLI 主入口:解析参数 → 数据源加载 → 抓取/离线 → 统计 → 输出。

    返回退出码:
      0  成功
      1  无有效记录 / 抓取失败(不可恢复)
      2  参数或输入文件错误(如 --from-json 指向不存在/损坏文件)

    两条数据路径(互斥,优先 --from-json):
      [在线]  fetch_daily_reports_via_playwright(AdsPower + Playwright)
              → 失败成员记入日志,不中断;全部失败视为无记录
      [离线]  --from-json <path> → load_records_from_json
              → 适用于单元测试、rerender.py 与历史数据重放
    后续统一走 _run_stats_pipeline(回算 → calculate_stats → 输出)。
    """
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    _validate_cli_combinations(args, parser)
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    _detect_python_runtime()
    LOG.info("%s %s 启动", APP_NAME, APP_VERSION)

    # ---- 1. 三数据源(v2.0)----
    metadata, snapshots, headcount = _load_v2_sources(args)

    # ---- 2. 成员与周期 ----
    members = _resolve_members(None, args.members)
    start, end = resolve_dates(args.start_date, args.end_date)
    LOG.info("成员 %d 人,日期范围 %s ~ %s", len(members), format_date(start), format_date(end))

    # ---- 3. 数据获取(在线/离线二选一)----
    records = []
    if args.from_json:
        # 离线入口:直接读本地 records JSON,跳过 AdsPower/Playwright
        try:
            records, meta = load_records_from_json(args.from_json)
        except ValueError as exc:
            LOG.error(str(exc))
            return 2
        # JSON 内嵌周期提示优先于命令行缺省(命令行显式指定仍以命令行为主)
        if not args.start_date and meta.get("start"):
            try:
                start = parse_date(str(meta["start"]))
            except Exception:  # noqa: BLE001
                pass
        if not args.end_date and meta.get("end"):
            try:
                end = parse_date(str(meta["end"]))
            except Exception:  # noqa: BLE001
                pass
        if start > end:
            start, end = end, start
        members = _resolve_members(meta.get("members"), args.members)
        LOG.info("离线模式: 记录 %d 条,周期 %s ~ %s", len(records), format_date(start), format_date(end))
    else:
        # 在线模式:AdsPower + Playwright 抓仓颉日报
        if not args.adspower_user_id:
            LOG.info("探测 AdsPower 本地活跃浏览器(127.0.0.1:%d)...", ADSPOWER_PORT)
        result = fetch_daily_reports_via_playwright(
            members=members,
            start_date=start,
            end_date=end,
            adspower_user_id=args.adspower_user_id,
            force_reload=args.force_reload,
            simplify_project=args.simplify_project,
        )
        records = result.get("records", [])
        failed = result.get("failed", [])
        LOG.info("抓取完成:有效记录 %d 条,失败成员 %d 人 %s",
                 len(records), len(failed), failed or "")
        if failed:
            LOG.warning("以下成员抓取失败(已跳过): %s", "、".join(failed))

    # ---- 4. 统计流水线 + 输出 ----
    stats, paths = _run_stats_pipeline(records, members, start, end,
                                       args, metadata, snapshots, headcount)
    if stats is None:
        return 1
    return _main_print_result(stats, paths)


def _detect_python_runtime():
    """记录运行环境信息(供诊断:Python 版本 / 平台)。"""
    LOG.debug("runtime: %s / %s", sys.version.split()[0], sys.platform)
    return (sys.version.split()[0], sys.platform)


def _validate_cli_combinations(args, parser):
    """CLI 参数组合校验:--from-json 与在线参数互斥;--quiet 与 --verbose 互斥。

    非法组合直接打印错误并退出(return 2),避免走到抓取阶段才发现。
    """
    if args.from_json and args.force_reload:
        parser.error("--from-json 为离线模式,与 --force-reload 互斥")
    if args.from_json and args.simplify_project:
        parser.error("--from-json 为离线模式,与 --simplify-project 互斥(离线已回算)")
    if args.quiet and args.verbose:
        parser.error("--quiet 与 --verbose 互斥")


def _load_v2_sources(args):
    """统一加载 v2.0 三数据源(供 main 与 rerender 共用)。

    返回 (metadata, snapshots, headcount);no_backfill_v2 时全为 None。
    """
    if getattr(args, "no_backfill_v2", False):
        return None, None, None
    return (
        load_project_metadata(getattr(args, "project_metadata", None)),
        load_monthly_snapshots(getattr(args, "monthly_snapshot_dir", None)),
        load_headcount_target(getattr(args, "headcount_target", None)),
    )


def _resolve_members(meta_members, args_members, default=True):
    """成员合并:meta.members 优先(离线 JSON 内嵌名单),否则命令行/缺省。

    规则:
      - meta 提供名单且非空 → 用之(除非命令行显式给了非全员名单)
      - 命令行显式名单(非'全员') → 优先命令行
      - 都缺省 → ALL_V19_MEMBERS
    """
    explicit = (args_members or "").strip() not in ("", DEFAULT_MEMBERS_TOKEN)
    if explicit:
        return parse_members_arg(args_members)
    if meta_members:
        cleaned = [str(m) for m in meta_members if str(m).strip()]
        if cleaned:
            return cleaned
    if default:
        return list(ALL_V19_MEMBERS)
    return []
def render_html_from_stats(stats, start=None, end=None, path=None):
    """stats → HTML 渲染 + 写盘(封装 generate_html_report + write_html)。

    供 rerender.py 与 --from-json 路径共用;path 缺省按周期命名。
    返回写入的 HTML 路径。
    """
    if path is None:
        start_fmt = format_date(start) if start else _get_summary(stats).get("dateRange", {}).get("start", "unknown")
        end_fmt = format_date(end) if end else _get_summary(stats).get("dateRange", {}).get("end", "unknown")
        path = REPORT_HTML_TEMPLATE.format(start=start_fmt, end=end_fmt)
    html = generate_html_report(stats, start_date=start, end_date=end)
    write_html(html, path)
    return path


def _stat_key(stats, key, default=0.0):
    """安全读取 stats.summary 数值字段(缺失/None 时回落 default)。"""
    s = stats.get("summary", {}) if isinstance(stats, dict) else {}
    v = s.get(key, default)
    return default if v is None else v


def _summarize_outputs(paths):
    """输出产物摘要(供终端/日志提示)。"""
    parts = []
    if paths.get("json"):
        parts.append("JSON=%s" % paths["json"])
    if paths.get("html"):
        parts.append("HTML=%s" % paths["html"])
    return " | ".join(parts) if parts else "(无文件输出,仅终端摘要)"


def _record_stat_sanity(stats):
    """统计结果健康度自查:守恒校验 + 关键字段存在性。

    返回 (ok, [问题...]);供 rerender 与 CI 调用方快速判定。
    校验项:
      - totalHours ≈ workHours + overtimeHours(±0.1 允许四舍五入)
      - summary 含 dateRange / workdays / overPct
      - memberStats / projectStats 非空
    """
    issues = []
    s = stats.get("summary", {}) if isinstance(stats, dict) else {}
    total = float(s.get("totalHours", 0.0) or 0.0)
    work = float(s.get("workHours", 0.0) or 0.0)
    ot = float(s.get("overtimeHours", 0.0) or 0.0)
    if abs(total - round(work + ot, 1)) > 0.11:
        issues.append("守恒校验失败: total=%.1f != work+ot=%.1f" % (total, work + ot))
    for key in ("dateRange", "workdays", "overPct"):
        if key not in s:
            issues.append("summary 缺少字段: %s" % key)
    if not stats.get("memberStats"):
        issues.append("memberStats 为空(成员维度缺失)")
    if not stats.get("projectStats"):
        issues.append("projectStats 为空(项目维度缺失)")
    return (len(issues) == 0, issues)


def _ensure_suffix(path, suffix):
    """确保输出路径带指定后缀(缺省补全),返回规范化 Path。"""
    p = Path(path)
    if not p.name.lower().endswith(suffix.lower()):
        p = p.with_name(p.name + suffix)
    return p


def _resolve_outputs(args, start, end):
    """由 CLI 参数解析最终输出路径(JSON / HTML),缺省按周期命名。

    返回 (json_path, html_path):
      - --output 指定 JSON(缺失后缀自动补 .json)
      - --html 指定 HTML(缺失后缀自动补 .html)
      - --json-only 且无 --output → 仅默认 JSON
      - 全部缺省 → 默认 JSON + HTML 双输出
    """
    json_path = None
    html_path = None
    default_json, default_html = _default_output_names(start, end)
    if args.output:
        json_path = str(_ensure_suffix(args.output, ".json"))
    elif not args.html:
        json_path = default_json
    if args.html:
        html_path = str(_ensure_suffix(args.html, ".html"))
    elif not args.json_only:
        html_path = default_html
    return json_path, html_path



def rerender_records(
    records,
    members=None,
    start=None,
    end=None,
    project_metadata=None,
    monthly_snapshots=None,
    headcount_target=None,
    no_backfill=False,
    json_out=None,
    html_out=None,
    quiet=False,
):
    """对已有记录重算统计并渲染 HTML(供 rerender.py 与离线测试复用)。

    这是 report-analyzer 统计/渲染链路的高层封装:
      records → (可选 backfill) → calculate_stats → JSON/HTML 输出

    参数与 CLI 对齐:
      members           成员名单(缺省 = meta/全员)
      start/end         周期(缺省 = 记录最小/最大日期)
      no_backfill       = --no-backfill-v2
      json_out/html_out 输出路径(缺省按周期命名)
      quiet             不打印终端摘要
    返回 (stats, {"json": path|None, "html": path|None});
    记录为空返回 (None, {})。
    """
    if not records:
        LOG.error("rerender_records: 无记录可回算")
        return None, {}
    if no_backfill:
        metadata = snapshots = headcount = None
    else:
        metadata = project_metadata
        snapshots = monthly_snapshots
        headcount = headcount_target
    # 周期推导:显式 > 记录范围
    if start is None and records:
        dates = [r.get("date") for r in records if r.get("date")]
        if dates:
            try:
                start = min(parse_date(d) for d in dates)
                end = max(parse_date(d) for d in dates)
            except Exception:  # noqa: BLE001
                start = end = None
    if start is None:
        today = _dt.date.today()
        start = _dt.date(today.year, today.month, 1)
        end = today
    members = list(members) if members else list(ALL_V19_MEMBERS)
    stats = calculate_stats(
        records=records,
        target_members=members,
        start_date=start,
        end_date=end,
        project_metadata=metadata,
        monthly_snapshots=snapshots,
        headcount_target=headcount,
    )
    paths = {}
    if json_out:
        paths["json"] = str(_ensure_suffix(json_out, ".json"))
        save_stats_json(stats, paths["json"])
    if html_out:
        paths["html"] = render_html_from_stats(stats, start, end, html_out)
    if not quiet:
        print(_format_terminal_summary(stats))
    ok, issues = _record_stat_sanity(stats)
    for issue in issues:
        LOG.warning("健康度提示: %s", issue)
    LOG.info("rerender_records 完成: %s", _summarize_outputs(paths))
    return stats, paths


def rerender_from_records_path(
    records_path,
    project_metadata=None,
    monthly_snapshots=None,
    headcount_target=None,
    no_backfill=False,
    json_out=None,
    html_out=None,
    quiet=False,
):
    """从 records JSON 文件重放重算(rerender.py 主路径)。

    流程:load_records_from_json → 解析 meta(members/周期)
      → rerender_records → (stats, paths)
    返回 (stats, paths, meta);文件问题抛 ValueError。
    """
    records, meta = load_records_from_json(records_path)
    members = meta.get("members") or None
    start = meta.get("start") or None
    end = meta.get("end") or None
    if start:
        try:
            start = parse_date(str(start))
        except Exception:  # noqa: BLE001
            start = None
    if end:
        try:
            end = parse_date(str(end))
        except Exception:  # noqa: BLE001
            end = None
    stats, paths = rerender_records(
        records=records,
        members=members,
        start=start,
        end=end,
        project_metadata=project_metadata,
        monthly_snapshots=monthly_snapshots,
        headcount_target=headcount_target,
        no_backfill=no_backfill,
        json_out=json_out,
        html_out=html_out,
        quiet=quiet,
    )
    return stats, paths, meta


def _main_print_result(stats, paths, return_code=0):
    """main 收尾:汇总输出产物并打印(供在线/离线双路径复用)。"""
    LOG.info("完成: %s", _summarize_outputs(paths))
    if stats is not None and not getattr(logging.getLogger(), "disabled", False):
        LOG.debug("summary: total=%.1fh work=%.1fh ot=%.1fh over=%.1f%%",
                  _stat_key(stats, "totalHours"),
                  _stat_key(stats, "workHours"),
                  _stat_key(stats, "overtimeHours"),
                  _stat_key(stats, "overPct"))
    return return_code


# ===================== 主入口段结束 =====================

if __name__ == "__main__":
    sys.exit(main())
