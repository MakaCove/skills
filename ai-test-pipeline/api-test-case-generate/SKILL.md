---
name: api-test-case-generate
description: 基于 project-analysis 生成 API 用例。
disable-model-invocation: true
---

# api-test-case-generate

## 目标

确认主流程候选并生成可执行的 API 用例 JSON。

## 文档索引

| 文档 | 说明 |
|------|------|
| [01_工作流.md](01_工作流.md) | 执行步骤 |
| [02_主流程识别与编排.md](02_主流程识别与编排.md) | 主流程识别规则 + 变量编排与依赖 |
| [03_完整示例.md](03_完整示例.md) | 完整产物示例 |

## 输出

- `ai-tests/test-artifacts/api-cases/api-cases-{ts}.json`
- schema：`ai-test-pipeline/api-case/v2`
- Canonical Schema：[shared/04_接口用例结构.md](../shared/04_接口用例结构.md)

## 生成后校验确认

写入用例文件后，**先询问用户是否执行校验**，再根据用户选择运行或跳过。流程见 [01_工作流.md](01_工作流.md#校验确认生成后必做)。
