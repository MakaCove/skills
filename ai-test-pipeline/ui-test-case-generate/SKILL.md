---
name: ui-test-case-generate
description: 基于 project-analysis 生成 UI 用例。
disable-model-invocation: true
---

# ui-test-case-generate

## 目标

确认主流程候选并生成可执行的 UI 用例 JSON。

## 文档索引

| 文档 | 说明 |
|------|------|
| [01_工作流.md](01_工作流.md) | 执行步骤 |
| [02_主流程识别与编排.md](02_主流程识别与编排.md) | 主流程识别规则 + 变量编排与依赖 |
| [03_菜单导航与步骤.md](03_菜单导航与步骤.md) | 菜单驱动步骤设计（26 种 action） |
| [04_完整示例.md](04_完整示例.md) | 完整产物示例 |

## 输出

- `ai-tests/test-artifacts/ui-cases/ui-cases-{ts}.json`
- schema：`ai-test-pipeline/ui-case/v2`
- Canonical Schema：[shared/05_UI用例结构.md](../shared/05_UI用例结构.md)
- 说明：UI 侧命名统一为 `ui-*`（目录、产物、schema、脚本）。

## 生成后校验确认

写入用例文件后，**先询问用户是否执行校验**，再根据用户选择运行或跳过。流程见 [01_工作流.md](01_工作流.md#校验确认生成后必做)。
