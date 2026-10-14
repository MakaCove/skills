---
name: api-test-execute
description: 执行 API 用例并生成 Markdown 报告。
disable-model-invocation: true
---

# api-test-execute

确定性脚本 `ai-tests/scripts/run-api-tests.mjs`：依赖排序、变量流转、断言判定、Markdown 报告。

## 文档索引

| 文档 | 说明 |
|------|------|
| [01_工作流.md](01_工作流.md) | 执行步骤（含步骤 0：部署脚本到目标项目） |
| [02_结果判定与示例.md](02_结果判定与示例.md) | 判定规则与示例 |

## 执行

执行前，步骤 0 会自动将脚本从技能包部署到目标项目（文件已存在则跳过）：

- `ai-tests/scripts/run-api-tests.mjs` + `ai-tests/scripts/validate-artifacts.mjs`

然后执行：

```bash
cd d:\IdeaProjects\WMS
node ai-tests/scripts/validate-artifacts.mjs --type api
node ai-tests/scripts/run-api-tests.mjs --base-url <测试地址>
```

测试地址由用户提供（`meta.baseUrl` 或 `--base-url`），技能包不写死环境地址。

参考：[shared/06_断言语法.md](../shared/06_断言语法.md)
