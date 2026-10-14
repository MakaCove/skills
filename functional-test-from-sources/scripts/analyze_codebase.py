#!/usr/bin/env python3
"""Inventory frontend requests and backend REST endpoints without executing project code."""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path


SUPPORTED_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx", ".vue", ".java", ".go"}
IGNORED_DIRS = {".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", "vendor", "__pycache__"}

FRONTEND_REQUESTS = [
    re.compile(r"\b(?P<client>axios|http|client|request)\.(?P<method>get|post|put|patch|delete)\s*\(\s*[`'\"](?P<path>[^`'\"]+)", re.I),
    re.compile(r"\bfetch\s*\(\s*[`'\"](?P<path>[^`'\"]+)[`'\"](?P<tail>[\s\S]{0,300}?)\)", re.I),
    re.compile(r"\b(?:request|httpRequest|apiRequest)\s*\(\s*\{(?P<config>[\s\S]{0,500}?)\}\s*\)", re.I),
]
EXPRESS_ROUTE = re.compile(r"\b(?:app|router)\.(?P<method>get|post|put|patch|delete)\s*\(\s*[`'\"](?P<path>[^`'\"]+)", re.I)
SPRING_ROUTE = re.compile(r"@(?P<kind>Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?[`'\"](?P<path>[^`'\"]*)", re.I)
GO_ROUTE = re.compile(r"\.(?P<method>GET|POST|PUT|PATCH|DELETE)\s*\(\s*[`\"](?P<path>[^`\"]+)")
AUTH_PATTERN = re.compile(r"(auth|permission|role|tenant|isAdmin|hasAuthority|authorize|login_required|Depends\([^)]*(?:user|auth))", re.I)
STATE_PATTERN = re.compile(r"\b(status|state|enum|workflow|approve|reject|cancel|submit|transition)\b", re.I)
ERROR_PATTERN = re.compile(r"\b(throw|raise|except|catch|HttpException|HTTPException|abort)\b", re.I)


def iter_source_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_SUFFIXES:
            continue
        if any(part in IGNORED_DIRS for part in path.parts):
            continue
        yield path


def evidence(root: Path, path: Path, line: int) -> str:
    return f"{path.relative_to(root).as_posix()}:{line}"


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def normalize_path(value: str) -> str:
    path = re.sub(r"\$\{[^}]+}|:[A-Za-z_][\w]*|\{[^}/]+\}|<[^>]+>", "{param}", value)
    path = re.sub(r"//+", "/", path.split("?", 1)[0])
    if not path.startswith("/"):
        path = "/" + path
    return path.rstrip("/") or "/"


def analyze_frontend(root: Path) -> list[dict[str, object]]:
    requests: list[dict[str, object]] = []
    for path in iter_source_files(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        for pattern in FRONTEND_REQUESTS:
            for match in pattern.finditer(text):
                method = match.groupdict().get("method") or "GET"
                tail = match.groupdict().get("tail") or ""
                config = match.groupdict().get("config") or ""
                if pattern is FRONTEND_REQUESTS[1]:
                    method_match = re.search(r"method\s*:\s*[`'\"](GET|POST|PUT|PATCH|DELETE)", tail, re.I)
                    method = method_match.group(1) if method_match else "GET"
                if pattern is FRONTEND_REQUESTS[2]:
                    path_match = re.search(r"(?:url|path)\s*:\s*[`'\"]([^`'\"]+)", config, re.I)
                    if not path_match:
                        continue
                    raw_path = path_match.group(1)
                    method_match = re.search(r"method\s*:\s*[`'\"](GET|POST|PUT|PATCH|DELETE)", config, re.I)
                    method = method_match.group(1) if method_match else "GET"
                else:
                    raw_path = match.group("path")
                requests.append({
                    "method": method.upper(),
                    "path": raw_path,
                    "normalized_path": normalize_path(raw_path),
                    "evidence": evidence(root, path, line_number(text, match.start())),
                })
    unique: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for request in requests:
        key = (str(request["method"]), str(request["normalized_path"]), str(request["evidence"]))
        if key not in seen:
            seen.add(key)
            unique.append(request)
    return unique


def python_endpoints(root: Path, path: Path, text: str) -> list[dict[str, object]]:
    endpoints: list[dict[str, object]] = []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return endpoints
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                continue
            method = decorator.func.attr.lower()
            if method not in {"get", "post", "put", "patch", "delete", "route"} or not decorator.args:
                continue
            first = decorator.args[0]
            if not isinstance(first, ast.Constant) or not isinstance(first.value, str):
                continue
            methods = [method.upper()]
            if method == "route":
                methods = ["ANY"]
                for keyword in decorator.keywords:
                    if keyword.arg == "methods" and isinstance(keyword.value, (ast.List, ast.Tuple)):
                        methods = [str(item.value).upper() for item in keyword.value.elts if isinstance(item, ast.Constant)] or ["ANY"]
            segment = ast.get_source_segment(text, node) or ""
            for current_method in methods:
                endpoints.append({
                    "method": current_method,
                    "path": first.value,
                    "normalized_path": normalize_path(first.value),
                    "symbol": node.name,
                    "evidence": evidence(root, path, node.lineno),
                    "auth_signal": bool(AUTH_PATTERN.search(segment)),
                    "state_signal": bool(STATE_PATTERN.search(segment)),
                    "error_signal": bool(ERROR_PATTERN.search(segment)),
                    "branch_count": sum(isinstance(child, (ast.If, ast.Match, ast.Try)) for child in ast.walk(node)),
                })
    return endpoints


def regex_endpoints(root: Path, path: Path, text: str) -> list[dict[str, object]]:
    endpoints: list[dict[str, object]] = []
    suffix = path.suffix.lower()
    if suffix in {".js", ".jsx", ".ts", ".tsx", ".vue"}:
        patterns = [(EXPRESS_ROUTE, None)]
    elif suffix == ".java":
        patterns = [(SPRING_ROUTE, "spring")]
    elif suffix == ".go":
        patterns = [(GO_ROUTE, None)]
    else:
        patterns = []
    for pattern, kind in patterns:
        for match in pattern.finditer(text):
            method = match.groupdict().get("method")
            if kind == "spring":
                spring_kind = match.group("kind").upper()
                method = "ANY" if spring_kind == "REQUEST" else spring_kind
            raw_path = match.group("path")
            surrounding = text[match.start(): match.start() + 1500]
            endpoints.append({
                "method": method.upper(),
                "path": raw_path,
                "normalized_path": normalize_path(raw_path),
                "symbol": "",
                "evidence": evidence(root, path, line_number(text, match.start())),
                "auth_signal": bool(AUTH_PATTERN.search(surrounding)),
                "state_signal": bool(STATE_PATTERN.search(surrounding)),
                "error_signal": bool(ERROR_PATTERN.search(surrounding)),
                "branch_count": len(re.findall(r"\b(if|switch|catch)\b", surrounding)),
            })
    return endpoints


def analyze_backend(root: Path) -> list[dict[str, object]]:
    endpoints: list[dict[str, object]] = []
    for path in iter_source_files(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        if path.suffix.lower() == ".py":
            endpoints.extend(python_endpoints(root, path, text))
        endpoints.extend(regex_endpoints(root, path, text))
    return endpoints


def correlate(frontend: list[dict[str, object]], backend: list[dict[str, object]]) -> list[dict[str, object]]:
    matches: list[dict[str, object]] = []
    for request in frontend:
        candidates = [endpoint for endpoint in backend if endpoint["normalized_path"] == request["normalized_path"]]
        exact = [endpoint for endpoint in candidates if endpoint["method"] in {request["method"], "ANY"}]
        status = "matched" if exact else "method_mismatch" if candidates else "backend_not_found"
        matches.append({"status": status, "frontend": request, "backend_candidates": exact or candidates})
    return matches


def main() -> int:
    parser = argparse.ArgumentParser(description="联合分析前端请求与后端 REST 接口")
    parser.add_argument("--frontend", required=True, help="前端代码目录")
    parser.add_argument("--backend", required=True, help="后端代码目录")
    parser.add_argument("--output", required=True, help="输出 JSON 文件")
    args = parser.parse_args()

    frontend_root = Path(args.frontend).resolve()
    backend_root = Path(args.backend).resolve()
    for label, root in (("前端", frontend_root), ("后端", backend_root)):
        if not root.is_dir():
            print(f"ERROR: {label}目录不存在: {root}", file=sys.stderr)
            return 2

    frontend = analyze_frontend(frontend_root)
    backend = analyze_backend(backend_root)
    contracts = correlate(frontend, backend)
    matched = sum(item["status"] == "matched" for item in contracts)
    report = {
        "schema_version": 1,
        "frontend_root": str(frontend_root),
        "backend_root": str(backend_root),
        "frontend_requests": frontend,
        "backend_endpoints": backend,
        "contracts": contracts,
        "summary": {
            "frontend_request_count": len(frontend),
            "backend_endpoint_count": len(backend),
            "matched_contract_count": matched,
            "unmatched_frontend_count": len(contracts) - matched,
        },
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已生成前后端分析: {output}（前端请求 {len(frontend)}，后端接口 {len(backend)}，匹配 {matched}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
