# Manager-Claw

Manager-Claw 是一个面向 OpenClaw 的本地多 Agent 协作控制台。

它的目标不是替代 OpenClaw 本体，而是补上 OpenClaw 在“多 Agent 可视化管理、任务调度、双人讨论、结果整合”这一层的中控前台。

## 核心能力

- 聚合本机多个 OpenClaw Agent
- 查看和编辑每只 Agent 的关键 Markdown 文档
- 从 Web 端直接向指定 Agent 发消息
- 让主控 Agent 拆解大任务并生成分级子任务
- 统一管理子任务状态、上下文、artifact 和里程碑
- 支持 A/B 双人无领导讨论
- 讨论结束后交给主控 Agent 生成收官报告
- 在 Web 侧统一展示 Agent 忙闲、外部活跃、心跳巡检等状态

---

## 当前已经实现的内容

### 1. Agent 聚合与识别

- 支持读取一个或多个 OpenClaw 根目录
- 支持从真实 `.openclaw` 工作区中扫描 Agent
- 支持识别已经写入 `openclaw.json`、但尚未初始化文档的角色
- 保留关键来源信息：`sourceKey`、`sourceLabel`、工作区目录

### 2. Agent 中心

- Agent 卡片展示：
  - 名称
  - 角色
  - 来源
  - 积分
  - 状态
  - 占用原因
- 支持查看关键文档：
  - `IDENTITY.md`
  - `SOUL.md`
  - `USER.md`
  - `TOOLS.md`
  - `TASK.md`
  - `MEMORY.md`
  - `HEARTBEAT.md`
  - `AGENTS.md`
  - `BOOTSTRAP.md`
- 支持直接编辑并写回真实 Markdown 文件
- 支持从 Web 端直接与 Agent 聊天

### 3. 聊天链路

当前已支持：

- `sessions_send`
- `sessions_spawn`

并包含：

- OpenClaw CLI 调用
- 失败 fallback
- 结构化结果提取
- 超时保护

### 4. 任务中心

#### 4.1 主控拆解

输入一个大目标，指定主控 Agent 后，可调用拆解接口生成：

- 一级里程碑
- 多个子任务
- `level`
- `dependency`
- `priority`
- `score`
- `description`

#### 4.2 子任务状态流转

当前状态机包括：

- `todo`
- `claimed`
- `in_progress`
- `review`
- `done`
- `blocked`
- `integrated`
- `accepted`

当前支持动作：

- 认领
- 释放认领
- 开始
- 提审
- 完成
- 阻塞
- 删除
- 派发执行

#### 4.3 分级发布

不是把全部子任务一次性放出去，而是按分级推进：

- 同级可并行
- 跨级默认串行
- 上一层准备好后，下一层才释放

#### 4.4 里程碑详情

每个大任务有独立详情页，包含：

- 进度条
- 子任务列表
- 上游可复用上下文
- 事件流
- 主控整合入口

#### 4.5 里程碑整合

当子任务完成后，可由主控 Agent 统一整合，生成：

- 里程碑总结
- 收尾建议
- artifact 路径

### 5. 双人无领导讨论

当前只支持 A/B 双人模式。

已实现：

- 创建讨论
- 指定 A / B / 主控整合角色
- 串行轮次发言
- 自动推进 / 手动推进
- 暂停 / 中止 / 删除
- 继续讨论
- 结束后生成讨论报告
- 下载 Markdown

讨论结果协议当前使用：

- `continue`
- `finish`
- `blocked`

### 6. 讨论收官报告

讨论结束后可生成结构化报告，当前主要字段包括：

- `summary`
- `decision`
- `consensus`
- `risks`
- `action_items`
- `score`
- `artifact`

### 7. 调度系统

当前支持两种模式：

- `central`
  - 中控统一轮询并派发
- `agent_pull`
  - 通过 heartbeat job 让 Agent 自己拉取任务

默认推荐：

- `central`

### 8. Agent 状态感知

当前状态不是简单的手工字段，而是实时判定。

已支持区分：

- `空闲`
- `繁忙`
- `外部活跃`
- `心跳巡检`
- `离线`

并且心跳巡检不会阻塞任务调度。

### 9. 协议模板与同步

协议模板文件：

- `docs/MANAGER_CLAW_PROTOCOL_V1.md`

同步命令：

```bash
npm run sync:protocol
```

---

## 当前未完成部分

以下内容仍在开发中，当前版本不应宣传为“已成熟支持”。

### 1. 多人群聊

当前仅支持双人讨论，不支持多人群聊调度。

### 2. 审核 / 打回 / 重试闭环

虽然已有 `review` 状态，但完整的审核人、打回原因、重试策略、自动验收门禁还未做完。

### 3. 日志与可观测性

目前已有任务事件和讨论事件，但还缺：

- 独立日志页
- 错误链路展开
- 调用证据面板
- 更强的排障视图

### 4. Docker 路线

项目早期做过 Docker 接入，但当前主维护路径是本机 `.openclaw`。

Docker 相关代码仍在仓库中，但不是当前推荐方案。

### 5. OpenClaw 版本适配

本项目贴近 OpenClaw 本地目录结构和 session 行为实现。

如果 OpenClaw 升级后目录结构、provider、session 格式发生变化，Manager-Claw 可能需要同步适配。

---

## 技术栈

### 后端

- Node.js
- Express

主入口：

- `server.js`

### 前端

- 原生 HTML
- 原生 CSS
- 原生 JavaScript

主要文件：

- `web/index.html`
- `web/main.js`
- `web/styles.css`

### 持久化

当前不依赖数据库，主要使用本地 JSON 文件：

- `data/task-center.json`
- `data/group-sessions.json`
- `data/dispatch-settings.json`
- `data/heartbeat-jobs.json`

以及自动生成目录：

- `data/task-center-backups/`
- `data/discussion-exports/`

---

## 目录结构

```text
manager-claw/
  data/
  docs/
  scripts/
  web/
  server.js
  package.json
  README.md
  Dockerfile
  docker-compose.yml
```

---

## 主要 API

这里只列主要接口，不在 README 中展开完整接口文档。

### Agent / 文档 / 聊天

- `GET /api/agents`
- `GET /api/agents/:agentId/files/:fileName`
- `PUT /api/agents/:agentId/files/:fileName`
- `GET /api/agents/:agentId/avatar`
- `GET /api/chat/agents/:agentId/messages`
- `POST /api/chat/agents/:agentId/messages`

### 任务中心

- `GET /api/tasks`
- `GET /api/milestones/:milestoneId`
- `POST /api/tasks/decompose`
- `POST /api/tasks/:taskId/claim`
- `POST /api/tasks/:taskId/release`
- `POST /api/tasks/:taskId/status`
- `POST /api/tasks/:taskId/dispatch`
- `POST /api/tasks/heartbeat/tick`
- `POST /api/milestones/:milestoneId/integrate`

### 讨论组

- `GET /api/group-sessions`
- `GET /api/group-sessions/:sessionId`
- `POST /api/group-sessions`
- `POST /api/group-sessions/:sessionId/start`
- `POST /api/group-sessions/:sessionId/pause`
- `POST /api/group-sessions/:sessionId/tick`
- `POST /api/group-sessions/:sessionId/abort`
- `DELETE /api/group-sessions/:sessionId`

### 系统设置

- `GET /api/settings/dispatch`
- `PUT /api/settings/dispatch`
- `GET /health`

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

最简单：

```bash
npm start
```

推荐显式指定端口和 OpenClaw 根目录。

#### Windows

```powershell
$env:PORT=3302
$env:CLAW_AGENTS_ROOTS="C:\Users\<用户名>\.openclaw"
npm start
```

#### macOS / Linux

```bash
PORT=3302 CLAW_AGENTS_ROOTS="$HOME/.openclaw" npm start
```

### 3. 打开页面

- `http://localhost:3302`
- `http://localhost:3302/health`

---

## 如何在一台新电脑上初始化

### 前提条件

必须先有可用的 OpenClaw 环境。

至少应满足：

1. OpenClaw 已安装
2. `.openclaw/openclaw.json` 已存在
3. 至少创建过一个 Agent
4. 能在 OpenClaw TUI 中正常与 Agent 对话

Manager-Claw 不负责安装 OpenClaw 本体，只负责读取和管理已有的 OpenClaw 工作区。

### 初始化步骤

#### Windows

1. 安装 Node.js 18+
2. 克隆本仓库
3. 执行 `npm install`
4. 确认 OpenClaw 根目录，例如：
   - `C:\Users\<用户名>\.openclaw`
5. 用环境变量启动：

```powershell
$env:PORT=3302
$env:CLAW_AGENTS_ROOTS="C:\Users\<用户名>\.openclaw"
npm start
```

#### macOS / Linux

1. 安装 Node.js 18+
2. 克隆本仓库
3. 执行 `npm install`
4. 确认 OpenClaw 根目录，例如：
   - `$HOME/.openclaw`
5. 启动：

```bash
PORT=3302 CLAW_AGENTS_ROOTS="$HOME/.openclaw" npm start
```

### 首次启动后建议检查

1. 打开 `Agent 中心`
2. 确认可以扫描到已有角色
3. 打开任意 Agent，确认关键文档能读取
4. 编辑一个 Markdown 文件，确认可以写回真实文件
5. 从 Web 端发送一条消息给 Agent
6. 在 `任务中心` 用主控 Agent 拆一个简单目标
7. 在 `讨论组` 创建一场双人讨论

---

## OpenClaw 侧建议准备的文档

建议至少具备以下文件：

- `IDENTITY.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `AGENTS.md`
- `HEARTBEAT.md`

推荐分工：

- 主控 Agent：任务拆解、整合、编排
- 执行 Agent：结构化回包、artifact 产出
- 讨论 Agent：遵守 `continue | finish | blocked`

如果采用本项目协议模板，可执行：

```bash
npm run sync:protocol
```

---

## 环境变量

常用环境变量：

- `PORT`
- `CLAW_AGENTS_ROOT`
- `CLAW_AGENTS_ROOTS`
- `DISPATCH_MODE`
- `CENTRAL_DISPATCH_INTERVAL_MS`
- `CENTRAL_DISPATCH_EXCLUDE`
- `TASK_CLAIM_TTL_MS`
- `CHAT_BRIDGE_TIMEOUT_MS`
- `CHAT_AGENT_TIMEOUT_MS`
- `MILESTONE_ARTIFACT_CONTEXT_MODE`

推荐默认：

- `DISPATCH_MODE=central`

---

## 已知限制

- 依赖 OpenClaw 本地目录结构
- 不同 OpenClaw 版本可能需要额外兼容
- PowerShell 控制台中文输出可能乱码
  - 主要影响终端显示
  - 不代表文件内容一定损坏
- 当前多人群聊未完成
- 当前审核打回链路未做完整
- 当前 Docker 路线不是主维护方向

---

## Roadmap

- [ ] 多人群聊与多人轮次调度
- [ ] 更完整的审核 / 打回 / 重试机制
- [ ] 更强的日志与运行证据面板
- [ ] 更易懂的调度设置
- [ ] 讨论结果一键转入任务中心
- [ ] 更细的 artifact 管理与项目级目录
- [ ] 更通用的跨平台启动脚本
- [ ] 更完整的测试与异常恢复

---

## 推荐补充文件

如果作为 GitHub 开源仓库发布，建议补齐：

- `LICENSE`
- `.env.example`
- `CONTRIBUTING.md`
- `CHANGELOG.md`

其中 `LICENSE` 最关键。

---

## 开发命令

```bash
npm install
npm start
npm run sync:protocol
npm run migrate:artifacts
```

---

## 项目定位

Manager-Claw 当前定位是：

- OpenClaw 的本地协作控制台
- 多 Agent 编排实验平台
- 用来验证“拆解 -> 调度 -> 讨论 -> 整合”这套模式的本地中控前台

它不是 OpenClaw 官方替代品，也不是通用 Agent 平台。

---

## Windows 本地启动与排障经验

这几轮迭代里，Windows 本地启动最容易踩的是下面几件事：

- 管理台默认端口是 `3000`，但本项目实际建议固定用 `3302`。如果不显式传 `PORT=3302`，很容易撞上本机已有服务。
- 当前推荐的 Agent 根目录是本机 `.openclaw`，不要依赖早期 Docker 工作区。启动时建议显式传入：`CLAW_AGENTS_ROOTS=C:\Users\<用户名>\.openclaw`。
- 在 Windows 下，后台拉起 Node 服务时，`cmd /c` 的稳定性高于复杂的 PowerShell 拼接命令。实践里更稳的方式是先设环境变量，再后台启动 `node server.js`。
- 启动后不要只看浏览器页面，先检查健康接口：`http://localhost:3302/health`。只要这里返回 `ok: true`，前端通常就是缓存或静态资源问题。
- 如果页面样式或交互和代码不一致，优先强刷浏览器（`Ctrl+F5`）。这个项目前端缓存命中率高，静态资源版本没有更新时很容易误判“改动没生效”。
- OpenClaw 的“外部活跃”与“心跳巡检”需要区分。仅仅看到 session 最近有写入，不代表 Agent 真正在忙主任务；心跳不应该阻塞调度。
- PowerShell 终端里看到中文乱码，不应直接推断为文件内容损坏。优先以 Web 页面渲染结果、实际文件内容和接口返回为准。

当前推荐的 Windows 本地启动方式：

```bash
set PORT=3302
set CLAW_AGENTS_ROOTS=C:\Users\<用户名>\.openclaw
set DISPATCH_MODE=central
node server.js
```

启动后验证：

```bash
curl http://localhost:3302/health
```
