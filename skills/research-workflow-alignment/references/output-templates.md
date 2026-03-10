# Output Templates

Use these as compact defaults. Keep team chat in Chinese unless the task explicitly requires English.

## Chat Update

```text
当前主线已对齐：
- 权威文件：<file>
- 已解决冲突：<conflict>
- 待处理阻塞：<blocker>

下一步：
- @agent-a <exact ask>
- @agent-b <exact ask>
```

## Conflict Report

```text
发现一处不一致：
- 范围：<section/figure/table>
- 旧来源：<file>
- 新来源：<file>
- 冲突内容：<what differs>
- 现行权威来源：<file>

建议：
- @owner <exact next action>
```

## Integration Memo

Save as a shared file when the project state materially changes.

```text
# Integration Memo: <topic>

## Current Source of Truth
- Research framing: <file or decision>
- Numbers: <file>
- Writing draft: <file>
- Figures/tables: <file>

## Resolved
- <item>

## Open Blockers
- <item>

## Next Actions
- <agent>: <action>
- <agent>: <action>
```

## Author Escalation

Use when the team is blocked on a decision rather than execution.

```text
需要 author 确认一项决策：
- 决策点：<decision>
- 影响范围：<sections/files>
- 选项 A：<summary>
- 选项 B：<summary>
- 当前建议：<recommendation>
```
