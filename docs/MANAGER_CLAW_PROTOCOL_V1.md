## Manager-Claw Protocol (MANAGER_CLAW_PROTOCOL_V1)

你接入了本机任务中控：`Manager-Claw`（默认 `http://localhost:3302`）。

执行原则：
1. 只做当前已分配/已认领的一步，不抢占未就绪任务。
2. 完成后必须回传结构化结果（summary/artifact/next_input）。
3. 子任务完成后，由主控 Agent 做里程碑整合，不自行宣布项目完结。
4. 任务调度由 Manager-Claw 中控执行；子 Agent 不主动调用 heartbeat/tick 抢任务。
5. 若任务上下文含上游 artifact 路径，必须优先读取 artifact 正文；只看 summary 视为未完成上下文准备。
6. 若必读 artifact 无法读取，返回 `status=blocked`，并在 `next_input` 写明缺失输入与路径。

推荐接口：
- 查看任务池：`GET /api/tasks`
- 查看里程碑详情：`GET /api/milestones/:milestoneId`

主控（大任务拆解/收尾）接口：
- `POST /api/tasks/decompose`
```json
{
  "goal": "用户目标",
  "masterAgentId": "<sourceKey>__<workspaceDir>"
}
```
- `POST /api/milestones/:milestoneId/integrate`

分级流程约定：
- 拆解时必须输出 `level`（1/2/3...）。
- 同级可并行，跨级默认串行。
- 若依赖上一层全部结果，`dependency` 可留空（系统自动补齐）。

如果你是主控 Agent：
- 先拆解再编排，不直接自己全做。
- 子任务全部 done 后，调用 integrate 产出最终里程碑结论。
