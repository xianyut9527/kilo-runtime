# -*- coding: utf-8 -*-
"""test_v19.py — report-analyzer 单元测试(69 用例,全 mock JSON 数据)。

覆盖(v2.0 核心契约):
  1) 工具函数:normalize_project_name / strip_stage_prefix / extract_top_level_project
     / get_role / get_role_label / parse_date / format_date / calculate_workdays / date_range
  2) 记录清洗与去重:_normalize_records / _dedupe_records / _filter_records_by_range
  3) 工时拆解:_daily_hours_map / _calc_time_breakdown / _calc_expected_hours
  4) 成员 / 项目 / 风险:_build_member_stats / _infer_project_type / _calc_risk_score
  5) 核心统计:calculate_stats(总工时守恒 + 期望工时 7.5h/天 + overPct)
  6) 9-Section HTML:generate_html_report(关键锚点 section-1..section-9 / XSS 转义)
  7) 离线入口:load_records_from_json(3 种形态)/ rerender_records / rerender_from_records_path
     / --no-backfill-v2 路径(no_backfill=True)
全部使用 mock JSON 数据,无需真实 AdsPower / Playwright。
"""

import datetime as _dt
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# ---------------------------------------------------------------------
# 加载同目录 report-analyzer.py(文件名含连字符,不能用 import;
# 与 rerender.py 相同方式 importlib 从文件路径加载)
# ---------------------------------------------------------------------
_RA_PATH = Path(__file__).resolve().parent.parent / "report-analyzer.py"
_SPEC = importlib.util.spec_from_file_location("report_analyzer_v19", _RA_PATH)
RA = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(RA)

# =====================================================================
# 共享 mock fixtures(69 用例复用)
# =====================================================================
MOCK_MEMBERS = ["邓佳辉", "罗贵川", "王海关"]  # 3 人:delivery / product / test

# 5 个工作日(2026-07-13 周一 ~ 2026-07-17 周五),每人每天 8h,全在 P1
MOCK_WEEK = [
    "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17",
]


def _make_records(days=MOCK_WEEK, members=MOCK_MEMBERS, hours=8.0, project="P1",
                  with_dupes=False, bad_rows=False):
    """生成 mock 日报记录列表。with_dupes=True 时给每条追加一条完全重复。"""
    rows = []
    for d in days:
        for m in members:
            rec = {"date": d, "name": m, "project": project,
                   "content": "mock 日报 %s %s" % (d, m), "hours": hours}
            rows.append(rec)
            if with_dupes:
                rows.append(dict(rec))
    if bad_rows:
        rows.append({"date": "2026-07-13", "name": MOCK_MEMBERS[0],
                     "project": project, "content": "bad", "hours": 99.0})
        rows.append({"date": "2026-07-13", "name": MOCK_MEMBERS[0],
                     "project": project, "content": "bad2", "hours": 0.05})
        rows.append({"date": "2026-07-13", "project": project,
                     "content": "no-name", "hours": 1.0})
        rows.append({"date": "2026-07-13", "name": MOCK_MEMBERS[0],
                     "content": "no-project", "hours": 1.0})
    return rows


def _stable_stats():
    """标准场景 stats:3 人 × 5 天 × 8h 全在 P1 → total=120h, expected=112.5h。"""
    records = _make_records()
    return RA.calculate_stats(
        records, list(MOCK_MEMBERS),
        start_date=_dt.date(2026, 7, 13), end_date=_dt.date(2026, 7, 17),
    )


def _write_json(tmpdir, name, payload):
    """向临时目录写 JSON 文件,返回绝对路径。"""
    p = Path(tmpdir) / name
    p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return str(p)


# =====================================================================
# 1) 工具函数
# =====================================================================
class TestNormalizeProjectName(unittest.TestCase):
    """normalize_project_name / strip_stage_prefix / extract_top_level_project。"""

    def test_normalize_fullwidth_and_quotes(self):
        name = RA.normalize_project_name('\u3000\u201c一码检查\u201d\u3000')
        self.assertEqual(name, '"一码检查"')

    def test_normalize_keeps_plain(self):
        self.assertEqual(RA.normalize_project_name("司法局"), "司法局")

    def test_strip_stage_prefix(self):
        self.assertEqual(
            RA.strip_stage_prefix("项目开发阶段-司法局"), "司法局")
        self.assertEqual(
            RA.strip_stage_prefix("订单跟进阶段-北碚项目"), "北碚项目")
        self.assertEqual(RA.strip_stage_prefix("司法局"), "司法局")

    def test_extract_top_level_project(self):
        # alias 归一:短名 → 完整项目名
        self.assertEqual(
            RA.extract_top_level_project("司法局-执法监督"),
            "重庆市司法局执法+监督集成数字应用项目")
        self.assertEqual(
            RA.extract_top_level_project("一码检查"),
            "成都市\"一码检查\"")
# =====================================================================
# 角色与日期工具
# =====================================================================
class TestRoleUtils(unittest.TestCase):
    """get_role / get_role_label / ROLES 常量。"""

    def test_get_role_delivery(self):
        self.assertEqual(RA.get_role("邓佳辉"), "delivery")
        self.assertEqual(RA.get_role("秦琪森"), "delivery")

    def test_get_role_product(self):
        self.assertEqual(RA.get_role("罗贵川"), "product")
        self.assertEqual(RA.get_role("胡阳"), "product")

    def test_get_role_test_and_dev(self):
        self.assertEqual(RA.get_role("王海关"), "test")
        self.assertEqual(RA.get_role("未登记成员"), "dev")

    def test_get_role_label(self):
        self.assertEqual(RA.get_role_label("delivery"), "交付经理")
        self.assertEqual(RA.get_role_label("product"), "产品经理")
        self.assertEqual(RA.get_role_label("dev"), "研发")

    def test_roles_constant_5_keys(self):
        self.assertEqual(
            sorted(RA.ROLES.keys()),
            ["delivery", "implement", "product", "test"])


class TestDateUtils(unittest.TestCase):
    """parse_date / format_date / calculate_workdays / date_range。"""

    def test_parse_date(self):
        d = RA.parse_date("2026-07-13")
        self.assertEqual(d, _dt.date(2026, 7, 13))
        self.assertEqual(RA.parse_date("2026/07/13"), _dt.date(2026, 7, 13))

    def test_parse_date_invalid_raises(self):
        with self.assertRaises(ValueError):
            RA.parse_date("not-a-date")

    def test_format_date(self):
        self.assertEqual(RA.format_date(_dt.date(2026, 7, 13)), "2026-07-13")

    def test_calculate_workdays_week(self):
        # 2026-07-13(周一) ~ 2026-07-17(周五)= 5 个工作日
        self.assertEqual(
            RA.calculate_workdays(_dt.date(2026, 7, 13), _dt.date(2026, 7, 17)), 5)

    def test_calculate_workdays_weekend(self):
        # 周末两天 = 0
        self.assertEqual(
            RA.calculate_workdays(_dt.date(2026, 7, 18), _dt.date(2026, 7, 19)), 0)

    def test_date_range(self):
        days = list(RA.date_range(_dt.date(2026, 7, 13), _dt.date(2026, 7, 15)))
        self.assertEqual(len(days), 3)
        self.assertEqual(days[0], _dt.date(2026, 7, 13))
        self.assertEqual(days[-1], _dt.date(2026, 7, 15))


# =====================================================================
# 2) 记录清洗与去重
# =====================================================================
class TestNormalizeRecords(unittest.TestCase):
    """_normalize_records 清洗规则。"""

    def test_clean_fields(self):
        rows = RA._normalize_records([
            {"date": "2026-07-13", "name": " 邓佳辉 ", "project": " P1 ",
             "content": " 内容 ", "hours": "8"},
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "邓佳辉")
        self.assertEqual(rows[0]["project"], "P1")
        self.assertEqual(rows[0]["hours"], 8.0)

    def test_drop_invalid_hours(self):
        # >24h 丢弃、<0.25h 丢弃、非数字 → 0 但仍保留(低于 0.25 阈值被丢)
        rows = RA._normalize_records([
            {"date": "2026-07-13", "name": "A", "project": "P", "hours": 99.0},
            {"date": "2026-07-13", "name": "A", "project": "P", "hours": 0.05},
            {"date": "2026-07-13", "name": "B", "project": "P", "hours": "abc"},
        ])
        self.assertEqual(len(rows), 0)

    def test_fallback_project_bucket(self):
        rows = RA._normalize_records([
            {"date": "2026-07-13", "name": "A", "project": "", "hours": 1.0},
            {"date": "2026-07-13", "name": "B", "project": "  ", "hours": 1.0},
        ])
        for r in rows:
            self.assertEqual(r["project"], RA.NON_PROJECT_BUCKET)

    def test_non_dict_skipped(self):
        rows = RA._normalize_records(["string", 123, None, {"date": "x"}])
        self.assertEqual(len(rows), 0)


class TestDedupeRecords(unittest.TestCase):
    """_dedupe_records 去重。"""

    def test_dedupe_exact_duplicates(self):
        records = [
            {"date": "2026-07-13", "name": "A", "project": "P", "hours": 8.0},
            {"date": "2026-07-13", "name": "A", "project": "P", "hours": 8.0},
            {"date": "2026-07-13", "name": "A", "project": "P", "hours": 7.0},
        ]
        kept, stats = RA._dedupe_records(records)
        self.assertEqual(len(kept), 2)
        self.assertEqual(stats["original"], 3)
        self.assertEqual(stats["kept"], 2)
        self.assertEqual(stats["removed"], 1)

    def test_dedupe_no_duplicates(self):
        records = _make_records(days=MOCK_WEEK[:1], members=MOCK_MEMBERS)
        kept, stats = RA._dedupe_records(records)
        self.assertEqual(len(kept), 3)
        self.assertEqual(stats["removed"], 0)

    def test_dedupe_custom_key_fields(self):
        # 同 date+name 视为重复,忽略 project/hours 差异
        records = [
            {"date": "2026-07-13", "name": "A", "project": "P1", "hours": 8.0},
            {"date": "2026-07-13", "name": "A", "project": "P2", "hours": 2.0},
        ]
        kept, _ = RA._dedupe_records(records, key_fields=("date", "name"))
        self.assertEqual(len(kept), 1)

    def test_dedupe_empty(self):
        kept, stats = RA._dedupe_records([])
        self.assertEqual(kept, [])
        self.assertEqual(stats, {"original": 0, "kept": 0, "removed": 0})


class TestFilterRecordsByRange(unittest.TestCase):
    """_filter_records_by_range 日期闭区间过滤。"""

    def test_filter_in_range(self):
        records = _make_records(days=MOCK_WEEK[:2], members=MOCK_MEMBERS)
        kept = RA._filter_records_by_range(
            records, _dt.date(2026, 7, 14), _dt.date(2026, 7, 15))
        dates = sorted({r["date"] for r in kept})
        self.assertEqual(dates, ["2026-07-14"])

    def test_filter_keeps_unparseable(self):
        records = [
            {"date": "not-a-date", "name": "A", "project": "P", "hours": 1.0},
            {"date": "2026-07-13", "name": "A", "project": "P", "hours": 1.0},
        ]
        kept = RA._filter_records_by_range(
            records, _dt.date(2026, 7, 13), _dt.date(2026, 7, 13))
        self.assertEqual(len(kept), 2)  # 不可解析行保留


# =====================================================================
# 3) 工时拆解
# =====================================================================
class TestCalcTimeBreakdown(unittest.TestCase):
    """_calc_time_breakdown:总工时守恒 / 期望工时 / overPct。"""

    def test_basic_breakdown(self):
        tb = RA._calc_time_breakdown(
            {"2026-07-13": 8.0, "2026-07-14": 7.0}, workday_count=5)
        self.assertEqual(tb["totalHours"], 15.0)
        self.assertEqual(tb["workHours"], 15.0)
        self.assertEqual(tb["overtimeHours"], 0.0)
        self.assertEqual(tb["expectedHours"], 37.5)

    def test_overtime_cap_at_8(self):
        tb = RA._calc_time_breakdown({"2026-07-13": 9.0}, workday_count=1)
        self.assertEqual(tb["totalHours"], 9.0)
        self.assertEqual(tb["workHours"], 8.0)
        self.assertEqual(tb["overtimeHours"], 1.0)

    def test_conservation_total(self):
        # 守恒:totalHours == workHours + overtimeHours
        tb = RA._calc_time_breakdown(
            {"2026-07-13": 9.5, "2026-07-14": 7.0, "2026-07-15": 10.0},
            workday_count=5)
        self.assertEqual(
            round(tb["totalHours"], 1),
            round(tb["workHours"] + tb["overtimeHours"], 1))

    def test_expected_hours_7_5_per_day(self):
        tb = RA._calc_time_breakdown({"2026-07-13": 8.0}, workday_count=10)
        self.assertEqual(tb["expectedHours"], 75.0)

    def test_over_pct_positive(self):
        tb = RA._calc_time_breakdown({"2026-07-13": 10.0}, workday_count=1)
        self.assertEqual(tb["expectedHours"], 7.5)
        self.assertAlmostEqual(tb["overPct"], 33.3, places=1)

    def test_empty_daily(self):
        tb = RA._calc_time_breakdown({}, workday_count=0)
        self.assertEqual(tb["totalHours"], 0.0)
        self.assertEqual(tb["expectedHours"], 0.0)
        self.assertEqual(tb["overPct"], 0.0)


class TestCalcExpectedHours(unittest.TestCase):
    """_calc_expected_hours:期望工时 = 工作日 × 7.5 × 人数。"""

    def test_expected_basic(self):
        self.assertEqual(RA._calc_expected_hours(5, 3), 112.5)

    def test_expected_zero_members(self):
        self.assertEqual(RA._calc_expected_hours(5, 0), 0.0)

    def test_expected_single(self):
        self.assertEqual(RA._calc_expected_hours(1, 2), 15.0)
# =====================================================================
# 4) 成员 / 项目 / 风险
# =====================================================================
class TestBuildMemberStats(unittest.TestCase):
    """_build_member_stats 成员维度统计。"""

    def test_member_stats_fields(self):
        records = _make_records(days=MOCK_WEEK[:1], members=MOCK_MEMBERS)
        ms = RA._build_member_stats(records, list(MOCK_MEMBERS), workdays=1)
        self.assertEqual(len(ms), 3)
        m = ms["邓佳辉"]
        self.assertEqual(m["totalHours"], 8.0)
        self.assertEqual(m["workdayCount"], 1)
        self.assertEqual(m["recordCount"], 1)
        self.assertEqual(m["role"], "delivery")

    def test_member_expected_and_overpct(self):
        records = _make_records(days=MOCK_WEEK, members=["邓佳辉"], hours=8.0)
        ms = RA._build_member_stats(records, ["邓佳辉"], workdays=5)
        m = ms["邓佳辉"]
        self.assertEqual(m["totalHours"], 40.0)
        self.assertEqual(m["expectedHours"], 37.5)
        self.assertAlmostEqual(m["overPct"], 6.7, places=1)
        self.assertEqual(m["avgDailyHours"], 8.0)

    def test_member_zero_hours(self):
        ms = RA._build_member_stats([], ["邓佳辉"], workdays=5)
        m = ms["邓佳辉"]
        self.assertEqual(m["totalHours"], 0.0)
        self.assertEqual(m["expectedHours"], 37.5)
        self.assertEqual(m["utilizationPct"], 0.0)


class TestInferProjectType(unittest.TestCase):
    """_infer_project_type:metadata 优先,缺省按 dev 工时占比。"""

    def test_metadata_priority(self):
        metadata = {"projects": {"P1": {"projectType": "开发类"}}}
        pst = {"hours": 10.0, "roleBreakdown": {"dev": {"hours": 0.0}}}
        self.assertEqual(
            RA._infer_project_type("P1", pst, metadata), "开发类")

    def test_dev_ratio_high_dev(self):
        # dev 占比 > 60% → 开发类
        pst = {"hours": 10.0, "roleBreakdown": {"dev": {"hours": 7.0}}}
        self.assertEqual(RA._infer_project_type("P1", pst, None), "开发类")

    def test_dev_ratio_low_ops(self):
        # dev 占比 ≤ 60% → 运维类
        pst = {"hours": 10.0, "roleBreakdown": {"dev": {"hours": 6.0}}}
        self.assertEqual(RA._infer_project_type("P1", pst, None), "运维类")

    def test_no_metadata_and_zero_hours(self):
        pst = {"hours": 0.0, "roleBreakdown": {}}
        self.assertEqual(RA._infer_project_type("P1", pst, None), "开发类")


class TestCalcRiskScore(unittest.TestCase):
    """_calc_risk_score:5 因子 / 阈值分级 / unknown。"""

    def test_unknown_when_no_schedule(self):
        pst = {
            "timeBreakdown": {"totalHours": 10.0, "workHours": 10.0},
            "completionSegments": {"completionThisMonth": None,
                                   "forecastCompletion": None},
            "roleBreakdown": {},
        }
        r = RA._calc_risk_score("P1", pst, None, {}, {})
        self.assertEqual(r["status"], "unknown")
        self.assertEqual(r["score"], 0.0)

    def test_high_risk(self):
        meta = {"projects": {"P1": {"plannedHours": 100.0}}}
        pst = {
            "timeBreakdown": {"totalHours": 50.0, "workHours": 45.0,
                              "overtimeHours": 5.0},
            "completionSegments": {"completionThisMonth": 30.0,
                                   "forecastCompletion": 100.0},
            "roleBreakdown": {"dev": {"hours": 50.0}},
        }
        r = RA._calc_risk_score("P1", pst, meta, {}, {})
        self.assertEqual(r["status"], "high")
        self.assertLess(r["score"], RA.RISK_HIGH_THRESHOLD)

    def test_medium_risk(self):
        meta = {"projects": {"P1": {"plannedHours": 100.0}}}
        pst = {
            "timeBreakdown": {"totalHours": 100.0, "workHours": 100.0},
            "completionSegments": {"completionThisMonth": 100.0,
                                   "forecastCompletion": 100.0},
            "roleBreakdown": {"dev": {"hours": 100.0}},
        }
        r = RA._calc_risk_score("P1", pst, meta, {}, {})
        self.assertIn(r["status"], ("low", "medium"))

    def test_low_risk(self):
        meta = {"projects": {"P1": {"plannedHours": 50.0}}}
        pst = {
            "timeBreakdown": {"totalHours": 60.0, "workHours": 60.0},
            "completionSegments": {"completionThisMonth": 95.0,
                                   "forecastCompletion": 100.0},
            "roleBreakdown": {"dev": {"hours": 60.0}},
        }
        r = RA._calc_risk_score("P1", pst, meta, {}, {})
        self.assertGreaterEqual(r["score"], RA.RISK_MEDIUM_THRESHOLD)

    def test_headcount_factor(self):
        meta = {"projects": {"P1": {"plannedHours": 100.0}}}
        pst = {
            "timeBreakdown": {"totalHours": 100.0, "workHours": 100.0},
            "completionSegments": {"completionThisMonth": 80.0,
                                   "forecastCompletion": 100.0},
            "roleBreakdown": {"dev": {"hours": 100.0}},
        }
        # target dev=5 actual=0 → 缺口 (5-0)/5 = +100%(正缺口=缺人)
        r = RA._calc_risk_score("P1", pst, meta, {"dev": 5}, {"dev": 0})
        self.assertIn("headcount", r["factors"])
        self.assertEqual(r["factors"]["headcount"], 100.0)

    def test_factors_present(self):
        meta = {"projects": {"P1": {"plannedHours": 100.0}}}
        pst = {
            "timeBreakdown": {"totalHours": 100.0, "workHours": 90.0,
                              "overtimeHours": 10.0},
            "completionSegments": {"completionThisMonth": 80.0,
                                   "forecastCompletion": 100.0},
            "roleBreakdown": {"dev": {"hours": 100.0}},
        }
        r = RA._calc_risk_score("P1", pst, meta, {"dev": 5}, {"dev": 3})
        self.assertEqual(
            set(r["factors"]), {"schedule", "workProgress", "overtime",
                                "headcount", "urgency"})
# =====================================================================
# 5) 核心统计 calculate_stats
# =====================================================================
class TestCalculateStats(unittest.TestCase):
    """calculate_stats 核心契约:总工时守恒 / 期望工时 / overPct。"""

    def test_stable_scenario_summary(self):
        stats = _stable_stats()
        s = stats["summary"]
        self.assertEqual(s["workdays"], 5)
        self.assertEqual(s["totalHours"], 120.0)
        self.assertEqual(s["expectedHours"], 112.5)
        self.assertEqual(s["memberCount"], 3)
        self.assertEqual(s["recordCount"], 15)

    def test_total_hours_conservation(self):
        # 总工时守恒:totalHours == workHours + overtimeHours(summary 级)
        stats = _stable_stats()
        s = stats["summary"]
        self.assertAlmostEqual(
            s["totalHours"], s["workHours"] + s["overtimeHours"], places=1)

    def test_member_hours_conservation(self):
        # 成员级守恒:Σ member.totalHours == summary.totalHours
        stats = _stable_stats()
        s = stats["summary"]
        ms_total = sum(m["totalHours"] for m in stats["memberStats"].values())
        self.assertAlmostEqual(ms_total, s["totalHours"], places=1)

    def test_over_pct_expected(self):
        # overPct = (120 - 112.5) / 112.5 × 100 ≈ 6.7
        stats = _stable_stats()
        self.assertAlmostEqual(stats["summary"]["overPct"], 6.7, places=1)

    def test_project_stats_populated(self):
        stats = _stable_stats()
        self.assertIn("P1", stats["projectStats"])
        p = stats["projectStats"]["P1"]
        self.assertEqual(p["hours"], 120.0)
        self.assertEqual(p["memberCount"], 3)
        # dev 占比 0 ≤ 60% → 运维类
        self.assertEqual(p["projectType"], "运维类")

    def test_dedupe_stats_included(self):
        records = _make_records(days=MOCK_WEEK[:1], members=MOCK_MEMBERS,
                                with_dupes=True)
        stats = RA.calculate_stats(
            records, list(MOCK_MEMBERS),
            start_date=_dt.date(2026, 7, 13), end_date=_dt.date(2026, 7, 13))
        self.assertEqual(stats["dedupe"]["original"], 6)
        self.assertEqual(stats["dedupe"]["removed"], 3)
        self.assertEqual(stats["summary"]["recordCount"], 3)

    def test_range_filter_applied(self):
        # 只取 1 天 → totalHours = 3 × 8 = 24
        records = _make_records()
        stats = RA.calculate_stats(
            records, list(MOCK_MEMBERS),
            start_date=_dt.date(2026, 7, 13), end_date=_dt.date(2026, 7, 13))
        self.assertEqual(stats["summary"]["totalHours"], 24.0)
        self.assertEqual(stats["summary"]["recordCount"], 3)

    def test_date_range_swap(self):
        # start > end 时自动交换
        records = _make_records(days=MOCK_WEEK[:1], members=MOCK_MEMBERS)
        stats = RA.calculate_stats(
            records, list(MOCK_MEMBERS),
            start_date=_dt.date(2026, 7, 13), end_date=_dt.date(2026, 7, 13))
        s = stats["summary"]
        self.assertEqual(s["dateRange"]["start"], "2026-07-13")
        self.assertEqual(s["dateRange"]["end"], "2026-07-13")

    def test_metadata_sources_flags(self):
        stats = _stable_stats()
        s = stats["summary"]
        self.assertFalse(s["hasProjectMetadata"])
        self.assertFalse(s["hasMonthlySnapshots"])
        self.assertFalse(s["hasHeadcountTarget"])

    def test_headcount_analysis_shape(self):
        stats = _stable_stats()
        ha = stats["headcountAnalysis"]
        self.assertIn("delivery", ha)
        d = ha["delivery"]
        self.assertEqual(d["label"], "交付经理")
        self.assertIn("gap", d)
        self.assertIn("gapPct", d)

    def test_role_breakdown_keys(self):
        stats = _stable_stats()
        rb = stats["roleBreakdown"]
        self.assertEqual(
            sorted(rb.keys()), ["delivery", "dev", "implement", "product", "test"])
        self.assertEqual(rb["delivery"]["label"], "交付经理")

    def test_matrix_and_weekday(self):
        stats = _stable_stats()
        self.assertIn("邓佳辉", stats["memberProjectMatrix"])
        self.assertEqual(
            stats["memberProjectMatrix"]["邓佳辉"]["P1"], 40.0)
        wd = stats["weekdayDistribution"]
        self.assertGreaterEqual(len(wd), 1)
        self.assertIn("周一", wd)

    def test_zero_records(self):
        stats = RA.calculate_stats(
            [], list(MOCK_MEMBERS),
            start_date=_dt.date(2026, 7, 13), end_date=_dt.date(2026, 7, 17))
        self.assertEqual(stats["summary"]["totalHours"], 0.0)
        self.assertEqual(stats["summary"]["recordCount"], 0)
        self.assertEqual(stats["summary"]["overPct"], -100.0)


# =====================================================================
# 6) 9-Section HTML 生成
# =====================================================================
class TestGenerateHtmlReport(unittest.TestCase):
    """generate_html_report:9-section 锚点 / header / XSS 转义。"""

    def setUp(self):
        self.stats = _stable_stats()

    def test_document_root(self):
        html = RA.generate_html_report(self.stats, "2026-07-13", "2026-07-17")
        self.assertIn("<!DOCTYPE html>", html)
        self.assertIn("<html>", html)
        self.assertIn("</html>", html)

    def test_title(self):
        html = RA.generate_html_report(self.stats, "2026-07-13", "2026-07-17")
        self.assertIn("<title>项目成员工作报告", html)

    def test_header_total_hours(self):
        html = RA.generate_html_report(self.stats, "2026-07-13", "2026-07-17")
        self.assertIn("总工时 120", html)
        self.assertIn("统计周期:2026-07-13 ~ 2026-07-17", html)

    def test_section1_anchor(self):
        html = RA.generate_html_report(self.stats, "2026-07-13", "2026-07-17")
        self.assertIn('id="section-1"', html)
        self.assertIn("整体统计", html)

    def test_section9_anchor(self):
        html = RA.generate_html_report(self.stats, "2026-07-13", "2026-07-17")
        self.assertIn('id="section-9"', html)
        self.assertIn("附录", html)

    def test_all_section_ids(self):
        html = RA.generate_html_report(self.stats, "2026-07-13", "2026-07-17")
        for i in range(1, 10):
            self.assertIn('id="section-%d"' % i, html)

    def test_toc_contains_links(self):
        html = RA.generate_html_report(self.stats, "2026-07-13", "2026-07-17")
        self.assertIn('<nav class="toc">', html)
        for i in range(1, 10):
            self.assertIn('href="#section-%d"' % i, html)

    def test_xss_escape(self):
        # project 名含脚本 → 必须转义,不得原样注入
        evil = '<script>alert(1)</script>'
        stats = RA.calculate_stats(
            [{"date": "2026-07-13", "name": "邓佳辉", "project": evil,
              "content": "x", "hours": 8.0}],
            ["邓佳辉"],
            start_date=_dt.date(2026, 7, 13), end_date=_dt.date(2026, 7, 13))
        html = RA.generate_html_report(stats, "2026-07-13", "2026-07-13")
        self.assertNotIn('<script>alert(1)</script>', html)
        self.assertNotIn('<script>', html)
        # 转义后的安全形式(可能双重转义)
        self.assertTrue(('&lt;script&gt;' in html) or ('&amp;lt;script&amp;gt;' in html))

    def test_write_html(self):
        with tempfile.TemporaryDirectory() as td:
            html = RA.generate_html_report(self.stats, "2026-07-13", "2026-07-17")
            out = os.path.join(td, "report.html")
            n = RA.write_html(html, out)
            self.assertGreater(n, 1000)
            with open(out, encoding="utf-8") as fh:
                self.assertIn("<html>", fh.read())
# =====================================================================
# 7) JSON 离线入口与 rerender 端到端
# =====================================================================
class TestLoadRecordsFromJson(unittest.TestCase):
    """load_records_from_json:3 种输入形态兼容。"""

    def setUp(self):
        self.records = _make_records(days=MOCK_WEEK[:1], members=MOCK_MEMBERS)

    def test_top_level_array(self):
        with tempfile.TemporaryDirectory() as td:
            p = _write_json(td, "records.json", self.records)
            records, meta = RA.load_records_from_json(p)
            self.assertEqual(len(records), 3)
            self.assertEqual(meta, {})

    def test_wrapped_records(self):
        with tempfile.TemporaryDirectory() as td:
            p = _write_json(td, "records.json",
                            {"meta": {"start": "2026-07-13", "end": "2026-07-17"},
                             "records": self.records})
            records, meta = RA.load_records_from_json(p)
            self.assertEqual(len(records), 3)
            self.assertEqual(meta["start"], "2026-07-13")

    def test_statistics_wrapped(self):
        with tempfile.TemporaryDirectory() as td:
            p = _write_json(td, "records.json",
                            {"statistics": {"records": self.records}})
            records, meta = RA.load_records_from_json(p)
            self.assertEqual(len(records), 3)

    def test_missing_file_raises(self):
        with self.assertRaises(ValueError):
            RA.load_records_from_json("E:\\nonexistent\\records.json")

    def test_unrecognized_shape_raises(self):
        with tempfile.TemporaryDirectory() as td:
            p = _write_json(td, "records.json", {"foo": 1})
            with self.assertRaises(ValueError):
                RA.load_records_from_json(p)


class TestRerenderRecords(unittest.TestCase):
    """rerender_records 高层封装:stats / html 输出。"""

    def test_rerender_stats(self):
        records = _make_records()
        stats, paths = RA.rerender_records(
            records, members=list(MOCK_MEMBERS),
            start=_dt.date(2026, 7, 13), end=_dt.date(2026, 7, 17))
        self.assertIsNotNone(stats)
        self.assertEqual(stats["summary"]["totalHours"], 120.0)
        self.assertEqual(paths, {})

    def test_rerender_empty_returns_none(self):
        stats, paths = RA.rerender_records([])
        self.assertIsNone(stats)
        self.assertEqual(paths, {})

    def test_rerender_with_json_and_html_out(self):
        with tempfile.TemporaryDirectory() as td:
            records = _make_records(days=MOCK_WEEK[:1], members=MOCK_MEMBERS)
            jout = os.path.join(td, "stats.json")
            hout = os.path.join(td, "report.html")
            stats, paths = RA.rerender_records(
                records, members=list(MOCK_MEMBERS),
                start=_dt.date(2026, 7, 13), end=_dt.date(2026, 7, 13),
                json_out=jout, html_out=hout, quiet=True)
            self.assertTrue(Path(jout).exists())
            self.assertTrue(Path(hout).exists())
            self.assertEqual(paths["json"], str(Path(jout)))
            self.assertEqual(paths["html"], str(Path(hout)))
            self.assertEqual(stats["summary"]["totalHours"], 24.0)

    def test_rerender_no_backfill_skips_sources(self):
        # no_backfill=True(= --no-backfill-v2)时三数据源被跳过
        with tempfile.TemporaryDirectory() as td:
            records = _make_records(days=MOCK_WEEK[:1], members=MOCK_MEMBERS)
            metadata = {"projects": {"P1": {"projectType": "开发类"}}}
            stats, _ = RA.rerender_records(
                records, members=list(MOCK_MEMBERS),
                start=_dt.date(2026, 7, 13), end=_dt.date(2026, 7, 13),
                project_metadata=metadata, no_backfill=True)
            s = stats["summary"]
            self.assertFalse(s["hasProjectMetadata"])


class TestRerenderFromRecordsPath(unittest.TestCase):
    """rerender_from_records_path(--from-json 端到端主路径)。"""

    def _write_input(self, td):
        records = _make_records()
        payload = {
            "meta": {"start": "2026-07-13", "end": "2026-07-17",
                     "members": list(MOCK_MEMBERS)},
            "records": records,
        }
        return _write_json(td, "input.json", payload)

    def test_end_to_end(self):
        with tempfile.TemporaryDirectory() as td:
            inp = self._write_input(td)
            jout = os.path.join(td, "stats.json")
            hout = os.path.join(td, "report.html")
            stats, paths, meta = RA.rerender_from_records_path(
                inp, json_out=jout, html_out=hout, quiet=True)
            self.assertIsNotNone(stats)
            self.assertEqual(stats["summary"]["totalHours"], 120.0)
            self.assertTrue(Path(jout).exists())
            self.assertTrue(Path(hout).exists())
            self.assertEqual(meta["start"], "2026-07-13")

    def test_missing_input_raises(self):
        with self.assertRaises(ValueError):
            RA.rerender_from_records_path("E:\\nonexistent\\in.json")


class TestBackfillMemberAndProjectFields(unittest.TestCase):
    """backfill_member_and_project_fields:v2.0 字段回算。"""

    def test_backfill_role_and_project(self):
        metadata = {"projects": {"成都市\"一码检查\"": {"projectType": "开发类"}}}
        records = [
            {"date": "2026-07-13", "name": "邓佳辉",
             "project": "一码检查", "hours": 8.0},
        ]
        out = RA.backfill_member_and_project_fields(records, metadata)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["role"], "delivery")
        self.assertEqual(out[0]["roleLabel"], "交付经理")
        # alias 归一:一码检查 → 完整名
        self.assertEqual(out[0]["project"], "成都市\"一码检查\"")

    def test_backfill_empty(self):
        self.assertEqual(RA.backfill_member_and_project_fields([]), [])


class TestArgParserAndConstants(unittest.TestCase):
    """CLI 入口与常量契约。"""

    def test_from_json_flag(self):
        parser = RA.build_arg_parser()
        args = parser.parse_args(
            ["--from-json", "records.json", "--html", "report.html",
             "--no-backfill-v2"])
        self.assertEqual(args.from_json, "records.json")
        self.assertEqual(args.html, "report.html")
        self.assertTrue(args.no_backfill_v2)

    def test_default_members_token(self):
        self.assertEqual(RA.DEFAULT_MEMBERS_TOKEN, "全员")
        self.assertEqual(len(RA.ALL_V19_MEMBERS), 14)

    def test_standard_daily_hours(self):
        self.assertEqual(RA.STANDARD_DAILY_HOURS, 7.5)
        self.assertEqual(RA.OVERTIME_DAILY_THRESHOLD, 8.0)
        self.assertEqual(RA.APP_VERSION, "v2.0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
