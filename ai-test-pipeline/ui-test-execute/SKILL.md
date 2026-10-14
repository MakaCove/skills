---
name: ui-test-execute
description: 执行 UI 用例并生成 Markdown 报告与截图。
disable-model-invocation: true
---

# ui-test-execute

确定性脚本 `ai-tests/scripts/run-ui-tests.mjs`：菜单步骤、分层选择器、断言、截图、Markdown 报告。

## 文档索引

| 文档 | 说明 |
|------|------|
| [01_工作流.md](01_工作流.md) | 执行步骤（含步骤 0：部署脚本到目标项目） |
| [02_浏览器配置.md](02_浏览器配置.md) | Playwright 与 profile 配置 |
| [03_结果判定与示例.md](03_结果判定与示例.md) | 判定规则与示例 |

## 执行

执行前，步骤 0 会自动将脚本和配置从技能包部署到目标项目（文件已存在则跳过）：

1. 部署 `ai-tests/scripts/run-ui-tests.mjs` + `ai-tests/scripts/validate-artifacts.mjs`
2. 部署 `ai-tests/test-artifacts/ui-test.config.json`

然后执行：

```bash
cd d:\IdeaProjects\WMS
node ai-tests/scripts/validate-artifacts.mjs --type ui
node ai-tests/scripts/run-ui-tests.mjs --base-url <测试地址>
```

测试地址由用户提供（`meta.baseUrl` 或 `--base-url`），技能包不写死环境地址。

参考：[shared/07_选择器策略.md](../shared/07_选择器策略.md)
