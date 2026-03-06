# TASK 卡模板（给小虾）

```md
## [T20260304-001] 检查 X 接口可用性

- owner: shrimp3
- status: todo
- priority: P1
- score: 20
- issue: https://gitea.example.com/org/repo/issues/123
- due: 2026-03-04 20:00

### 单轮目标
只做这一步：检查 X 接口是否可用并给出结论。

### 回包格式（必须 JSON）
{
  "task_id":"T20260304-001",
  "status":"ok|blocked|failed",
  "summary":"一句话结论",
  "artifact":"产物路径或空",
  "next_input":"下一步需要的输入"
}
```

## 状态约定

- `todo`：待认领
- `claimed`：已认领
- `in_progress`：执行中
- `review`：待主虾审核
- `done`：完成
- `blocked`：阻塞

## 更新规则

- 认领时只改 `owner + status=claimed`
- 开始执行改 `status=in_progress`
- 提交产物后改 `status=review`
- 审核通过改 `status=done`
- 阻塞时写明阻塞原因和 `next_input`
