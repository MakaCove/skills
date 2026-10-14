#!/usr/bin/env python3
"""Validate the six-sheet functional testcase Excel workbook."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REQUIRED_SHEETS = [
    "测试说明",
    "测试方法覆盖",
    "测试场景",
    "详细测试用例",
    "需求覆盖",
    "信息缺口",
]
CANONICAL_METHODS = [
    "等价类",
    "边界值",
    "判定表",
    "因果图",
    "状态迁移",
    "场景法",
    "正交或成对组合",
    "错误推测",
]
METHOD_STATUS = {"适用", "不适用", "适用但未覆盖"}
CASE_TYPES = {"正常", "边界", "异常"}
PRIORITIES = {"P0", "P1", "P2", "P3"}
DB_VALUES = {"需要", "不需要"}
CASE_ID = re.compile(r"^TC-(\d{3,})$")


def normalize(value: object) -> str:
    return "" if value is None else str(value).replace("\r\n", "\n").replace("\r", "\n").strip()


def rows_by_header(ws) -> tuple[list[str], list[dict[str, str]]]:
    values = list(ws.iter_rows(values_only=True))
    if not values:
        return [], []
    headers = [normalize(v) for v in values[0]]
    rows = []
    for raw in values[1:]:
        cells = list(raw) + [None] * max(0, len(headers) - len(raw))
        row = {headers[i]: normalize(cells[i]) for i in range(len(headers)) if headers[i]}
        if any(row.values()):
            rows.append(row)
    return headers, rows


def issue(items: list[str], code: str, message: str) -> None:
    items.append(f"ERROR [{code}] {message}")


def split_methods(text: str) -> list[str]:
    # 设计方法只用加号或顿号组合，每个词必须是 8 个固定名称之一
    parts = re.split(r"\s*[+＋、]\s*", text.strip())
    return [part for part in parts if part]


def validate(path: Path, at_generation: bool = False) -> list[str]:
    try:
        import openpyxl
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except ImportError:
        return ["ERROR [DEPENDENCY] 请安装 openpyxl"]
    except Exception as exc:
        return [f"ERROR [INPUT] 无法读取 Excel: {exc}"]

    errors: list[str] = []
    actual = workbook.sheetnames
    if actual != REQUIRED_SHEETS:
        issue(errors, "SHEET_ORDER", f"工作表必须按 {REQUIRED_SHEETS} 排列，实际为 {actual}")

    required_headers = {
        "测试方法覆盖": ["设计方法", "适用性", "对应用例", "说明"],
        "测试场景": ["场景编号", "场景名称", "优先级", "关联需求", "覆盖说明"],
        "详细测试用例": [
            "用例编号", "模块", "用例标题", "设计方法", "优先级", "类型", "关联需求",
            "前置条件", "测试数据", "操作步骤", "页面预期结果", "接口或数据预期结果",
            "数据库验证", "执行结果", "备注",
        ],
        "需求覆盖": ["需求编号", "需求摘要", "对应用例", "覆盖状态", "说明"],
        "信息缺口": ["编号", "缺少的信息", "影响范围", "是否影响执行", "建议确认内容"],
    }
    parsed: dict[str, tuple[list[str], list[dict[str, str]]]] = {}
    for sheet, headers in required_headers.items():
        if sheet not in workbook.sheetnames:
            continue
        actual_headers, rows = rows_by_header(workbook[sheet])
        parsed[sheet] = (actual_headers, rows)
        missing = [h for h in headers if h not in actual_headers]
        if missing:
            issue(errors, "MISSING_HEADERS", f"{sheet} 缺少列: {', '.join(missing)}")

    detail_rows = parsed.get("详细测试用例", ([], []))[1]
    ids: list[int] = []
    seen_ids: set[str] = set()
    seen_titles: set[str] = set()
    for row in detail_rows:
        case_id = row.get("用例编号", "")
        title = row.get("用例标题", "")
        if not case_id or not CASE_ID.match(case_id):
            issue(errors, "INVALID_ID", f"用例编号非法: {case_id or '<空>'}")
        else:
            if case_id in seen_ids:
                issue(errors, "DUPLICATE_ID", f"用例编号重复: {case_id}")
            seen_ids.add(case_id)
            ids.append(int(CASE_ID.match(case_id).group(1)))
        if title in seen_titles and title:
            issue(errors, "DUPLICATE_TITLE", f"用例标题重复: {title}")
        if title:
            seen_titles.add(title)

        for field in ("模块", "用例标题", "设计方法", "优先级", "类型", "前置条件", "测试数据", "操作步骤", "页面预期结果", "执行结果"):
            if not row.get(field):
                issue(errors, "EMPTY_REQUIRED", f"{case_id or '<空>'} 缺少字段: {field}")
        if row.get("优先级") and row["优先级"] not in PRIORITIES:
            issue(errors, "INVALID_PRIORITY", f"{case_id} 优先级非法: {row['优先级']}")
        if row.get("类型") and row["类型"] not in CASE_TYPES:
            issue(errors, "INVALID_TYPE", f"{case_id} 类型必须是正常、边界或异常")
        methods = row.get("设计方法", "")
        unknown_methods = [token for token in split_methods(methods) if token not in set(CANONICAL_METHODS)]
        if methods and unknown_methods:
            issue(errors, "INVALID_METHOD", f"{case_id} 设计方法无法识别: {methods}")
        if row.get("数据库验证") not in DB_VALUES:
            issue(errors, "INVALID_DATABASE_CHECK", f"{case_id} 数据库验证必须是需要或不需要")
        if at_generation and row.get("执行结果") != "未执行":
            issue(errors, "INVALID_EXECUTION_STATE", f"{case_id} 生成时执行结果必须是未执行")
        if not re.search(r"(?:R|AC)-\d+", row.get("关联需求", ""), re.I):
            issue(errors, "INVALID_REQUIREMENT_TRACE", f"{case_id} 关联需求必须包含 R-n 或 AC-n")

    if ids and sorted(ids) != list(range(1, len(ids) + 1)):
        issue(errors, "NON_CONTIGUOUS_IDS", f"用例编号必须从 TC-001 连续递增，实际为 {sorted(ids)}")

    method_rows = parsed.get("测试方法覆盖", ([], []))[1]
    actual_methods = [row.get("设计方法", "") for row in method_rows]
    if actual_methods != CANONICAL_METHODS:
        issue(
            errors,
            "METHOD_COVERAGE_ROWS",
            "测试方法覆盖必须按此顺序各一行：" + "、".join(CANONICAL_METHODS),
        )
    for row in method_rows:
        method = row.get("设计方法", "") or "<空>"
        status = row.get("适用性", "")
        if status not in METHOD_STATUS:
            issue(errors, "INVALID_METHOD_STATUS", f"{method} 适用性必须是适用、不适用或适用但未覆盖")
        if status == "适用" and not row.get("对应用例"):
            issue(errors, "MISSING_METHOD_CASES", f"{method} 标记适用但没有用例编号")
        if status == "不适用" and not row.get("说明"):
            issue(errors, "MISSING_NOT_APPLICABLE_REASON", f"{method} 标记不适用但没有填写原因")
        if status == "适用但未覆盖" and not row.get("说明"):
            issue(errors, "MISSING_UNCOVERED_REASON", f"{method} 标记适用但未覆盖但没有填写缺少场景")

    valid_ids = set(seen_ids)
    coverage_rows = parsed.get("需求覆盖", ([], []))[1]
    for row in coverage_rows:
        refs = re.findall(r"TC-\d+", row.get("对应用例", ""))
        for ref in refs:
            if ref not in valid_ids:
                issue(errors, "UNKNOWN_COVERAGE_ID", f"需求覆盖引用不存在的用例: {ref}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="校验六张表格式的功能测试用例 Excel")
    parser.add_argument("workbook", help="功能测试用例.xlsx")
    parser.add_argument("--generation", action="store_true", help="生成时校验：执行结果必须是未执行")
    args = parser.parse_args()
    path = Path(args.workbook)
    if not path.is_file() or path.suffix.lower() != ".xlsx":
        print("ERROR [INPUT] 请输入存在的 .xlsx 文件", file=sys.stderr)
        return 2
    errors = validate(path, at_generation=args.generation)
    for item in errors:
        print(item, file=sys.stderr)
    if errors:
        print(f"校验失败: {len(errors)} 个问题", file=sys.stderr)
        return 1
    print("校验通过: 六张表、字段、用例编号、设计方法和追踪关系均符合规则")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
