# Manager-Claw Task Center Rollout TODO

更新时间: 2026-03-05  
状态: 持续推进

## 里程碑

- [x] M1. 飞书入口接入
  - [x] Feishu -> 本地 webhook 打通
  - [x] 可把用户需求结构化成 goal

- [x] M2. 主Agent协议与记忆固化
  - [x] 协议写入主Agent核心文档
  - [x] MEMORY 写入“必须走任务中心”规则
  - [x] 主Agent首条动作验证通过（结构化回包）

- [x] M3. 多大任务模型
  - [x] 引入 `projectId/projectTitle`（多项目并行）
  - [x] 每个 project 可挂多个 milestone
  - [x] 子任务字段标准化输出（含 `next_input` 别名）
  - [x] `GET /api/tasks` 增加 `projects` 统计视图
  - [x] 新增 `GET /api/projects/:projectId`

- [x] M4. 分级发布引擎（核心）
  - [x] 不一次性全部放入可认领池（`releaseState` 门禁）
  - [x] L1 done 后自动发布 L2，L2 done 后发布 L3（自动触发）
  - [x] 同级并行，跨级串行

- [ ] M5. 子任务池认领机制
  - [x] 原子认领
  - [x] 认领 TTL 回收
  - [x] 可认领池内随机策略

- [x] M6. 子Agent cron
  - [x] 中心调度每分钟轮询（`DISPATCH_MODE=central`）并派发给 idle agent
  - [x] 兼容子Agent拉模式（`DISPATCH_MODE=agent_pull` + heartbeat jobs）
  - [x] 单次最多处理 1 条
  - [x] 结构化结果回传

- [ ] M7. 上下文复用策略
  - [ ] 注入上游结果
  - [ ] 最小必要上下文
  - [ ] Win + Docker artifact 路径统一

- [ ] M8. 主Agent收尾整合
  - [ ] 可整合状态自动通知主Agent
  - [ ] integrate 产出最终结论
  - [ ] 保存 summary + artifact

- [ ] M9. 可观测与容错
  - [ ] 事件流日志
  - [ ] 死信/重试
  - [ ] repair/requeue 工具

## 下一步

1. 开始 M4：把“分级可发布状态”做成后端硬门禁。  
2. 新增“发布下一层”接口与自动触发策略。  
