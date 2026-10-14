#!/usr/bin/env node
/**
 * =============================================================================
 * 模板文件 — 部署到目标项目 ai-tests/scripts/ 时复制此副本
 * =============================================================================
 * 来源：ai-test-pipeline 技能包 scripts/run-ui-tests.mjs
 * 角色：UI 用例执行器（Playwright 浏览器自动化 + 断言 + 截图 + Markdown 报告）
 * 部署规则：由 ui-test-execute 步骤 0 按需首次复制，已存在则跳过
 * =============================================================================
 *
 * run-ui-tests.mjs — UI 用例执行器（只接受 trace.*）
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const V1_FIELDS = ["dependsOnCases", "consumes", "produces", "featureRef", "featureRefs"];

function parseArgs(argv) {
  const o = {
    file: null,
    artifactsDir: "ai-tests/test-artifacts",
    baseUrl: null,
    profile: null,
    localChrome: false,
    headless: false,
    slowMo: null,
    limit: null,
    all: false,
    module: null,
    ids: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--artifacts-dir") o.artifactsDir = argv[++i];
    else if (a === "--base-url") o.baseUrl = argv[++i];
    else if (a === "--profile") o.profile = argv[++i];
    else if (a === "--local-chrome") o.localChrome = true;
    else if (a === "--headless") o.headless = true;
    else if (a === "--slow-mo") o.slowMo = Number(argv[++i]);
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--all") o.all = true;
    else if (a === "--module") o.module = argv[++i];
    else if (a === "--ids") o.ids = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else if (!a.startsWith("-") && !o.file) o.file = a;
  }
  return o;
}

const HELP = `用法:
  node ai-tests/scripts/run-ui-tests.mjs [文件路径] [选项]

选项:
  --artifacts-dir <dir>  产物根目录（默认 ./ai-tests/test-artifacts）
  --base-url <url>       指定测试地址（覆盖用例 meta.baseUrl）
  --profile <name>       ui-test.config.json 中的 profile
  --local-chrome         强制系统 Chrome
  --headless             无头模式（须明确指定）
  --slow-mo <ms>         动作间隔
  --limit <n> / --all    执行范围
  --module <name> / --ids <id,...>
  -h, --help             显示帮助
`;

function fileExists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function failField(moduleName, caseId, fieldPath, message) {
  return `[${moduleName || "unknown"}][${caseId || "unknown"}][${fieldPath}] ${message}`;
}

function resolveCaseFile(opts) {
  if (opts.file) return path.resolve(process.cwd(), opts.file);
  const root = path.resolve(process.cwd(), opts.artifactsDir);
  const dir = path.join(root, "ui-cases");
  const latest = path.join(root, "latest");
  if (fileExists(latest)) {
    const ts = fs.readFileSync(latest, "utf8").trim();
    const c = path.join(dir, `ui-cases-${ts}.json`);
    if (fileExists(c)) return c;
  }
  if (!fileExists(dir)) throw new Error(`未找到 ${dir}，也未传入文件路径。`);
  const files = fs.readdirSync(dir).filter((n) => /^ui-cases-.*\.json$/.test(n))
    .map((n) => ({ full: path.join(dir, n), m: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) throw new Error("ui-cases 目录下没有 ui-cases-*.json。");
  return files[0].full;
}

function loadUiConfig(root) {
  const cfgPath = path.join(root, "ui-test.config.json");
  if (!fileExists(cfgPath)) return null;
  try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch { return null; }
}

function scriptRootDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function resolvePlaywrightModulePaths(cfg) {
  const paths = [];
  for (const p of cfg?.browserResolve?.playwrightModulePaths || []) {
    paths.push(path.resolve(p));
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    paths.push(path.join(dir, "node_modules", "playwright"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  paths.push(path.join(scriptRootDir(), "node_modules", "playwright"));
  return [...new Set(paths)];
}

async function resolvePlaywrightModule(cfg) {
  const browsersPath = cfg?.browserResolve?.playwrightBrowsersPath
    || process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(process.env.LOCALAPPDATA || "", "ms-playwright");

  if (fileExists(browsersPath)) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;

  for (const pkgDir of resolvePlaywrightModulePaths(cfg)) {
    const pkgJson = path.join(pkgDir, "package.json");
    if (!fileExists(pkgJson)) continue;
    try {
      const req = createRequire(path.join(pkgDir, "index.js"));
      const mod = req(".");
      const version = JSON.parse(fs.readFileSync(pkgJson, "utf8")).version;
      return { chromium: mod.chromium, version, modulePath: pkgDir, browsersPath };
    } catch {
      // noop
    }
  }

  try {
    const mod = await import("playwright");
    return { chromium: mod.chromium, version: "unknown", modulePath: "playwright", browsersPath };
  } catch {
    return null;
  }
}

function readChromiumRevision(modulePath) {
  if (!modulePath || modulePath === "playwright") return null;
  const browsersJson = path.join(path.dirname(modulePath), "playwright-core", "browsers.json");
  if (!fileExists(browsersJson)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(browsersJson, "utf8"));
    return data.browsers?.find((b) => b.name === "chromium")?.revision || null;
  } catch {
    return null;
  }
}

function hasFixedChromium(browsersPath, revision) {
  if (!revision || !fileExists(browsersPath)) return false;
  const dir = path.join(browsersPath, `chromium-${revision}`);
  if (!fileExists(dir)) return false;
  const markers = [
    path.join(dir, "INSTALLATION_COMPLETE"),
    path.join(dir, "chrome-win64", "chrome.exe"),
    path.join(dir, "chrome-linux", "chrome"),
    path.join(dir, "chrome-mac", "Chromium.app"),
  ];
  return markers.some((p) => fileExists(p));
}

function findChromeExecutable(cfg) {
  for (const p of cfg?.browserResolve?.chromeExecutablePaths || []) {
    const resolved = path.resolve(p);
    if (fileExists(resolved)) return resolved;
  }
  const defaults = [
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  return defaults.find((p) => p && fileExists(p)) || null;
}

function resolveBrowserEngine(cfg, pwInfo, headed) {
  const prefer = cfg?.browserResolve?.preferEngine || ["fixed-chromium", "system-chrome"];
  const revision = readChromiumRevision(pwInfo?.modulePath);
  const browsersPath = pwInfo?.browsersPath;
  const chromeExe = findChromeExecutable(cfg);
  for (const step of prefer) {
    if (step === "fixed-chromium" && hasFixedChromium(browsersPath, revision)) {
      return {
        engine: "playwright-chromium",
        launchOptions: { headless: !headed },
        label: `固定缓存 chromium-${revision} (${headed ? "headed" : "headless"})`,
      };
    }
    if (step === "system-chrome" && chromeExe) {
      return {
        engine: "local-chrome",
        launchOptions: { headless: !headed, channel: "chrome" },
        label: `系统 Chrome (${headed ? "headed" : "headless"}) @ ${chromeExe}`,
      };
    }
  }
  return {
    engine: "playwright-chromium",
    launchOptions: { headless: !headed },
    label: `Playwright Chromium 兜底 (${headed ? "headed" : "headless"})`,
  };
}

function resolveProfile(opts, cfg) {
  let name = opts.profile;
  if (!name && opts.localChrome) name = opts.headless ? "local-chrome-headless" : "local-chrome-headed";
  if (!name) name = cfg?.defaultProfile || "auto-headed";
  const builtin = {
    "auto-headed": { engine: "auto", headed: true, slowMo: 800, launchOptions: { args: ["--start-maximized"] }, contextOptions: { viewport: null } },
    "auto-headless": { engine: "auto", headed: false, slowMo: 0 },
    "playwright-headed": { engine: "playwright-chromium", headed: true, slowMo: 1000, launchOptions: { args: ["--start-maximized"] }, contextOptions: { viewport: null } },
    "playwright-headless": { engine: "playwright-chromium", headed: false, slowMo: 0 },
    "local-chrome-headed": { engine: "local-chrome", headed: true, slowMo: 800, launchOptions: { args: ["--start-maximized"] }, contextOptions: { viewport: null } },
    "local-chrome-headless": { engine: "local-chrome", headed: false, slowMo: 0 },
  };
  const profile = { ...(cfg?.profiles?.[name] || builtin[name] || builtin["auto-headed"]) };
  if (opts.headless) profile.headed = false;
  if (opts.slowMo != null) profile.slowMo = opts.slowMo;
  return { name, profile: applyHeadedWindowDefaults(profile) };
}

/** 有头模式默认最大化窗口（launch args + viewport: null） */
function applyHeadedWindowDefaults(profile) {
  if (!profile.headed) return profile;
  const launchOptions = { ...(profile.launchOptions || {}) };
  const args = new Set(Array.isArray(launchOptions.args) ? launchOptions.args : []);
  args.add("--start-maximized");
  launchOptions.args = [...args];
  return {
    ...profile,
    launchOptions,
    contextOptions: { viewport: null, ...(profile.contextOptions || {}) },
  };
}

function ensureV2Shape(meta, cases) {
  if (!meta.schema || !String(meta.schema).includes("/v2")) {
    throw new Error("[meta][schema] schema 必须包含 /v2");
  }
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
}

function orderCases(cases) {
  const hasOrder = cases.every((c) => Number.isFinite(c.executionOrder));
  if (hasOrder) return [...cases].sort((a, b) => a.executionOrder - b.executionOrder);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const visited = new Set();
  const stack = new Set();
  const out = [];
  const visit = (c) => {
    if (visited.has(c.id)) return;
    if (stack.has(c.id)) throw new Error(failField(c.module, c.id, "trace.dependsOn", "依赖图中存在循环"));
    stack.add(c.id);
    for (const depId of c.trace?.dependsOn || []) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    stack.delete(c.id);
    visited.add(c.id);
    out.push(c);
  };
  cases.forEach(visit);
  return out;
}

function filterCases(cases, opts) {
  let sel = cases;
  if (opts.ids) sel = sel.filter((c) => opts.ids.includes(c.id));
  if (opts.module) sel = sel.filter((c) => c.module === opts.module);
  const ordered = orderCases(sel);
  if (opts.limit && !opts.all) return ordered.slice(0, opts.limit);
  return ordered;
}

function subst(str, vars) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(\w+)\}\}/g, (m, n) => (n in vars ? vars[n] : m));
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLocateText(text) {
  return String(text || "").trim().replace(/^label=/, "").replace(/^placeholder=/, "");
}

function parseLocateDesc(desc) {
  const raw = String(desc || "").trim();
  const dialog = raw.match(/^dialog:([^|]+)\|(.+)$/);
  if (dialog) {
    return { scope: "dialog", dialogTitle: dialog[1].trim(), text: dialog[2].trim() };
  }
  if (!/^(footer|role|login|toolbar|testid|append-btn|row):/.test(raw) && raw.includes("|")) {
    const section = raw.match(/^([^|]+)\|(.+)$/);
    if (section) {
      return { scope: "section", sectionTitle: section[1].trim(), text: section[2].trim() };
    }
  }
  return { scope: "page", text: raw };
}

function dialogRoot(page, titlePart) {
  const titleRe = new RegExp(escapeRegex(titlePart));
  return page.locator(".el-dialog__wrapper:visible").filter({
    has: page.locator(".el-dialog__title", { hasText: titleRe }),
  }).last();
}

function sectionRoot(page, titlePart) {
  return page.locator(".billing-section").filter({
    has: page.locator(".section-title", { hasText: titlePart }),
  });
}

async function tryElFormItemLocator(root, labelText) {
  const text = normalizeLocateText(labelText);
  if (!text || /[:|]/.test(text)) return null;
  const items = root.locator(".el-form-item").filter({
    has: root.locator(".el-form-item__label", { hasText: new RegExp(`^\\s*${escapeRegex(text)}\\s*$`) }),
  });
  if (!(await items.count().catch(() => 0))) return null;
  const item = items.first();
  const input = item.locator(".el-input__inner, .el-textarea__inner, input:not([type='hidden'])").first();
  if (await input.count().catch(() => 0)) {
    return { locator: input, strategy: `el-form-item:${text}` };
  }
  const selectInput = item.locator(".el-select input").first();
  if (await selectInput.count().catch(() => 0)) {
    return { locator: selectInput, strategy: `el-form-item-select:${text}` };
  }
  return null;
}

async function locateInRoot(root, text) {
  if (!text) return null;
  if (/^[#.][\w-[\].#]+/.test(String(text).trim())) {
    const loc = root.locator(String(text).trim()).first();
    if (await loc.count().catch(() => 0)) return { locator: loc, strategy: `css:${text}` };
  }
  const textboxIdx = text.match(/^textbox:(\d+)$/);
  if (textboxIdx) {
    const idx = Number(textboxIdx[1]);
    const loc = root.getByRole("textbox").nth(idx);
    if (await loc.count().catch(() => 0)) return { locator: loc, strategy: `textbox:${idx}` };
  }
  const pwdIdx = text.match(/^password:(\d+)$/);
  if (pwdIdx) {
    const idx = Number(pwdIdx[1]);
    const loc = root.locator('input[type="password"]').nth(idx);
    if (await loc.count().catch(() => 0)) return { locator: loc, strategy: `password:${idx}` };
  }
  const toolbarBtn = text.match(/^toolbar:(.+)$/);
  if (toolbarBtn) {
    const loc = root.locator(".buttonItem .table_list_btn, .buttonItem .el-button--primary")
      .filter({ hasText: new RegExp(`^\\s*${toolbarBtn[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }).first();
    if (await loc.count().catch(() => 0)) return { locator: loc, strategy: `toolbar:${toolbarBtn[1]}` };
  }
  if (text === "footer:primary") {
    const loc = root.locator(".dialog-footer .el-button--primary, .add-footer .el-button--primary, .el-dialog__footer .el-button--primary").first();
    if (await loc.count().catch(() => 0)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      return { locator: loc, strategy: "footer:primary" };
    }
  }
  if (text === "footer:cancel") {
    const loc = root.locator(".dialog-footer .el-button:not(.el-button--primary), .add-footer .el-button:not(.el-button--primary), .el-dialog__footer .el-button:not(.el-button--primary)").first();
    if (await loc.count().catch(() => 0)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      return { locator: loc, strategy: "footer:cancel" };
    }
  }
  const footerBtn = text.match(/^footer:(.+)$/);
  if (footerBtn) {
    const btnText = footerBtn[1].trim();
    const re = new RegExp(escapeRegex(btnText).replace(/\s+/g, "\\s*"));
    let loc = root.locator(".add-footer .el-button, .footer .el-button, .dialog-footer .el-button, .el-dialog__footer .el-button")
      .filter({ hasText: re }).first();
    if (await loc.count().catch(() => 0)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      return { locator: loc, strategy: `footer:${btnText}` };
    }
    if (/确/.test(btnText)) {
      loc = root.locator(".dialog-footer .el-button--primary, .add-footer .el-button--primary").first();
      if (await loc.count().catch(() => 0)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        return { locator: loc, strategy: `footer:primary` };
      }
    }
    if (/取/.test(btnText)) {
      loc = root.locator(".dialog-footer .el-button:not(.el-button--primary), .add-footer .el-button:not(.el-button--primary)").first();
      if (await loc.count().catch(() => 0)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        return { locator: loc, strategy: `footer:cancel` };
      }
    }
  }
  if (/^(确\s*定|取\s*消)$/.test(String(text).trim())) {
    const btnText = String(text).trim();
    const re = new RegExp(escapeRegex(btnText).replace(/\s+/g, "\\s*"));
    let loc = root.locator(".dialog-footer .el-button, .el-dialog__footer .el-button")
      .filter({ hasText: re }).first();
    if (await loc.count().catch(() => 0)) {
      return { locator: loc, strategy: `dialog-btn:${btnText}` };
    }
  }
  const appendBtn = text.match(/^append-btn:(.+)$/);
  if (appendBtn) {
    const item = root.locator(".el-form-item:visible").filter({
      has: root.locator(".el-form-item__label", { hasText: new RegExp(`^\\s*${escapeRegex(appendBtn[1])}\\s*$`) }),
    }).first();
    const btn = item.locator(".el-input-group__append .el-button").first();
    if (await btn.count().catch(() => 0)) return { locator: btn, strategy: `append-btn:${appendBtn[1]}` };
  }
  const rowAction = text.match(/^row-action:(.+)$/);
  if (rowAction) {
    const btnText = rowAction[1].trim();
    const row = root.locator(".vxe-body--row").first();
    const btn = row.locator("button, .el-button, .el-button--text").filter({ hasText: btnText }).first();
    if (await btn.count().catch(() => 0)) {
      return { locator: btn, strategy: `row-action:${btnText}` };
    }
  }
  const rowPick = text.match(/^row:(\d+)$/);
  if (rowPick || text === "第一行") {
    const idx = rowPick ? Number(rowPick[1]) : 0;
    const row = root.locator(".vxe-body--row").nth(idx);
    const checkbox = row.locator('input[type="checkbox"], .vxe-checkbox--icon, .vxe-cell--checkbox').first();
    if (await checkbox.count().catch(() => 0)) {
      return { locator: checkbox, strategy: `row:${idx}` };
    }
    if (await row.count().catch(() => 0)) return { locator: row, strategy: `row:${idx}` };
  }
  const selectIdx = text.match(/^select:(\d+)$/);
  if (selectIdx) {
    const idx = Number(selectIdx[1]);
    const selectBox = root.locator(".el-select").nth(idx);
    if (await selectBox.count().catch(() => 0)) {
      return { locator: selectBox, strategy: `select:${idx}` };
    }
    const loc = root.locator(".el-select input, .el-select .el-input__inner").nth(idx);
    if (await loc.count().catch(() => 0)) return { locator: loc, strategy: `select-input:${idx}` };
  }
  const loginField = text.match(/^(?:login:)?(账号|密码)$/);
  if (loginField) {
    const form = root.locator("#formLogin, .user-layout-login");
    const loc = loginField[1] === "账号"
      ? form.locator(".el-input input").first()
      : form.locator('input[type="password"]').first();
    if (await loc.count().catch(() => 0)) return { locator: loc, strategy: `login:${loginField[1]}` };
  }
  const tid = text.match(/^testid=(.+)$/);
  if (tid) return { locator: root.getByTestId(tid[1]), strategy: `testid=${tid[1]}` };
  const roleMatch = text.match(/^role=(\w+)\|(.+)$/);
  if (roleMatch) {
    const loc = root.getByRole(roleMatch[1], { name: roleMatch[2], exact: false });
    if (await loc.count().catch(() => 0)) return { locator: loc.first(), strategy: `role=${roleMatch[1]}[name=${roleMatch[2]}]` };
  }
  const formHit = await tryElFormItemLocator(root, text);
  if (formHit) return formHit;
  const normText = normalizeLocateText(text);
  for (const role of ["button", "link", "menuitem", "tab", "checkbox"]) {
    const loc = root.getByRole(role, { name: normText, exact: false });
    if (await loc.count().catch(() => 0)) return { locator: loc.first(), strategy: `role=${role}[name=${normText}]` };
  }
  const byLabel = root.getByLabel(normText, { exact: false });
  if (await byLabel.count().catch(() => 0)) return { locator: byLabel.first(), strategy: `label=${normText}` };
  const byPh = root.getByPlaceholder(normText, { exact: false });
  if (await byPh.count().catch(() => 0)) return { locator: byPh.first(), strategy: `placeholder=${normText}` };
  const byText = root.getByText(normText, { exact: false });
  if (await byText.count().catch(() => 0)) return { locator: byText.first(), strategy: `text=${normText}` };
  return null;
}

async function locate(page, desc) {
  const parsed = parseLocateDesc(desc);
  let root = page;
  if (parsed.scope === "dialog") {
    root = dialogRoot(page, parsed.dialogTitle);
    if (!(await root.count().catch(() => 0))) return null;
  } else if (parsed.scope === "section") root = sectionRoot(page, parsed.sectionTitle);
  const hit = await locateInRoot(root, parsed.text);
  if (!hit) return null;
  if (parsed.scope === "dialog") hit.strategy = `dialog:${parsed.dialogTitle}>${hit.strategy}`;
  else if (parsed.scope === "section") hit.strategy = `section:${parsed.sectionTitle}>${hit.strategy}`;
  return hit;
}

async function clickLocator(locator) {
  const role = await locator.getAttribute("role").catch(() => null);
  const type = await locator.getAttribute("type").catch(() => null);
  const cls = String((await locator.getAttribute("class").catch(() => "")) || "");
  const ancestorClick = async (xpath) => {
    const wrap = locator.locator(`xpath=${xpath}`);
    if (await wrap.count().catch(() => 0)) {
      await wrap.first().click({ timeout: 10000 });
      return true;
    }
    return false;
  };
  if (role === "combobox" || cls.includes("el-select__input")) {
    if (await ancestorClick("ancestor::*[contains(@class,'el-select')][1]")) return;
  }
  if (type === "radio" && cls.includes("el-radio-button__original-radio")) {
    if (await ancestorClick("ancestor::*[contains(@class,'el-radio-button')][1]")) return;
  }
  if (type === "checkbox" && cls.includes("el-checkbox__original")) {
    if (await ancestorClick("ancestor::label[contains(@class,'el-checkbox')][1]")) return;
    if (await ancestorClick("ancestor::*[contains(@class,'el-checkbox')][1]")) return;
  }
  await locator.click({ timeout: 10000 });
}

async function closeSelectDropdown(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

async function pickSelectDropdownItem(page, value) {
  const popper = page.locator(".el-select-dropdown:visible").last();
  await popper.waitFor({ state: "visible", timeout: 8000 });
  const val = String(value || "first").trim();
  let item;
  if (val === "first") {
    const items = popper.locator(".el-select-dropdown__item:not(.is-disabled)");
    const count = await items.count().catch(() => 0);
    item = null;
    for (let i = 0; i < count; i += 1) {
      const text = String((await items.nth(i).textContent().catch(() => "")) || "");
      if (text && !/无数据/.test(text)) {
        item = items.nth(i);
        break;
      }
    }
    if (!item) item = items.first();
  } else {
    item = popper.locator(".el-select-dropdown__item").filter({ hasText: val }).first();
  }
  await item.click({ timeout: 8000 });
  await closeSelectDropdown(page);
}

function resolveMenuLabel(rawTarget, menuMap) {
  if (!rawTarget) return rawTarget;
  if (!Array.isArray(menuMap)) return rawTarget;
  const hit = menuMap.find((item) => item?.route === rawTarget || item?.menuLabel === rawTarget);
  return hit?.menuLabel || rawTarget;
}

function resolveMenuEntry(rawTarget, menuMap) {
  if (!Array.isArray(menuMap)) return null;
  return menuMap.find((item) => item?.menuLabel === rawTarget || item?.route === rawTarget) || null;
}

/** 将 routeMenuMap 的 route 转为 hash 片段（去掉 /index，支持嵌套路径） */
function routeHashFragment(route) {
  const s = String(route || "").replace(/^\//, "").replace(/\/index$/, "");
  return s || null;
}

function hashMatchesRoute(hash, route) {
  const frag = routeHashFragment(route);
  if (!frag) return true;
  if (hash.includes(frag)) return true;
  const last = frag.split("/").filter(Boolean).pop();
  return last ? hash.includes(last) : false;
}

/**
 * SidebarItem.vue: 子菜单 .last-menu-item @click="go(path)" => $router.push
 * TagsView/index.vue: $route 变化后自动 addTags + isActive(route.path === $route.path)
 * 问题：el-menu horizontal 下拉在 router.push 后仍可能遮挡页面按钮
 */
async function ensureMenuClosed(page) {
  // 鼠标移出顶部横向菜单，避免 popup 遮挡页面按钮
  await page.mouse.move(500, 400).catch(() => {});
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }
  // 主动点击已展开的一级菜单标题，关闭 hover 状态（Escape 无法关闭 .is-opened）
  const openSub = page.locator(".el-menu--horizontal .el-submenu.is-opened .el-submenu__title");
  try {
    const n = await openSub.count().catch(() => 0);
    for (let i = 0; i < n; i += 1) {
      await openSub.nth(i).click({ force: true, timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(150);
    }
  } catch {
    // ignore
  }
  // 尝试等待 EL Menu popup 消失（Element Plus Admin 项目），非 EL 项目跳过
  const elPopup = page.locator(".el-menu--horizontal .el-menu--popup, .el-menu--horizontal [x-placement]");
  try {
    await elPopup.first().waitFor({ state: "hidden", timeout: 2000 });
  } catch {
    // ignore timeout — 后续 body.click 兜底
  }
  // 点击主区域关闭任何残留弹窗（通用兜底）
  await page.locator("body").click({ position: { x: 100, y: 100 }, force: true }).catch(() => {});
  await page.waitForTimeout(300);
  // 最后一次 Escape 兜底
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
}

async function activateTagsViewTab(page, label) {
  const activeSel = () => page.locator(".tags-view-item.active").filter({ hasText: label });
  if (await activeSel().count().catch(() => 0)) return true;
  const tab = page.locator(".tags-view-item").filter({ hasText: label }).first();
  if (!(await tab.count().catch(() => 0))) return false;
  await tab.click({ force: true });
  await page.waitForTimeout(600);
  return (await activeSel().count().catch(() => 0)) > 0;
}

function resolveLoginUrl(baseUrl, loginPath = "/login") {
  const pathPart = String(loginPath || "/login").trim();
  const base = String(baseUrl || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(pathPart)) return pathPart;
  return `${base}${pathPart.startsWith("/") ? pathPart : `/${pathPart}`}`;
}

async function gotoLoginPage(page, baseUrl, loginPath) {
  const loginUrl = resolveLoginUrl(baseUrl, loginPath);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#formLogin, .user-layout-login").first()
    .waitFor({ state: "visible", timeout: 15000 })
    .catch(() => {});
  return loginUrl;
}

async function resetPage(page, baseUrl) {
  // 1. 关闭残留弹窗/抽屉/遮罩（通用：Escape 多次 + body 点击）
  await ensureMenuClosed(page);
  // 2. 尝试关闭多标签页（Element Plus Admin TagsView，非 EL 项目自动跳过）
  const closeBtns = page.locator(".tags-view-item .el-icon-close, .tabs-view .close-btn, [class*='tag-view'] [class*='close']");
  const n = await closeBtns.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i -= 1) {
    await closeBtns.nth(i).click({ force: true }).catch(() => {});
    await page.waitForTimeout(200);
  }
  // 3. 导航到首页，销毁旧页面 DOM（通用：适用于任何 SPA）
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(500);
  // 4. 再次关闭残留弹窗和菜单（通用：Escape 兜底）
  await ensureMenuClosed(page);
  return { ok: true };
}

async function waitRouteActive(page, entry, label) {
  const routeFrag = routeHashFragment(entry?.route);
  if (routeFrag) {
    try {
      await page.waitForFunction(
        (frag) => {
          const h = window.location.hash;
          if (h.includes(frag)) return true;
          const last = frag.split("/").filter(Boolean).pop();
          return last ? h.includes(last) : false;
        },
        routeFrag,
        { timeout: 12000 },
      );
    } catch {
      const hash = await page.evaluate(() => window.location.hash);
      return { ok: false, error: `路由未切换到 ${routeFrag}，当前：${hash}` };
    }
  }
  if (!(await activateTagsViewTab(page, label))) {
    return { ok: false, error: `未找到或未激活标签：${label}` };
  }
  await ensureMenuClosed(page);
  // ensureMenuClosed 后再次确认标签仍激活（防止误触首页）
  if (routeFrag) {
    const hashOk = await page.evaluate(
      (frag) => {
        const h = window.location.hash;
        if (h.includes(frag)) return true;
        const last = frag.split("/").filter(Boolean).pop();
        return last ? h.includes(last) : false;
      },
      routeFrag,
    );
    if (!hashOk) await activateTagsViewTab(page, label);
  }
  if (!(await activateTagsViewTab(page, label))) {
    return { ok: false, error: `关菜单后标签丢失：${label}，hash=${await page.evaluate(() => window.location.hash)}` };
  }
  return { ok: true };
}

async function clickLastMenuItem(page, label) {
  const item = page.locator(`.last-menu-item[title="${label}"]`).first();
  try {
    await item.waitFor({ state: "visible", timeout: 4000 });
    await item.click({ timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** 顶栏一级菜单（如「首页」），渲染为 el-menu-item 而非下拉子项 */
async function clickTopMenuItem(page, label) {
  const menu = page.locator(".el-menu--horizontal").first();
  if (!(await menu.count().catch(() => 0))) return false;
  const direct = menu.locator(":scope > .el-menu-item, :scope > div:not([style*='inline']) .el-menu-item").filter({ hasText: label }).first();
  if (await direct.count().catch(() => 0)) {
    await direct.click({ timeout: 10000 });
    return true;
  }
  const fallback = menu.locator(".el-menu-item").filter({ hasText: new RegExp(`^\\s*${escapeRegex(label)}\\s*$`) }).first();
  if (await fallback.count().catch(() => 0)) {
    await fallback.click({ timeout: 10000 });
    return true;
  }
  return false;
}

async function clickSubMenu(page, menuLabel, menuMap) {
  const entry = resolveMenuEntry(menuLabel, menuMap);
  const label = entry?.menuLabel || menuLabel;
  const group = entry?.menuGroup;
  const navType = entry?.navigation?.type;
  const isTopLevel = navType === "top" || group == null || group === "";

  await ensureMenuClosed(page);

  const tryUnderGroup = async (groupName) => {
    const exactRe = new RegExp(`^\\s*${escapeRegex(groupName)}\\s*$`);
    const topMenu = page.locator(".el-menu--horizontal .el-submenu")
      .filter({ has: page.locator(".el-submenu__title", { hasText: exactRe }) })
      .locator(".el-submenu__title").first();
    if (!(await topMenu.count().catch(() => 0))) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await ensureMenuClosed(page);
      await topMenu.hover({ timeout: 10000 });
      await page.waitForTimeout(attempt === 0 ? 600 : 900);
      if (await clickLastMenuItem(page, label)) return true;
    }
    return false;
  };

  let clicked = false;
  let strategyGroup = group || "top";

  // 1) 顶栏一级入口（首页等）：直接点 el-menu-item，不遍历下拉
  if (isTopLevel) {
    clicked = await clickTopMenuItem(page, label);
    if (!clicked && entry?.route) {
      const hash = await page.evaluate(() => window.location.hash).catch(() => "");
      if (hashMatchesRoute(hash, entry.route)) clicked = true;
    }
  }

  // 2) 指定了 menuGroup：只在该分组下找，禁止全量遍历
  if (!clicked && group) {
    clicked = await tryUnderGroup(group);
    strategyGroup = group;
  }

  // 3) 未配置 menuGroup 的子菜单：兜底遍历（仅无 group 时）
  if (!clicked && !group) {
    strategyGroup = "auto";
    const titles = page.locator(".el-menu--horizontal .el-submenu .el-submenu__title");
    const n = await titles.count().catch(() => 0);
    for (let i = 0; i < n && !clicked; i += 1) {
      await ensureMenuClosed(page);
      await titles.nth(i).hover({ timeout: 5000 });
      await page.waitForTimeout(400);
      clicked = await clickLastMenuItem(page, label);
    }
  }

  if (!clicked) {
    return { ok: false, error: `菜单未找到：${label}（menuGroup=${group || "无"}，请核对 routeMenuMap）` };
  }

  const routeResult = await waitRouteActive(page, entry, label);
  if (!routeResult.ok) return routeResult;

  return { ok: true, strategy: `menu:${strategyGroup}>${label}>${entry?.route || ""}` };
}

async function activatePageTab(page, tabText, menuMap) {
  const entry = resolveMenuEntry(tabText, menuMap);
  return waitRouteActive(page, entry, tabText);
}

async function runStep(page, step, vars, baseUrl, menuMap, loginPath = "/login") {
  const action = step.action;
  const target = subst(step.target, vars);
  const value = subst(step.value, vars);

  const click = async (desc) => {
    await ensureMenuClosed(page);
    const hit = await locate(page, desc);
    if (!hit) return { ok: false, error: `未定位到元素：${desc}` };
    await hit.locator.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await clickLocator(hit.locator);
    } catch {
      await hit.locator.click({ force: true, timeout: 10000 });
    }
    return { ok: true, strategy: hit.strategy };
  };

  switch (action) {
    case "reset_session":
      await page.context().clearCookies();
      await gotoLoginPage(page, baseUrl, loginPath).catch(() => {});
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
      return { ok: true };
    case "open_login":
      await gotoLoginPage(page, baseUrl, loginPath);
      return { ok: true };
    case "reset_page":
      return resetPage(page, baseUrl);
    case "ensure_session":
      // 复用会话前仅清残留弹窗/菜单，不改变当前路由
      await ensureMenuClosed(page);
      return { ok: true };
    case "navigate":
      await page.goto(baseUrl + (String(target).startsWith("http") ? "" : String(target)), { waitUntil: "domcontentloaded" });
      return { ok: true };
    case "click_menu": {
      const menuLabel = resolveMenuLabel(target, menuMap);
      return clickSubMenu(page, menuLabel, menuMap);
    }
    case "activate_tab":
      return activatePageTab(page, target, menuMap);
    case "dismiss_menu":
      await ensureMenuClosed(page);
      return { ok: true };
    case "switch_auth_tab":
    case "switch_tab":
    case "click":
      return click(target);
    case "fill": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到输入框：${target}` };
      await hit.locator.fill(String(value), { timeout: 10000 });
      return { ok: true, strategy: hit.strategy, outputValue: String(value) };
    }
    case "select": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到下拉：${target}` };
      try {
        await hit.locator.selectOption({ label: String(value) });
        return { ok: true, strategy: hit.strategy, outputValue: String(value) };
      } catch {
        await clickLocator(hit.locator);
        await page.waitForTimeout(400);
        await pickSelectDropdownItem(page, value || "first");
        return { ok: true, strategy: hit.strategy, outputValue: String(value || "first") };
      }
    }
    case "select_dropdown": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到下拉：${target}` };
      try {
        await closeSelectDropdown(page);
        await hit.locator.scrollIntoViewIfNeeded().catch(() => {});
        const selectWrap = hit.locator.locator('xpath=ancestor::*[contains(@class,"el-select")][1]');
        if (await selectWrap.count().catch(() => 0)) {
          await selectWrap.first().click({ timeout: 10000 });
        } else {
          await clickLocator(hit.locator);
        }
        await page.waitForTimeout(500);
        await pickSelectDropdownItem(page, value || "first");
        return { ok: true, strategy: hit.strategy, outputValue: String(value || "first") };
      } catch (e) {
        await closeSelectDropdown(page);
        return { ok: false, error: `下拉选择失败：${e.message}` };
      }
    }
    case "hover": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到元素：${target}` };
      await hit.locator.hover();
      return { ok: true, strategy: hit.strategy };
    }
    case "wait":
      await page.waitForTimeout(Number(value) || 1000);
      return { ok: true };
    case "wait_visible": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `等待可见失败，未定位到：${target}` };
      await hit.locator.waitFor({ state: "visible", timeout: Number(value) || 10000 });
      return { ok: true, strategy: hit.strategy };
    }
    case "press_key":
      await page.keyboard.press(String(value || target));
      return { ok: true };
    case "scroll":
      await page.mouse.wheel(0, Number(value) || 600);
      return { ok: true };
    case "screenshot":
      return { ok: true, screenshotHint: true };
    case "clear": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到输入框：${target}` };
      await hit.locator.clear({ timeout: 5000 });
      return { ok: true, strategy: hit.strategy };
    }
    case "check": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到复选框：${target}` };
      const isChecked = await hit.locator.isChecked().catch(() => false);
      if (!isChecked) await hit.locator.check({ timeout: 5000 });
      return { ok: true, strategy: hit.strategy };
    }
    case "uncheck": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到复选框：${target}` };
      const isChecked = await hit.locator.isChecked().catch(() => false);
      if (isChecked) await hit.locator.uncheck({ timeout: 5000 });
      return { ok: true, strategy: hit.strategy };
    }
    case "double_click": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到元素：${target}` };
      await hit.locator.dblclick({ timeout: 10000 });
      return { ok: true, strategy: hit.strategy };
    }
    case "right_click": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到元素：${target}` };
      await hit.locator.click({ button: "right", timeout: 10000 });
      return { ok: true, strategy: hit.strategy };
    }
    case "upload_file": {
      const hit = await locate(page, target);
      if (!hit) return { ok: false, error: `未定位到上传控件：${target}` };
      await hit.locator.setInputFiles(String(value).split(",").map((f) => f.trim()));
      return { ok: true, strategy: hit.strategy };
    }
    default:
      return { ok: false, error: `不支持的 action：${action}` };
  }
}

async function visibleDialogRoot(page) {
  const el = page.locator(".el-dialog:visible, .el-drawer:visible").first();
  if (await el.count().catch(() => 0)) return el;
  const aria = page.locator('[role="dialog"]:visible').first();
  if (await aria.count().catch(() => 0)) return aria;
  const mask = page.locator(".el-overlay:visible .el-dialog__wrapper:visible, .el-overlay:visible .el-drawer__wrapper:visible").first();
  if (await mask.count().catch(() => 0)) return mask;
  return null;
}

async function judgeUiAssertion(page, a) {
  const target = String(a.target || "");
  try {
    switch (a.type) {
      case "element_visible": {
        const hit = await locate(page, target);
        const vis = hit ? await hit.locator.isVisible().catch(() => false) : false;
        return vis === (a.expected !== false);
      }
      case "element_hidden": {
        const hit = await locate(page, target);
        const vis = hit ? await hit.locator.isVisible().catch(() => false) : false;
        return !vis;
      }
      case "text_contains":
        return (await page.content()).includes(target);
      case "text_not_contains":
        return !(await page.content()).includes(target);
      case "url_equals":
        return page.url() === target || page.url().replace(/\/$/, "") === target.replace(/\/$/, "");
      case "url_contains":
        return page.url().includes(target);
      case "count_gte": {
        const hit = await locate(page, target);
        const n = hit ? await hit.locator.count() : 0;
        return n >= Number(a.expected);
      }
      case "count_eq": {
        const hit = await locate(page, target);
        const n = hit ? await hit.locator.count() : 0;
        return n === Number(a.expected);
      }
      case "count_gt": {
        const hit = await locate(page, target);
        const n = hit ? await hit.locator.count() : 0;
        return n > Number(a.expected);
      }
      case "count_lt": {
        const hit = await locate(page, target);
        const n = hit ? await hit.locator.count() : 0;
        return n < Number(a.expected);
      }
      case "count_lte": {
        const hit = await locate(page, target);
        const n = hit ? await hit.locator.count() : 0;
        return n <= Number(a.expected);
      }
      case "element_disabled": {
        const hit = await locate(page, target);
        if (!hit) return a.expected === false;
        const disabled = await hit.locator.isDisabled().catch(() => true);
        return disabled === (a.expected !== false);
      }
      case "element_enabled": {
        const hit = await locate(page, target);
        if (!hit) return a.expected === false;
        const disabled = await hit.locator.isDisabled().catch(() => true);
        return !disabled === (a.expected !== false);
      }
      case "input_value_equals": {
        const hit = await locate(page, target);
        if (!hit) return false;
        const val = await hit.locator.inputValue().catch(() => "");
        return val === String(a.expected);
      }
      case "input_value_contains": {
        const hit = await locate(page, target);
        if (!hit) return false;
        const val = await hit.locator.inputValue().catch(() => "");
        return val.includes(String(a.expected));
      }
      case "dialog_visible": {
        const dlg = await visibleDialogRoot(page);
        if (!dlg) return false;
        if (!target) return true;
        const hasTarget = await dlg.locator(`:has-text("${target}")`).count().catch(() => 0);
        return hasTarget > 0;
      }
      case "dialog_hidden": {
        const dlg = await visibleDialogRoot(page);
        return !dlg;
      }
      case "toast_contains":
        return (await page.content()).includes(target);
      case "toast_not_contains":
        return !(await page.content()).includes(target);
      case "attribute_equals": {
        const hit = await locate(page, target);
        if (!hit) return false;
        const attr = await hit.locator.getAttribute(String(a.attrName || "")).catch(() => null);
        return attr === String(a.expected);
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

async function runCase(page, testCase, vars, completed, shotDir, ts) {
  const result = {
    id: testCase.id,
    title: testCase.title || "",
    module: testCase.module || "",
    priority: testCase.priority || "",
    flowRefs: testCase.trace.flowRefs || [],
    status: "passed",
    durationMs: 0,
    assertions: [],
    steps: [],
    screenshot: "",
    screenshots: [],
    error: null,
    isChain: Boolean((testCase.trace.dependsOn || []).length || (testCase.trace.consumes || []).length),
  };

  for (const depId of testCase.trace.dependsOn || []) {
    if (completed.get(depId) && completed.get(depId) !== "passed") {
      result.status = "skipped";
      result.error = failField(testCase.module, testCase.id, "trace.dependsOn", `上游失败传递：${depId}`);
      await ensureMenuClosed(page);
      return result;
    }
  }
  for (const name of testCase.trace.consumes || []) {
    if (!(name in vars)) {
      result.status = "skipped";
      result.error = failField(testCase.module, testCase.id, "trace.consumes", `变量缺失：${name}`);
      await ensureMenuClosed(page);
      return result;
    }
  }

  const t0 = Date.now();
  const stepVars = { ...vars };
  for (const step of testCase.steps || []) {
    if (Array.isArray(step.useVar)) {
      for (const v of step.useVar) {
        if (!(v in stepVars)) {
          result.status = "failed";
          result.error = failField(testCase.module, testCase.id, `steps.${step.step}.useVar`, `变量缺失：${v}`);
          break;
        }
      }
      if (result.status === "failed") break;
    }
    let stepResult;
    try {
      stepResult = await runStep(page, step, stepVars, vars.__baseUrl, vars.__menuMap, vars.__loginPath);
    } catch (err) {
      stepResult = { ok: false, error: `步骤异常：${err?.message || String(err)}` };
    }
    result.steps.push({
      step: step.step,
      action: step.action,
      target: step.target,
      ok: stepResult.ok,
      strategy: stepResult.strategy || "",
      error: stepResult.error || "",
    });
    if (stepResult.screenshotHint) {
      const p = path.join(shotDir, `${testCase.id}_step${step.step}_${ts}.png`);
      await page.screenshot({ path: p }).catch(() => {});
      result.screenshots.push({ label: `步骤 ${step.step}（${step.action}）`, path: p });
    }
    if (step.saveAs) {
      stepVars[step.saveAs] = stepResult.outputValue ?? String(step.value ?? "");
      vars[step.saveAs] = stepVars[step.saveAs];
    }
    if (!stepResult.ok) {
      result.status = "failed";
      result.error = failField(testCase.module, testCase.id, `steps.${step.step}`, stepResult.error || "执行失败");
      break;
    }
  }

  if (result.status !== "failed") {
    let allPass = true;
    for (const assertion of testCase.assertions || []) {
      const pass = await judgeUiAssertion(page, assertion);
      if (!pass) allPass = false;
      result.assertions.push({ type: assertion.type, target: assertion.target, expected: assertion.expected, pass });
    }
    if (!allPass) {
      result.status = "failed";
      const failItem = result.assertions.find((x) => !x.pass);
      result.error = failField(testCase.module, testCase.id, `assertions.${failItem.type}`, `断言失败：${failItem.target}`);
    }
  }

  if (result.status === "failed") {
    const p = path.join(shotDir, `${testCase.id}_fail_${ts}.png`);
    await page.screenshot({ path: p }).catch(() => {});
    result.screenshot = p;
    result.screenshots.push({ label: "失败截图", path: p });
  }

  for (const name of testCase.trace.produces || []) {
    if (!(name in vars)) vars[name] = `__produced_by_${testCase.id}__`;
  }

  // 无论成功或失败，退出前清理残留弹窗/菜单，防止失败扩散到下一条用例
  await ensureMenuClosed(page);

  result.durationMs = Date.now() - t0;
  return result;
}

function screenshotRelPath(reportDir, absPath) {
  if (!absPath) return "";
  return path.relative(reportDir, absPath).split(path.sep).join("/");
}

function renderScreenshotBlock(reportDir, screenshots) {
  if (!screenshots?.length) return "**截图**：_无_\n\n";
  let md = "**截图**\n\n";
  for (const shot of screenshots) {
    const rel = screenshotRelPath(reportDir, shot.path);
    md += `- ${shot.label}\n\n`;
    if (rel) md += `![${shot.label}](${rel})\n\n`;
  }
  return md;
}

function renderCaseDetailBlock(r, reportDir, icon) {
  let md = `### ${icon(r.status)} ${r.id} — ${r.title}\n\n`;
  md += `- **模块**：${r.module}\n`;
  md += `- **优先级**：${r.priority}\n`;
  md += `- **主流程**：${r.flowRefs.join(", ")}\n`;
  md += `- **结果**：${r.status}\n`;
  md += `- **耗时**：${(r.durationMs / 1000).toFixed(1)}s\n`;
  if (r.error) md += `- **错误信息**：${r.error}\n`;
  const failedAssertion = r.assertions?.find((a) => !a.pass);
  if (failedAssertion) {
    md += `- **失败断言**：${failedAssertion.type} — ${failedAssertion.target}\n`;
  }
  md += "\n";
  md += renderScreenshotBlock(reportDir, r.screenshots);
  return md;
}

function buildMarkdown(meta, results, caseFile, baseUrl, browser, durationMs, reportDir) {
  const total = results.length;
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const passRate = total ? ((passed / total) * 100).toFixed(1) : "0.0";
  const cov = meta?.coverage || {};
  const icon = (s) => (s === "passed" ? "✅" : s === "failed" ? "❌" : "⏭️");
  let md = "# UI 测试报告\n\n";
  md += `**生成时间**：${new Date().toISOString()}\n`;
  md += `**用例来源**：${caseFile}\n`;
  md += `**测试地址**：${baseUrl}\n`;
  md += `**浏览器**：${browser}\n`;
  md += `**Schema**：${meta.schema || "unknown"}\n\n---\n\n`;
  md += "## 概览\n\n";
  md += "| 指标 | 数值 |\n|------|------|\n";
  md += `| 总用例数 | ${total} |\n| 通过 | ${passed} |\n| 失败 | ${failed} |\n| 跳过 | ${skipped} |\n| 通过率 | ${passRate}% |\n| 执行耗时 | ${(durationMs / 1000).toFixed(1)}s |\n\n`;
  md += "## 覆盖统计\n\n";
  md += "| 指标 | 数值 |\n|------|------|\n";
  md += `| 主流程覆盖 | ${cov.mainFlowsCovered ?? "?"} / ${cov.mainFlowTotal ?? "?"}（${cov.mainFlowCoveragePercent ?? "?"}%） |\n`;
  md += `| 未覆盖主流程 | ${(cov.uncoveredMainFlows || []).join(", ") || "无"} |\n`;
  md += `| 孤儿用例数 | ${cov.orphanCases ?? "?"} |\n\n`;
  const failures = results.filter((r) => r.status !== "passed");
  if (failures.length) {
    md += "## 失败/跳过用例\n\n";
    for (const r of failures) {
      md += renderCaseDetailBlock(r, reportDir, icon);
      md += "---\n\n";
    }
  }
  md += "## 全部用例明细\n\n";
  md += "| ID | 模块 | 标题 | 主流程 | 优先级 | 结果 | 耗时 |\n|----|------|------|--------|--------|------|------|\n";
  for (const r of results) {
    md += `| ${r.id} | ${r.module} | ${r.title} | ${r.flowRefs.join(",")} | ${r.priority} | ${icon(r.status)} | ${(r.durationMs / 1000).toFixed(1)}s |\n`;
  }
  md += "\n## 用例明细与截图\n\n";
  md += "> 每条用例的截图紧跟在对应明细下方（路径相对报告文件 `screenshots/`）。\n\n";
  for (const r of results) {
    md += renderCaseDetailBlock(r, reportDir, icon);
    md += "---\n\n";
  }
  return md;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  let caseFile;
  let payload;
  try {
    caseFile = resolveCaseFile(opts);
    payload = JSON.parse(fs.readFileSync(caseFile, "utf8"));
  } catch (e) {
    console.error(`❌ 读取用例失败：${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(payload) || payload.length < 2) {
    console.error("❌ 用例结构错误：顶层须为 [meta, ...cases]。");
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
  const root = path.resolve(process.cwd(), opts.artifactsDir);
  const cfg = loadUiConfig(root);

  const pwInfo = await resolvePlaywrightModule(cfg);
  if (!pwInfo) {
    console.error("❌ 未找到 Playwright npm 包。请执行 npm install playwright，或在 ai-tests/test-artifacts/ui-test.config.json 配置 browserResolve.playwrightModulePaths");
    process.exit(2);
  }

  const baseUrl = opts.baseUrl || meta.baseUrl;
  if (!baseUrl) {
    console.error("❌ 缺少测试地址 baseUrl。请通过 --base-url 传入，或在用例 meta.baseUrl 中填写。");
    process.exit(1);
  }
  const { name: profileName, profile } = resolveProfile(opts, cfg);
  const selectedCases = filterCases(allCases, opts);
  const browserPlan = profile.engine === "auto"
    ? resolveBrowserEngine(cfg, pwInfo, profile.headed)
    : {
      engine: profile.engine,
      launchOptions: {
        headless: !profile.headed,
        ...(profile.engine === "local-chrome" ? { channel: "chrome" } : {}),
      },
      label: `${profile.engine} (${profile.headed ? "headed" : "headless"}) profile=${profileName}`,
    };

  const reportsDir = path.join(root, "ui-reports");
  const shotDir = path.join(reportsDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });

  const vars = {
    __baseUrl: baseUrl,
    __menuMap: meta.coverage?.routeMenuMap || [],
    __loginPath: meta.loginPath || meta.coverage?.loginPath || "/login",
  };
  const acct = meta.testAccount || meta.auth?.testAccount;
  if (acct?.username) vars.username = acct.username;
  if (acct?.password) vars.password = acct.password;
  vars.timestamp = String(Date.now());

  const launchOptions = {
    slowMo: profile.slowMo || 0,
    ...(profile.launchOptions || {}),
    ...browserPlan.launchOptions,
  };
  const browserLabel = profile.engine === "auto"
    ? `${browserPlan.label} profile=${profileName}`
    : browserPlan.label;

  console.log(`\n🚀 UI 执行 | baseUrl=${baseUrl} | 选中 ${selectedCases.length}/${allCases.length} 条`);
  console.log(`📦 Playwright: ${pwInfo.modulePath} (v${pwInfo.version})`);
  console.log(`📁 浏览器缓存: ${pwInfo.browsersPath}`);
  console.log(`🌐 引擎: ${browserLabel}\n`);

  const browser = await pwInfo.chromium.launch(launchOptions);
  const context = await browser.newContext(profile.contextOptions || {});
  const page = await context.newPage();

  const completed = new Map();
  const results = [];
  const start = Date.now();
  const ts = timestamp();
  for (const c of selectedCases) {
    const r = await runCase(page, c, vars, completed, shotDir, ts);
    completed.set(c.id, r.status);
    results.push(r);
    // 主循环层面兜底清理，确保失败扩散不蔓延
    await ensureMenuClosed(page);
    const icon = r.status === "passed" ? "✅" : r.status === "failed" ? "❌" : "⏭️";
    console.log(`${icon} ${c.id} ${c.title || ""}${r.error ? ` — ${r.error}` : ""}`);
  }
  await browser.close();
  const durationMs = Date.now() - start;

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const md = buildMarkdown(meta, results, caseFile, baseUrl, browserLabel, durationMs, reportsDir);
  const reportPath = path.join(reportsDir, `ui-report-${ts}.md`);
  fs.writeFileSync(reportPath, md, "utf8");

  console.log(`\n📊 通过 ${passed} | ❌ 失败 ${failed} | ⏭️ 跳过 ${skipped}`);
  console.log(`📁 报告：${reportPath}`);
  process.exit(failed > 0 ? 1 : 0);
}

if (process.argv[1]?.endsWith("run-ui-tests.mjs")) main();

export { parseArgs, timestamp, fileExists };
