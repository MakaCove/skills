---
name: project-analyzer
description: 解析项目结构并生成 project-analysis 产物。
disable-model-invocation: true
---

# project-analyzer

## 目标

扫描项目入口、模块、端点、路由和鉴权信息，生成 `project-analysis` 基础产物。

## 文档索引

| 文档 | 说明 |
|------|------|
| [01_工作流.md](01_工作流.md) | 执行步骤 |
| [02_输出规范.md](02_输出规范.md) | 产物字段要求 |
| [03_多栈扫描指南.md](03_多栈扫描指南.md) | 多技术栈扫描方法 |
| [04_下游衔接.md](04_下游衔接.md) | 与生成阶段的衔接 |
| [05_完整示例.md](05_完整示例.md) | 完整产物示例 |

## 输出

- `ai-tests/test-artifacts/project-analysis-{ts}.json`
- schema：`ai-test-pipeline/project-analysis/v2`
- Canonical Schema：[shared/03_项目分析结构.md](../shared/03_项目分析结构.md)
