#!/usr/bin/env python3
"""Create a developer self-test execution CSV from testcase Markdown."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from testcase_io import ensure_input_paths, load_markdown_files, normalize


HEADERS = ["id", "title", "priority", "result", "version", "environment", "executor", "executed_at", "defect", "defect_status", "evidence", "notes"]


def build_rows(functional: list[dict[str, str]], chain: list[dict[str, str]], version: str = "") -> list[dict[str, str]]:
    rows = []
    for item in functional + chain:
        rows.append({
            "id": normalize(item.get("ID") or item.get("链路ID")),
            "title": normalize(item.get("标题") or item.get("链路名称")),
            "priority": normalize(item.get("优先级")),
            "result": "未执行",
            "version": version,
            "environment": "",
            "executor": "",
            "executed_at": "",
            "defect": "",
            "defect_status": "",
            "evidence": "",
            "notes": "",
        })
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="从测试用例生成开发自测执行记录 CSV")
    parser.add_argument("testcases", nargs="+", help="测试用例 Markdown 文件")
    parser.add_argument("--version", default="", help="目标版本")
    parser.add_argument("-o", "--output", required=True, help="输出 CSV")
    args = parser.parse_args()
    try:
        paths = ensure_input_paths(args.testcases, {".md"})
        functional, chain = load_markdown_files(paths)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    rows = build_rows(functional, chain, args.version)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=HEADERS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"已生成自测执行模板: {output}（{len(rows)} 条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
