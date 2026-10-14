# ui-test.config.json

配置路径：`ai-tests/test-artifacts/ui-test.config.json`（与用例产物同级）。

**部署规则**：执行 UI 测试时，步骤 0 会将此文件从技能包部署到目标项目。文件已存在则跳过，保护定制修改。

## 字段说明

| 字段 | 含义 |
|------|------|
| `defaultProfile` | 默认浏览器配置名称（如 `auto-headed` / `auto-headless`） |
| `profiles` | 浏览器配置字典，每项含 `engine`、`headed`、`slowMo` |
| `browserResolve.preferEngine` | 浏览器引擎优先级数组（`fixed-chromium` / `system-chrome`） |
| `browserResolve.playwrightBrowsersPath` | Playwright 浏览器二进制缓存目录 |
| `browserResolve.playwrightModulePaths` | Node.js `playwright` npm 包绝对路径数组 |
| `browserResolve.chromeExecutablePaths` | 系统 Chrome 可执行文件绝对路径数组 |

## 示例

```json
{
  "defaultProfile": "auto-headed",
  "profiles": {
    "auto-headed": { "engine": "auto", "headed": true, "slowMo": 500 },
    "auto-headless": { "engine": "auto", "headed": false, "slowMo": 0 }
  },
  "browserResolve": {
    "preferEngine": ["fixed-chromium", "system-chrome"],
    "playwrightBrowsersPath": "C:\\Users\\...\\ms-playwright",
    "playwrightModulePaths": ["C:\\Users\\...\\node_modules\\playwright"],
    "chromeExecutablePaths": ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
  }
}
```

> 所有人路径均使用**绝对路径**，不依赖当前工作目录。
