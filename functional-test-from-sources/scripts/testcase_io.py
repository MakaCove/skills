#!/usr/bin/env python3
"""Shared parsing and serialization helpers for testcase files."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable


# Current workbook contract. Legacy table helpers below are not the new schema.
SHEET_HEADERS = {
    "测试说明": ["项目", "内容"],
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
REQUIRED_SHEETS = list(SHEET_HEADERS)
INFO_KEYS = ["测试范围", "输入来源", "数据库 MCP", "分析限制", "设计覆盖说明"]
CANONICAL_METHODS = [
    "等价类", "边界值", "判定表", "因果图", "状态迁移", "场景法", "正交或成对组合", "错误推测",
]
METHOD_STATUS = {"适用", "不适用", "适用但未覆盖"}
CASE_TYPES = {"正常", "边界", "异常"}
PRIORITIES = {"P0", "P1", "P2", "P3"}
DB_VALUES = {"需要", "不需要"}
EXECUTION_RESULTS = {"未执行", "通过", "失败"}
COVERAGE_STATUS = {"已覆盖", "部分覆盖", "未覆盖", "待确认"}
CASE_ID = re.compile(r"TC-[0-9]{3,}")
REQUIREMENT_ID = re.compile(r"(?:R|AC)-[1-9][0-9]*")
SCENARIO_ID = re.compile(r"SC-[0-9]{3,}")
GAP_ID = re.compile(r"GAP-[0-9]{3,}")


def split_methods(text: str) -> list[str]:
    # Keep empty tokens so malformed combinations such as '+' cannot pass.
    return [part.strip() for part in re.split(r"[+＋]", text)]


def split_references(text: str) -> list[str]:
    return [part for part in re.split(r"[\s,，、;；]+", text.strip()) if part]


def find_case_references(text: str) -> set[str]:
    # Explanation cells may contain prose, but ranges must still be expanded.
    return set(re.findall(r"(?<![A-Za-z0-9_-])TC-[0-9]+(?![A-Za-z0-9_-])", text))


FUNCTIONAL_HEADERS = [
    "模块", "ID", "标题", "优先级", "类型", "前置条件", "步骤", "测试数据", "预期结果", "备注/覆盖点"
]
CHAIN_HEADERS = [
    "链路ID", "链路名称", "涉及模块", "优先级", "类型", "前置条件", "步骤", "测试数据", "预期结果", "备注/覆盖点"
]

TABLE_SPECS = {
    "functional": FUNCTIONAL_HEADERS,
    "chain": CHAIN_HEADERS,
}

_MD_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_MD_TABLE_SEPARATOR = re.compile(r"^\s*\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|\s*$")
_STEPS = re.compile(r"(?<!\n)(?<!^)\s*(?=(?:\[\d+\]|\d+\.))")
_EXPECT_BRACKET = re.compile(r"(?<!\n)(?<!^)\s*(?=\[[^\]]*\d+[^\]]*\])")
_EXPECT_PAREN = re.compile(r"(?<!\n)(?<!^)\s*(?=\d+[）)])")
_DATA_SEPARATOR = re.compile(r"(?<!\n)(?<!^)\s*[;；、]\s*")


def normalize(value: object) -> str:
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n").strip()


def normalize_cell_text(value: object, header: str) -> str:
    text = normalize(value)
    if not text or "\n" in text:
        return text
    if header == "步骤":
        return _STEPS.sub("\n", text)
    if header == "预期结果":
        return _EXPECT_PAREN.sub("\n", _EXPECT_BRACKET.sub("\n", text))
    if header == "测试数据":
        return _DATA_SEPARATOR.sub("\n", text)
    return text


def split_markdown_row(line: str) -> list[str]:
    """Split a Markdown row while preserving backslashes except escaped pipes."""
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|"):
        text = text[:-1]

    cells: list[str] = []
    current: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text) and text[index + 1] in {"|", "\\"}:
            current.append(text[index + 1])
            index += 2
            continue
        if char == "|":
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
        index += 1
    cells.append("".join(current).strip())
    return cells


def _matching_spec(header_cells: list[str]) -> tuple[str, list[str]] | None:
    for table_type, required_headers in TABLE_SPECS.items():
        if all(header in header_cells for header in required_headers):
            return table_type, required_headers
    return None


def parse_markdown_tables(text: str) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Parse every recognized testcase table from Markdown text."""
    lines = text.splitlines()
    results: dict[str, list[dict[str, str]]] = {"functional": [], "chain": []}
    index = 0

    while index < len(lines) - 1:
        if not _MD_TABLE_ROW.match(lines[index]) or not _MD_TABLE_SEPARATOR.match(lines[index + 1]):
            index += 1
            continue

        header_cells = split_markdown_row(lines[index])
        match = _matching_spec(header_cells)
        if not match:
            index += 1
            continue

        table_type, required_headers = match
        column_indexes = {header: header_cells.index(header) for header in required_headers}
        all_headers: list[str] = []
        for header in header_cells:
            if header and header not in all_headers:
                all_headers.append(header)
        index += 2
        while index < len(lines) and _MD_TABLE_ROW.match(lines[index]):
            cells = split_markdown_row(lines[index])
            cells.extend([""] * max(0, len(header_cells) - len(cells)))
            row = {
                header: cells[header_cells.index(header)] if header_cells.index(header) < len(cells) else ""
                for header in all_headers
            }
            if any(normalize(value) for value in row.values()):
                results[table_type].append(row)
            index += 1

    if not results["functional"] and not results["chain"]:
        raise ValueError("未找到包含完整标准表头的测试用例表格")
    return results["functional"], results["chain"]


def load_markdown(path: Path) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    return parse_markdown_tables(path.read_text(encoding="utf-8-sig"))


def load_markdown_files(paths: Iterable[Path]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    functional: list[dict[str, str]] = []
    chain: list[dict[str, str]] = []
    for path in paths:
        current_functional, current_chain = load_markdown(path)
        functional.extend(current_functional)
        chain.extend(current_chain)
    return functional, chain


def ensure_input_paths(values: Iterable[str], suffixes: set[str]) -> list[Path]:
    paths = [Path(value) for value in values]
    for path in paths:
        if not path.is_file():
            raise ValueError(f"文件不存在: {path}")
        if path.suffix.lower() not in suffixes:
            allowed = ", ".join(sorted(suffixes))
            raise ValueError(f"不支持的文件类型: {path}（允许 {allowed}）")
    return paths


def detect_excel_table(header_cells: list[str]) -> tuple[str, list[str]] | None:
    normalized = [normalize(value) for value in header_cells]
    if all(header in normalized for header in CHAIN_HEADERS):
        return "chain", CHAIN_HEADERS
    if all(header in normalized for header in FUNCTIONAL_HEADERS):
        return "functional", FUNCTIONAL_HEADERS
    return None


def extract_excel_sheets(workbook) -> list[tuple[str, str, list[dict[str, str]]]]:
    """Extract recognized tables from an openpyxl workbook."""
    sheets: list[tuple[str, str, list[dict[str, str]]]] = []
    for worksheet in workbook.worksheets:
        raw_rows = [[normalize(value) for value in row] for row in worksheet.iter_rows(values_only=True)]
        found: tuple[int, str, list[str], list[str]] | None = None
        for row_index, cells in enumerate(raw_rows[:100]):
            detected = detect_excel_table(cells)
            if detected:
                table_type, required_headers = detected
                found = (row_index, table_type, required_headers, cells)
                break
        if not found:
            continue

        row_index, table_type, required_headers, header_cells = found
        all_headers: list[str] = []
        for header in header_cells:
            if header and header not in all_headers:
                all_headers.append(header)
        column_indexes = {header: header_cells.index(header) for header in all_headers}
        rows: list[dict[str, str]] = []
        for cells in raw_rows[row_index + 1:]:
            if not any(cells):
                continue
            row = {
                header: cells[column_indexes[header]] if column_indexes[header] < len(cells) else ""
                for header in all_headers
            }
            id_field = "ID" if table_type == "functional" else "链路ID"
            title_field = "标题" if table_type == "functional" else "链路名称"
            if normalize(row[id_field]) or normalize(row[title_field]):
                rows.append(row)
        if rows:
            sheets.append((worksheet.title, table_type, rows))
    return sheets


def escape_markdown_cell(value: object) -> str:
    return normalize(value).replace("\\", "\\\\").replace("|", "\\|").replace("\n", "<br>")


def rows_to_markdown(sheets: list[tuple[str, str, list[dict[str, str]]]], title: str) -> str:
    lines = [f"# {title}", ""]
    for sheet_name, table_type, rows in sheets:
        core = TABLE_SPECS[table_type]
        extras: list[str] = []
        for row in rows:
            for header in row:
                if header not in core and header not in extras:
                    extras.append(header)
        headers = core + extras
        lines.extend([
            f"## {sheet_name}",
            "",
            "| " + " | ".join(headers) + " |",
            "|" + "|".join(["---"] * len(headers)) + "|",
        ])
        for row in rows:
            cells = [escape_markdown_cell(row.get(header, "")) or "-" for header in headers]
            lines.append("| " + " | ".join(cells) + " |")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
