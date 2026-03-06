# Manager-Claw

Manager-Claw 是一个面向 OpenClaw 的本地多 Agent 协作控制台。

它不替代 OpenClaw 本体，而是补上这一层能力：

- 聚合本机多个 OpenClaw Agent
- 查看和编辑关键 Markdown 文档
- 把一个主题交给主 Agent 拆解
- 按分级自动流转子任务
- 在任务完成后由主 Agent 自动整合结果
- 发起 A/B 双人讨论，并在结束后生成收官报告
- 在 Web 端统一看到 Agent 的真实占用状态

当前主维护路线是：`Windows / 本机 .openclaw / central 中心调度`。

## 当前工作流

项目当前只推荐这一条主流程：

1. 用户在任务中心输入主题
2. 选择主 Agent
3. 主 Agent 调用拆解接口生成多级子任务
4. 系统按 level 自动释放子任务
5. 中心调度自动选择可用子 Agent 执行
6. 子 Agent 回传结构化结果（summary / artifact / next_input）
7. 全部子任务完成后，主 Agent 自动整合里程碑

A/B 讨论是独立能力：

- 只负责围绕一个问题讨论并收敛结论
- 不直接参与任务调度
- 结束后可以交由主控 Agent 生成报告

## 已实现能力

### 1. Agent 中心

- 扫描并识别本机 `.openclaw` 下的 Agent
- 展示名称、emoji、角色、来源、积分、状态
- 查看/编辑关键文档：
  - `IDENTITY.md`
  - `SOUL.md`
  - `USER.md`
  - `TOOLS.md`
  - `TASK.md`
  - `MEMORY.md`
  - `HEARTBEAT.md`
  - `AGENTS.md`
  - `BOOTSTRAP.md`
- 直接向指定 Agent 发消息

### 2. 任务中心

- 由主 Agent 拆解主题为多级子任务
- 只保留自动流转路线，不再暴露手工认领/派发入口
- 支持里程碑总览、任务详情抽屉、子任务表格、可复用上下文表格
- 子任务按 level 自动释放：同级可并行，跨级默认串行
- 全部子任务完成后自动触发主控整合

### 3. 双人讨论组

- 创建 A/B 双人无领导讨论
- 指定 A、B、主控整合角色
- 支持自动推进和手动推进
- 支持继续讨论、暂停、中止、删除
- 讨论结束后自动生成结构化讨论报告
- 支持前端本地下载 Markdown 记录

### 4. 占用真相层

Agent 状态不再只看一个手工字段，而是统一计算：

- `idle`
- `busy_task`
- `busy_discussion`
- `busy_external`
- `heartbeat_only`
- `offline`

并同步返回：

- `status`
- `statusSource`
- `statusDetail`
- `assignable`

这套状态同时服务：

- Agent 卡片
- 任务中心角色选择
- 讨论组角色选择
- 中心调度器

### 5. 运行状态面板

顶部运行状态面板当前显示：

- 当前根目录
- 当前调度模式
- 活跃任务数
- 活跃讨论数
- 最近一次调度错误

## 当前不再推荐的旧能力

以下接口/流程已降级为遗留，不应再作为公开工作流使用：

- 手工认领任务
- 手工释放任务
- 手工派发任务
- 心跳认领执行接口
- 手工修复里程碑流程
- 手工释放下一层级任务

项目内部可能仍保留部分兼容逻辑，用于读取旧数据或支持调度器内部行为；但前端和 README 不再以这些能力作为主路径。

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
- `web/styles.css`
- `web/main.js`

### 本地持久化

项目当前不依赖数据库，主要使用本地 JSON 文件：

- `data/task-center.json`
- `data/group-sessions.json`
- `data/dispatch-settings.json`
- `data/heartbeat-jobs.json`

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 确认本机 OpenClaw 已可用

至少确认这几项：

- 本机存在 `.openclaw`
- OpenClaw CLI 可执行
- 你已经在 OpenClaw 里创建过至少一个 Agent
- 对应工作区内已经有核心 Markdown 文档，或者已经在 `openclaw.json` 注册过 Agent

### 3. 设置推荐环境变量

Windows PowerShell：

```powershell
$env:PORT="3302"
$env:CLAW_AGENTS_ROOTS="$HOME\.openclaw"
node server.js
```

如果你希望长期固定，也可以写到本地启动脚本中。

### 4. 打开页面

- 控制台首页：<http://localhost:3302>
- 健康检查：<http://localhost:3302/health>

## 新电脑初始化说明

如果别人要在另一台电脑上跑起来，建议按这个顺序：

### 步骤 1：安装 Node.js

推荐使用 Node 18+。

### 步骤 2：安装 OpenClaw 并完成基础初始化

至少要让 OpenClaw 成功生成：

- `~/.openclaw/openclaw.json`
- `~/.openclaw/agents/...`
- 一个或多个 Agent 工作区

### 步骤 3：创建至少一个可识别 Agent

Manager-Claw 当前识别逻辑基于两类信息：

- 工作区中的关键 Markdown 文档
- `openclaw.json` 中登记的 Agent/workspace 信息

如果只是新建了空目录，页面会显示“待初始化”，但仍可被识别。

### 步骤 4：启动 Manager-Claw

建议固定端口 `3302`，避免和其他本地服务冲突。

### 步骤 5：首次检查

优先看：

- `/health` 是否返回 `ok: true`
- 页面顶部是否正确显示 `.openclaw` 根目录
- Agent 中心是否识别到你刚创建的角色

## 关键 API

这里只列当前推荐使用的接口。

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
- `POST /api/milestones/:milestoneId/integrate`

### 双人讨论

- `GET /api/group-sessions`
- `GET /api/group-sessions/:sessionId`
- `POST /api/group-sessions`
- `POST /api/group-sessions/:sessionId/start`
- `POST /api/group-sessions/:sessionId/pause`
- `POST /api/group-sessions/:sessionId/tick`
- `POST /api/group-sessions/:sessionId/abort`
- `DELETE /api/group-sessions/:sessionId`

## 已知限制

- 当前主路线只推荐本机 `.openclaw`，不推荐 Docker 作为主维护方案
- 当前只支持 A/B 双人讨论，不支持多人群聊
- OpenClaw 的目录结构、session 格式、provider 行为如果升级变化，Manager-Claw 需要跟着适配
- 当前后端仍以单文件 `server.js` 为主，后续还需要继续拆层
- 当前持久化仍是本地 JSON，不适合多人同时写入

## Roadmap

下一阶段建议继续做：

1. 后端按行为拆层：`agent-runtime / task-orchestrator / discussion-orchestrator / persistence`
2. 统一错误对象和排障面板
3. 完成任务中心与讨论组的统一工作台交互
4. 增加更稳的调度证据与恢复机制
5. 再考虑是否恢复 Docker 线路作为次维护路线

## 开发建议

如果你是在 Windows 本地长期使用，推荐固定遵守这几条：

1. 固定使用 `3302` 端口
2. 固定使用本机 `.openclaw` 作为根目录
3. 启动后先看 `/health`，再看页面
4. 前端改动后优先 `Ctrl+F5`
5. 不要把 PowerShell 控制台乱码直接等同于文件内容乱码

## License

当前仓库尚未补充正式 LICENSE。开源发布前建议补齐。
