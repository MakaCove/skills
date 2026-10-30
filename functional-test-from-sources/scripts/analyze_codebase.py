#!/usr/bin/env python3
"""Inventory frontend requests and backend REST endpoints without executing project code."""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from itertools import product
from pathlib import Path
from urllib.parse import urlsplit


SUPPORTED_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx", ".vue", ".java", ".go"}
IGNORED_DIRS = {".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", "vendor", "__pycache__"}

FRONTEND_REQUESTS = [
    re.compile(r"\b(?P<client>axios|http|client|request)\.(?P<method>get|post|put|patch|delete)\s*\(\s*[`'\"](?P<path>[^`'\"]+)", re.I),
    re.compile(r"\bfetch\s*\(\s*[`'\"](?P<path>[^`'\"]+)[`'\"](?P<tail>[\s\S]{0,300}?)\)", re.I),
    re.compile(r"\b(?:request|httpRequest|apiRequest)\s*\(\s*\{(?P<config>[\s\S]{0,500}?)\}\s*\)", re.I),
]
EXPRESS_ROUTE = re.compile(r"\b(?:app|router)\.(?P<method>get|post|put|patch|delete)\s*\(\s*[`'\"](?P<path>[^`'\"]+)", re.I)
SPRING_ROUTE = re.compile(r"@(?P<kind>Get|Post|Put|Patch|Delete|Request)Mapping\b", re.I)
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
    if value.startswith(("http://", "https://")):
        value = urlsplit(value).path
    path = re.sub(r"\$\{[^}]+}|:[A-Za-z_][\w]*|\{[^}/]+\}|<[^>]+>", "{param}", value)
    path = re.sub(r"//+", "/", path.split("?", 1)[0])
    if not path.startswith("/"):
        path = "/" + path
    return path.rstrip("/") or "/"


def analyze_frontend(root: Path, review_notes: list[str] | None = None) -> list[dict[str, object]]:
    requests: list[dict[str, object]] = []
    review_notes = review_notes if review_notes is not None else []
    for path in iter_source_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            review_notes.append(f"{path.relative_to(root)} 读取失败，未扫描: {exc}")
            continue
        recognized = set()
        for pattern in FRONTEND_REQUESTS:
            for match in pattern.finditer(text):
                method = match.groupdict().get("method") or "GET"
                tail = match.groupdict().get("tail") or ""
                config = match.groupdict().get("config") or ""
                if pattern is FRONTEND_REQUESTS[1]:
                    method_match = re.search(r"method\s*:\s*[`'\"](GET|POST|PUT|PATCH|DELETE)", tail, re.I)
                    method = method_match.group(1) if method_match else "UNKNOWN" if re.search(r"\bmethod\s*:", tail) else "GET"
                if pattern is FRONTEND_REQUESTS[2]:
                    path_match = re.search(r"(?:url|path)\s*:\s*[`'\"]([^`'\"]+)", config, re.I)
                    if not path_match:
                        continue
                    raw_path = path_match.group(1)
                    method_match = re.search(r"method\s*:\s*[`'\"](GET|POST|PUT|PATCH|DELETE)", config, re.I)
                    # Wrapper defaults are not necessarily the Fetch API's GET.
                    method = method_match.group(1) if method_match else "UNKNOWN"
                else:
                    raw_path = match.group("path")
                recognized.add(match.start())
                notes = []
                if method == "UNKNOWN":
                    notes.append("封装请求未明确方法，需阅读默认配置")
                if "${" in raw_path or re.match(r"[`'\"]\s*\+", text[match.end():]):
                    notes.append("动态或拼接地址，需核对完整路径")
                if re.search(r"\b(baseURL|baseUrl)\s*:", text):
                    notes.append("文件含请求前缀配置，需核对最终地址")
                requests.append({
                    "method": method.upper(),
                    "path": raw_path,
                    "normalized_path": None if notes else normalize_path(raw_path),
                    "evidence": evidence(root, path, line_number(text, match.start())),
                    "needs_review": bool(notes), "review_notes": notes,
                })
        calls = re.finditer(r"\b(?:axios|http|client|request)\.(?:get|post|put|patch|delete)\s*\(|\b(?:fetch|request|httpRequest|apiRequest)\s*\(", text, re.I)
        for call in calls:
            if call.start() not in recognized:
                requests.append({
                    "method": "UNKNOWN", "path": None, "normalized_path": None,
                    "evidence": evidence(root, path, line_number(text, call.start())),
                    "needs_review": True, "review_notes": ["请求参数未解析，需阅读地址与方法配置"],
                })
    unique: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for request in requests:
        key = (str(request["method"]), str(request["normalized_path"]), str(request["evidence"]))
        if key not in seen:
            seen.add(key)
            unique.append(request)
    return unique


def mask_noncode(text: str) -> str:
    pattern = re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'')
    return pattern.sub(lambda m: re.sub(r"[^\n]", " ", m.group()), text)


def closing_bracket(masked: str, start: int, left: str, right: str) -> int | None:
    depth = 0
    for index in range(start, len(masked)):
        if masked[index] == left:
            depth += 1
        elif masked[index] == right:
            depth -= 1
            if depth == 0:
                return index
    return None


def spring_mapping_args(kind: str, args: str) -> tuple[list[str], list[str], list[str]]:
    notes = []
    path_arg = re.search(r"\b(?:value|path)\s*=\s*(\{[^}]*\}|[^,]+)", args)
    raw = path_arg.group(1).strip() if path_arg else args.strip() if args.strip().startswith(('"', '{')) else None
    if raw is None:
        # A bare constant is an unresolved positional path, not an empty path.
        raw = args.strip() if args.strip() and "=" not in args else '""'
    literal = r'"(?:\\.|[^"\\])*"'
    valid = re.fullmatch(literal, raw) or re.fullmatch(r"\{\s*(?:" + literal + r"\s*(?:,\s*" + literal + r"\s*)*)?\}", raw)
    paths = re.findall(r'"((?:\\.|[^"\\])*)"', raw) if valid else []
    if not valid or not paths or any("${" in item or "\\" in item for item in paths):
        notes.append("路由常量、配置占位或表达式未解析")
        paths = paths or [""]
    if kind.upper() == "REQUEST":
        methods_arg = re.search(r"\bmethod\s*=\s*(\{[^}]*\}|[^,]+)", args)
        methods = re.findall(r"RequestMethod\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b", methods_arg.group(1)) if methods_arg else ["ANY"]
        if not methods:
            methods = ["UNKNOWN"]
            notes.append("RequestMapping 方法限制未解析")
    else:
        methods = [kind.upper()]
    return paths, methods, notes


def spring_endpoints(root: Path, path: Path, text: str) -> list[dict[str, object]]:
    """Resolve common literal class/method mappings; leave uncertain forms for review."""
    masked = mask_noncode(text)
    classes = []
    for match in re.finditer(r"\b(?:class|interface|record)\s+(\w+)[^{;]*\{", masked):
        end = closing_bracket(masked, match.end() - 1, "{", "}")
        if end is not None:
            classes.append({"start": match.start(), "body": match.end() - 1, "end": end,
                            "paths": [""], "notes": [], "name": match.group(1)})
    mappings = []
    for match in SPRING_ROUTE.finditer(masked):
        after = match.end()
        while after < len(masked) and masked[after].isspace():
            after += 1
        args = ""
        if after < len(masked) and masked[after] == "(":
            end = closing_bracket(masked, after, "(", ")")
            if end is None:
                mappings.append((match, after, [""], ["UNKNOWN"], ["路由注解未闭合"]))
                continue
            args = text[after + 1:end]
            after = end + 1
        paths, methods, notes = spring_mapping_args(match.group("kind"), args)
        mappings.append((match, after, paths, methods, notes))
    method_mappings = []
    for match, after, paths, methods, notes in mappings:
        boundary = re.search(r"[;{]", masked[after:])
        declaration_end = after + boundary.start() if boundary else len(masked)
        target = next((item for item in classes if after <= item["start"] < declaration_end), None)
        if target is not None:
            target["paths"] = paths
            target["notes"] = notes
        else:
            method_mappings.append((match, after, paths, methods, notes))
    endpoints = []
    for match, after, paths, methods, notes in method_mappings:
        enclosing = [item for item in classes if item["body"] < match.start() < item["end"]]
        owner = max(enclosing, key=lambda item: item["body"]) if enclosing else None
        notes = list(notes) + (owner["notes"] if owner else ["未确定所属类与前缀"])
        prefixes = owner["paths"] if owner else [""]
        following = next((m.start() for m in SPRING_ROUTE.finditer(masked, after)), len(text))
        segment = text[match.start():following]
        for prefix, route, method in product(prefixes, paths, methods):
            full_path = "/".join((prefix.rstrip("/"), route.lstrip("/")))
            endpoints.append({
                "method": method, "path": full_path,
                "normalized_path": None if notes else normalize_path(full_path),
                "symbol": owner["name"] if owner else "",
                "evidence": evidence(root, path, line_number(text, match.start())),
                "auth_signal": bool(AUTH_PATTERN.search(segment)),
                "state_signal": bool(STATE_PATTERN.search(segment)),
                "error_signal": bool(ERROR_PATTERN.search(segment)),
                "branch_count": len(re.findall(r"\b(if|switch|catch)\b", segment)),
                "needs_review": bool(notes), "review_notes": notes,
            })
    return endpoints


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
        return spring_endpoints(root, path, text)
    elif suffix == ".go":
        patterns = [(GO_ROUTE, None)]
    else:
        patterns = []
    for pattern, kind in patterns:
        for match in pattern.finditer(text):
            method = match.groupdict().get("method")
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


def analyze_backend(root: Path, review_notes: list[str] | None = None) -> list[dict[str, object]]:
    endpoints: list[dict[str, object]] = []
    review_notes = review_notes if review_notes is not None else []
    for path in iter_source_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            review_notes.append(f"{path.relative_to(root)} 读取失败，未扫描: {exc}")
            continue
        if path.suffix.lower() == ".py" and re.search(r"\b(prefix|url_prefix)\s*=|\binclude_router\s*\(", text):
            review_notes.append(f"{path.relative_to(root)} 存在 Python 路由前缀/挂载配置，扫描路径需人工组装")
        if path.suffix.lower() in {".js", ".ts", ".go"} and re.search(r"\b(?:use|Group|group)\s*\(", text):
            review_notes.append(f"{path.relative_to(root)} 存在路由挂载/分组，需人工核对前缀")
        if path.suffix.lower() == ".py":
            endpoints.extend(python_endpoints(root, path, text))
        endpoints.extend(regex_endpoints(root, path, text))
    return endpoints


def correlate(frontend: list[dict[str, object]], backend: list[dict[str, object]]) -> list[dict[str, object]]:
    matches: list[dict[str, object]] = []
    for request in frontend:
        candidates = [endpoint for endpoint in backend if request.get("normalized_path") is not None and endpoint.get("normalized_path") == request["normalized_path"]]
        exact = [endpoint for endpoint in candidates if endpoint["method"] in {request["method"], "ANY"}]
        status = "needs_review" if request.get("needs_review") else "matched_candidate" if exact else "method_mismatch_candidate" if candidates else "not_matched_in_scan"
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

    review_notes = ["本结果是静态定位线索，不是完整接口清单；未匹配不代表功能缺失。", "需结合网关、请求封装、继承及动态注册确认最终路径；权限/状态/异常信号不是已验证的业务规则。"]
    frontend = analyze_frontend(frontend_root, review_notes)
    backend = analyze_backend(backend_root, review_notes)
    contracts = correlate(frontend, backend)
    matched = sum(item["status"] == "matched_candidate" for item in contracts)
    report = {
        "schema_version": 2,
        "review_notes": review_notes,
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
