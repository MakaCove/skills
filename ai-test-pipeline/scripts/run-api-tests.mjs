#!/usr/bin/env node
/**
 * =============================================================================
 * 模板文件 — 部署到目标项目 ai-tests/scripts/ 时复制此副本
 * =============================================================================
 * 来源：ai-test-pipeline 技能包 scripts/run-api-tests.mjs
 * 角色：接口用例执行器（HTTP 请求 + 断言 + Markdown 报告）
 * 部署规则：由 api-test-execute 步骤 0 按需首次复制，已存在则跳过
 * =============================================================================
 *
 * run-api-tests.mjs — 接口用例执行器（只接受 trace.* 字段）
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT = 30000;
const V1_FIELDS = ["dependsOnCases", "consumes", "produces", "flowRef", "featureRefs", "contractRef", "scenarioRef"];

function parseArgs(argv) {
  const opts = {
    file: null,
    artifactsDir: "ai-tests/test-artifacts",
    baseUrl: null,
    limit: null,
    all: false,
    module: null,
    ids: null,
    timeout: DEFAULT_TIMEOUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--artifacts-dir") opts.artifactsDir = argv[++i];
    else if (a === "--base-url") opts.baseUrl = argv[++i];
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--all") opts.all = true;
    else if (a === "--module") opts.module = argv[++i];
    else if (a === "--ids") opts.ids = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--timeout") opts.timeout = Number(argv[++i]);
    else if (!a.startsWith("-") && !opts.file) opts.file = a;
  }
  return opts;
}

const HELP = `用法:
  node ai-tests/scripts/run-api-tests.mjs [文件路径] [选项]

选项:
  --artifacts-dir <dir>  产物根目录（默认 ./ai-tests/test-artifacts）
  --base-url <url>       指定测试地址（覆盖用例 meta.baseUrl）
  --limit <n>            仅执行前 n 条（按 executionOrder）
  --all                  执行全部（默认）
  --module <name>        仅执行指定 module
  --ids <id,id,...>      仅执行指定用例 id
  --timeout <ms>         单请求超时（默认 30000）
  -h, --help             显示帮助
`;

function fileExists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

function failField(moduleName, caseId, fieldPath, message) {
  return `[${moduleName || "unknown"}][${caseId || "unknown"}][${fieldPath}] ${message}`;
}

function resolveCaseFile(opts) {
  if (opts.file) return path.resolve(process.cwd(), opts.file);
  const root = path.resolve(process.cwd(), opts.artifactsDir);
  const casesDir = path.join(root, "api-cases");
  const latestPath = path.join(root, "latest");
  if (fileExists(latestPath)) {
    const ts = fs.readFileSync(latestPath, "utf8").trim();
    const candidate = path.join(casesDir, `api-cases-${ts}.json`);
    if (fileExists(candidate)) return candidate;
  }
  if (!fileExists(casesDir)) throw new Error(`未找到 ${casesDir}，也未传入文件路径。`);
  const files = fs.readdirSync(casesDir)
    .filter((n) => /^api-cases-.*\.json$/.test(n))
    .map((n) => ({ full: path.join(casesDir, n), mtime: fs.statSync(path.join(casesDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error("api-cases 目录下没有 api-cases-*.json。");
  return files[0].full;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function getByPath(root, fieldPath) {
  if (!fieldPath) return undefined;
  const parts = String(fieldPath).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = root;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function judge(actual, operator, expected) {
  try {
    switch (operator) {
      case "eq": return actual === expected;
      case "neq": return actual !== expected;
      case "contains": return String(actual).includes(String(expected));
      case "not_contains": return !String(actual).includes(String(expected));
      case "gt": return Number(actual) > Number(expected);
      case "lt": return Number(actual) < Number(expected);
      case "exists": return actual !== undefined && actual !== null;
      case "not_exists": return actual === undefined || actual === null;
      case "regex": return new RegExp(String(expected)).test(String(actual));
      case "type":
        if (expected === "array") return Array.isArray(actual);
        if (expected === "null") return actual === null;
        return typeof actual === expected;
      default: return false;
    }
  } catch {
    return false;
  }
}

function resolveAssertionActual(field, ctx) {
  if (field === "status") return ctx.status;
  if (field === "body") return ctx.bodyText;
  if (field.startsWith("body.")) return getByPath(ctx.body, field.slice(5));
  if (field.startsWith("headers.")) return ctx.headers[field.slice(8).toLowerCase()];
  return getByPath(ctx.body, field);
}

function substitute(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? vars[name] : match));
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}

function collectTemplateVars(testCase) {
  const vars = new Set();
  const scan = (value) => {
    if (typeof value === "string") {
      for (const m of value.matchAll(/\{\{(\w+)\}\}/g)) vars.add(m[1]);
    } else if (Array.isArray(value)) {
      value.forEach(scan);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(scan);
    }
  };
  scan(testCase.request);
  return vars;
}

function ensureV2Shape(meta, cases) {
  for (const c of cases) {
    for (const f of V1_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(c, f)) {
        throw new Error(failField(c.module, c.id, f, "检测到无效字段，仅支持 trace.*"));
      }
    }
    if (!c.trace || typeof c.trace !== "object") {
      throw new Error(failField(c.module, c.id, "trace", "缺少 trace 对象"));
    }
    if (!Array.isArray(c.trace.flowRefs) || c.trace.flowRefs.length === 0) {
      throw new Error(failField(c.module, c.id, "trace.flowRefs", "必须是非空数组"));
    }
    if (c.trace.dependsOn && !Array.isArray(c.trace.dependsOn)) {
      throw new Error(failField(c.module, c.id, "trace.dependsOn", "必须是数组"));
    }
    if (c.trace.consumes && !Array.isArray(c.trace.consumes)) {
      throw new Error(failField(c.module, c.id, "trace.consumes", "必须是数组"));
    }
    if (c.trace.produces && !Array.isArray(c.trace.produces)) {
      throw new Error(failField(c.module, c.id, "trace.produces", "必须是数组"));
    }
  }
  if (!meta.schema || !String(meta.schema).includes("/v2")) {
    throw new Error("[meta][schema] schema 必须包含 /v2");
  }
}

function buildRequestSnapshot(req, baseUrl) {
  const method = req.method || "GET";
  const url = `${baseUrl || ""}${req.path || ""}`;
  const headers = {
    ...(req.body !== undefined && method !== "GET" ? { "Content-Type": "application/json" } : {}),
    ...(req.headers || {}),
  };
  let body = req.body;
  if (body === "__FORM__") body = "(multipart/form)";
  return { method, url, headers, body };
}

function buildResponseSnapshot(resp) {
  if (!resp) return null;
  if (resp.error) return { error: resp.error };
  return {
    status: resp.status,
    headers: resp.headers,
    body: resp.body ?? resp.bodyText ?? null,
  };
}

function formatJsonBlock(value, maxLen = 8000) {
  if (value === undefined) return "_无_";
  let text;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  }
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen)}\n... (已截断，共 ${text.length} 字符)`;
  }
  return `\`\`\`json\n${text}\n\`\`\``;
}

function renderRequestResponseSection(request, response) {
  let md = "";
  if (request) {
    md += "**请求**\n\n";
    md += `- **Method**：\`${request.method}\`\n`;
    md += `- **URL**：\`${request.url}\`\n\n`;
    md += "**Headers**\n\n";
    md += `${formatJsonBlock(request.headers)}\n\n`;
    if (request.body !== undefined) {
      md += "**Body（入参）**\n\n";
      md += `${formatJsonBlock(request.body)}\n\n`;
    }
  }
  if (response) {
    md += "**响应**\n\n";
    if (response.error) {
      md += `- **错误**：${response.error}\n\n`;
    } else {
      md += `- **Status**：\`${response.status}\`\n\n`;
      md += "**Headers**\n\n";
      md += `${formatJsonBlock(response.headers)}\n\n`;
      md += "**Body（响应体）**\n\n";
      md += `${formatJsonBlock(response.body)}\n\n`;
    }
  } else if (request) {
    md += "**响应**：_未发起请求_\n\n";
  }
  return md;
}

function renderAssertionsTable(result) {
  if (!result.assertions || result.assertions.length === 0) return "";
  let md = "**断言**\n\n";
  md += "| 字段 | 操作符 | 期望 | 实际 | 结果 |\n|------|--------|------|------|------|\n";
  for (const a of result.assertions) {
    const passLabel = a.pass ? "通过" : "失败";
    md += `| \`${a.field}\` | \`${a.operator}\` | \`${JSON.stringify(a.expected)}\` | \`${JSON.stringify(a.actual)}\` | ${passLabel} |\n`;
  }
  md += "\n";
  return md;
}

function orderCases(cases) {
  const hasOrder = cases.every((c) => Number.isFinite(c.executionOrder));
  if (hasOrder) return [...cases].sort((a, b) => a.executionOrder - b.executionOrder);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const result = [];
  const visited = new Set();
  const stack = new Set();

  const visit = (c) => {
    if (visited.has(c.id)) return;
    if (stack.has(c.id)) throw new Error(failField(c.module, c.id, "trace.dependsOn", "依赖图中存在循环"));
    stack.add(c.id);
    for (const depId of c.trace?.dependsOn || []) {
      const depCase = byId.get(depId);
      if (depCase) visit(depCase);
    }
    stack.delete(c.id);
    visited.add(c.id);
    result.push(c);
  };
  cases.forEach(visit);
  return result;
}

async function sendRequest(url, init, timeoutMs, retriesLeft = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    const bodyText = await res.text();
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = null; }
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, body, bodyText, headers };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err?.name === "AbortError";
    const msg = err?.message || String(err);
    const isNetwork = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg);
    if (!isTimeout && isNetwork && retriesLeft > 0) {
      return sendRequest(url, init, timeoutMs, retriesLeft - 1);
    }
    return { error: isTimeout ? `请求超时（${timeoutMs / 1000} 秒）` : msg };
  }
}

async function runCase(testCase, vars, opts, completed) {
  const result = {
    id: testCase.id,
    title: testCase.title || "",
    module: testCase.module || "",
    priority: testCase.priority || "",
    flowRefs: testCase.trace.flowRefs || [],
    status: "passed",
    durationMs: 0,
    assertions: [],
    error: null,
    request: null,
    response: null,
    isChain: Boolean((testCase.trace.dependsOn || []).length || (testCase.trace.consumes || []).length || (testCase.trace.produces || []).length),
  };

  if (testCase.mockData && typeof testCase.mockData === "object") {
    for (const [k, v] of Object.entries(testCase.mockData)) {
      if (!(k in vars)) vars[k] = v;
    }
  }

  for (const depId of testCase.trace.dependsOn || []) {
    if (completed.get(depId) && completed.get(depId) !== "passed") {
      result.status = "skipped";
      result.error = failField(testCase.module, testCase.id, "trace.dependsOn", `上游失败传递：${depId}=${completed.get(depId)}`);
      return result;
    }
  }
  for (const varName of testCase.trace.consumes || []) {
    if (!(varName in vars)) {
      result.status = "skipped";
      result.error = failField(testCase.module, testCase.id, "trace.consumes", `变量缺失：${varName}`);
      return result;
    }
  }
  for (const varName of collectTemplateVars(testCase)) {
    if (!(varName in vars)) {
      result.status = "skipped";
      result.error = failField(testCase.module, testCase.id, "request", `模板变量未解析：{{${varName}}}`);
      return result;
    }
  }

  const req = substitute(testCase.request || {}, vars);
  result.request = buildRequestSnapshot(req, opts.baseUrl);
  const url = result.request.url;
  const method = result.request.method;
  const init = {
    method,
    headers: { ...result.request.headers },
  };
  if (req.body !== undefined && method !== "GET" && req.body !== "__FORM__") {
    init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  const t0 = Date.now();
  const resp = await sendRequest(url, init, opts.timeout);
  result.durationMs = Date.now() - t0;
  result.response = buildResponseSnapshot(resp);
  if (resp.error) {
    result.status = "failed";
    result.error = failField(testCase.module, testCase.id, "request", resp.error);
    return result;
  }

  let allPass = true;
  for (const assertion of testCase.assertions || []) {
    const actual = resolveAssertionActual(assertion.field, resp);
    const pass = judge(actual, assertion.operator, assertion.expected);
    if (!pass) allPass = false;
    result.assertions.push({
      field: assertion.field,
      operator: assertion.operator,
      expected: assertion.expected,
      actual,
      pass,
    });
  }
  result.status = allPass ? "passed" : "failed";
  if (!allPass) {
    const failedAssertion = result.assertions.find((item) => !item.pass);
    result.error = failField(
      testCase.module,
      testCase.id,
      `assertions.${failedAssertion.field}`,
      `断言失败：${failedAssertion.operator} 期望=${JSON.stringify(failedAssertion.expected)} 实际=${JSON.stringify(failedAssertion.actual)}`
    );
  }

  if (testCase.extract && typeof testCase.extract === "object") {
    for (const [name, sourcePath] of Object.entries(testCase.extract)) {
      const normalizedPath = String(sourcePath).startsWith("body.") ? String(sourcePath).slice(5) : String(sourcePath);
      const value = getByPath(resp.body, normalizedPath);
      if (value !== undefined && value !== null) vars[name] = value;
    }
  }

  for (const varName of testCase.trace.produces || []) {
    if (!(varName in vars)) {
      result.status = "failed";
      result.error = failField(testCase.module, testCase.id, "trace.produces", `声明产出但未提取：${varName}`);
      break;
    }
  }
  return result;
}

function buildMarkdown(meta, results, caseFile, baseUrl, durationMs) {
  const total = results.length;
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const passRate = total ? ((passed / total) * 100).toFixed(1) : "0.0";
  const coverage = meta?.coverage || {};
  const chain = coverage.flowChains || {};
  const failures = results.filter((r) => r.status !== "passed");
  const icon = (status) => (status === "passed" ? "✅" : status === "failed" ? "❌" : "⏭️");
  let md = "# 接口测试报告\n\n";
  md += `**生成时间**：${new Date().toISOString()}\n`;
  md += `**用例来源**：${caseFile}\n`;
  md += `**执行环境**：${baseUrl}\n`;
  md += `**Schema**：${meta.schema || "unknown"}\n\n---\n\n`;
  md += "## 概览\n\n";
  md += "| 指标 | 数值 |\n|------|------|\n";
  md += `| 总用例数 | ${total} |\n| 通过 | ${passed} |\n| 失败 | ${failed} |\n| 跳过 | ${skipped} |\n| 通过率 | ${passRate}% |\n| 执行耗时 | ${(durationMs / 1000).toFixed(1)}s |\n\n`;
  md += "## 覆盖统计\n\n";
  md += "| 指标 | 数值 |\n|------|------|\n";
  md += `| 主流程覆盖 | ${coverage.mainFlowsCovered ?? "?"} / ${coverage.mainFlowTotal ?? "?"}（${coverage.mainFlowCoveragePercent ?? "?"}%） |\n`;
  md += `| 未覆盖主流程 | ${(coverage.uncoveredMainFlows || []).join(", ") || "无"} |\n`;
  md += `| 孤儿用例数 | ${coverage.orphanCases ?? "?"} |\n`;
  if (chain.chainScenarioTotal) {
    md += `| 链路场景覆盖 | ${chain.chainScenarioCovered} / ${chain.chainScenarioTotal}（${chain.chainScenarioCoveragePercent}%） |\n`;
  }
  md += "\n";
  if (failures.length) {
    md += "## 失败/跳过用例\n\n";
    for (const item of failures) {
      md += `### ${icon(item.status)} ${item.id} — ${item.title}\n\n`;
      md += `- **模块**：${item.module}\n`;
      md += `- **优先级**：${item.priority}\n`;
      md += `- **追溯主流程**：${item.flowRefs.join(", ")}\n`;
      md += `- **错误信息**：${item.error || "无"}\n\n`;
      md += renderAssertionsTable(item);
      md += renderRequestResponseSection(item.request, item.response);
      md += "---\n\n";
    }
  }
  md += "## 全部用例明细\n\n";
  md += "| ID | 模块 | 标题 | 主流程 | 优先级 | 结果 | 耗时 |\n|----|------|------|--------|--------|------|------|\n";
  for (const item of results) {
    md += `| ${item.id} | ${item.module} | ${item.title} | ${item.flowRefs.join(",")} | ${item.priority} | ${icon(item.status)} | ${item.durationMs}ms |\n`;
  }
  md += "\n## 用例请求与响应明细\n\n";
  for (const item of results) {
    md += `### ${icon(item.status)} ${item.id} — ${item.title}\n\n`;
    md += renderAssertionsTable(item);
    md += renderRequestResponseSection(item.request, item.response);
    md += "---\n\n";
  }
  return md;
}

function filterCases(cases, opts) {
  let selected = cases;
  if (opts.ids) selected = selected.filter((c) => opts.ids.includes(c.id));
  if (opts.module) selected = selected.filter((c) => c.module === opts.module);
  const ordered = orderCases(selected);
  if (opts.limit && !opts.all) return ordered.slice(0, opts.limit);
  return ordered;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  let caseFile;
  let payload;
  try {
    caseFile = resolveCaseFile(opts);
    payload = JSON.parse(fs.readFileSync(caseFile, "utf8"));
  } catch (error) {
    console.error(`❌ 读取用例失败：${error.message}`);
    process.exit(1);
  }
  if (!Array.isArray(payload) || payload.length < 2) {
    console.error("❌ 用例文件结构错误：顶层必须是 [meta, ...cases]。");
    process.exit(1);
  }

  const meta = payload[0];
  const allCases = payload.slice(1);
  try {
    ensureV2Shape(meta, allCases);
  } catch (error) {
    console.error(`❌ 校验失败：${error.message}`);
    process.exit(1);
  }

  const baseUrl = opts.baseUrl || meta.baseUrl;
  if (!baseUrl) {
    console.error("❌ 缺少测试地址 baseUrl。请通过 --base-url 传入，或在用例 meta.baseUrl 中填写。");
    process.exit(1);
  }
  opts.baseUrl = baseUrl;
  const vars = {};
  if (meta.mockData && typeof meta.mockData === "object") Object.assign(vars, meta.mockData);
  const account = meta.testAccount || meta.auth?.testAccount;
  if (account?.username) vars.username = account.username;
  if (account?.password) vars.password = account.password;
  vars.timestamp = String(Date.now());

  const selectedCases = filterCases(allCases, opts);
  console.log(`\n🚀 API 执行 | baseUrl=${opts.baseUrl} | 选中 ${selectedCases.length}/${allCases.length} 条\n`);

  const completed = new Map();
  const results = [];
  const begin = Date.now();
  for (const testCase of selectedCases) {
    const result = await runCase(testCase, vars, opts, completed);
    completed.set(testCase.id, result.status);
    results.push(result);
    const icon = result.status === "passed" ? "✅" : result.status === "failed" ? "❌" : "⏭️";
    console.log(`${icon} ${testCase.id} ${testCase.title || ""}${result.error ? ` — ${result.error}` : ""}`);
  }
  const durationMs = Date.now() - begin;

  const root = path.resolve(process.cwd(), opts.artifactsDir);
  const reportsDir = path.join(root, "api-reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const ts = timestamp();
  const reportPath = path.join(reportsDir, `api-report-${ts}.md`);
  fs.writeFileSync(reportPath, buildMarkdown(meta, results, caseFile, opts.baseUrl, durationMs), "utf8");

  const failed = results.filter((r) => r.status === "failed").length;
  const passed = results.filter((r) => r.status === "passed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  console.log(`\n📊 通过 ${passed} | ❌ 失败 ${failed} | ⏭️ 跳过 ${skipped}`);
  console.log(`📁 报告：${reportPath}`);
  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run-api-tests.mjs")) {
  main();
}

export { parseArgs, resolveCaseFile, timestamp, fileExists };
