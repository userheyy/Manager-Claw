const navTasks = document.getElementById("navTasks");
const navGroups = document.getElementById("navGroups");
const navAgents = document.getElementById("navAgents");
const openDispatchSettings = document.getElementById("openDispatchSettings");
const tasksView = document.getElementById("tasksView");
const groupsView = document.getElementById("groupsView");
const agentsView = document.getElementById("agentsView");
const dispatchSettingsDialog = document.getElementById("dispatchSettingsDialog");
const closeDispatchSettings = document.getElementById("closeDispatchSettings");
const dispatchModeSelect = document.getElementById("dispatchModeSelect");
const dispatchIntervalInput = document.getElementById("dispatchIntervalInput");
const dispatchExcludeInput = document.getElementById("dispatchExcludeInput");
const saveDispatchSettings = document.getElementById("saveDispatchSettings");
const dispatchSettingsMeta = document.getElementById("dispatchSettingsMeta");
const dispatchModeHint = document.getElementById("dispatchModeHint");

const agentGrid = document.getElementById("agentGrid");
const rootInfo = document.getElementById("rootInfo");

const taskStats = document.getElementById("taskStats");
const taskBoard = document.getElementById("taskBoard");
const taskDecomposeForm = document.getElementById("taskDecomposeForm");
const refreshTasksBtn = document.getElementById("refreshTasksBtn");
const autoClaimBtn = document.getElementById("autoClaimBtn");
const heartbeatTickBtn = document.getElementById("heartbeatTickBtn");
const autoClaimAgentSelect = document.getElementById("autoClaimAgentSelect");
const masterAgentSelect = document.getElementById("masterAgentSelect");
const masterAgentPicker = document.getElementById("masterAgentPicker");
const goalInput = document.getElementById("goalInput");
const taskSearchInput = document.getElementById("taskSearchInput");
const taskProjectFilter = document.getElementById("taskProjectFilter");
const taskStatusFilter = document.getElementById("taskStatusFilter");
const taskSortSelect = document.getElementById("taskSortSelect");
const taskFilterResetBtn = document.getElementById("taskFilterResetBtn");

const taskDetailPage = document.getElementById("taskDetailPage");
const taskDetailBack = document.getElementById("taskDetailBack");
const taskDetailTitle = document.getElementById("taskDetailTitle");
const taskDetailMeta = document.getElementById("taskDetailMeta");
const taskDetailProgress = document.getElementById("taskDetailProgress");
const taskDetailDesc = document.getElementById("taskDetailDesc");
const taskDetailSummary = document.getElementById("taskDetailSummary");
const taskDetailChecklist = document.getElementById("taskDetailChecklist");
const taskDetailChildren = document.getElementById("taskDetailChildren");
const taskDetailContext = document.getElementById("taskDetailContext");
const taskDetailEvents = document.getElementById("taskDetailEvents");
const taskDetailAgentSelect = document.getElementById("taskDetailAgentSelect");
const taskDispatchModeSelect = document.getElementById("taskDispatchModeSelect");

const taskBtnClaim = document.getElementById("taskBtnClaim");
const taskBtnStart = document.getElementById("taskBtnStart");
const taskBtnReview = document.getElementById("taskBtnReview");
const taskBtnIntegrated = document.getElementById("taskBtnIntegrated");
const taskBtnDone = document.getElementById("taskBtnDone");
const taskBtnBlock = document.getElementById("taskBtnBlock");
const taskBtnRelease = document.getElementById("taskBtnRelease");
const taskBtnDispatch = document.getElementById("taskBtnDispatch");
const taskBtnDelete = document.getElementById("taskBtnDelete");

const groupCreateForm = document.getElementById("groupCreateForm");
const groupTitleInput = document.getElementById("groupTitleInput");
const groupGoalInput = document.getElementById("groupGoalInput");
const groupAgentASelect = document.getElementById("groupAgentASelect");
const groupAgentBSelect = document.getElementById("groupAgentBSelect");
const groupMasterAgentSelect = document.getElementById("groupMasterAgentSelect");
const groupAgentAPicker = document.getElementById("groupAgentAPicker");
const groupAgentBPicker = document.getElementById("groupAgentBPicker");
const groupMasterAgentPicker = document.getElementById("groupMasterAgentPicker");
const groupMaxRoundsInput = document.getElementById("groupMaxRoundsInput");
const groupAutoRunInput = document.getElementById("groupAutoRunInput");
const refreshGroupsBtn = document.getElementById("refreshGroupsBtn");
const groupSessionList = document.getElementById("groupSessionList");
const groupDetailPanel = document.getElementById("groupDetailPanel");
const groupDetailTitle = document.getElementById("groupDetailTitle");
const groupDetailMeta = document.getElementById("groupDetailMeta");
const groupDetailSummary = document.getElementById("groupDetailSummary");
const groupDetailReport = document.getElementById("groupDetailReport");
const groupExportFileName = document.getElementById("groupExportFileName");
const groupExportBtn = document.getElementById("groupExportBtn");
const groupMessages = document.getElementById("groupMessages");
const groupStartBtn = document.getElementById("groupStartBtn");
const groupPauseBtn = document.getElementById("groupPauseBtn");
const groupTickBtn = document.getElementById("groupTickBtn");
const groupAbortBtn = document.getElementById("groupAbortBtn");
const groupDeleteBtn = document.getElementById("groupDeleteBtn");
const dialog = document.getElementById("docDialog");
const fileList = document.getElementById("fileList");
const markdownBody = document.getElementById("markdownBody");
const markdownEditor = document.getElementById("markdownEditor");
const activeFile = document.getElementById("activeFile");
const docCount = document.getElementById("docCount");
const closeDialog = document.getElementById("closeDialog");
const closeDialogTop = document.getElementById("closeDialogTop");
const editBtn = document.getElementById("editBtn");
const saveBtn = document.getElementById("saveBtn");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const tabDocs = document.getElementById("tabDocs");
const tabChat = document.getElementById("tabChat");
const docsPanel = document.getElementById("docsPanel");
const chatPanel = document.getElementById("chatPanel");
const chatAgentName = document.getElementById("chatAgentName");
const chatAgentMeta = document.getElementById("chatAgentMeta");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

const STATUS_LABEL = {
  todo: "待认领",
  claimed: "已认领",
  in_progress: "进行中",
  review: "待评审",
  integrated: "已集成",
  accepted: "已验收",
  done: "已完成",
  blocked: "阻塞"
};

let currentView = "tasks";
let currentAgent = null;
let agents = [];
let tasks = [];
let milestones = [];
let projects = [];
let groupSessions = [];
let currentFileName = null;
let currentRaw = "";
let isEditMode = false;
let chatSending = false;
let currentSendMode = "sessions_send";
let currentTaskId = null;
let currentMilestoneId = null;
let milestoneDetail = null;
let dispatchSettings = null;
let currentGroupSessionId = null;
let currentGroupDetail = null;
let liveRefreshTimer = null;
let liveRefreshInFlight = false;
let liveRefreshBackoffMs = 0;
const taskFilter = {
  q: "",
  projectId: "all",
  status: "all",
  sort: "updated_desc"
};
const LIVE_REFRESH_MS = {
  tasks: 5000,
  groups: 3000,
  agents: 10000
};

function escapeHtml(input) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function normalizeForSearch(v) {
  return String(v || "").trim().toLowerCase();
}

function syncTaskFilterFromUI() {
  taskFilter.q = normalizeForSearch(taskSearchInput?.value || "");
  taskFilter.projectId = String(taskProjectFilter?.value || "all");
  taskFilter.status = String(taskStatusFilter?.value || "all");
  taskFilter.sort = String(taskSortSelect?.value || "updated_desc");
}

function resetTaskFilters() {
  if (taskSearchInput) taskSearchInput.value = "";
  if (taskProjectFilter) taskProjectFilter.value = "all";
  if (taskStatusFilter) taskStatusFilter.value = "all";
  if (taskSortSelect) taskSortSelect.value = "updated_desc";
  syncTaskFilterFromUI();
}

async function requestJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.replyText ? ` | ${String(data.replyText).slice(0, 240)}` : "";
    const err = new Error((data.error || `HTTP ${res.status}`) + detail);
    err.status = res.status;
    throw err;
  }
  return data;
}

function setView(view) {
  currentView = view;
  const isTasks = view === "tasks";
  const isGroups = view === "groups";
  const isAgents = view === "agents";
  navTasks.classList.toggle("active", isTasks);
  navGroups?.classList.toggle("active", isGroups);
  navAgents.classList.toggle("active", isAgents);
  tasksView.style.display = isTasks ? "block" : "none";
  if (groupsView) groupsView.style.display = isGroups ? "block" : "none";
  agentsView.style.display = isAgents ? "block" : "none";
  scheduleLiveRefresh(true);
}

function liveRefreshIntervalForView(view = currentView) {
  return LIVE_REFRESH_MS[view] || 8000;
}

async function runLiveRefresh() {
  if (liveRefreshInFlight) return;
  if (document.hidden) {
    scheduleLiveRefresh();
    return;
  }
  liveRefreshInFlight = true;
  try {
    if (currentView === "groups") {
      await refreshGroupSessions();
    } else if (currentView === "agents") {
      await refreshAgents();
    } else {
      await refreshTasks();
      await refreshAgents();
    }
    liveRefreshBackoffMs = 0;
  } catch (err) {
    console.warn("live refresh failed:", err);
    liveRefreshBackoffMs = Math.min(30000, Math.max(5000, liveRefreshBackoffMs || liveRefreshIntervalForView()) * 2);
  } finally {
    liveRefreshInFlight = false;
    scheduleLiveRefresh();
  }
}

function scheduleLiveRefresh(immediate = false) {
  if (liveRefreshTimer) {
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
  }
  const waitMs = immediate ? 250 : liveRefreshBackoffMs || liveRefreshIntervalForView();
  liveRefreshTimer = window.setTimeout(() => {
    runLiveRefresh().catch(() => {});
  }, waitMs);
}

function getTaskById(taskId) {
  return tasks.find((t) => t.id === taskId);
}

function getAgentById(agentId) {
  return agents.find((a) => a.id === agentId);
}

function agentName(agentId) {
  const agent = getAgentById(agentId);
  return agent ? agent.name : "未认领";
}

function closeAgentDialog() {
  if (dialog.open) dialog.close();
}

function renderAvatar(agent) {
  if (agent.avatarType === "url" || agent.avatarType === "file") {
    return `<div class="avatar"><img src="${agent.avatarUrl}" alt="${escapeHtml(agent.name)}" /></div>`;
  }
  return `<div class="avatar">${escapeHtml(agent.avatar || "??")}</div>`;
}

function mapAgentStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "heartbeat_only" || s === "heartbeat") return "heartbeat_only";
  if (s === "busy_external" || s === "external" || s === "unknown") return "busy_external";
  if (s === "busy" || s === "active" || s === "in_progress") return "busy";
  if (s === "offline") return "offline";
  return "idle";
}

function renderAgents() {
  if (agents.length === 0) {
    agentGrid.innerHTML = '<div class="agent-card"><div class="agent-name">暂无 Agent</div><div class="agent-role">请检查目录配置</div></div>';
    return;
  }

  agentGrid.innerHTML = agents
    .map(
      (agent) => `
      <article class="agent-card status-${mapAgentStatus(agent.status)}" data-agent-id="${agent.id}">
        <div class="agent-head">
          <div class="identity">
            ${renderAvatar(agent)}
            <div class="title-wrap">
              <div class="agent-name">${escapeHtml(agent.name)}</div>
              <div class="agent-role">${escapeHtml(agent.role)}</div>
            </div>
          </div>
          <div class="status-dot ${mapAgentStatus(agent.status)}" title="${escapeHtml(String(agent.statusLabel || agent.status || "idle"))}"></div>
        </div>
        <div class="source-chip">来源 ${escapeHtml(agent.sourceLabel)}</div>
        <div class="agent-runtime">
          <span class="runtime-pill ${mapAgentStatus(agent.status)}">${escapeHtml(agent.statusLabel || agent.status || "空闲")}</span>
          <span class="agent-runtime-text">${escapeHtml(agent.statusReason || "")}</span>
        </div>
        <div class="agent-foot">
          <span>文档 ${agent.files.length}</span>
          <span class="agent-score">★${agent.score}</span>
        </div>
      </article>
    `
    )
    .join("");

  for (const card of document.querySelectorAll(".agent-card[data-agent-id]")) {
    card.addEventListener("click", async () => {
      const id = card.getAttribute("data-agent-id");
      const agent = getAgentById(id);
      if (!agent) return;
      currentAgent = agent;
      await openAgentDialog(agent);
    });
  }
}

function renderTaskSelectOptions() {
  const options = agents
    .map((a) => `<option value="${a.id}">${escapeHtml(a.name)} · ${escapeHtml(a.sourceLabel)}</option>`)
    .join("");
  const masterOptions = [`<option value="">不指定主控整合</option>`, options].join("");
  autoClaimAgentSelect.innerHTML = options;
  masterAgentSelect.innerHTML = options;
  taskDetailAgentSelect.innerHTML = options;
  if (masterAgentSelect && masterAgentSelect.options.length > 0 && !masterAgentSelect.value) {
    const preferred = agents.find((a) => ["idle", "heartbeat_only"].includes(String(a.status || "").toLowerCase())) || agents[0];
    masterAgentSelect.value = preferred?.id || "";
  }
  if (groupAgentASelect) groupAgentASelect.innerHTML = options;
  if (groupAgentBSelect) groupAgentBSelect.innerHTML = options;
  if (groupMasterAgentSelect) groupMasterAgentSelect.innerHTML = masterOptions;
  if (groupAgentASelect && groupAgentASelect.options.length > 0 && !groupAgentASelect.value) {
    groupAgentASelect.value = groupAgentASelect.options[0].value;
  }
  if (groupAgentBSelect && groupAgentBSelect.options.length > 1 && !groupAgentBSelect.value) {
    groupAgentBSelect.value = groupAgentBSelect.options[1].value;
  }
  if (groupMasterAgentSelect && !groupMasterAgentSelect.value) {
    groupMasterAgentSelect.value = masterAgentSelect?.value || "";
  }
  if (groupAgentASelect && groupAgentBSelect && groupAgentASelect.value === groupAgentBSelect.value) {
    const fallback = agents.find((a) => a.id !== groupAgentASelect.value);
    if (fallback) groupAgentBSelect.value = fallback.id;
  }
  renderAgentPickers();
}

function renderAgentPicker(container, targetSelect, options = {}) {
  if (!container || !targetSelect) return;
  const {
    allowEmpty = false,
    emptyLabel = "不指定",
    emptyDesc = "留空",
    filter = () => true,
    isDisabled = () => false
  } = options;
  const current = String(targetSelect.value || "");
  const items = [];
  if (allowEmpty) {
    items.push({
      id: "",
      name: emptyLabel,
      role: emptyDesc,
      status: "idle",
      statusLabel: "可跳过",
      statusReason: "保留为空，稍后再指定",
      sourceLabel: "system",
      selectable: true
    });
  }
  for (const agent of agents.filter(filter)) {
    items.push({
      ...agent,
      selectable: !isDisabled(agent)
    });
  }
  container.innerHTML = items
    .map((agent) => {
      const selected = current === String(agent.id || "");
      const disabled = !agent.selectable;
      const statusClass = mapAgentStatus(agent.status);
      return `
        <button
          type="button"
          class="agent-pick-card status-${statusClass}${selected ? " selected" : ""}${disabled ? " disabled" : ""}"
          data-picker-value="${escapeHtml(String(agent.id || ""))}"
          ${disabled ? 'aria-disabled="true"' : ""}
        >
          <div class="agent-pick-top">
            <strong>${escapeHtml(agent.name || emptyLabel)}</strong>
            <span class="runtime-pill ${statusClass}">${escapeHtml(agent.statusLabel || "")}</span>
          </div>
          <div class="agent-pick-meta">${escapeHtml(agent.role || "")}</div>
          <div class="agent-pick-reason">${escapeHtml(agent.statusReason || "")}</div>
          <div class="agent-pick-foot">${escapeHtml(agent.sourceLabel || "")}</div>
        </button>
      `;
    })
    .join("");
  for (const button of container.querySelectorAll(".agent-pick-card[data-picker-value]")) {
    button.addEventListener("click", () => {
      if (button.classList.contains("disabled")) return;
      const nextValue = button.getAttribute("data-picker-value") || "";
      targetSelect.value = nextValue;
      renderAgentPickers();
    });
  }
}

function renderAgentPickers() {
  if (groupAgentASelect && groupAgentBSelect && groupAgentASelect.value === groupAgentBSelect.value) {
    const fallback = agents.find((agent) => String(agent.id || "") !== String(groupAgentASelect.value || ""));
    if (fallback) groupAgentBSelect.value = fallback.id;
  }
  renderAgentPicker(masterAgentPicker, masterAgentSelect, {
    filter: () => true,
    isDisabled: (agent) => !["idle", "heartbeat_only"].includes(String(agent.status || "").toLowerCase())
  });
  renderAgentPicker(groupAgentAPicker, groupAgentASelect, {
    filter: () => true,
    isDisabled: (agent) => !["idle", "heartbeat_only"].includes(String(agent.status || "").toLowerCase())
  });
  renderAgentPicker(groupAgentBPicker, groupAgentBSelect, {
    filter: (agent) => String(agent.id || "") !== String(groupAgentASelect?.value || ""),
    isDisabled: (agent) => !["idle", "heartbeat_only"].includes(String(agent.status || "").toLowerCase())
  });
  renderAgentPicker(groupMasterAgentPicker, groupMasterAgentSelect, {
    allowEmpty: true,
    emptyLabel: "不指定主控",
    emptyDesc: "讨论结束后不自动整合",
    filter: () => true,
    isDisabled: () => false
  });
}

function renderTaskStats() {
  const top = tasks.filter((t) => !t.parentTaskId);
  const visible = getFilteredMilestones();
  const html = [
    `<span class="stat-pill">大任务 ${top.length}</span>`,
    `<span class="stat-pill">当前显示 ${visible.length}</span>`,
    `<span class="stat-pill">子任务 ${tasks.filter((t) => t.parentTaskId).length}</span>`,
    `<span class="stat-pill">进行中 ${tasks.filter((t) => t.status === "in_progress").length}</span>`,
    `<span class="stat-pill">已完成 ${tasks.filter((t) => t.status === "done").length}</span>`
  ];
  taskStats.innerHTML = html.join("");
}

function renderTaskProjectFilterOptions() {
  if (!taskProjectFilter) return;
  const current = String(taskProjectFilter.value || taskFilter.projectId || "all");
  const opts = ['<option value="all">全部项目</option>']
    .concat(
      (projects || [])
        .slice()
        .sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh-CN"))
        .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title || p.id)}</option>`)
    )
    .join("");
  taskProjectFilter.innerHTML = opts;
  const shouldSet = (projects || []).some((p) => p.id === current) || current === "all" ? current : "all";
  taskProjectFilter.value = shouldSet;
}

function getFilteredMilestones() {
  syncTaskFilterFromUI();
  const q = taskFilter.q;
  const status = taskFilter.status;
  const projectId = taskFilter.projectId;
  const sort = taskFilter.sort;
  const list = milestones
    .filter((m) => (status === "all" ? true : String(m.status) === status))
    .filter((m) => (projectId === "all" ? true : String(m.projectId) === projectId))
    .filter((m) => {
      if (!q) return true;
      const hay = normalizeForSearch([m.title, m.id, m.projectTitle, agentName(m.owner)].join(" "));
      return hay.includes(q);
    })
    .slice();

  list.sort((a, b) => {
    const pa = Number(a.childrenTotal || 0) > 0 ? Number(a.childrenDone || 0) / Number(a.childrenTotal || 1) : 0;
    const pb = Number(b.childrenTotal || 0) > 0 ? Number(b.childrenDone || 0) / Number(b.childrenTotal || 1) : 0;
    if (sort === "progress_desc") return pb - pa;
    if (sort === "progress_asc") return pa - pb;
    if (sort === "title_asc") return String(a.title || "").localeCompare(String(b.title || ""), "zh-CN");
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
  return list;
}

function renderTaskBoard() {
  const list = getFilteredMilestones();
  const cards = list
    .map((m) => {
      const done = Number(m.childrenDone || 0);
      const total = Number(m.childrenTotal || 0);
      const percent = total > 0 ? Math.round((done / total) * 100) : 0;
      const blocked = Number(m.childrenBlocked || 0);
      const inProgress = Number(m.childrenInProgress || 0);
      const statusLabel = STATUS_LABEL[m.status] || m.status;
      return `
        <article class="milestone-card" data-milestone-open="${m.id}">
          <div class="milestone-head">
            <strong>${escapeHtml(m.title)}</strong>
            <span>${statusLabel}</span>
          </div>
          <div class="milestone-meta">
            <span>${escapeHtml(m.projectTitle || m.projectId || "未分组")}</span>
            <span>${escapeHtml(agentName(m.owner))}</span>
            <span>${fmtDate(m.updatedAt)}</span>
          </div>
          <div class="milestone-tags">
            <span class="tag">进度 ${percent}%</span>
            <span class="tag">${done}/${total}</span>
            <span class="tag">进行中 ${inProgress}</span>
            <span class="tag ${blocked > 0 ? "danger" : ""}">阻塞 ${blocked}</span>
          </div>
          <div class="milestone-progress-text">进度 ${done}/${total} (${percent}%)</div>
          <div class="milestone-progress"><span style="width:${percent}%"></span></div>
        </article>
      `;
    })
    .join("");
  const empty =
    '<div class="task-empty">未命中筛选结果，调整关键词/项目/状态后再试。</div>';
  taskBoard.innerHTML = `<div class="milestone-list">${cards || empty}</div>`;
}

function groupStatusLabel(status) {
  const s = String(status || "");
  if (s === "running") return "运行中";
  if (s === "paused") return "已暂停";
  if (s === "done") return "已完成";
  if (s === "timeout") return "超时结束";
  if (s === "aborted") return "已中止";
  return "草稿";
}

function renderGroupSessions() {
  const cards = (groupSessions || [])
    .map(
      (s) => `
      <article class="milestone-card" data-group-open="${s.id}">
        <div class="milestone-head">
          <strong>${escapeHtml(s.title)}</strong>
          <span>${escapeHtml(groupStatusLabel(s.status))}</span>
        </div>
        <div class="milestone-meta">
          <span>${escapeHtml(agentName(s.agentA))} ↔ ${escapeHtml(agentName(s.agentB))}</span>
          <span>轮次 ${Number(s.round || 1)}/${Number(s.maxRounds || 6)}</span>
          <span>${fmtDate(s.updatedAt)}</span>
        </div>
        <div class="milestone-tags">
          <span class="tag">当前发言 ${escapeHtml(agentName(s.turnAgentId))}</span>
          <span class="tag">自动运行 ${s.autoRun ? "on" : "off"}</span>
        </div>
      </article>
    `
    )
    .join("");
  groupSessionList.innerHTML = cards || '<div class="task-empty">暂无讨论会话，先创建一个。</div>';
}

function renderGroupMessages(messages) {
  if (!messages || messages.length === 0) {
    groupMessages.innerHTML = '<div class="msg system">暂无消息</div>';
    return;
  }
  groupMessages.innerHTML = messages
    .map((m) => {
      const cls = m.role === "agent" ? "assistant" : "system";
      const prefix = m.role === "agent" ? `[${agentName(m.agentId)}] ` : "[系统] ";
      return `<div class="msg ${cls}">${escapeHtml(prefix + (m.text || ""))}</div>`;
    })
    .join("");
  groupMessages.scrollTop = groupMessages.scrollHeight;
}

function renderGroupDetail(session) {
  currentGroupDetail = session;
  currentGroupSessionId = session.id;
  groupDetailPanel.style.display = "block";
  const status = String(session.status || "");
  const isRunning = status === "running";
  groupDetailTitle.textContent = session.title;
  groupDetailMeta.textContent = `${session.id} · ${groupStatusLabel(session.status)} · ${agentName(session.agentA)} ↔ ${agentName(
    session.agentB
  )} · 当前轮到 ${agentName(session.turnAgentId)} · 主控整合 ${agentName(session.masterAgentId)}`;
  const resolvedSummary = session.reportSummary || session.reportDecision || session.summary || session.goal;
  groupDetailSummary.textContent = resolvedSummary ? `讨论结论：${resolvedSummary}` : "讨论结论：(暂无)";
  if (groupDetailReport) {
    const report = session.reportRaw || null;
    const parts = [
      `<div class="detail-title">讨论报告</div>`,
      `<div class="task-meta">整合状态：${escapeHtml(session.reportStatus || "idle")}</div>`,
      `<div class="task-meta">落地建议：${escapeHtml(session.reportDecision || "(暂无)")}</div>`
    ];
    if (Number.isFinite(Number(report?.score))) parts.push(`<div class="task-meta">评分：${Number(report.score)}</div>`);
    if (report?.consensus?.length) parts.push(`<div class="task-meta">共识：${escapeHtml(report.consensus.join("；"))}</div>`);
    if (report?.risks?.length) parts.push(`<div class="task-meta">风险：${escapeHtml(report.risks.join("；"))}</div>`);
    if (report?.action_items?.length) parts.push(`<div class="task-meta">行动项：${escapeHtml(report.action_items.join("；"))}</div>`);
    if (session.reportArtifact) parts.push(`<div class="task-meta">产物：${escapeHtml(session.reportArtifact)}</div>`);
    groupDetailReport.innerHTML = parts.join("");
  }
  renderGroupMessages(session.messages || []);

  if (groupTickBtn) {
    groupTickBtn.disabled = !isRunning;
    groupTickBtn.textContent = isRunning ? "推进一轮" : status === "done" ? "已完成（不可推进）" : status === "paused" ? "请先开始" : "不可推进";
  }
  if (groupStartBtn) {
    groupStartBtn.disabled = isRunning;
    groupStartBtn.textContent = status === "paused" ? "继续" : status === "done" || status === "timeout" || status === "aborted" ? "继续讨论" : "开始";
  }
  if (groupPauseBtn) {
    groupPauseBtn.disabled = !isRunning;
  }
}

async function refreshGroupSessions() {
  const data = await requestJson("/api/group-sessions");
  groupSessions = data.sessions || [];
  renderGroupSessions();
  if (currentGroupSessionId) {
    const hit = groupSessions.find((x) => x.id === currentGroupSessionId);
    if (!hit) {
      currentGroupSessionId = null;
      currentGroupDetail = null;
      groupDetailPanel.style.display = "none";
      return;
    }
    try {
      const detail = await requestJson(`/api/group-sessions/${currentGroupSessionId}`);
      renderGroupDetail(detail.session);
    } catch {
      currentGroupSessionId = null;
      currentGroupDetail = null;
      groupDetailPanel.style.display = "none";
    }
  }
}

async function createGroupSession(e) {
  e.preventDefault();
  const body = {
    title: groupTitleInput.value.trim(),
    goal: groupGoalInput.value.trim(),
    agentA: groupAgentASelect.value,
    agentB: groupAgentBSelect.value,
    masterAgentId: groupMasterAgentSelect?.value || "",
    maxRounds: Number(groupMaxRoundsInput.value || 6),
    autoRun: Boolean(groupAutoRunInput.checked),
    mode: "sessions_send"
  };
  const data = await requestJson("/api/group-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  groupGoalInput.value = "";
  currentGroupSessionId = data.session?.id || null;
  await refreshAll();
  if (currentGroupSessionId) {
    const detail = await requestJson(`/api/group-sessions/${currentGroupSessionId}`);
    renderGroupDetail(detail.session);
  }
}

function buildGroupMarkdownForDownload(session) {
  const report = session?.reportRaw || {};
  const lines = [
    `# ${session?.title || "双人讨论"}`,
    "",
    `- session_id: ${session?.id || ""}`,
    `- status: ${session?.status || ""}`,
    `- stop_reason: ${session?.stopReason || ""}`,
    `- agent_a: ${agentName(session?.agentA)} (${session?.agentA || ""})`,
    `- agent_b: ${agentName(session?.agentB)} (${session?.agentB || ""})`,
    `- master_agent: ${agentName(session?.masterAgentId)}${session?.masterAgentId ? ` (${session.masterAgentId})` : ""}`,
    `- created_at: ${session?.createdAt || ""}`,
    `- updated_at: ${session?.updatedAt || ""}`,
    "",
    "## Goal",
    "",
    session?.goal || "(none)",
    "",
    "## Summary",
    "",
    session?.reportSummary || session?.reportDecision || session?.summary || "(none)",
    "",
    "## Decision",
    "",
    session?.reportDecision || "(none)",
    "",
    "## Consensus",
    ""
  ];
  const consensus = Array.isArray(report.consensus) ? report.consensus : [];
  lines.push(...(consensus.length ? consensus.map((x) => `- ${x}`) : ["- (none)"]));
  lines.push("", "## Risks", "");
  const risks = Array.isArray(report.risks) ? report.risks : [];
  lines.push(...(risks.length ? risks.map((x) => `- ${x}`) : ["- (none)"]));
  lines.push("", "## Action Items", "");
  const actions = Array.isArray(report.action_items) ? report.action_items : [];
  lines.push(...(actions.length ? actions.map((x) => `- ${x}`) : ["- (none)"]));
  lines.push("", "## Transcript", "");
  for (const m of session?.messages || []) {
    const who = m.role === "agent" ? `${agentName(m.agentId)} (${m.agentId || ""})` : "system";
    lines.push(`### ${who}`);
    lines.push("");
    lines.push(String(m.text || "").trim() || "(empty)");
    lines.push("");
  }
  return lines.join("\n");
}

async function exportGroupSessionMarkdown() {
  const session = currentGroupDetail;
  if (!session) return;
  const base = String(groupExportFileName?.value || session.title || session.id || "discussion")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "discussion";
  const fileName = `${base}.md`;
  const markdown = buildGroupMarkdownForDownload(session);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function groupSessionAction(action) {
  if (!currentGroupSessionId) return;
  const map = {
    start: `/api/group-sessions/${currentGroupSessionId}/start`,
    pause: `/api/group-sessions/${currentGroupSessionId}/pause`,
    tick: `/api/group-sessions/${currentGroupSessionId}/tick`,
    abort: `/api/group-sessions/${currentGroupSessionId}/abort`,
    delete: `/api/group-sessions/${currentGroupSessionId}`
  };
  const url = map[action];
  if (!url) return;
  if (action === "delete") {
    await requestJson(url, { method: "DELETE" });
    currentGroupSessionId = null;
    currentGroupDetail = null;
    groupDetailPanel.style.display = "none";
    await refreshGroupSessions();
    return;
  }
  const isClosed = ["done", "timeout", "aborted"].includes(String(currentGroupDetail?.status || ""));
  const payload =
    action === "start"
      ? {
          autoRun: Boolean(groupAutoRunInput.checked),
          continueFromClosed: isClosed,
          continueTargetRounds: Number(groupMaxRoundsInput?.value || 6)
        }
      : {};
  await requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  await refreshAll();
}

function setTaskActionVisibility(task) {
  const show = (el, ok) => {
    el.style.display = ok ? "inline-block" : "none";
  };
  show(taskBtnClaim, task.status === "todo" || task.status === "blocked");
  show(taskBtnStart, task.status === "claimed");
  show(taskBtnReview, task.status === "in_progress");
  show(
    taskBtnIntegrated,
    task.level === 1 && ["todo", "claimed", "in_progress", "review", "integrated", "blocked"].includes(task.status)
  );
  show(taskBtnDone, task.level === 1 ? false : task.status === "review");
  show(taskBtnBlock, ["claimed", "in_progress", "review", "integrated", "accepted"].includes(task.status));
  show(taskBtnRelease, ["claimed", "in_progress", "review", "blocked"].includes(task.status) && task.level !== 1);
  show(taskBtnDispatch, ["claimed", "in_progress"].includes(task.status));
  show(taskBtnDelete, Boolean(task && task.id));
}

async function openMilestonePage(milestoneId) {
  const data = await requestJson(`/api/milestones/${milestoneId}`);
  milestoneDetail = data;
  currentMilestoneId = milestoneId;
  currentTaskId = milestoneId;

  const m = data.milestone;
  taskDetailTitle.textContent = m.title;
  taskDetailMeta.textContent = `${m.id} · 状态 ${STATUS_LABEL[m.status] || m.status} · 负责人 ${agentName(m.owner)}`;
  taskDetailProgress.innerHTML = `
    <div class="milestone-progress-text">总体进度 ${data.progress.done}/${data.progress.total} (${data.progress.percent}%)</div>
    <div class="milestone-progress"><span style="width:${data.progress.percent}%"></span></div>
  `;
  taskDetailDesc.textContent = m.description || "(无描述)";
  taskDetailSummary.textContent = m.summary ? `里程碑结论：${m.summary}` : "暂无里程碑结论";

  taskDetailChecklist.innerHTML =
    '<div class="detail-title">里程碑整合</div><div class="task-meta">子任务全部完成后，点击“主虾整合产出”，由主控Agent汇总最终结果并回写里程碑。</div>';

  taskDetailChildren.innerHTML = `<div class="detail-title">子任务 (${data.progress.done}/${data.progress.total})</div>${
    data.children
      .map(
        (c) => `
      <div class="child-row" data-task-select="${c.id}">
        <div>
          <strong>${escapeHtml(c.title)}</strong>
          <div class="task-meta">L${Number(c.execLevel || 1)} · ${STATUS_LABEL[c.status] || c.status} · 负责人 ${escapeHtml(agentName(c.owner))}</div>
          <div class="task-meta">结果：${escapeHtml(c.summary || "(暂无)")}</div>
        </div>
        <button class="mini-btn" data-task-select-btn="${c.id}">处理</button>
      </div>
    `
      )
      .join("") || "<div class='child-row'>暂无子任务</div>"
  }`;

  taskDetailContext.innerHTML = `<div class="detail-title">可复用上下文（上游结果）</div>${
    (data.carryContext || []).length
      ? data.carryContext
          .map(
            (x) =>
              `<div class="child-row"><div>${escapeHtml(x.title)}：${escapeHtml(x.summary || "")}</div><span>${escapeHtml(
                x.artifactPath || x.artifact || ""
              )}${x.artifact && x.artifactPath && x.artifactExists === false ? " (未找到)" : ""}</span></div>`
          )
          .join("")
      : "<div class='child-row'>暂无可复用结果</div>"
  }`;

  taskDetailEvents.innerHTML = `<div class="detail-title">流程事件</div>${
    (data.events || []).length
      ? data.events
          .map((e) => `<div class="child-row"><div>${escapeHtml(e.type)}</div><span>${fmtDate(e.ts)}</span></div>`)
          .join("")
      : "<div class='child-row'>暂无事件</div>"
  }`;

  setTaskActionVisibility(m);
  taskDetailPage.style.display = "block";
  taskDetailPage.scrollIntoView({ behavior: "smooth", block: "start" });
}

function selectTaskForAction(taskId) {
  const task = getTaskById(taskId);
  if (!task) return;
  currentTaskId = taskId;
  taskDetailMeta.textContent = `${task.id} · 状态 ${STATUS_LABEL[task.status] || task.status} · 负责人 ${agentName(task.owner)} · （当前操作对象）`;
  taskDetailSummary.textContent = task.summary ? `任务结论：${task.summary}` : "暂无任务结论";
  if (task.owner) taskDetailAgentSelect.value = task.owner;
  setTaskActionVisibility(task);
}

async function claimTask(taskId, agentId, force = false) {
  await requestJson(`/api/tasks/${taskId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, force })
  });
  await refreshAll();
  if (currentMilestoneId) await openMilestonePage(currentMilestoneId);
}

async function releaseTask(taskId, agentId, force = false) {
  await requestJson(`/api/tasks/${taskId}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, force })
  });
  await refreshAll();
  if (currentMilestoneId) await openMilestonePage(currentMilestoneId);
}

async function updateTaskStatus(taskId, status) {
  const task = getTaskById(taskId);
  const summary = status === "done" ? prompt("完成结论（会被后续子任务复用）", task?.summary || "") : "";
  await requestJson(`/api/tasks/${taskId}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, summary: summary || "", rewardScore: status === "done" ? task?.score : undefined, syncTaskMd: true })
  });
  await refreshAll();
  if (currentMilestoneId) await openMilestonePage(currentMilestoneId);
}

async function integrateMilestone(milestoneId) {
  const masterAgentId = (taskDetailAgentSelect.value || masterAgentSelect.value || "").trim();
  if (!masterAgentId) throw new Error("请先选择主虾");
  const mode = taskDispatchModeSelect?.value === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
  await requestJson(`/api/milestones/${milestoneId}/integrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ masterAgentId, mode })
  });
  await refreshAll();
  if (currentMilestoneId) await openMilestonePage(currentMilestoneId);
}

async function dispatchTask(taskId) {
  const task = getTaskById(taskId);
  const agentId = task?.owner || autoClaimAgentSelect.value;
  if (!agentId) throw new Error("请先选择或认领负责人");
  const mode = taskDispatchModeSelect?.value === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
  await requestJson(`/api/tasks/${taskId}/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, mode })
  });
  await refreshAll();
  if (currentMilestoneId) await openMilestonePage(currentMilestoneId);
}

async function heartbeatTick() {
  const agentId = (taskDetailAgentSelect.value || autoClaimAgentSelect.value || "").trim();
  if (!agentId) throw new Error("请先选择执行心跳的 Agent");
  const mode = taskDispatchModeSelect?.value === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
  const payload = { agentId, mode };
  if (currentMilestoneId) payload.milestoneId = currentMilestoneId;
  await requestJson("/api/tasks/heartbeat/tick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  await refreshAll();
  if (currentMilestoneId) await openMilestonePage(currentMilestoneId);
}

async function deleteTask(taskId) {
  await requestJson(`/api/tasks/${taskId}`, { method: "DELETE" });
  await refreshAll();
  if (currentMilestoneId === taskId) {
    showTaskDashboard();
    return;
  }
  if (currentMilestoneId) await openMilestonePage(currentMilestoneId);
}

function setActiveTab(tab) {
  const docs = tab === "docs";
  tabDocs.classList.toggle("active", docs);
  tabChat.classList.toggle("active", !docs);
  docsPanel.style.display = docs ? "block" : "none";
  chatPanel.style.display = docs ? "none" : "grid";
}

function setEditMode(value) {
  isEditMode = value;
  markdownBody.style.display = isEditMode ? "none" : "block";
  markdownEditor.style.display = isEditMode ? "block" : "none";
  editBtn.style.display = isEditMode ? "none" : "inline-block";
  saveBtn.style.display = isEditMode ? "inline-block" : "none";
  cancelEditBtn.style.display = isEditMode ? "inline-block" : "none";
  if (isEditMode) markdownEditor.focus();
}

function renderChatMessages(messages) {
  if (!messages || messages.length === 0) {
    chatMessages.innerHTML = '<div class="msg system">还没有聊天记录，先发一句试试。</div>';
    return;
  }
  chatMessages.innerHTML = messages.map((m) => `<div class="msg ${m.role}">${escapeHtml(m.text || "")}</div>`).join("");
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function ensureChatModeSelector() {
  let select = document.getElementById("chatModeSelect");
  if (select) return select;
  select = document.createElement("select");
  select.id = "chatModeSelect";
  select.className = "ghost-btn";
  select.innerHTML = `
    <option value="sessions_send">sessions_send</option>
    <option value="sessions_spawn">sessions_spawn</option>
  `;
  select.addEventListener("change", () => {
    currentSendMode = select.value;
  });
  chatAgentMeta.parentElement.appendChild(select);
  return select;
}

async function openFile(agentId, name, selectedItem) {
  const params = new URLSearchParams({ _t: Date.now().toString() });
  const res = await fetch(`/api/agents/${agentId}/files/${encodeURIComponent(name)}?${params}`);
  if (!res.ok) {
    markdownBody.innerHTML = "<p>文件读取失败。</p>";
    return;
  }
  const data = await res.json();
  currentFileName = data.fileName;
  currentRaw = data.raw;
  activeFile.textContent = data.fileName;
  markdownBody.innerHTML = data.html;
  markdownEditor.value = data.raw;
  setEditMode(false);

  for (const el of fileList.querySelectorAll(".file-item")) el.classList.remove("active");
  if (selectedItem) selectedItem.classList.add("active");
}

async function openAgentDialog(agent) {
  docCount.textContent = `${agent.files.length} 个文件`;
  fileList.innerHTML = "";
  markdownBody.innerHTML = "";
  activeFile.textContent = `${agent.name} - 核心文档`;
  setEditMode(false);
  setActiveTab("docs");
  chatAgentName.textContent = `${agent.name}`;
  chatAgentMeta.textContent = `${agent.role} · ${agent.sourceLabel} · ${agent.chatMode}`;
  ensureChatModeSelector().value = currentSendMode;

  if (!dialog.open) dialog.showModal();

  for (const file of agent.files) {
    const item = document.createElement("div");
    item.className = "file-item";
    item.innerHTML = `<div><strong>${escapeHtml(file.name)}</strong></div><div class="line2">${fmtDate(file.modifiedAt)} · ${fmtBytes(file.size)}</div>`;
    item.addEventListener("click", () => openFile(agent.id, file.name, item));
    fileList.appendChild(item);
  }

  if (agent.files.length > 0) {
    const firstItem = fileList.querySelector(".file-item");
    await openFile(agent.id, agent.files[0].name, firstItem);
  } else {
    markdownBody.innerHTML = "<p>该 Agent 暂无 Markdown 文档。</p>";
  }
  await loadChatMessages();
}

async function saveCurrentFile() {
  if (!currentAgent || !currentFileName) return;
  const raw = markdownEditor.value;
  const res = await fetch(`/api/agents/${currentAgent.id}/files/${encodeURIComponent(currentFileName)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw })
  });
  if (!res.ok) return alert("保存失败");
  const data = await res.json();
  currentRaw = raw;
  markdownBody.innerHTML = data.html;
  setEditMode(false);
}

async function loadChatMessages() {
  if (!currentAgent) return;
  try {
    const res = await fetch(`/api/chat/agents/${currentAgent.id}/messages`);
    if (!res.ok) return renderChatMessages([{ role: "system", text: "聊天记录读取失败。" }]);
    const data = await res.json();
    renderChatMessages(data.messages || []);
  } catch (err) {
    renderChatMessages([{ role: "system", text: `聊天记录读取失败: ${err.message}` }]);
  }
}

async function sendChatMessage() {
  if (!currentAgent || chatSending) return;
  const text = chatInput.value.trim();
  if (!text) return;

  chatSending = true;
  chatSendBtn.disabled = true;
  try {
    await requestJson(`/api/chat/agents/${currentAgent.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode: currentSendMode })
    });
    chatInput.value = "";
    await loadChatMessages();
  } catch (err) {
    alert(`发送失败: ${err.message}`);
  } finally {
    chatSending = false;
    chatSendBtn.disabled = false;
  }
}

async function refreshTasks() {
  const data = await requestJson("/api/tasks");
  tasks = data.tasks || [];
  milestones = data.milestones || [];
  projects = data.projects || [];
  renderTaskProjectFilterOptions();
  renderTaskStats();
  renderTaskBoard();
  if (currentMilestoneId) {
    try {
      await openMilestonePage(currentMilestoneId);
    } catch {
      currentMilestoneId = null;
      currentTaskId = null;
      taskDetailPage.style.display = "none";
      history.replaceState(null, "", "#tasks");
    }
  }
}

async function decomposeGoal(e) {
  e.preventDefault();
  try {
    const data = await requestJson("/api/tasks/decompose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: goalInput.value.trim(), masterAgentId: masterAgentSelect.value })
    });
    alert(`拆解完成，新增 ${data.created?.length || 0} 条子任务`);
    goalInput.value = "";
    await refreshTasks();
    if (data.milestone?.id) {
      await openMilestonePage(data.milestone.id);
      history.replaceState(null, "", `#milestone/${data.milestone.id}`);
    }
  } catch (err) {
    alert(`拆解失败: ${err.message}`);
  }
}

async function autoClaimOne() {
  try {
    const mode = taskDispatchModeSelect?.value === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
    const payload = { agentId: autoClaimAgentSelect.value, mode };
    if (currentMilestoneId) payload.milestoneId = currentMilestoneId;
    await requestJson("/api/tasks/heartbeat/tick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    await refreshTasks();
    if (currentMilestoneId) await openMilestonePage(currentMilestoneId);
  } catch (err) {
    alert(`自动认领并执行失败: ${err.message}`);
  }
}

function renderDispatchModeHint() {
  if (!dispatchModeHint) return;
  const mode = dispatchModeSelect?.value === "agent_pull" ? "agent_pull" : "central";
  dispatchModeHint.textContent =
    mode === "central"
      ? "推荐模式。由管理台统一扫描空闲 Agent 并主动派任务，最适合现在这套控制台。"
      : "高级模式。要求每个子 Agent 自己稳定心跳拉任务；如果 Agent 侧配置不完整，任务更容易卡住。";
}

function renderDispatchSettingsMeta(data = dispatchSettings) {
  if (!dispatchSettingsMeta || !data) return;
  const mode = data.dispatchMode === "agent_pull" ? "agent_pull" : "central";
  const interval = Number(data.centralDispatchIntervalMs || 60000);
  const excludes = Array.isArray(data.centralDispatchExclude) ? data.centralDispatchExclude.filter(Boolean) : [];
  const modeText =
    mode === "central"
      ? "中心调度：管理台统一派任务"
      : "子 Agent 拉取：各 Agent 自己抢任务";
  const excludeText = excludes.length ? `排除名单：${excludes.join("、")}` : "排除名单：无";
  dispatchSettingsMeta.textContent = `${modeText} · 扫描间隔 ${interval} ms · ${excludeText}`;
}

async function loadDispatchSettings() {
  const data = await requestJson("/api/settings/dispatch");
  dispatchSettings = data;
  if (dispatchModeSelect) dispatchModeSelect.value = data.dispatchMode || "central";
  if (dispatchIntervalInput) dispatchIntervalInput.value = Number(data.centralDispatchIntervalMs || 60000);
  if (dispatchExcludeInput) {
    dispatchExcludeInput.value = Array.isArray(data.centralDispatchExclude) ? data.centralDispatchExclude.join(",") : "";
  }
  renderDispatchModeHint();
  renderDispatchSettingsMeta(data);
}

async function saveDispatchSettingsToServer() {
  const payload = {
    dispatchMode: dispatchModeSelect?.value === "agent_pull" ? "agent_pull" : "central",
    centralDispatchIntervalMs: Math.max(30000, Number(dispatchIntervalInput?.value) || 60000),
    centralDispatchExclude: String(dispatchExcludeInput?.value || "")
      .split(/[;,]/)
      .map((x) => x.trim())
      .filter(Boolean)
  };
  const data = await requestJson("/api/settings/dispatch", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  dispatchSettings = data;
  renderDispatchModeHint();
  renderDispatchSettingsMeta(data);
}

async function refreshAgents() {
  const data = await requestJson("/api/agents");
  agents = data.agents || [];
  rootInfo.textContent = `当前读取目录: ${(data.roots || [data.root]).join(" | ")}`;
  renderTaskSelectOptions();
  renderAgents();
}

async function refreshAll() {
  await refreshAgents();
  await refreshTasks();
  await refreshGroupSessions();
}

function showTaskDashboard() {
  taskDetailPage.style.display = "none";
  currentMilestoneId = null;
  currentTaskId = null;
  history.replaceState(null, "", "#tasks");
}

function tryOpenByHash() {
  const m = /^#milestone\/(.+)$/.exec(location.hash || "");
  if (!m) return;
  openMilestonePage(m[1]).catch(() => {});
}

async function boot() {
  await loadDispatchSettings();
  await refreshAll();
  tryOpenByHash();
  scheduleLiveRefresh();
}

navTasks.addEventListener("click", () => setView("tasks"));
navGroups?.addEventListener("click", () => setView("groups"));
navAgents.addEventListener("click", () => setView("agents"));
openDispatchSettings?.addEventListener("click", async () => {
  try {
    await loadDispatchSettings();
    dispatchSettingsDialog?.showModal();
  } catch (err) {
    alert(`读取调度设置失败: ${err.message}`);
  }
});
closeDispatchSettings?.addEventListener("click", () => dispatchSettingsDialog?.close());
saveDispatchSettings?.addEventListener("click", async () => {
  try {
    await saveDispatchSettingsToServer();
  } catch (err) {
    alert(`保存调度设置失败: ${err.message}`);
  }
});
dispatchModeSelect?.addEventListener("change", renderDispatchModeHint);

closeDialog.addEventListener("click", closeAgentDialog);
closeDialogTop.addEventListener("click", closeAgentDialog);

tabDocs.addEventListener("click", () => setActiveTab("docs"));
tabChat.addEventListener("click", () => setActiveTab("chat"));
editBtn.addEventListener("click", () => {
  markdownEditor.value = currentRaw;
  setEditMode(true);
});
cancelEditBtn.addEventListener("click", () => {
  markdownEditor.value = currentRaw;
  setEditMode(false);
});
saveBtn.addEventListener("click", saveCurrentFile);
chatSendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendChatMessage();
  }
});
dialog.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeAgentDialog();
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) closeAgentDialog();
});

taskDecomposeForm.addEventListener("submit", decomposeGoal);
refreshTasksBtn.addEventListener("click", refreshTasks);
autoClaimBtn.addEventListener("click", autoClaimOne);
heartbeatTickBtn.addEventListener("click", async () => {
  try {
    await heartbeatTick();
  } catch (err) {
    alert(`心跳执行失败: ${err.message}`);
  }
});
taskSearchInput?.addEventListener("input", () => {
  renderTaskStats();
  renderTaskBoard();
});
taskProjectFilter?.addEventListener("change", () => {
  renderTaskStats();
  renderTaskBoard();
});
taskStatusFilter?.addEventListener("change", () => {
  renderTaskStats();
  renderTaskBoard();
});
taskSortSelect?.addEventListener("change", () => {
  renderTaskStats();
  renderTaskBoard();
});
taskFilterResetBtn?.addEventListener("click", () => {
  resetTaskFilters();
  renderTaskProjectFilterOptions();
  renderTaskStats();
  renderTaskBoard();
});

taskBoard.addEventListener("click", (e) => {
  const card = e.target.closest("[data-milestone-open]");
  if (!card) return;
  const milestoneId = card.getAttribute("data-milestone-open");
  openMilestonePage(milestoneId)
    .then(() => history.replaceState(null, "", `#milestone/${milestoneId}`))
    .catch((err) => alert(`打开详情失败: ${err.message}`));
});

taskDetailBack.addEventListener("click", showTaskDashboard);

taskDetailChildren.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-task-select-btn]");
  if (!btn) return;
  const taskId = btn.getAttribute("data-task-select-btn");
  selectTaskForAction(taskId);
});

taskBtnClaim.addEventListener("click", async () => {
  if (!currentTaskId) return;
  const picked = taskDetailAgentSelect.value || autoClaimAgentSelect.value;
  try {
    await claimTask(currentTaskId, picked, false);
  } catch (err) {
    alert(`认领失败: ${err.message}`);
  }
});

taskBtnStart.addEventListener("click", async () => {
  if (!currentTaskId) return;
  try {
    await updateTaskStatus(currentTaskId, "in_progress");
  } catch (err) {
    alert(`开始失败: ${err.message}`);
  }
});

taskBtnReview.addEventListener("click", async () => {
  if (!currentTaskId) return;
  try {
    await updateTaskStatus(currentTaskId, "review");
  } catch (err) {
    alert(`提审失败: ${err.message}`);
  }
});

taskBtnIntegrated.addEventListener("click", async () => {
  if (!currentTaskId) return;
  try {
    const task = getTaskById(currentTaskId);
    if (!task || task.level !== 1) {
      await updateTaskStatus(currentTaskId, "integrated");
      return;
    }
    await integrateMilestone(currentTaskId);
  } catch (err) {
    alert(`主虾整合失败: ${err.message}`);
  }
});

taskBtnDone.addEventListener("click", async () => {
  if (!currentTaskId) return;
  try {
    await updateTaskStatus(currentTaskId, "done");
  } catch (err) {
    alert(`完成失败: ${err.message}`);
  }
});

taskBtnBlock.addEventListener("click", async () => {
  if (!currentTaskId) return;
  try {
    await updateTaskStatus(currentTaskId, "blocked");
  } catch (err) {
    alert(`阻塞失败: ${err.message}`);
  }
});

taskBtnRelease.addEventListener("click", async () => {
  if (!currentTaskId) return;
  const picked = taskDetailAgentSelect.value || autoClaimAgentSelect.value;
  try {
    await releaseTask(currentTaskId, picked, false);
  } catch (err) {
    alert(`释放失败: ${err.message}`);
  }
});

taskBtnDispatch.addEventListener("click", async () => {
  if (!currentTaskId) return;
  try {
    await dispatchTask(currentTaskId);
  } catch (err) {
    alert(`派发失败: ${err.message}`);
  }
});

taskBtnDelete.addEventListener("click", async () => {
  if (!currentTaskId) return;
  const task = getTaskById(currentTaskId);
  if (!task) return;
  const tip =
    task.level === 1
      ? "确认删除该大任务？会级联删除所有子任务和流程事件。"
      : "确认删除该子任务？";
  if (!confirm(tip)) return;
  try {
    await deleteTask(currentTaskId);
  } catch (err) {
    alert(`删除失败: ${err.message}`);
  }
});

groupCreateForm?.addEventListener("submit", async (e) => {
  try {
    await createGroupSession(e);
  } catch (err) {
    alert(`创建讨论失败: ${err.message}`);
  }
});
refreshGroupsBtn?.addEventListener("click", () => refreshGroupSessions().catch((err) => alert(`刷新讨论失败: ${err.message}`)));
groupSessionList?.addEventListener("click", async (e) => {
  const card = e.target.closest("[data-group-open]");
  if (!card) return;
  const id = card.getAttribute("data-group-open");
  try {
    const data = await requestJson(`/api/group-sessions/${id}`);
    renderGroupDetail(data.session);
  } catch (err) {
    alert(`读取讨论详情失败: ${err.message}`);
  }
});
groupStartBtn?.addEventListener("click", () => groupSessionAction("start").catch((err) => alert(`开始失败: ${err.message}`)));
groupPauseBtn?.addEventListener("click", () => groupSessionAction("pause").catch((err) => alert(`暂停失败: ${err.message}`)));
groupTickBtn?.addEventListener("click", () => groupSessionAction("tick").catch((err) => alert(`推进失败: ${err.message}`)));
groupAbortBtn?.addEventListener("click", () => groupSessionAction("abort").catch((err) => alert(`中止失败: ${err.message}`)));
groupDeleteBtn?.addEventListener("click", async () => {
  if (!currentGroupDetail) return;
  if (!confirm(`确认删除讨论会话「${currentGroupDetail.title}」？此操作不可恢复。`)) return;
  try {
    await groupSessionAction("delete");
  } catch (err) {
    alert(`删除失败: ${err.message}`);
  }
});
groupExportBtn?.addEventListener("click", () => exportGroupSessionMarkdown().catch((err) => alert(`导出失败: ${err.message}`)));

window.addEventListener("hashchange", tryOpenByHash);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleLiveRefresh(true);
});

boot().catch((err) => {
  rootInfo.textContent = `初始化失败: ${err.message}`;
});









