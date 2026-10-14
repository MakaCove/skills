#!/usr/bin/env node
/**
 * =============================================================================
 * 模板文件 — 部署到目标项目 ai-tests/scripts/ 时复制此副本
 * =============================================================================
 * 来源：ai-test-pipeline 技能包 scripts/validate-artifacts.mjs
 * 角色：产物轻量校验器（Schema 检查 + V1 字段检测 + trace 完整性）
 * 部署规则：由 ui-test-execute / api-test-execute 步骤 0 按需首次复制，已存在则跳过
 * =============================================================================
 *
 * validate-artifacts.mjs — 产物轻量校验器
 */

import fs from "node:fs";
import path from "node:path";

const V1_FIELDS = ["dependsOnCases", "consumes", "produces", "flowRef", "featureRefs", "featureRef", "contractRef", "scenarioRef"];

function parseArgs(argv) {
  const opts = { artifactsDir: "ai-tests/test-artifacts", type: "all", file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--artifacts-dir") opts.artifactsDir = argv[++i];
    else if (a === "--type") opts.type = argv[++i];
    else if (a === "--file") opts.file = argv[++i];
  }
  return opts;
}

const HELP = `用法:
  node ai-tests/scripts/validate-artifacts.mjs [选项]

选项:
  --artifacts-dir <dir>  产物根目录（默认 ./ai-tests/test-artifacts）
  --type <api|ui|all>    校验类型（默认 all）
  --file <path>          直接指定单个用例文件
  -h, --help             显示帮助
`;

function fileExists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function latestCaseFile(root, dirName, pattern) {
  const dir = path.join(root, dirName);
  if (!fileExists(dir)) return null;
  const latestPath = path.join(root, "latest");
  if (fileExists(latestPath)) {
    const ts = fs.readFileSync(latestPath, "utf8").trim();
    const candidate = path.join(dir, pattern.replace("{ts}", ts));
    if (fileExists(candidate)) return candidate;
  }
  const files = fs.readdirSync(dir)
    .filter((n) => new RegExp(`^${pattern.replace("{ts}", ".*").replace(".", "\\.")}$`).test(n))
    .map((n) => ({ full: path.join(dir, n), m: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files[0]?.full || null;
}

function describeMissingFiles(opts, root) {
  const lines = [
    "❌ 未找到可校验的用例文件。",
    "",
    `当前工作目录：${process.cwd()}`,
    `产物目录：${root}`,
    "",
    "脚本会在上述产物目录下查找：",
  ];
  if (opts.type === "all" || opts.type === "api") {
    const apiDir = path.join(root, "api-cases");
    const api = latestCaseFile(root, "api-cases", "api-cases-{ts}.json");
    lines.push(`- API：${apiDir}/api-cases-*.json ${api ? `(命中 ${api})` : "(未找到)"}`);
  }
  if (opts.type === "all" || opts.type === "ui") {
    const uiDir = path.join(root, "ui-cases");
    const ui = latestCaseFile(root, "ui-cases", "ui-cases-{ts}.json");
    lines.push(`- UI：${uiDir}/ui-cases-*.json ${ui ? `(命中 ${ui})` : "(未找到)"}`);
  }
  lines.push(
    "",
    "常见原因：",
    "1. 在错误目录执行（应在包含 ai-tests/test-artifacts/ 的被测项目根目录运行）",
    "2. 尚未生成用例（需先运行 api-test-case-generate / ui-test-case-generate）",
    "3. --type 与现有产物不匹配（例如只有 API 用例却用了 --type ui）",
    "4. ai-tests/test-artifacts/latest 指向的时间戳文件不存在",
    "",
    "解决方式：",
    "  node ai-tests/scripts/validate-artifacts.mjs --type api",
    "  node ai-tests/scripts/validate-artifacts.mjs --file ai-tests/test-artifacts/api-cases/api-cases-xxx.json",
    "  node ai-tests/scripts/validate-artifacts.mjs --artifacts-dir <产物目录>",
  );
  return lines.join("\n");
}

function pushErr(list, file, moduleName, caseId, fieldPath, message) {
  list.push(`[${path.basename(file)}][${moduleName || "unknown"}][${caseId || "unknown"}][${fieldPath}] ${message}`);
}

function validateCommon(file, payload, schemaNeedle) {
  const errors = [];
  if (!Array.isArray(payload) || payload.length < 2) {
    pushErr(errors, file, "meta", "meta", "root", "顶层必须是 [meta, ...cases]");
    return { errors, meta: null, cases: [] };
  }
  const meta = payload[0];
  const cases = payload.slice(1);
  if (!meta?.schema || !String(meta.schema).includes(schemaNeedle)) {
    pushErr(errors, file, "meta", "meta", "schema", `schema 必须包含 ${schemaNeedle}`);
  }
  if (!meta?.generatedAt) {
    pushErr(errors, file, "meta", "meta", "generatedAt", "缺少生成时间");
  }
  const ids = new Set();
  for (const c of cases) {
    if (!c?.id) {
      pushErr(errors, file, c?.module, c?.id, "id", "缺少 id");
      continue;
    }
    if (ids.has(c.id)) {
      pushErr(errors, file, c.module, c.id, "id", "id 重复");
    }
    ids.add(c.id);
    if (!c.module) pushErr(errors, file, c.module, c.id, "module", "缺少 module");
    if (!c.priority) pushErr(errors, file, c.module, c.id, "priority", "缺少 priority");
    for (const f of V1_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(c, f)) {
        pushErr(errors, file, c.module, c.id, f, "检测到无效字段，仅支持 trace.*");
      }
    }
    if (!c.trace || typeof c.trace !== "object") {
      pushErr(errors, file, c.module, c.id, "trace", "缺少 trace 对象");
      continue;
    }
    if (!Array.isArray(c.trace.flowRefs) || c.trace.flowRefs.length === 0) {
      pushErr(errors, file, c.module, c.id, "trace.flowRefs", "必须是非空数组");
    }
    if (c.trace.dependsOn && !Array.isArray(c.trace.dependsOn)) {
      pushErr(errors, file, c.module, c.id, "trace.dependsOn", "必须是数组");
    }
    if (c.trace.consumes && !Array.isArray(c.trace.consumes)) {
      pushErr(errors, file, c.module, c.id, "trace.consumes", "必须是数组");
    }
    if (c.trace.produces && !Array.isArray(c.trace.produces)) {
      pushErr(errors, file, c.module, c.id, "trace.produces", "必须是数组");
    }
  }
  return { errors, meta, cases };
}

const VALID_UI_ACTIONS = new Set([
  "reset_session", "open_login", "ensure_session", "reset_page", "dismiss_menu",
  "click_menu", "switch_auth_tab", "switch_tab", "activate_tab", "navigate",
  "click", "double_click", "right_click", "fill", "clear", "select", "select_dropdown",
  "check", "uncheck", "upload_file", "hover", "wait", "wait_visible", "press_key", "scroll", "screenshot",
]);

const VALID_UI_ASSERTIONS = new Set([
  "element_visible", "element_hidden", "element_disabled", "element_enabled",
  "text_contains", "text_not_contains", "url_equals", "url_contains",
  "count_gte", "count_gt", "count_eq", "count_lt", "count_lte",
  "input_value_equals", "input_value_contains",
  "dialog_visible", "dialog_hidden", "toast_contains", "toast_not_contains", "attribute_equals",
]);

const VALID_SCOPES = new Set(["core", "related", "regression"]);

const VALID_API_OPERATORS = new Set(["eq", "neq", "contains", "not_contains", "gt", "lt", "regex", "type", "exists", "not_exists"]);

function validateApiFile(file) {
  const payload = readJson(file);
  const { errors, meta, cases } = validateCommon(file, payload, "api-case/v2");
  const idSet = new Set(cases.map((c) => c.id));
  for (const c of cases) {
    if (!c.request || typeof c.request !== "object") {
      pushErr(errors, file, c.module, c.id, "request", "缺少 request");
    } else {
      if (!c.request.method) pushErr(errors, file, c.module, c.id, "request.method", "缺少 method");
      if (!c.request.path) pushErr(errors, file, c.module, c.id, "request.path", "缺少 path");
    }
    if (!Array.isArray(c.assertions) || c.assertions.length === 0) {
      pushErr(errors, file, c.module, c.id, "assertions", "必须是非空数组");
    }
    for (const a of c.assertions || []) {
      if (a.operator && !VALID_API_OPERATORS.has(a.operator)) {
        pushErr(errors, file, c.module, c.id, `assertions.${a.field || a.operator}`, `不支持的 operator：${a.operator}`);
      }
    }
    for (const depId of c.trace?.dependsOn || []) {
      if (!idSet.has(depId)) pushErr(errors, file, c.module, c.id, "trace.dependsOn", `引用不存在：${depId}`);
    }
  }
  return errors;
}

function validateUiFile(file) {
  const payload = readJson(file);
  const { errors, meta, cases } = validateCommon(file, payload, "ui-case/v2");
  const idSet = new Set(cases.map((c) => c.id));
  const menuMap = meta?.coverage?.routeMenuMap || [];
  for (const c of cases) {
    if (!Array.isArray(c.steps) || c.steps.length === 0) {
      pushErr(errors, file, c.module, c.id, "steps", "必须是非空数组");
    }
    for (const s of c.steps || []) {
      if (s.action && !VALID_UI_ACTIONS.has(s.action)) {
        pushErr(errors, file, c.module, c.id, `steps.${s.step}.action`, `不支持的 action：${s.action}`);
      }
    }
    if (!Array.isArray(c.assertions) || c.assertions.length === 0) {
      pushErr(errors, file, c.module, c.id, "assertions", "必须是非空数组");
    }
    for (const a of c.assertions || []) {
      if (a.type && !VALID_UI_ASSERTIONS.has(a.type)) {
        pushErr(errors, file, c.module, c.id, `assertions.${a.type}`, `不支持的断言类型：${a.type}`);
      }
    }
    if (c.scope && !VALID_SCOPES.has(c.scope)) {
      pushErr(errors, file, c.module, c.id, "scope", `不支持的 scope：${c.scope}`);
    }
    for (const depId of c.trace?.dependsOn || []) {
      if (!idSet.has(depId)) pushErr(errors, file, c.module, c.id, "trace.dependsOn", `引用不存在：${depId}`);
    }
  }
  // routeMenuMap 结构校验
  for (const entry of menuMap) {
    if (entry.requiresAuth && !entry.menuLabel && entry.navigation?.type !== "direct") {
      pushErr(errors, file, "meta", "meta", "coverage.routeMenuMap", `条目缺少 menuLabel：route=${entry.route}`);
    }
  }
  return errors;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }

  const root = path.resolve(process.cwd(), opts.artifactsDir);
  const files = [];
  if (opts.file) {
    files.push(path.resolve(process.cwd(), opts.file));
  } else {
    if (opts.type === "all" || opts.type === "api") {
      const api = latestCaseFile(root, "api-cases", "api-cases-{ts}.json");
      if (api) files.push(api);
    }
    if (opts.type === "all" || opts.type === "ui") {
      const ui = latestCaseFile(root, "ui-cases", "ui-cases-{ts}.json");
      if (ui) files.push(ui);
    }
  }

  if (files.length === 0) {
    console.error(describeMissingFiles(opts, root));
    process.exit(1);
  }

  const allErrors = [];
  for (const file of files) {
    if (!fileExists(file)) {
      allErrors.push(`[${file}] 文件不存在`);
      continue;
    }
    try {
      if (file.includes("api-cases")) {
        allErrors.push(...validateApiFile(file));
      } else if (file.includes("ui-cases")) {
        allErrors.push(...validateUiFile(file));
      } else {
        allErrors.push(`[${file}] 无法推断用例类型，请放在 api-cases 或 ui-cases 目录`);
      }
    } catch (err) {
      allErrors.push(`[${file}] JSON 解析或校验异常：${err.message}`);
    }
  }

  if (allErrors.length > 0) {
    console.error("❌ 校验失败：");
    for (const e of allErrors) console.error(`- ${e}`);
    process.exit(1);
  }
  console.log(`✅ 校验通过，共 ${files.length} 个文件。`);
}

main();
