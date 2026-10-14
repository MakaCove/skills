# ai-test-pipeline

面向 AI Agent 的测试流水线技能包，覆盖项目分析 → 用例生成 → 校验 → 执行 → 报告。

## 技能一览

| 技能 | 目录 | 输出 |
|------|------|------|
| **project-analyzer** | `project-analyzer/` | `ai-tests/test-artifacts/project-analysis-{ts}.json` |
| **api-test-case-generate** | `api-test-case-generate/` | `ai-tests/test-artifacts/api-cases/api-cases-{ts}.json` |
| **ui-test-case-generate** | `ui-test-case-generate/` | `ai-tests/test-artifacts/ui-cases/ui-cases-{ts}.json` |
| **api-test-execute** | `api-test-execute/` | `ai-tests/test-artifacts/api-reports/api-report-{ts}.md` |
| **ui-test-execute** | `ui-test-execute/` | `ai-tests/test-artifacts/ui-reports/ui-report-{ts}.md` |
| **shared** | `shared/` | 统一 Schema、断言语法、选择器策略、产物布局 |

各技能工作流详见目录内 `01_工作流.md` 与 `SKILL.md` 索引。

## 前置条件

- Node.js >= 18
- 所有命令在**被测项目根目录**执行
- UI 执行需要 Playwright（配置写入 `ai-tests/test-artifacts/ui-test.config.json`）

## 标准流程

1. **project-analyzer** → 扫描 Controller / Router / 布局组件，输出项目分析
2. **api-test-case-generate** + **ui-test-case-generate** → 生成用例并写入 `ai-tests/test-artifacts/latest`
3. **执行阶段步骤 0**（自动）→ 部署 `ai-tests/scripts/*.mjs` 与 `ui-test.config.json` 到目标项目
4. **校验**：`node ai-tests/scripts/validate-artifacts.mjs --type ui`
5. **执行**：`node ai-tests/scripts/run-ui-tests.mjs --base-url <地址> --limit 20`
6. **查看报告**：`ai-tests/test-artifacts/api-reports/`、`ai-tests/test-artifacts/ui-reports/`

## 核心约束

- Schema：`project-analysis/v2`、`api-case/v2`、`ui-case/v2`
- 命名约定：UI 侧统一使用 `ui-*`
- 链路字段：`trace.*`（`flowRefs`、`dependsOn`、`produces`、`consumes`）
- 测试地址由用户提供，技能包不写死—写入 `meta.baseUrl`，或执行时 `--base-url` 传入

## 产物目录

```text
项目根目录/
└── ai-tests/
    ├── scripts/                      ← 执行阶段自动从技能包部署
    │   ├── run-api-tests.mjs
    │   ├── run-ui-tests.mjs
    │   └── validate-artifacts.mjs
    └── test-artifacts/
        ├── latest
        ├── project-analysis-*.json
        ├── ui-test.config.json       ← 执行阶段自动部署
        ├── api-cases/
        ├── ui-cases/
        ├── api-reports/
        └── ui-reports/
```

详细架构见 [架构与流程.md](架构与流程.md)。
