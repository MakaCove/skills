#!/usr/bin/env python3
"""Export testcase Markdown tables to a formatted Excel workbook."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from testcase_io import CHAIN_HEADERS, FUNCTIONAL_HEADERS, ensure_input_paths, load_markdown_files, normalize_cell_text


def _headers(rows: list[dict[str, str]], core: list[str]) -> list[str]:
    extras: list[str] = []
    for row in rows:
        for key in row:
            if key not in core and key not in extras:
                extras.append(key)
    return core + extras


def write_sheet(worksheet, headers: list[str], rows: list[dict[str, str]]) -> None:
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    worksheet.freeze_panes = "A2"
    worksheet.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{max(1, len(rows) + 1)}"
    for column, header in enumerate(headers, start=1):
        cell = worksheet.cell(row=1, column=column, value=header)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1F4E78")
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for row_number, row in enumerate(rows, start=2):
        for column, header in enumerate(headers, start=1):
            cell = worksheet.cell(row=row_number, column=column, value=normalize_cell_text(row.get(header, ""), header))
            cell.alignment = Alignment(vertical="top", wrap_text=True)

    widths = {
        "步骤": 48, "操作步骤": 48, "预期结果": 48, "页面预期结果": 48,
        "接口或数据预期结果": 42, "前置条件": 42, "测试数据": 30,
        "备注/覆盖点": 36, "备注": 36, "说明": 42,
    }
    for column, header in enumerate(headers, start=1):
        worksheet.column_dimensions[get_column_letter(column)].width = widths.get(header, 18)
    worksheet.row_dimensions[1].height = 28


def write_key_value_sheet(worksheet, rows: list[tuple[str, str]]) -> None:
    from openpyxl.styles import Alignment, Font, PatternFill

    worksheet.append(["项目", "内容"])
    for key, value in rows:
        worksheet.append([key, value])
    for cell in worksheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1F4E78")
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    for row in worksheet.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)
    worksheet.column_dimensions["A"].width = 24
    worksheet.column_dimensions["B"].width = 90


def write_fixed_workbook(workbook, functional: list[dict[str, str]]) -> None:
    """Write the single-file workbook contract used by the skill."""
    write_key_value_sheet(workbook.create_sheet("测试说明"), [
        ("输出文件", "功能测试用例.xlsx"),
        ("测试用例数量", str(len(functional))),
        ("数据库 MCP", "由本次执行任务判定；未提供时在信息缺口中说明"),
        ("执行结果初始值", "未执行"),
    ])

    method_headers = ["设计方法", "适用性", "对应用例", "说明"]
    method_names = [
        ("等价类", "等价类"),
        ("边界值", "边界值"),
        ("判定表", "判定表"),
        ("因果图", "因果图"),
        ("状态迁移", "状态迁移"),
        ("场景法", "场景法"),
        ("正交或成对组合", "正交"),
        ("错误推测", "错误推测"),
    ]
    method_rows = []
    for display_name, keyword in method_names:
        ids = [row.get("ID", "") for row in functional if keyword in row.get("设计方法", "")]
        method_rows.append({
            "设计方法": display_name,
            "适用性": "适用" if ids else "适用但未覆盖",
            "对应用例": ", ".join(item for item in ids if item),
            "说明": "" if ids else "未在输入用例中找到对应覆盖，请判断不适用或补充用例",
        })
    write_sheet(workbook.create_sheet("测试方法覆盖"), method_headers, method_rows)

    scenario_headers = ["场景编号", "场景名称", "优先级", "关联需求", "覆盖说明"]
    scenarios = []
    for row in functional:
        scenarios.append({
            "场景编号": row.get("ID", ""),
            "场景名称": row.get("标题", ""),
            "优先级": row.get("优先级", ""),
            "关联需求": row.get("需求来源", ""),
            "覆盖说明": row.get("备注/覆盖点", ""),
        })
    write_sheet(workbook.create_sheet("测试场景"), scenario_headers, scenarios)

    detail_headers = [
        "用例编号", "模块", "用例标题", "设计方法", "优先级", "类型", "关联需求", "前置条件",
        "测试数据", "操作步骤", "页面预期结果", "接口或数据预期结果", "数据库验证",
        "执行结果", "备注",
    ]
    details = []
    for row in functional:
        details.append({
            "用例编号": row.get("ID", ""),
            "模块": row.get("模块", ""),
            "用例标题": row.get("标题", ""),
            "设计方法": row.get("设计方法", ""),
            "优先级": row.get("优先级", ""),
            "类型": row.get("类型", ""),
            "关联需求": row.get("需求来源", ""),
            "前置条件": row.get("前置条件", ""),
            "测试数据": row.get("测试数据", ""),
            "操作步骤": row.get("步骤", ""),
            "页面预期结果": row.get("预期结果", ""),
            "接口或数据预期结果": row.get("接口或数据预期结果", ""),
            "数据库验证": row.get("数据库验证", ""),
            "执行结果": row.get("执行结果", "未执行") or "未执行",
            "备注": row.get("备注/覆盖点", ""),
        })
    write_sheet(workbook.create_sheet("详细测试用例"), detail_headers, details)

    coverage_headers = ["需求编号", "需求摘要", "对应用例", "覆盖状态", "说明"]
    coverage = []
    for row in functional:
        coverage.append({
            "需求编号": row.get("需求来源", "待补充"),
            "需求摘要": row.get("标题", ""),
            "对应用例": row.get("ID", ""),
            "覆盖状态": "已设计",
            "说明": row.get("备注/覆盖点", ""),
        })
    write_sheet(workbook.create_sheet("需求覆盖"), coverage_headers, coverage)
    write_sheet(workbook.create_sheet("信息缺口"), ["编号", "缺少的信息", "影响范围", "是否影响执行", "建议确认内容"], [])


def main() -> int:
    parser = argparse.ArgumentParser(description="导出测试用例 Markdown 表格为 Excel")
    parser.add_argument("md_files", nargs="+", help="一个或多个测试用例 Markdown 文件")
    parser.add_argument("-o", "--output", default=None, help="输出 .xlsx 路径")
    args = parser.parse_args()

    try:
        paths = ensure_input_paths(args.md_files, {".md"})
        functional, chain = load_markdown_files(paths)
        if chain:
            raise ValueError("当前输出契约不再支持业务链路表；请将链路用例并入详细测试用例，并使用类型字段区分")
        import openpyxl
    except ImportError:
        print("错误: 请安装 openpyxl（pip install -r requirements.txt）", file=sys.stderr)
        return 2
    except (OSError, UnicodeError, ValueError) as error:
        print(f"错误: {error}", file=sys.stderr)
        return 2

    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)
    write_fixed_workbook(workbook, functional)

    output = Path(args.output) if args.output else paths[0].with_suffix(".xlsx")
    output.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(output)
    print(f"已导出: {output}（测试用例 {len(functional)} 条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
