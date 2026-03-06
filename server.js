const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { marked } = require("marked");

const app = express();
const port = Number(process.env.PORT || 3000);
const defaultRoot = path.join(__dirname, "data", "agents");

const openclawConfigPath =
  process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
const openclawCmdPath =
  process.env.OPENCLAW_CMD_PATH || path.join(os.homedir(), "AppData", "Roaming", "npm", "openclaw.cmd");
const openclawMjsPath =
  process.env.OPENCLAW_MJS_PATH ||
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "openclaw", "openclaw.mjs");

const bridgeTimeoutMs = Number(process.env.CHAT_BRIDGE_TIMEOUT_MS || 180000);
const agentTimeoutMs = Number(process.env.CHAT_AGENT_TIMEOUT_MS || 180000);
const taskClaimTtlMs = Math.max(60000, Number(process.env.TASK_CLAIM_TTL_MS || 15 * 60 * 1000));
const externalActivityWindowMs = Math.max(60000, Number(process.env.OPENCLAW_EXTERNAL_ACTIVITY_WINDOW_MS || 5 * 60 * 1000));
let dispatchMode = String(process.env.DISPATCH_MODE || "central").trim().toLowerCase();
let centralDispatchIntervalMs = Math.max(30000, Number(process.env.CENTRAL_DISPATCH_INTERVAL_MS || 60 * 1000));
let centralDispatchExclude = new Set(
  String(process.env.CENTRAL_DISPATCH_EXCLUDE || "s2__workspace")
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean)
);
const bridgeContainer = process.env.BRIDGE_CONTAINER || "openclaw-single";
const artifactContainerRoots = (process.env.ARTIFACT_CONTAINER_ROOTS || "/data/openclaw/workspace,/data/.openclaw/workspace,/workspace")
  .split(/[;,]/)
  .map((x) => x.trim())
  .filter(Boolean);

function resolveRoots() {
  const fromRoots = (process.env.CLAW_AGENTS_ROOTS || "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromRoots.length > 0) return fromRoots;
  return [process.env.CLAW_AGENTS_ROOT || defaultRoot];
}

const roots = resolveRoots();
const sources = roots.map((root, index) => ({
  key: `s${index + 1}`,
  root,
  label: path.basename(root) || root
}));

const chatStore = new Map();
const inflightAgents = new Set();
const dataDir = path.join(__dirname, "data");
const taskCenterPath = path.join(dataDir, "task-center.json");
const legacyTaskStorePath = path.join(dataDir, "tasks.json");
const taskBackupDir = path.join(dataDir, "task-center-backups");
const heartbeatJobsPath = path.join(dataDir, "heartbeat-jobs.json");
const dispatchSettingsPath = path.join(dataDir, "dispatch-settings.json");
const groupSessionsPath = path.join(dataDir, "group-sessions.json");
const groupExportsDir = path.join(dataDir, "discussion-exports");

const TASK_STATUS = Object.freeze({
  TODO: "todo",
  READY: "ready",
  EXECUTING: "executing",
  DONE: "done",
  BLOCKED: "blocked",
  INTEGRATED: "integrated"
});

const LEGACY_TASK_STATUS = Object.freeze({
  CLAIMED: "claimed",
  IN_PROGRESS: "in_progress",
  REVIEW: "review",
  ACCEPTED: "accepted"
});

const TASK_PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const TASK_RELEASE_STATE = Object.freeze({
  STAGED: "staged",
  PUBLISHED: "published"
});
let taskStoreWriteChain = Promise.resolve();
let groupStoreWriteChain = Promise.resolve();
const inflightHeartbeatAgents = new Set();
const inflightMilestoneIntegrations = new Set();
const inflightGroupSessions = new Set();
let heartbeatSchedulerStarted = false;
let centralDispatchSchedulerStarted = false;
let groupChatSchedulerStarted = false;
let nextCentralDispatchAt = 0;
const runtimeState = {
  lastDispatchError: "",
  lastDispatchErrorAt: null,
  lastDispatchSource: "",
  lastDispatchTarget: "",
  lastDispatchOkAt: null
};

marked.setOptions({ breaks: true, gfm: true });
app.use(express.static(path.join(__dirname, "web")));
app.use(express.json({ limit: "2mb" }));
ensureDataFiles();
{
  const s = readDispatchSettings();
  dispatchMode = s.dispatchMode === "agent_pull" ? "agent_pull" : "central";
  centralDispatchIntervalMs = s.centralDispatchIntervalMs;
  centralDispatchExclude = new Set(s.centralDispatchExclude || []);
}

function nowIso() {
  return new Date().toISOString();
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    error: {
      code: status,
      message: String(message || "Unknown error"),
      ...extra
    }
  });
}

function sendOk(res, payload = {}) {
  return res.json({ ok: true, ...payload });
}

function markRuntimeDispatchError(source, target, err) {
  runtimeState.lastDispatchError = err instanceof Error ? err.message : String(err || "");
  runtimeState.lastDispatchErrorAt = nowIso();
  runtimeState.lastDispatchSource = String(source || "");
  runtimeState.lastDispatchTarget = String(target || "");
}

function markRuntimeDispatchOk(source, target) {
  runtimeState.lastDispatchOkAt = nowIso();
  runtimeState.lastDispatchSource = String(source || "");
  runtimeState.lastDispatchTarget = String(target || "");
  runtimeState.lastDispatchError = "";
  runtimeState.lastDispatchErrorAt = null;
}

function normalizeFsPath(p) {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

function toPosixPath(p) {
  return String(p || "").replace(/\\/g, "/");
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

function readTailLines(filePath, limit = 120) {
  const text = safeReadFile(filePath);
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(2000, Number(limit) || 120)));
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(safeReadFile(filePath));
  } catch {
    return null;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function ensureDataFiles() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(taskBackupDir, { recursive: true });
  fs.mkdirSync(groupExportsDir, { recursive: true });
  if (!fs.existsSync(taskCenterPath)) {
    const legacy = safeReadJson(legacyTaskStorePath);
    const initial =
      legacy && Array.isArray(legacy.tasks) && Array.isArray(legacy.events)
        ? { schemaVersion: 2, tasks: legacy.tasks, events: legacy.events, migratedFrom: "tasks.json", migratedAt: nowIso() }
        : { schemaVersion: 2, tasks: [], events: [] };
    fs.writeFileSync(taskCenterPath, JSON.stringify(initial, null, 2), "utf8");
  }
  if (!fs.existsSync(heartbeatJobsPath)) {
    fs.writeFileSync(heartbeatJobsPath, JSON.stringify({ schemaVersion: 1, jobs: [] }, null, 2), "utf8");
  }
  if (!fs.existsSync(dispatchSettingsPath)) {
    fs.writeFileSync(
      dispatchSettingsPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          dispatchMode,
          centralDispatchIntervalMs,
          centralDispatchExclude: Array.from(centralDispatchExclude)
        },
        null,
        2
      ),
      "utf8"
    );
  }
  if (!fs.existsSync(groupSessionsPath)) {
    fs.writeFileSync(groupSessionsPath, JSON.stringify({ schemaVersion: 1, sessions: [] }, null, 2), "utf8");
  }
}

function slugifyFileName(text, fallback = "discussion") {
  const base = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || fallback;
}

function buildGroupSessionMarkdown(session) {
  const s = normalizeGroupSession(session);
  const report = s.reportRaw || {};
  const lines = [
    `# ${s.title}`,
    "",
    `- session_id: ${s.id}`,
    `- status: ${s.status}`,
    `- stop_reason: ${s.stopReason || ""}`,
    `- agent_a: ${agentName(s.agentA)} (${s.agentA})`,
    `- agent_b: ${agentName(s.agentB)} (${s.agentB})`,
    `- master_agent: ${agentName(s.masterAgentId)} ${s.masterAgentId ? `(${s.masterAgentId})` : ""}`.trim(),
    `- created_at: ${s.createdAt}`,
    `- updated_at: ${s.updatedAt}`,
    "",
    "## Goal",
    "",
    s.goal || "(none)",
    "",
    "## Discussion Summary",
    "",
    s.reportSummary || s.summary || "(none)",
    "",
    "## Decision",
    "",
    s.reportDecision || "(none)",
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
  lines.push("", "## Discussion Transcript", "");
  for (const m of s.messages || []) {
    const who = m.role === "agent" ? `${agentName(m.agentId)} (${m.agentId})` : "system";
    lines.push(`### ${who}`);
    lines.push("");
    lines.push(String(m.text || "").trim() || "(empty)");
    lines.push("");
  }
  return lines.join("\n");
}

function readTaskStore() {
  ensureDataFiles();
  const raw = safeReadJson(taskCenterPath);
  if (!raw || !Array.isArray(raw.tasks) || !Array.isArray(raw.events)) {
    return { tasks: [], events: [] };
  }
  if (raw.tasks.length === 0) {
    const legacy = safeReadJson(legacyTaskStorePath);
    if (legacy && Array.isArray(legacy.tasks) && legacy.tasks.length > 0 && Array.isArray(legacy.events)) {
      const merged = {
        schemaVersion: 2,
        tasks: legacy.tasks,
        events: legacy.events,
        migratedFrom: "tasks.json",
        migratedAt: nowIso(),
        updatedAt: nowIso()
      };
      const tmpPath = `${taskCenterPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
      fs.renameSync(tmpPath, taskCenterPath);
      return merged;
    }
  }
  return raw;
}

function rotateTaskCenterBackups() {
  const files = safeReadDir(taskBackupDir)
    .filter((x) => x.isFile() && x.name.endsWith(".json"))
    .map((x) => x.name)
    .sort();
  const keep = 20;
  const toDelete = files.slice(0, Math.max(0, files.length - keep));
  for (const name of toDelete) {
    try {
      fs.unlinkSync(path.join(taskBackupDir, name));
    } catch {}
  }
}

function writeTaskStore(store) {
  ensureDataFiles();
  const full = {
    schemaVersion: 2,
    tasks: Array.isArray(store.tasks) ? store.tasks : [],
    events: Array.isArray(store.events) ? store.events : [],
    updatedAt: nowIso()
  };
  const payload = JSON.stringify(full, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(taskBackupDir, `task-center-${stamp}.json`);
  try {
    if (fs.existsSync(taskCenterPath)) {
      fs.copyFileSync(taskCenterPath, backupPath);
      rotateTaskCenterBackups();
    }
  } catch {}
  const tmpPath = `${taskCenterPath}.tmp`;
  fs.writeFileSync(tmpPath, payload, "utf8");
  fs.renameSync(tmpPath, taskCenterPath);
}

function withTaskStoreLock(work) {
  const run = taskStoreWriteChain.then(() => work());
  taskStoreWriteChain = run.catch(() => {});
  return run;
}

function mutateTaskStore(mutator) {
  return withTaskStoreLock(async () => {
    const store = readTaskStore();
    const result = await mutator(store);
    writeTaskStore(store);
    return result;
  });
}

function readGroupStore() {
  ensureDataFiles();
  const raw = safeReadJson(groupSessionsPath);
  if (!raw || !Array.isArray(raw.sessions)) return { schemaVersion: 1, sessions: [] };
  return raw;
}

function writeGroupStore(store) {
  ensureDataFiles();
  const full = {
    schemaVersion: 1,
    sessions: Array.isArray(store.sessions) ? store.sessions : [],
    updatedAt: nowIso()
  };
  const tmpPath = `${groupSessionsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(full, null, 2), "utf8");
  fs.renameSync(tmpPath, groupSessionsPath);
}

function withGroupStoreLock(work) {
  const run = groupStoreWriteChain.then(() => work());
  groupStoreWriteChain = run.catch(() => {});
  return run;
}

function mutateGroupStore(mutator) {
  return withGroupStoreLock(async () => {
    const store = readGroupStore();
    const result = await mutator(store);
    writeGroupStore(store);
    return result;
  });
}

function normalizeGroupSession(raw) {
  const members = Array.isArray(raw?.members) ? raw.members : [];
  const a = String(raw?.agentA || members[0] || "").trim();
  const b = String(raw?.agentB || members[1] || "").trim();
  const maxRounds = Math.max(1, Math.min(20, Number(raw?.maxRounds) || 6));
  const minFinishTurns = Math.max(2, Math.min(8, Number(raw?.minFinishTurns) || 4));
  const maxNoProgressRounds = Math.max(1, Math.min(6, Number(raw?.maxNoProgressRounds) || 2));
  const turnCount = Math.max(0, Number(raw?.turnCount) || 0);
  return {
    id: String(raw?.id || "").trim(),
    title: String(raw?.title || "").trim() || "未命名双人讨论",
    goal: String(raw?.goal || "").trim(),
    masterAgentId: String(raw?.masterAgentId || "").trim(),
    agentA: a,
    agentB: b,
    members: [a, b].filter(Boolean),
    status: String(raw?.status || "draft").trim(),
    turnAgentId: String(raw?.turnAgentId || a || "").trim(),
    turnCount,
    round: Math.max(1, Math.ceil(Math.max(1, turnCount || 1) / 2)),
    maxRounds,
    maxTurns: maxRounds * 2,
    minFinishTurns,
    maxNoProgressRounds,
    noProgressRounds: Math.max(0, Number(raw?.noProgressRounds) || 0),
    autoRun: Boolean(raw?.autoRun),
    mode: String(raw?.mode || "sessions_send") === "sessions_spawn" ? "sessions_spawn" : "sessions_send",
    runStartTurnCount: Math.max(0, Number(raw?.runStartTurnCount) || 0),
    summary: String(raw?.summary || "").trim(),
    resultArtifact: String(raw?.resultArtifact || "").trim(),
    reportStatus: String(raw?.reportStatus || "").trim() || "idle",
    reportSummary: String(raw?.reportSummary || "").trim(),
    reportArtifact: String(raw?.reportArtifact || "").trim(),
    reportDecision: String(raw?.reportDecision || "").trim(),
    reportRaw: raw?.reportRaw && typeof raw.reportRaw === "object" ? raw.reportRaw : null,
    stopReason: String(raw?.stopReason || "").trim(),
    messages: Array.isArray(raw?.messages) ? raw.messages.slice(-120) : [],
    events: Array.isArray(raw?.events) ? raw.events.slice(-200) : [],
    createdAt: String(raw?.createdAt || nowIso()),
    updatedAt: String(raw?.updatedAt || nowIso())
  };
}

function getMissingGroupAgents(session) {
  const s = normalizeGroupSession(session);
  return s.members.filter((id) => !getAgentById(id));
}

async function markGroupSessionUnavailable(sessionId, missingAgents, trigger = "system") {
  return mutateGroupStore(async (store) => {
    const idx = (store.sessions || []).findIndex((x) => String(x.id || "") === String(sessionId || "").trim());
    if (idx < 0) return null;
    const cur = normalizeGroupSession(store.sessions[idx]);
    cur.autoRun = false;
    cur.status = "paused";
    cur.stopReason = `missing_agents:${missingAgents.join(",")}`;
    cur.updatedAt = nowIso();
    appendGroupEvent(cur, "session_unavailable", { trigger, missingAgents });
    store.sessions[idx] = cur;
    syncGroupParticipantBusyStates(cur, null, store);
    return cur;
  });
}

function buildGroupReportPrompt(session) {
  const recent = (session.messages || [])
    .filter((m) => m.role === "agent" || m.role === "system")
    .slice(-16)
    .map((m, i) => `${i + 1}. [${m.role}] ${m.agentId || "system"}: ${String(m.text || "").slice(0, 800)}`);
  return [
    `group_session_id: ${session.id}`,
    `title: ${session.title}`,
    `goal: ${session.goal}`,
    `stop_reason: ${session.stopReason || session.status}`,
    "",
    "你是主控Agent，需要为一场已经结束的双人讨论做收官整合。",
    "不要复述聊天记录，要输出用户可直接阅读的结果。",
    "如果讨论已经形成明确方案，就给出落地建议；如果还不够，明确指出为何不建议直接执行。",
    "",
    "最近讨论记录：",
    ...(recent.length ? recent : ["(无讨论记录)"]),
    "",
    "只返回 JSON：",
    "{",
    '  "status":"ok|needs_followup|blocked",',
    '  "summary":"一句话总结这场讨论得到的核心结果",',
    '  "decision":"建议采纳的落地方案，若不建议执行则写明原因",',
    '  "consensus":["共识1","共识2"],',
    '  "risks":["风险1","风险2"],',
    '  "action_items":["行动1","行动2"],',
    '  "score":0,',
    '  "artifact":"产物路径或空",',
    '  "next_input":"下一步需要的人类输入或空"',
    "}"
  ].join("\n");
}

function normalizeGroupReportReply(parsedReply, fallbackText) {
  const status = ["ok", "needs_followup", "blocked"].includes(String(parsedReply?.status || "").trim().toLowerCase())
    ? String(parsedReply.status).trim().toLowerCase()
    : "ok";
  const summary = String(parsedReply?.summary || "").trim() || String(fallbackText || "").trim().slice(0, 240);
  const decision = String(parsedReply?.decision || "").trim();
  const artifact = String(parsedReply?.artifact || "").trim();
  const nextInput = String(parsedReply?.next_input || parsedReply?.nextInput || "").trim();
  const scoreRaw = Number(parsedReply?.score);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : 0;
  const normList = (value) =>
    Array.isArray(value) ? value.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 8) : [];
  return {
    status,
    summary,
    decision,
    consensus: normList(parsedReply?.consensus),
    risks: normList(parsedReply?.risks),
    action_items: normList(parsedReply?.action_items || parsedReply?.actionItems),
    score,
    artifact,
    next_input: nextInput,
    raw: parsedReply && typeof parsedReply === "object" ? parsedReply : null
  };
}

async function integrateClosedGroupSession(sessionId, trigger = "system") {
  const store = readGroupStore();
  const idx = (store.sessions || []).findIndex((x) => String(x.id || "") === String(sessionId || "").trim());
  if (idx < 0) return null;
  const session = normalizeGroupSession(store.sessions[idx]);
  if (!["done", "timeout", "aborted", "paused"].includes(session.status)) return session;
  if (!session.masterAgentId || session.reportStatus === "done" || session.reportStatus === "running") return session;
  const parsed = parseAgentId(session.masterAgentId);
  if (!parsed) return session;

  await mutateGroupStore(async (latestStore) => {
    const i = (latestStore.sessions || []).findIndex((x) => String(x.id || "") === String(sessionId || "").trim());
    if (i < 0) return;
    const cur = normalizeGroupSession(latestStore.sessions[i]);
    if (cur.reportStatus === "done" || cur.reportStatus === "running") return;
    cur.reportStatus = "running";
    cur.updatedAt = nowIso();
    appendGroupEvent(cur, "report_started", { trigger, masterAgentId: cur.masterAgentId });
    latestStore.sessions[i] = cur;
  });

  try {
    const transport = deriveChatTransport(parsed.source, parsed.dirName);
    const prompt = buildGroupReportPrompt(session);
    const sent = await sendTaskPromptWithFallback(transport, prompt, "sessions_send");
    const parsedReply = extractFirstJsonObject(sent.replyText) || {};
    const normalized = normalizeGroupReportReply(parsedReply, sent.replyText || "");
    return await mutateGroupStore(async (latestStore) => {
      const i = (latestStore.sessions || []).findIndex((x) => String(x.id || "") === String(sessionId || "").trim());
      if (i < 0) return null;
      const cur = normalizeGroupSession(latestStore.sessions[i]);
      cur.reportStatus = "done";
      cur.reportSummary = normalized.summary;
      cur.reportArtifact = normalized.artifact;
      cur.reportDecision = normalized.decision;
      cur.reportRaw = normalized;
      cur.updatedAt = nowIso();
      appendGroupEvent(cur, "report_done", {
        trigger,
        masterAgentId: cur.masterAgentId,
        status: normalized.status,
        artifact: normalized.artifact
      });
      latestStore.sessions[i] = cur;
      return cur;
    });
  } catch (err) {
    return await mutateGroupStore(async (latestStore) => {
      const i = (latestStore.sessions || []).findIndex((x) => String(x.id || "") === String(sessionId || "").trim());
      if (i < 0) return null;
      const cur = normalizeGroupSession(latestStore.sessions[i]);
      cur.reportStatus = "failed";
      cur.updatedAt = nowIso();
      appendGroupEvent(cur, "report_failed", {
        trigger,
        masterAgentId: cur.masterAgentId,
        error: err instanceof Error ? err.message : String(err)
      });
      latestStore.sessions[i] = cur;
      return cur;
    });
  }
}

function appendGroupEvent(session, type, payload = {}) {
  const evt = { id: crypto.randomUUID(), type, payload, ts: nowIso() };
  const next = Array.isArray(session.events) ? session.events.concat([evt]) : [evt];
  session.events = next.slice(-200);
}

function appendGroupMessage(session, role, text, extra = {}) {
  const item = {
    id: crypto.randomUUID(),
    role,
    text: String(text || ""),
    ts: nowIso(),
    ...extra
  };
  const next = Array.isArray(session.messages) ? session.messages.concat([item]) : [item];
  session.messages = next.slice(-120);
}

function countActiveGroupSessions(agentId, store = null, excludeSessionId = "") {
  const s = store || readGroupStore();
  const sessions = (s.sessions || []).map(normalizeGroupSession);
  const exclude = String(excludeSessionId || "").trim();
  return sessions.filter((x) => x.status === "running" && x.members.includes(agentId) && (!exclude || x.id !== exclude)).length;
}

function normalizeTaskRecord(task) {
  const parentTaskId = String((task || {}).parentTaskId || "").trim() || null;
  const levelRaw = Number((task || {}).level);
  const level = Number.isFinite(levelRaw) && levelRaw > 0 ? levelRaw : parentTaskId ? 2 : 1;
  const explicitProjectId = String(task?.projectId || "").trim();
  const explicitProjectTitle = String(task?.projectTitle || "").trim();
  const projectId = explicitProjectId || (level === 1 ? `PRJ-${String(task?.id || "").trim()}` : parentTaskId ? `PRJ-${parentTaskId}` : "PRJ-UNASSIGNED");
  const projectTitle = explicitProjectTitle || (level === 1 ? String(task?.title || "").trim() : "");
  const acceptanceChecklist = Array.isArray(task?.acceptanceChecklist)
    ? task.acceptanceChecklist
    : level === 1
      ? defaultMilestoneChecklist()
      : [];
  const releaseStateRaw = String(task?.releaseState || "").trim().toLowerCase();
  const releaseState =
    level === 1
      ? TASK_RELEASE_STATE.PUBLISHED
      : releaseStateRaw === TASK_RELEASE_STATE.PUBLISHED || releaseStateRaw === TASK_RELEASE_STATE.STAGED
        ? releaseStateRaw
        : (Number(task?.execLevel) || 1) <= 1
          ? TASK_RELEASE_STATE.PUBLISHED
          : TASK_RELEASE_STATE.STAGED;
  const rawStatus = String(task?.status || "").trim().toLowerCase();
  let status = TASK_STATUS.TODO;
  if (rawStatus === TASK_STATUS.DONE || rawStatus === TASK_STATUS.BLOCKED || rawStatus === TASK_STATUS.INTEGRATED) {
    status = rawStatus;
  } else if (rawStatus === LEGACY_TASK_STATUS.ACCEPTED) {
    status = TASK_STATUS.INTEGRATED;
  } else if (
    rawStatus === TASK_STATUS.EXECUTING ||
    rawStatus === LEGACY_TASK_STATUS.CLAIMED ||
    rawStatus === LEGACY_TASK_STATUS.IN_PROGRESS ||
    rawStatus === LEGACY_TASK_STATUS.REVIEW
  ) {
    status = TASK_STATUS.EXECUTING;
  } else if (rawStatus === TASK_STATUS.READY) {
    status = TASK_STATUS.READY;
  } else if (level !== 1 && releaseState === TASK_RELEASE_STATE.PUBLISHED) {
    status = TASK_STATUS.READY;
  }
  return {
    ...task,
    level,
    projectId,
    projectTitle,
    execLevel: Number.isFinite(Number(task?.execLevel)) ? Math.floor(Number(task.execLevel)) : null,
    parentTaskId,
    rawStatus,
    legacyStatus: rawStatus && rawStatus !== status ? rawStatus : "",
    claimedAt: task?.claimedAt ? String(task.claimedAt) : null,
    claimVersion: Number.isFinite(Number(task?.claimVersion)) ? Number(task.claimVersion) : 0,
    gateStatus: String(task?.gateStatus || "open"),
    acceptanceChecklist,
    releaseState,
    next_input: String(task?.nextInput || ""),
    status
  };
}

function isTaskPublished(task) {
  return Number(task?.level) === 1 || String(task?.releaseState || "") === TASK_RELEASE_STATE.PUBLISHED;
}

function isTaskClaimStale(task, nowMs = Date.now()) {
  if (!task) return false;
  const status = String(task.rawStatus || task.status || "");
  if (![LEGACY_TASK_STATUS.CLAIMED, LEGACY_TASK_STATUS.IN_PROGRESS, TASK_STATUS.EXECUTING].includes(status)) return false;
  const stamp = String(task.claimedAt || task.updatedAt || "").trim();
  const ts = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts > taskClaimTtlMs;
}

function reclaimStaleClaims(store, milestoneId) {
  const nowMs = Date.now();
  let reclaimedCount = 0;
  for (let i = 0; i < store.tasks.length; i += 1) {
    const t = normalizeTaskRecord(store.tasks[i]);
    if (t.level === 1) continue;
    if (milestoneId && t.parentTaskId !== milestoneId) continue;
    if (!isTaskClaimStale(t, nowMs)) continue;
    const prevOwner = t.owner || "";
    const prevStatus = t.status;
    const next = {
      ...t,
      owner: "",
      status: TASK_STATUS.TODO,
      claimedAt: null,
      updatedAt: nowIso()
    };
    store.tasks[i] = next;
    appendTaskEvent(store, t.id, "task_claim_reclaimed_timeout", {
      from: prevStatus,
      to: TASK_STATUS.TODO,
      prevOwner,
      ttlMs: taskClaimTtlMs
    });
    reclaimedCount += 1;
  }
  return reclaimedCount;
}

function pickClaimableTask(store, milestoneId, useRandom = true) {
  const normalized = store.tasks.map(normalizeTaskRecord);
  const claimable = normalized
    .filter((t) => t.level !== 1 && t.status === TASK_STATUS.READY)
    .filter((t) => (milestoneId ? t.parentTaskId === milestoneId : true))
    .filter((t) => isTaskPublished(t))
    .filter((t) => dependencyState(store, t).ready);

  if (claimable.length === 0) {
    const blockers = normalized
      .filter((t) => t.level !== 1 && [TASK_STATUS.TODO, TASK_STATUS.READY].includes(t.status))
      .filter((t) => (milestoneId ? t.parentTaskId === milestoneId : true))
      .map((t) => {
        if (!isTaskPublished(t)) {
          return { taskId: t.id, title: t.title, ready: false, missing: ["level_not_published"] };
        }
        return { taskId: t.id, title: t.title, ...dependencyState(store, t) };
      })
      .filter((x) => !x.ready)
      .slice(0, 8);
    return { picked: null, blockers };
  }

  const minPriority = claimable.reduce((acc, t) => Math.min(acc, TASK_PRIORITY_RANK[t.priority] ?? 9), 9);
  const topTier = claimable.filter((t) => (TASK_PRIORITY_RANK[t.priority] ?? 9) === minPriority);
  if (topTier.length === 0) return { picked: null, blockers: [] };
  if (!useRandom || topTier.length === 1) {
    const picked = topTier.slice().sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))[0];
    return { picked, blockers: [] };
  }
  const idx = Math.floor(Math.random() * topTier.length);
  return { picked: topTier[idx], blockers: [] };
}

function releaseNextLevelIfReady(store, milestoneId) {
  const tasks = store.tasks.map(normalizeTaskRecord);
  const children = tasks.filter((x) => x.parentTaskId === milestoneId && x.level !== 1);
  if (children.length === 0) return { releasedCount: 0, releasedLevel: null };
  const levels = Array.from(
    new Set(children.map((x) => (Number.isFinite(Number(x.execLevel)) && Number(x.execLevel) > 0 ? Number(x.execLevel) : 1)))
  ).sort((a, b) => a - b);

  // Ensure first level is published.
  const firstLevel = levels[0];
  let releasedCount = 0;
  let releasedLevel = null;
  for (const c of children) {
    const lv = Number.isFinite(Number(c.execLevel)) && Number(c.execLevel) > 0 ? Number(c.execLevel) : 1;
    if (lv !== firstLevel) continue;
    if (c.releaseState === TASK_RELEASE_STATE.PUBLISHED) continue;
    const idx = store.tasks.findIndex((t) => t.id === c.id);
    if (idx < 0) continue;
    store.tasks[idx] = {
      ...c,
      releaseState: TASK_RELEASE_STATE.PUBLISHED,
      status: c.status === TASK_STATUS.TODO ? TASK_STATUS.READY : c.status,
      updatedAt: nowIso()
    };
    releasedCount += 1;
    releasedLevel = firstLevel;
  }

  for (let i = 0; i < levels.length - 1; i += 1) {
    const lv = levels[i];
    const nextLv = levels[i + 1];
    const curLevelTasks = children.filter((x) => ((Number(x.execLevel) || 1) === lv));
    const allDone = curLevelTasks.length > 0 && curLevelTasks.every((x) => x.status === TASK_STATUS.DONE);
    if (!allDone) break;
    const nextLevelTasks = children.filter((x) => ((Number(x.execLevel) || 1) === nextLv));
    const shouldRelease = nextLevelTasks.some((x) => x.releaseState !== TASK_RELEASE_STATE.PUBLISHED);
    if (!shouldRelease) continue;
    for (const t of nextLevelTasks) {
      const idx = store.tasks.findIndex((x) => x.id === t.id);
      if (idx < 0) continue;
      const cur = normalizeTaskRecord(store.tasks[idx]);
      if (cur.releaseState === TASK_RELEASE_STATE.PUBLISHED) continue;
      store.tasks[idx] = {
        ...cur,
        releaseState: TASK_RELEASE_STATE.PUBLISHED,
        status: cur.status === TASK_STATUS.TODO ? TASK_STATUS.READY : cur.status,
        updatedAt: nowIso()
      };
      releasedCount += 1;
      releasedLevel = nextLv;
    }
    appendTaskEvent(store, milestoneId, "milestone_level_released", { level: nextLv, count: nextLevelTasks.length });
  }
  return { releasedCount, releasedLevel };
}

function listTasks() {
  const store = readTaskStore();
  return store.tasks.map(normalizeTaskRecord).slice().sort((a, b) => {
    const pa = TASK_PRIORITY_RANK[a.priority] ?? 9;
    const pb = TASK_PRIORITY_RANK[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

function defaultMilestoneChecklist() {
  return [];
}

function getChildTasks(tasks, parentTaskId) {
  return tasks.filter((t) => t.parentTaskId === parentTaskId);
}

function isDoneLike(status) {
  return status === TASK_STATUS.DONE || status === TASK_STATUS.INTEGRATED;
}

function isDependencySatisfied(status) {
  return status === TASK_STATUS.DONE || status === TASK_STATUS.INTEGRATED;
}

function dependencyState(store, task) {
  const deps = Array.isArray(task.dependency)
    ? task.dependency.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const scoped = store.tasks.map(normalizeTaskRecord).filter((x) => x.parentTaskId === task.parentTaskId && x.id !== task.id);
  const taskExecLevel = Number(task.execLevel);
  const hasExecLevel = Number.isFinite(taskExecLevel) && taskExecLevel > 0;
  const order = store.tasks
    .map(normalizeTaskRecord)
    .filter((x) => x.parentTaskId === task.parentTaskId)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));

  if (deps.length === 0) {
    if (hasExecLevel) {
      // Stage-mode: same level can run in parallel; only require lower levels done.
      const lowerLevelPending = scoped.filter((x) => {
        const lv = Number(x.execLevel);
        if (!Number.isFinite(lv) || lv <= 0) return false;
        if (lv >= taskExecLevel) return false;
        return !isDependencySatisfied(x.status);
      });
      if (lowerLevelPending.length > 0) {
        return { ready: false, missing: lowerLevelPending.map((x) => x.title || x.id) };
      }
      return { ready: true, missing: [] };
    }
    // Default serial safety: later sibling cannot run before all earlier siblings are completed.
    const idx = order.findIndex((x) => x.id === task.id);
    if (idx > 0) {
      const prev = order.slice(0, idx).filter((x) => !isDependencySatisfied(x.status));
      if (prev.length > 0) {
        return { ready: false, missing: prev.map((x) => x.title || x.id) };
      }
    }
    return { ready: true, missing: [] };
  }

  const missing = deps.filter((dep) => {
    const found = scoped.find((x) => x.id === dep || x.title === dep);
    if (!found) return true;
    return !isDependencySatisfied(found.status);
  });
  return { ready: missing.length === 0, missing };
}

function isMilestoneReadyForDone(store, milestoneTask) {
  const children = getChildTasks(store.tasks, milestoneTask.id);
  if (children.length === 0) return false;
  if (children.some((t) => t.status !== TASK_STATUS.DONE)) return false;
  return true;
}

function collectMilestoneScope(store, milestoneId) {
  const tasks = store.tasks.map(normalizeTaskRecord);
  const milestone = tasks.find((t) => t.id === milestoneId && t.level === 1);
  if (!milestone) return null;
  const children = tasks
    .filter((t) => t.parentTaskId === milestoneId)
    .sort((a, b) => {
      const la = Number(a.execLevel || 1);
      const lb = Number(b.execLevel || 1);
      if (la !== lb) return la - lb;
      return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });
  const taskIdSet = new Set([milestoneId, ...children.map((x) => x.id)]);
  const events = store.events.filter((e) => taskIdSet.has(e.taskId)).slice(-300).reverse();
  const carryContext = children
    .filter((t) => t.status === TASK_STATUS.DONE || t.status === TASK_STATUS.INTEGRATED)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .map((t) => ({
      artifactPath: resolveArtifactDisplayPath(t.artifact || "", t.owner || ""),
      taskId: t.id,
      title: t.title,
      summary: t.summary || "",
      artifact: t.artifact || "",
      artifactExists: Boolean(safeStat(resolveArtifactDisplayPath(t.artifact || "", t.owner || ""))),
      status: t.status,
      updatedAt: t.updatedAt
    }))
    .filter((x) => x.summary || x.artifact);
  return { milestone, children, events, carryContext };
}

function buildCarryContextForTask(store, task, limit = 10) {
  if (!task || !task.parentTaskId) return [];
  const tasks = store.tasks.map(normalizeTaskRecord);
  const siblings = tasks
    .filter((x) => x.parentTaskId === task.parentTaskId && x.id !== task.id)
    .filter((x) => isDoneLike(x.status))
    .map((x) => ({
      artifactPath: resolveArtifactDisplayPath(x.artifact || "", x.owner || ""),
      taskId: x.id,
      title: x.title,
      summary: x.summary || "",
      artifact: x.artifact || "",
      artifactExists: Boolean(safeStat(resolveArtifactDisplayPath(x.artifact || "", x.owner || ""))),
      status: x.status,
      updatedAt: x.updatedAt
    }))
    .filter((x) => x.summary || x.artifact);

  const depKeys = Array.isArray(task.dependency)
    ? task.dependency.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  const depFirst = siblings.filter((x) => depKeys.includes(x.taskId) || depKeys.includes(x.title));
  const recent = siblings
    .slice()
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  const picked = [];
  const seen = new Set();
  for (const item of depFirst) {
    if (seen.has(item.taskId)) continue;
    picked.push(item);
    seen.add(item.taskId);
    if (picked.length >= limit) return picked;
  }
  for (const item of recent) {
    if (seen.has(item.taskId)) continue;
    picked.push(item);
    seen.add(item.taskId);
    if (picked.length >= limit) break;
  }
  return picked;
}

function getTaskById(taskId) {
  const store = readTaskStore();
  const idx = store.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return null;
  return { store, idx, task: normalizeTaskRecord(store.tasks[idx]) };
}

function validateTaskStatus(status) {
  return Object.values(TASK_STATUS).includes(status);
}

function newTaskId() {
  const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `T${ts}-${crypto.randomUUID().slice(0, 4)}`;
}

function newProjectId() {
  const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `P${ts}-${crypto.randomUUID().slice(0, 4)}`;
}

function appendTaskEvent(store, taskId, type, payload) {
  store.events.push({
    id: crypto.randomUUID(),
    taskId,
    type,
    payload: payload || {},
    ts: nowIso()
  });
  store.events = store.events.slice(-2000);
}

function updateAgentScore(agentId, delta) {
  if (!delta) return false;
  const parsed = parseAgentId(agentId);
  if (!parsed) return false;
  const agentJsonPath = resolveSafePath(parsed.source.root, parsed.dirName, "agent.json");
  if (!agentJsonPath) return false;
  const agentDir = path.dirname(agentJsonPath);
  if (!safeStat(agentDir)?.isDirectory()) return false;
  const cfg = safeReadJson(agentJsonPath) || {};
  const nextScore = (Number(cfg.score) || 0) + Number(delta);
  cfg.score = nextScore;
  fs.writeFileSync(agentJsonPath, JSON.stringify(cfg, null, 2), "utf8");
  return true;
}

function setAgentStatus(agentId, status) {
  const parsed = parseAgentId(agentId);
  if (!parsed) return false;
  const agentJsonPath = resolveSafePath(parsed.source.root, parsed.dirName, "agent.json");
  if (!agentJsonPath) return false;
  const agentDir = path.dirname(agentJsonPath);
  if (!safeStat(agentDir)?.isDirectory()) return false;
  const cfg = safeReadJson(agentJsonPath) || {};
  cfg.status = status;
  fs.writeFileSync(agentJsonPath, JSON.stringify(cfg, null, 2), "utf8");
  return true;
}

function countActiveOwnedTasks(agentId, store = null) {
  const s = store || readTaskStore();
  const tasks = (s.tasks || []).map(normalizeTaskRecord);
  return tasks.filter((t) => t.owner === agentId && t.status === TASK_STATUS.EXECUTING).length;
}

function syncAgentBusyState(agentId, store = null) {
  const activeTask = countActiveOwnedTasks(agentId, store);
  const activeGroup = countActiveGroupSessions(agentId);
  const active = activeTask + activeGroup;
  return setAgentStatus(agentId, active > 0 ? "busy" : "idle");
}

function appendTaskToTaskMd(agentId, task) {
  const parsed = parseAgentId(agentId);
  if (!parsed) return false;
  const taskPath = resolveSafePath(parsed.source.root, parsed.dirName, "TASK.md");
  if (!taskPath) return false;
  const issueLine = task.issueUrl ? `- issue: ${task.issueUrl}` : "- issue: ";
  const block = [
    "",
    `## [${task.id}] ${task.title}`,
    `- owner: ${task.owner || ""}`,
    `- status: ${task.status}`,
    `- priority: ${task.priority}`,
    `- score: ${task.score}`,
    issueLine,
    `- updated_at: ${task.updatedAt}`,
    "",
    "### 单轮目标",
    task.description || task.title,
    ""
  ].join("\n");
  const prev = safeReadFile(taskPath);
  fs.writeFileSync(taskPath, `${prev.trimEnd()}\n${block}\n`, "utf8");
  return true;
}

function slugifyName(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "artifact";
}

function artifactFolderForTask(task) {
  const parent = String(task?.parentTaskId || "").trim();
  const self = String(task?.id || "").trim();
  const bucket = parent || self || "misc";
  return bucket.replace(/[^A-Za-z0-9_-]+/g, "_");
}

function ensureArtifactForTask(agentId, task, parsedReply, rawReplyText) {
  const existingRef = String(parsedReply?.artifact || "").trim();
  if (existingRef) {
    const full = resolveArtifactDisplayPath(existingRef, agentId);
    if (full && fs.existsSync(full)) {
      return { artifactRef: artifactToRef(agentId, existingRef), created: false, path: full };
    }
  }

  const parsed = parseAgentId(agentId || "");
  if (!parsed) return { artifactRef: artifactToRef(agentId, existingRef), created: false, path: "" };
  const artifactsDir = path.resolve(parsed.source.root, "artifacts", artifactFolderForTask(task));
  fs.mkdirSync(artifactsDir, { recursive: true });
  const ext = "md";
  const base = `${task.id}-${slugifyName(task.title)}`;
  const fileName = `${base}.${ext}`;
  const fullPath = path.join(artifactsDir, fileName);
  const summary = String(parsedReply?.summary || "").trim();
  const nextInput = String(parsedReply?.next_input || parsedReply?.nextInput || "").trim();
  const body = [
    `# ${task.title}`,
    "",
    `- task_id: ${task.id}`,
    `- generated_at: ${nowIso()}`,
    "",
    "## Summary",
    summary || "(empty)",
    "",
    "## Next Input",
    nextInput || "(empty)",
    "",
    "## Raw Reply",
    "```json",
    String(rawReplyText || "").trim() || "{}",
    "```",
    ""
  ].join("\n");
  fs.writeFileSync(fullPath, body, "utf8");
  const rel = path.relative(parsed.source.root, fullPath).replace(/\\/g, "/");
  const ref = `clawfs://${parsed.source.key}/${rel}`;
  return { artifactRef: ref, created: true, path: fullPath };
}

function materializeMissingArtifactsInStore(store, milestoneId) {
  const out = { changed: 0, skipped: 0 };
  const tasks = store.tasks.map(normalizeTaskRecord);
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (task.level === 1) continue;
    if (milestoneId && task.parentTaskId !== milestoneId) continue;
    if (!isDoneLike(task.status)) continue;
    if (!String(task.summary || "").trim() && !String(task.artifact || "").trim()) continue;
    const owner = String(task.owner || "").trim();
    if (!parseAgentId(owner)) {
      out.skipped += 1;
      continue;
    }
    const existingPath = resolveArtifactDisplayPath(task.artifact || "", owner);
    if (existingPath && fs.existsSync(existingPath)) continue;

    const ensured = ensureArtifactForTask(
      owner,
      task,
      { artifact: task.artifact || "", summary: task.summary || "", next_input: task.nextInput || "" },
      JSON.stringify({ task_id: task.id, summary: task.summary || "", next_input: task.nextInput || "" }, null, 2)
    );
    if (!ensured.artifactRef) {
      out.skipped += 1;
      continue;
    }
    const idx = store.tasks.findIndex((x) => x.id === task.id);
    if (idx < 0) continue;
    store.tasks[idx] = {
      ...normalizeTaskRecord(store.tasks[idx]),
      artifact: ensured.artifactRef,
      updatedAt: nowIso()
    };
    appendTaskEvent(store, task.id, "task_artifact_materialized", {
      agentId: owner,
      path: ensured.path,
      reason: "backfill_missing_artifact"
    });
    out.changed += 1;
  }
  return out;
}

function repairMilestoneDependenciesAndStatus(store, milestoneId, forceSerial = true) {
  const children = store.tasks
    .map(normalizeTaskRecord)
    .filter((t) => t.parentTaskId === milestoneId && t.level !== 1); // keep insertion order
  const summary = { patchedDependencies: 0, rewoundTasks: 0, touchedTaskIds: [] };
  if (children.length === 0) return summary;

  const indexById = new Map(children.map((t, i) => [t.id, i]));
  const indexByTitle = new Map(children.map((t, i) => [t.title, i]));

  // Patch dependency to strict serial chain when enabled.
  for (let i = 0; i < children.length; i += 1) {
    const current = children[i];
    const rawDeps = Array.isArray(current.dependency) ? current.dependency.map((x) => String(x || "").trim()).filter(Boolean) : [];
    const targetDeps = i === 0 ? [] : [children[i - 1].title];
    const hasMissing = rawDeps.length === 0;
    const hasForwardRef = rawDeps.some((d) => {
      const depIdx = indexById.has(d) ? indexById.get(d) : indexByTitle.get(d);
      return Number.isFinite(depIdx) && depIdx > i;
    });
    const serialMismatch =
      forceSerial &&
      (rawDeps.length !== targetDeps.length || rawDeps.some((d, idx) => d !== targetDeps[idx]));
    const needPatch = hasMissing || hasForwardRef || serialMismatch;
    if (!needPatch) continue;

    const idx = store.tasks.findIndex((x) => x.id === current.id);
    if (idx < 0) continue;
    const fixedDep = targetDeps;
    const next = {
      ...normalizeTaskRecord(store.tasks[idx]),
      dependency: fixedDep,
      updatedAt: nowIso()
    };
    store.tasks[idx] = next;
    appendTaskEvent(store, current.id, "task_dependency_patched", { dependency: next.dependency, reason: "repair_milestone" });
    summary.patchedDependencies += 1;
    summary.touchedTaskIds.push(current.id);
  }

  // Rebuild latest child view after patch
  const latestChildren = store.tasks
    .map(normalizeTaskRecord)
    .filter((t) => t.parentTaskId === milestoneId && t.level !== 1); // insertion order

  // Rewind tasks that are marked completed while dependency not satisfied.
  const completedLike = new Set([TASK_STATUS.DONE, TASK_STATUS.INTEGRATED]);
  let changed = true;
  let guard = 0;
  while (changed && guard < 8) {
    changed = false;
    guard += 1;
    for (const task of latestChildren) {
      if (!completedLike.has(normalizeTaskRecord(store.tasks.find((x) => x.id === task.id) || task).status)) continue;
      const dep = dependencyState(store, normalizeTaskRecord(store.tasks.find((x) => x.id === task.id) || task));
      if (dep.ready) continue;
      const idx = store.tasks.findIndex((x) => x.id === task.id);
      if (idx < 0) continue;
      const cur = normalizeTaskRecord(store.tasks[idx]);
      const next = {
        ...cur,
        status: TASK_STATUS.TODO,
        owner: "",
        claimedAt: null,
        updatedAt: nowIso()
      };
      store.tasks[idx] = next;
      appendTaskEvent(store, task.id, "task_rewound_for_dependency", {
        from: cur.status,
        to: TASK_STATUS.TODO,
        missing: dep.missing
      });
      summary.rewoundTasks += 1;
      summary.touchedTaskIds.push(task.id);
      changed = true;
    }
  }
  return summary;
}

function toAgentId(sourceKey, dirName) {
  return `${sourceKey}__${dirName}`;
}

function parseAgentId(agentId) {
  const m = /^(s\d+)__([\w\-.]+)$/.exec(agentId || "");
  if (!m) return null;
  const source = sources.find((s) => s.key === m[1]);
  if (!source) return null;
  return { source, dirName: m[2] };
}

function resolveSafePath(baseRoot, dirName, fileName) {
  const base = path.resolve(baseRoot, dirName);
  const filePath = path.resolve(base, fileName);
  if (filePath !== base && !filePath.startsWith(base + path.sep)) return null;
  return filePath;
}

function artifactToRef(agentId, artifactPath) {
  const raw = String(artifactPath || "").trim();
  if (!raw) return "";
  if (/^clawfs:\/\//i.test(raw)) return raw;

  const parsed = parseAgentId(agentId || "");
  if (!parsed) return raw;
  const sourceRootPosix = toPosixPath(path.resolve(parsed.source.root));
  const sourceRootNorm = sourceRootPosix.toLowerCase();

  const pathLike = toPosixPath(raw);
  const pathNorm = pathLike.toLowerCase();

  if (pathNorm.startsWith(sourceRootNorm + "/")) {
    const rel = pathLike.slice(sourceRootPosix.length + 1);
    return `clawfs://${parsed.source.key}/${rel}`;
  }
  if (pathNorm === sourceRootNorm) return `clawfs://${parsed.source.key}/`;

  for (const root of artifactContainerRoots) {
    const rp = toPosixPath(root);
    const rn = rp.toLowerCase();
    if (pathNorm === rn) return `clawfs://${parsed.source.key}/`;
    if (pathNorm.startsWith(rn + "/")) {
      const rel = pathLike.slice(rp.length + 1);
      return `clawfs://${parsed.source.key}/${rel}`;
    }
  }
  return raw;
}

function resolveArtifactRef(refOrPath) {
  const raw = String(refOrPath || "").trim();
  if (!raw) return null;
  const m = /^clawfs:\/\/(s\d+)\/?(.*)$/i.exec(raw);
  if (!m) return null;
  const source = sources.find((s) => s.key === m[1]);
  if (!source) return null;
  const rel = String(m[2] || "").replace(/^\/+/, "");
  const full = path.resolve(source.root, rel);
  const rootResolved = path.resolve(source.root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return { source, rel, fullPath: full };
}

function resolveArtifactDisplayPath(refOrPath, ownerAgentId) {
  const raw = String(refOrPath || "").trim();
  if (!raw) return "";
  const byRef = resolveArtifactRef(raw);
  if (byRef) return byRef.fullPath;

  const parsed = parseAgentId(ownerAgentId || "");
  if (!parsed) return "";
  const sourceRootPosix = toPosixPath(path.resolve(parsed.source.root));
  const sourceRootNorm = sourceRootPosix.toLowerCase();
  const pathLike = toPosixPath(raw);
  const pathNorm = pathLike.toLowerCase();

  if (pathNorm.startsWith(sourceRootNorm + "/") || pathNorm === sourceRootNorm) {
    return path.resolve(pathLike);
  }
  for (const root of artifactContainerRoots) {
    const rp = toPosixPath(root);
    const rn = rp.toLowerCase();
    if (pathNorm === rn) return path.resolve(parsed.source.root);
    if (pathNorm.startsWith(rn + "/")) {
      const rel = pathLike.slice(rp.length + 1);
      return path.resolve(parsed.source.root, rel);
    }
  }
  return "";
}

function pickByPatterns(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function readIdentityInfo(fullDir) {
  const raw = safeReadFile(path.join(fullDir, "IDENTITY.md"));
  if (!raw) return { name: null, emoji: null, avatar: null };

  const clean = (value) =>
    (value || "")
      .replace(/[*_`]/g, "")
      .replace(/^[:锛歕-\s]+/, "")
      .replace(/\s+$/, "")
      .trim();
  const isPlaceholder = (v) => !v || /^\s*[\(_（].*[\)_）]\s*$/.test(v);

  const name = clean(
    pickByPatterns(raw, [
      /^\s*-\s*\*\*Name:\*\*\s*(.+)$/im,
      /^\s*-\s*Name:\s*(.+)$/im,
      /^\s*-\s*\*\*鍚嶅瓧:\*\*\s*(.+)$/im,
      /^\s*-\s*鍚嶅瓧:\s*(.+)$/im
    ])
  );
  const emoji = clean(
    pickByPatterns(raw, [
      /^\s*-\s*\*\*Emoji:\*\*\s*(.+)$/im,
      /^\s*-\s*Emoji:\s*(.+)$/im,
      /^\s*-\s*\*\*琛ㄦ儏:\*\*\s*(.+)$/im
    ])
  );
  const avatar = clean(
    pickByPatterns(raw, [
      /^\s*-\s*\*\*Avatar:\*\*\s*(.+)$/im,
      /^\s*-\s*Avatar:\s*(.+)$/im,
      /^\s*-\s*\*\*澶村儚:\*\*\s*(.+)$/im
    ])
  );

  return {
    name: isPlaceholder(name) ? null : name,
    emoji: isPlaceholder(emoji) ? null : emoji,
    avatar: isPlaceholder(avatar) ? null : avatar
  };
}

function buildAvatarMeta(source, dirName, avatarFromIdentity, fallbackEmoji) {
  const fallback = { type: "emoji", value: fallbackEmoji || "馃" };
  if (!avatarFromIdentity) return fallback;
  if (/^https?:\/\//i.test(avatarFromIdentity) || /^data:/i.test(avatarFromIdentity)) {
    return { type: "url", value: avatarFromIdentity };
  }
  const cleaned = avatarFromIdentity.replace(/^["']|["']$/g, "").trim();
  if (!cleaned) return fallback;
  const avatarPath = resolveSafePath(source.root, dirName, cleaned);
  if (!avatarPath || !fs.existsSync(avatarPath)) return fallback;
  return {
    type: "file",
    value: `/api/agents/${toAgentId(source.key, dirName)}/avatar?path=${encodeURIComponent(cleaned)}`
  };
}

function loadOpenclawAgentWorkspaceMap() {
  const cfg = safeReadJson(openclawConfigPath);
  const map = new Map();
  const list = (((cfg || {}).agents || {}).list) || [];
  for (const item of list) {
    if (!item || !item.id || !item.workspace) continue;
    map.set(normalizeFsPath(item.workspace), item.id);
  }
  return map;
}

function loadOpenclawActiveWorkspaceDirSet() {
  const cfg = safeReadJson(openclawConfigPath);
  const list = (((cfg || {}).agents || {}).list) || [];
  const dirSet = new Set();
  for (const item of list) {
    if (!item || !item.id) continue;
    if (item.id === "main") {
      dirSet.add("workspace");
      continue;
    }
    if (item.workspace) {
      dirSet.add(path.basename(item.workspace));
      continue;
    }
    dirSet.add(`workspace-${item.id}`);
  }
  return dirSet;
}

function getOpenclawRootAllowSetForSource(source) {
  const openclawHome = normalizeFsPath(path.dirname(openclawConfigPath));
  const sourceNorm = normalizeFsPath(source.root);
  if (sourceNorm !== openclawHome) return null;
  const set = loadOpenclawActiveWorkspaceDirSet();
  return set.size > 0 ? set : null;
}

function deriveLocalAgentKey(source, dirName) {
  if (dirName === "workspace") return "main";
  if (dirName.startsWith("workspace-")) return dirName.slice("workspace-".length);
  const map = loadOpenclawAgentWorkspaceMap();
  const full = normalizeFsPath(path.join(source.root, dirName));
  if (map.has(full)) return map.get(full);
  return dirName;
}

function deriveChatTransport(source, dirName) {
  const bridgeRoot = path.join(source.root, "bridge");
  if (fs.existsSync(path.join(bridgeRoot, "inbox")) && fs.existsSync(path.join(bridgeRoot, "outbox"))) {
    return { mode: "bridge", bridgeRoot, bridgeTo: dirName };
  }
  return { mode: "openclaw-cli", agentKey: deriveLocalAgentKey(source, dirName) };
}

function loadOpenclawAgentConfigById() {
  const cfg = safeReadJson(openclawConfigPath) || {};
  const list = (((cfg || {}).agents || {}).list) || [];
  const map = new Map();
  for (const item of list) {
    if (!item || !item.id) continue;
    map.set(String(item.id), item);
  }
  return map;
}

function findSourceForWorkspace(workspacePath) {
  const target = normalizeFsPath(workspacePath);
  return sources.find((source) => {
    const rootNorm = normalizeFsPath(source.root);
    return target === rootNorm || target.startsWith(`${rootNorm}/`);
  }) || null;
}

function inspectExternalAgentActivity(source, dirName) {
  const openclawHome = normalizeFsPath(path.dirname(openclawConfigPath));
  if (normalizeFsPath(source.root) !== openclawHome) {
    return { supported: false, active: false, latestAt: null, activityKind: "unknown" };
  }
  const agentKey = deriveLocalAgentKey(source, dirName);
  const cfgMap = loadOpenclawAgentConfigById();
  const cfgEntry = cfgMap.get(agentKey);
  const sessionDir = cfgEntry?.agentDir
    ? path.join(path.dirname(cfgEntry.agentDir), "sessions")
    : path.join(path.dirname(openclawConfigPath), "agents", agentKey, "sessions");
  const dirStat = safeStat(sessionDir);
  if (!dirStat?.isDirectory()) {
    return { supported: true, active: false, latestAt: null, activityKind: "none", agentKey, sessionDir };
  }
  let latestMs = 0;
  let latestJsonlPath = "";
  for (const entry of safeReadDir(sessionDir)) {
    if (!entry.isFile()) continue;
    const lower = String(entry.name || "").toLowerCase();
    if (!(lower === "sessions.json" || lower.endsWith(".jsonl"))) continue;
    const fullPath = path.join(sessionDir, entry.name);
    const stat = safeStat(fullPath);
    if (stat?.mtimeMs && stat.mtimeMs > latestMs) latestMs = stat.mtimeMs;
    if (lower.endsWith(".jsonl") && stat?.mtimeMs) {
      if (!latestJsonlPath) {
        latestJsonlPath = fullPath;
      } else {
        const prev = safeStat(latestJsonlPath);
        if ((prev?.mtimeMs || 0) < stat.mtimeMs) latestJsonlPath = fullPath;
      }
    }
  }
  const latestAt = latestMs ? new Date(latestMs).toISOString() : null;
  let activityKind = "none";
  if (latestJsonlPath) {
    try {
      const raw = fs.readFileSync(latestJsonlPath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean).slice(-16);
      const snippets = [];
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (record?.type !== "message") continue;
          const message = record?.message || {};
          const role = String(message.role || "").toLowerCase();
          const parts = Array.isArray(message.content) ? message.content : [];
          const text = parts
            .map((part) => String(part?.text || part?.thinking || ""))
            .join("\n")
            .trim();
          if (!text) continue;
          snippets.push({ role, text });
        } catch {}
      }
      const lastSnippets = snippets.slice(-4);
      const heartbeatPattern =
        /Read HEARTBEAT\.md if it exists|HEARTBEAT_OK|\[Heartbeat Report\]|\[Queued messages while agent was busy\]/i;
      if (lastSnippets.length > 0 && lastSnippets.every((item) => heartbeatPattern.test(item.text))) {
        activityKind = "heartbeat";
      } else if (snippets.some((item) => heartbeatPattern.test(item.text))) {
        const lastUser = [...snippets].reverse().find((item) => item.role === "user");
        if (lastUser && heartbeatPattern.test(lastUser.text)) {
          activityKind = "heartbeat";
        }
      }
      if (activityKind === "none" && snippets.length > 0) {
        activityKind = "session";
      }
    } catch {
      activityKind = "session";
    }
  }
  return {
    supported: true,
    active: latestMs > 0 && Date.now() - latestMs <= externalActivityWindowMs,
    latestAt,
    activityKind,
    agentKey,
    sessionDir
  };
}

function resolveAgentOccupancy(agentId, taskStore = null, groupStore = null, options = {}) {
  const parsed = parseAgentId(agentId);
  if (!parsed) {
    return {
      status: "offline",
      statusLabel: "离线",
      statusReason: "Agent 不在当前管理范围",
      assignable: false,
      taskCount: 0,
      groupCount: 0,
      externalActiveAt: null
    };
  }
  const taskCount = countActiveOwnedTasks(agentId, taskStore);
  const groupCount = countActiveGroupSessions(agentId, groupStore, options.excludeGroupSessionId || "");
  const external = inspectExternalAgentActivity(parsed.source, parsed.dirName);
  const treatExternalAsAssignable = Boolean(options.treatExternalAsAssignable);
  if (taskCount > 0 || groupCount > 0) {
    const reasons = [];
    if (taskCount > 0) reasons.push(`任务占用 ${taskCount}`);
    if (groupCount > 0) reasons.push(`讨论占用 ${groupCount}`);
    if (external.active && external.activityKind === "heartbeat") reasons.push("心跳巡检");
    if (external.active && external.activityKind !== "heartbeat") reasons.push("外部会话活跃");
    const internalStatus = taskCount > 0 ? "busy_task" : "busy_discussion";
    const internalLabel = taskCount > 0 ? "任务执行中" : "讨论进行中";
    return {
      status: internalStatus,
      statusLabel: internalLabel,
      statusReason: reasons.join(" · "),
      assignable: false,
      taskCount,
      groupCount,
      externalActiveAt: external.latestAt,
      statusSource: external.active ? "mixed" : "internal"
    };
  }
  if (external.active) {
    if (external.activityKind === "heartbeat") {
      return {
        status: "heartbeat_only",
        statusLabel: "心跳巡检",
        statusReason: `最近仅检测到 HEARTBEAT 巡检（${fmtShortAgo(external.latestAt)}），不阻塞调度`,
        assignable: true,
        taskCount,
        groupCount,
        externalActiveAt: external.latestAt,
        statusSource: "heartbeat"
      };
    }
    if (treatExternalAsAssignable) {
      return {
        status: "busy_external",
        statusLabel: "外部活跃",
        statusReason: `OpenClaw 会话最近仍在写入（${fmtShortAgo(external.latestAt)}），但已允许当前讨论继续`,
        assignable: true,
        taskCount,
        groupCount,
        externalActiveAt: external.latestAt,
        statusSource: "external_advisory"
      };
    }
    return {
      status: "busy_external",
      statusLabel: "外部活跃",
      statusReason: `OpenClaw 会话最近仍在写入（${fmtShortAgo(external.latestAt)}）`,
      assignable: false,
      taskCount,
      groupCount,
      externalActiveAt: external.latestAt,
      statusSource: "external"
    };
  }
  return {
    status: "idle",
    statusLabel: "空闲",
    statusReason: "当前未检测到任务、讨论或外部会话占用",
    assignable: true,
    taskCount,
    groupCount,
    externalActiveAt: external.latestAt,
    statusSource: "idle"
  };
}

function fmtShortAgo(isoValue) {
  if (!isoValue) return "未知时间";
  const diff = Date.now() - Date.parse(isoValue);
  if (!Number.isFinite(diff) || diff < 0) return "刚刚";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

function collectAgents() {
  const all = [];
  const seen = new Set();
  const taskStore = readTaskStore();
  const groupStore = readGroupStore();
  const reservedDirNames = new Set(["artifacts", "bridge", "inbox", "outbox", "processed"]);
  const coreMdNames = new Set(["AGENTS.MD", "IDENTITY.MD", "SOUL.MD", "USER.MD", "TOOLS.MD", "HEARTBEAT.MD", "BOOTSTRAP.MD"]);
  const keyDocOrder = [
    "IDENTITY.MD",
    "SOUL.MD",
    "USER.MD",
    "TOOLS.MD",
    "TASK.MD",
    "MEMORY.MD",
    "HEARTBEAT.MD",
    "AGENTS.MD",
    "BOOTSTRAP.MD"
  ];
  const keyDocSet = new Set(keyDocOrder);
  const keyDocRank = new Map(keyDocOrder.map((name, i) => [name, i]));
  for (const source of sources) {
    const allowDirs = getOpenclawRootAllowSetForSource(source);
    const dirs = safeReadDir(source.root).filter((entry) => entry.isDirectory());
    for (const dir of dirs) {
      const dirName = dir.name;
      if (reservedDirNames.has(dirName.toLowerCase())) continue;
      if (allowDirs && !allowDirs.has(dirName)) continue;
      const fullDir = path.join(source.root, dirName);
      const config = safeReadJson(path.join(fullDir, "agent.json")) || {};
      const identity = readIdentityInfo(fullDir);

      const files = safeReadDir(fullDir)
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .filter((entry) => keyDocSet.has(String(entry.name || "").toUpperCase()))
        .map((entry) => {
          const stat = safeStat(path.join(fullDir, entry.name));
          return {
            name: entry.name,
            size: stat ? stat.size : 0,
            modifiedAt: stat ? stat.mtime.toISOString() : null
          };
        })
        .sort((a, b) => {
          const ra = keyDocRank.get(String(a.name || "").toUpperCase()) ?? 999;
          const rb = keyDocRank.get(String(b.name || "").toUpperCase()) ?? 999;
          if (ra !== rb) return ra - rb;
          return String(a.name || "").localeCompare(String(b.name || ""), "en");
        });

      if (Object.keys(config).length === 0 && files.length === 0) continue;
      const hasCoreMd = files.some((f) => coreMdNames.has(String(f.name || "").toUpperCase()));
      const hasAgentConfig = ["name", "role", "avatar", "score", "status"].some((k) => Object.prototype.hasOwnProperty.call(config, k));
      if (!hasCoreMd && !hasAgentConfig) continue;

      const displayName = config.name || identity.name || dirName;
      const emoji = config.avatar || identity.emoji || "馃";
      const avatarMeta = buildAvatarMeta(source, dirName, identity.avatar, emoji);
      const transport = deriveChatTransport(source, dirName);
      const agentId = toAgentId(source.key, dirName);
      const occupancy = String(config.status || "").toLowerCase() === "offline"
        ? {
            status: "offline",
            statusLabel: "离线",
            statusReason: "agent.json 标记为 offline",
            assignable: false,
            taskCount: 0,
            groupCount: 0,
            externalActiveAt: null,
            statusSource: "manual"
          }
        : resolveAgentOccupancy(agentId, taskStore, groupStore);

      seen.add(agentId);
      all.push({
        id: agentId,
        name: displayName,
        role: config.role || "未配置角色",
        score: Number.isFinite(config.score) ? config.score : 0,
        status: occupancy.status,
        statusLabel: occupancy.statusLabel,
        statusReason: occupancy.statusReason,
        statusDetail: occupancy.statusReason,
        statusSource: occupancy.statusSource,
        assignable: Boolean(occupancy.assignable),
        taskCount: occupancy.taskCount,
        groupCount: occupancy.groupCount,
        externalActiveAt: occupancy.externalActiveAt,
        avatar: avatarMeta.type === "emoji" ? avatarMeta.value : emoji,
        avatarType: avatarMeta.type,
        avatarUrl: avatarMeta.type === "emoji" ? null : avatarMeta.value,
        sourceKey: source.key,
        sourceLabel: source.label,
        chatMode: transport.mode,
        chatTarget: transport.mode === "openclaw-cli" ? transport.agentKey : transport.bridgeTo,
        files
      });
    }
  }
  const cfg = safeReadJson(openclawConfigPath) || {};
  const configuredAgents = (((cfg || {}).agents || {}).list) || [];
  for (const item of configuredAgents) {
    if (!item || !item.id || !item.workspace) continue;
    const source = findSourceForWorkspace(item.workspace);
    if (!source) continue;
    const dirName = path.basename(item.workspace);
    const agentId = toAgentId(source.key, dirName);
    if (seen.has(agentId)) continue;
    const fullDir = path.join(source.root, dirName);
    const files = safeReadDir(fullDir)
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .filter((entry) => keyDocSet.has(String(entry.name || "").toUpperCase()))
      .map((entry) => {
        const stat = safeStat(path.join(fullDir, entry.name));
        return {
          name: entry.name,
          size: stat ? stat.size : 0,
          modifiedAt: stat ? stat.mtime.toISOString() : null
        };
      })
      .sort((a, b) => {
        const ra = keyDocRank.get(String(a.name || "").toUpperCase()) ?? 999;
        const rb = keyDocRank.get(String(b.name || "").toUpperCase()) ?? 999;
        if (ra !== rb) return ra - rb;
        return String(a.name || "").localeCompare(String(b.name || ""), "en");
      });
    const identity = readIdentityInfo(fullDir);
    const emoji = identity.emoji || item.identity?.emoji || "馃";
    const avatarMeta = buildAvatarMeta(source, dirName, identity.avatar, emoji);
    const transport = deriveChatTransport(source, dirName);
    const occupancy = resolveAgentOccupancy(agentId, taskStore, groupStore);
    seen.add(agentId);
    all.push({
      id: agentId,
      name: identity.name || item.identity?.name || item.name || item.id,
      role: files.length === 0 ? "待初始化" : "未配置角色",
      score: 0,
      status: occupancy.status,
      statusLabel: occupancy.statusLabel,
      statusReason: occupancy.statusReason,
      statusDetail: occupancy.statusReason,
      statusSource: occupancy.statusSource,
      assignable: Boolean(occupancy.assignable),
      taskCount: occupancy.taskCount,
      groupCount: occupancy.groupCount,
      externalActiveAt: occupancy.externalActiveAt,
      avatar: avatarMeta.type === "emoji" ? avatarMeta.value : emoji,
      avatarType: avatarMeta.type,
      avatarUrl: avatarMeta.type === "emoji" ? null : avatarMeta.value,
      sourceKey: source.key,
      sourceLabel: source.label,
      chatMode: transport.mode,
      chatTarget: transport.mode === "openclaw-cli" ? transport.agentKey : transport.bridgeTo,
      files
    });
  }
  return all.sort((a, b) => {
    if (a.sourceKey !== b.sourceKey) return a.sourceKey > b.sourceKey ? 1 : -1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}

function runCommand(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, payload) => {
      if (settled) return;
      settled = true;
      fn(payload);
    };
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(reject, new Error(`command timeout: ${bin}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(reject, err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(reject, new Error((stderr || stdout || `${bin} exited ${code}`).trim()));
        return;
      }
      finish(resolve, { stdout, stderr });
    });
  });
}

function getAgentById(agentId) {
  return collectAgents().find((x) => x.id === agentId) || null;
}

function resolveOpenclawInvoker() {
  if (fs.existsSync(openclawMjsPath)) {
    return { bin: process.execPath, prefixArgs: [openclawMjsPath] };
  }
  if (fs.existsSync(openclawCmdPath)) {
    return { bin: openclawCmdPath, prefixArgs: [] };
  }
  return { bin: "openclaw.cmd", prefixArgs: [] };
}

function extractReplyTextFromAgentOutput(mixedText) {
  const i = mixedText.indexOf("{");
  const j = mixedText.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      const parsed = JSON.parse(mixedText.slice(i, j + 1));
      const payloads = (((parsed || {}).result || {}).payloads) || [];
      for (const p of payloads) {
        if (p && typeof p.text === "string" && p.text.trim()) return p.text.trim();
      }
      const fallback = (((parsed || {}).result || {}).text);
      if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
    } catch {}
  }

  const m = mixedText.match(/"payloads"\s*:\s*\[\s*\{[\s\S]*?"text"\s*:\s*"((?:\\.|[^"])*)"/);
  if (m && m[1]) {
    try {
      return JSON.parse(`"${m[1]}"`).trim();
    } catch {
      return m[1].trim();
    }
  }
  return null;
}

function extractFirstJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function extractTaskListFromReply(replyText) {
  const obj = extractFirstJsonObject(replyText);
  if (!obj) return null;
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.tasks)) return obj.tasks;
  if (Array.isArray(obj.levels)) {
    const flat = [];
    for (const group of obj.levels) {
      const lv = Number(group?.level ?? group?.phase ?? group?.wave);
      const arr = Array.isArray(group?.tasks) ? group.tasks : [];
      for (const item of arr) {
        flat.push({ ...(item || {}), level: Number.isFinite(lv) ? lv : item?.level });
      }
    }
    if (flat.length > 0) return flat;
  }
  if (obj.data && Array.isArray(obj.data.tasks)) return obj.data.tasks;
  if (obj.result && Array.isArray(obj.result.tasks)) return obj.result.tasks;
  return null;
}

function extractAcceptanceChecklistFromReply(replyText) {
  const obj = extractFirstJsonObject(replyText);
  if (!obj) return null;
  const candidates = [
    obj.acceptanceChecklist,
    obj.checklist,
    obj.data?.acceptanceChecklist,
    obj.result?.acceptanceChecklist
  ];
  const list = candidates.find((x) => Array.isArray(x));
  if (!list) return null;
  const normalized = list
    .map((item, idx) => {
      if (!item) return null;
      const title = String(item.title || item.name || "").trim();
      if (!title) return null;
      const id = String(item.id || `gate_${idx + 1}`)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "");
      return { id: id || `gate_${idx + 1}`, title, passed: false };
    })
    .filter(Boolean);
  return normalized.length > 0 ? normalized : null;
}

function normalizeDecomposedTaskItems(taskItems) {
  if (!Array.isArray(taskItems)) return [];
  const cleaned = [];
  let sawLevelSignal = false;
  for (let i = 0; i < taskItems.length; i += 1) {
    const item = taskItems[i] || {};
    const title = String(item.title || "").trim();
    if (!title) continue;
    const dependency = Array.isArray(item.dependency)
      ? item.dependency.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const levelRaw = Number(item.level ?? item.phase ?? item.wave);
    const level = Number.isFinite(levelRaw) && levelRaw > 0 ? Math.floor(levelRaw) : null;
    if (level !== null) sawLevelSignal = true;
    const normalized = {
      ...item,
      title,
      level,
      dependency
    };
    cleaned.push(normalized);
  }
  if (cleaned.length === 0) return cleaned;

  if (!sawLevelSignal) {
    // Backward compatible fallback: strict serial when no level information provided.
    return cleaned.map((item, idx) => ({
      ...item,
      level: 1,
      dependency: item.dependency.length > 0 ? item.dependency : idx > 0 ? [cleaned[idx - 1].title] : []
    }));
  }

  // Normalize missing levels to previous level (or 1), then enforce stage gating.
  let lastLv = 1;
  const withLevel = cleaned.map((item) => {
    const lv = item.level ?? lastLv ?? 1;
    lastLv = lv;
    return { ...item, level: lv };
  });
  const levels = Array.from(new Set(withLevel.map((x) => x.level))).sort((a, b) => a - b);
  const byLevel = new Map(levels.map((lv) => [lv, withLevel.filter((x) => x.level === lv)]));
  const prevTitles = new Map();
  for (let i = 0; i < levels.length; i += 1) {
    const lv = levels[i];
    const prevLv = levels[i - 1];
    const prev = prevLv === undefined ? [] : byLevel.get(prevLv) || [];
    prevTitles.set(lv, prev.map((x) => x.title));
  }
  return withLevel.map((item) => {
    if (item.dependency.length > 0) return item;
    const deps = prevTitles.get(item.level) || [];
    return { ...item, dependency: deps };
  });
}

function readHeartbeatJobs() {
  ensureDataFiles();
  const raw = safeReadJson(heartbeatJobsPath);
  if (!raw || !Array.isArray(raw.jobs)) return { jobs: [] };
  return { jobs: raw.jobs };
}

function readDispatchSettings() {
  ensureDataFiles();
  const raw = safeReadJson(dispatchSettingsPath);
  if (!raw || typeof raw !== "object") {
    return {
      dispatchMode,
      centralDispatchIntervalMs,
      centralDispatchExclude: Array.from(centralDispatchExclude)
    };
  }
  return {
    dispatchMode: String(raw.dispatchMode || dispatchMode).trim().toLowerCase(),
    centralDispatchIntervalMs: Math.max(30000, Number(raw.centralDispatchIntervalMs) || centralDispatchIntervalMs),
    centralDispatchExclude: Array.isArray(raw.centralDispatchExclude)
      ? raw.centralDispatchExclude.map((x) => String(x || "").trim()).filter(Boolean)
      : Array.from(centralDispatchExclude)
  };
}

function writeDispatchSettings(next) {
  ensureDataFiles();
  const payload = {
    schemaVersion: 1,
    dispatchMode: String(next.dispatchMode || "central").trim().toLowerCase(),
    centralDispatchIntervalMs: Math.max(30000, Number(next.centralDispatchIntervalMs) || 60000),
    centralDispatchExclude: Array.isArray(next.centralDispatchExclude)
      ? next.centralDispatchExclude.map((x) => String(x || "").trim()).filter(Boolean)
      : []
  };
  const tmp = `${dispatchSettingsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, dispatchSettingsPath);
  dispatchMode = payload.dispatchMode === "agent_pull" ? "agent_pull" : "central";
  centralDispatchIntervalMs = payload.centralDispatchIntervalMs;
  centralDispatchExclude = new Set(payload.centralDispatchExclude);
  return payload;
}

function writeHeartbeatJobs(payload) {
  ensureDataFiles();
  const next = { schemaVersion: 1, jobs: Array.isArray(payload?.jobs) ? payload.jobs : [], updatedAt: nowIso() };
  const tmp = `${heartbeatJobsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, heartbeatJobsPath);
}

function normalizeHeartbeatJob(job) {
  const agentId = String(job?.agentId || "").trim();
  const intervalSec = Math.max(30, Number(job?.intervalSec) || 300);
  const mode = job?.mode === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
  return {
    agentId,
    mode,
    intervalSec,
    enabled: Boolean(job?.enabled ?? true),
    milestoneId: String(job?.milestoneId || "").trim() || null,
    lastRunAt: job?.lastRunAt ? String(job.lastRunAt) : null,
    nextRunAt: job?.nextRunAt ? String(job.nextRunAt) : null,
    lastStatus: String(job?.lastStatus || "idle"),
    lastError: String(job?.lastError || ""),
    lastTaskId: String(job?.lastTaskId || "")
  };
}

function buildSafeMilestoneTitle(goal, taskItems) {
  const raw = String(goal || "").trim();
  if (!raw) return "里程碑：未命名目标";
  const qCount = (raw.match(/\?/g) || []).length;
  const hasCjk = /[\u4e00-\u9fff]/.test(raw);
  const likelyCorrupted = qCount >= 4 && !hasCjk;
  if (!likelyCorrupted) return `里程碑：${raw}`;

  const seed = (Array.isArray(taskItems) ? taskItems : [])
    .map((x) => String(x?.title || "").trim())
    .filter(Boolean)
    .slice(0, 2);
  if (seed.length > 0) {
    return `里程碑：${seed.join(" + ")}`;
  }
  return "里程碑：目标标题已损坏（请手动重命名）";
}

function buildStructuredTaskPrompt(inputText, mode) {
  if (mode !== "sessions_spawn") return inputText;
  const taskId = `T${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto
    .randomUUID()
    .slice(0, 4)}`;
  return [
    `task_id: ${taskId}`,
    inputText,
    "只返回 JSON，不要闲聊：",
    "{",
    `  "task_id": "${taskId}",`,
    '  "status": "ok|blocked|failed",',
    '  "summary": "一句话结论",',
    '  "artifact": "产物路径或空",',
    '  "next_input": "下一步需要的输入"',
    "}"
  ].join("\n");
}

async function runOpenclawAgentMessage(agentKey, text, mode) {
  const prompt = buildStructuredTaskPrompt(text, mode);
  const invoker = resolveOpenclawInvoker();
  const timeoutSec = Math.max(30, Math.ceil(agentTimeoutMs / 1000));
  const args = [...invoker.prefixArgs, "agent", "--agent", agentKey, "--message", prompt, "--timeout", String(timeoutSec), "--json"];
  const { stdout, stderr } = await runCommand(invoker.bin, args, agentTimeoutMs);
  const reply =
    extractReplyTextFromAgentOutput(stdout) ||
    extractReplyTextFromAgentOutput(stderr) ||
    extractReplyTextFromAgentOutput(`${stdout}\n${stderr}`);
  return reply || "已发送，但未提取到明确文本回复。";
}

async function sendTaskPromptWithFallback(transport, prompt, mode) {
  const primary = mode === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
  try {
    const replyText =
      transport.mode === "bridge"
        ? await sendViaBridge(transport.bridgeRoot, transport.bridgeTo, prompt, primary)
        : await runOpenclawAgentMessage(transport.agentKey, prompt, primary);
    return { replyText, usedMode: primary, fallbackUsed: false };
  } catch (err) {
    if (primary !== "sessions_spawn") throw err;
    const fallbackMode = "sessions_send";
    const replyText =
      transport.mode === "bridge"
        ? await sendViaBridge(transport.bridgeRoot, transport.bridgeTo, prompt, fallbackMode)
        : await runOpenclawAgentMessage(transport.agentKey, prompt, fallbackMode);
    return { replyText, usedMode: fallbackMode, fallbackUsed: true };
  }
}

function resolveTaskGoalContext(store, task) {
  if (!task) return "";
  const direct = String(task.goalContext || task.goal || "").trim();
  if (direct) return direct;
  if (!task.parentTaskId) {
    return String(task.projectTitle || task.title || "").trim();
  }
  const tasks = (store?.tasks || []).map(normalizeTaskRecord);
  const milestone = tasks.find((x) => x.id === task.parentTaskId && Number(x.level) === 1);
  if (!milestone) return String(task.projectTitle || "").trim();
  const fromMilestone = String(milestone.goal || milestone.projectTitle || milestone.title || "").trim();
  return fromMilestone;
}

function buildTaskDispatchPrompt(task, carryContext, goalContext = "") {
  const depKeys = Array.isArray(task?.dependency)
    ? task.dependency.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  const requiredIds = new Set(
    (carryContext || [])
      .filter((x) => depKeys.includes(String(x.taskId || "").trim()) || depKeys.includes(String(x.title || "").trim()))
      .map((x) => String(x.taskId || "").trim())
      .filter(Boolean)
  );

  const contextLines = (carryContext || []).length
    ? [
        "",
        "上游可复用结果（请作为输入参考，标注“必读”的必须先读 artifact 正文）：",
        ...(carryContext || []).map(
          (x, i) =>
            `${i + 1}. ${requiredIds.has(String(x.taskId || "")) ? "[必读]" : "[参考]"} ${x.title} | ${x.summary || "(无结论)"} | ${x.artifactPath || x.artifact || "(无产物路径)"} | exists=${x.artifactExists ? "yes" : "no"}`
        ),
        ""
      ]
    : [];
  return [
    `task_id: ${task.id}`,
    `goal: ${goalContext || task.projectTitle || "(none)"}`,
    `title: ${task.title}`,
    `issue: ${task.issueUrl || "(none)"}`,
    `priority: ${task.priority}`,
    `score: ${task.score}`,
    ...contextLines,
    "",
    "你现在只做这一步：执行这个任务并回传结构化结果。",
    goalContext ? `该任务隶属总目标：${goalContext}` : "",
    depKeys.length > 0 ? `依赖任务：${depKeys.join("、")}` : "依赖任务：(无)",
    task.description || task.title,
    "",
    "执行约束：",
    "1) 若存在“必读”上游结果，必须先读取对应 artifact 正文，再执行当前任务。",
    "2) 如果必读 artifact 路径不存在或无法读取，返回 status=blocked，并在 next_input 写明缺失输入。",
    "3) 不要只复述 summary，结果中要体现你对 artifact 正文的吸收。",
    "",
    "只返回 JSON：",
    "{",
    `  "task_id":"${task.id}",`,
    '  "status":"ok|blocked|failed",',
    '  "summary":"一句话结论",',
    '  "artifact":"产物路径或空",',
    '  "next_input":"下一步需要的输入"',
    "}"
  ].join("\n");
}

function buildMilestoneIntegratePrompt(milestone, children) {
  const artifactContextMode = String(process.env.MILESTONE_ARTIFACT_CONTEXT_MODE || "path_summary")
    .trim()
    .toLowerCase();

  function readArtifactFull(task, maxChars = 120000) {
    const displayPath = resolveArtifactDisplayPath(task.artifact || "", task.owner || "") || task.artifact || "";
    if (!displayPath) {
      return { artifactPath: "(无)", exists: false, full: "" };
    }
    const st = safeStat(displayPath);
    if (!st || !st.isFile()) {
      return { artifactPath: displayPath, exists: false, full: "" };
    }
    const raw = safeReadFile(displayPath);
    if (!raw) return { artifactPath: displayPath, exists: true, full: "" };
    return {
      artifactPath: displayPath,
      exists: true,
      full: raw.length > maxChars ? raw.slice(0, maxChars) : raw
    };
  }

  const childLines = (children || []).map((c, i) => {
    const artifactInfo = readArtifactFull(c);
    const lines = [
      `${i + 1}. 子任务: ${c.title}`,
      `   状态: ${c.status}`,
      `   负责人: ${c.owner || "(未认领)"}`,
      `   结论: ${c.summary || "(无)"}`,
      `   产物完整路径: ${toPosixPath(artifactInfo.artifactPath || "(无)")}`,
      `   产物是否存在: ${artifactInfo.exists ? "yes" : "no"}`
    ];
    if (artifactContextMode === "full") {
      lines.push("   产物全文(仅在full模式提供):");
      lines.push(artifactInfo.full ? artifactInfo.full : "(空)");
    }
    return lines.join("\n");
  });
  return [
    `里程碑ID: ${milestone.id}`,
    `里程碑标题: ${milestone.title}`,
    `里程碑说明: ${milestone.description || "(无)"}`,
    "",
    "你是主控Agent。请统筹所有已完成子任务，给出该里程碑的最终产出结论。",
    "要求：",
    "1) 必须优先依据每个子任务的 artifact 文件内容；summary 仅作索引。",
    "2) 当前默认只提供 summary + artifact完整路径，不再提供截断摘录。",
    "3) 若你能访问该路径，请先读取 artifact 正文再整合；不要只看 summary。",
    "4) 只基于已给出的子任务结果进行整合。",
    "5) 如果需要最终文档，请给出你生成的产物路径 artifact（可为空）。",
    "6) 只返回 JSON，不要解释。",
    "",
    "子任务结果：",
    ...(childLines.length ? childLines : ["(无子任务结果)"]),
    "",
    "返回格式：",
    "{",
    `  "task_id":"${milestone.id}",`,
    '  "status":"ok|blocked|failed",',
    '  "summary":"里程碑最终结论（可发布版）",',
    '  "artifact":"最终产物路径或空",',
    '  "next_input":"下一步建议或空"',
    "}"
  ].join("\n");
}

function buildGroupTurnPrompt(session, speakerId) {
  const otherId = speakerId === session.agentA ? session.agentB : session.agentA;
  const speaker = getAgentById(speakerId);
  const other = getAgentById(otherId);
  const recent = (session.messages || [])
    .slice(-8)
    .map((m, i) => `${i + 1}. [${m.role}] ${m.agentId || "system"}: ${String(m.text || "").slice(0, 600)}`);
  return [
    `group_session_id: ${session.id}`,
    `goal: ${session.goal}`,
    `title: ${session.title}`,
    `round: ${session.round}/${session.maxRounds}`,
    `you: ${speaker?.name || speakerId}`,
    `partner: ${other?.name || otherId}`,
    "",
    "你在进行双人无领导讨论（A/B）。当前只轮到你发言，不要代替对方发言。",
    "请基于目标与历史上下文，给出推进性发言。避免重复，优先补充新信息、指出风险或形成可执行结论。",
    "只有在你确认已经满足收官条件时，才能把 status 写成 finish。finish 不是“我倾向同意”，而是“我确认此刻可以结束讨论”。",
    "收官条件：1) 你的问题已被对方回应；2) 你没有新的关键分歧；3) 你能给出最终结论或明确执行建议；4) 当前停止不会明显损失结果质量。",
    "如果你只是部分同意、还有追问、还想补充条件、或只是赞同对方一部分，请继续返回 continue，不要返回 finish。",
    "若你被阻塞（信息缺失、前提冲突、无法继续），才返回 blocked，并写清阻塞原因。",
    "",
    "最近上下文：",
    ...(recent.length ? recent : ["(暂无历史消息)"]),
    "",
    "只返回 JSON：",
    "{",
    '  "status":"continue|finish|blocked",',
    '  "position":"你当前观点（一句话）",',
    '  "evidence":"关键依据/论据（可简短）",',
    '  "proposal":"可执行建议（可空）",',
    '  "next_question":"希望对方回答的问题（可空）",',
    '  "delta":"new|repeat",',
    '  "finish_reason":"若 status=finish，写清为何现在可以结束；否则留空"',
    "}"
  ].join("\n");
}

function normalizeGroupTurnReply(parsedReply, fallbackText) {
  const status = ["continue", "finish", "blocked"].includes(String(parsedReply?.status || "").trim().toLowerCase())
    ? String(parsedReply.status).trim().toLowerCase()
    : "continue";
  const position = String(parsedReply?.position || "").trim();
  const evidence = String(parsedReply?.evidence || "").trim();
  const proposal = String(parsedReply?.proposal || "").trim();
  const nextQuestion = String(parsedReply?.next_question || parsedReply?.nextQuestion || "").trim();
  const delta = String(parsedReply?.delta || "").trim().toLowerCase() === "repeat" ? "repeat" : "new";
  const finishReason = String(parsedReply?.finish_reason || parsedReply?.finishReason || "").trim();
  const text = [
    position,
    evidence ? `依据：${evidence}` : "",
    proposal ? `建议：${proposal}` : "",
    nextQuestion ? `问题：${nextQuestion}` : "",
    status === "finish" && finishReason ? `收官依据：${finishReason}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  return {
    status,
    position: position || String(fallbackText || "").trim().slice(0, 300),
    evidence,
    proposal,
    next_question: nextQuestion,
    delta,
    finish_reason: finishReason,
    text: text || String(fallbackText || "").trim().slice(0, 300)
  };
}

function syncGroupParticipantBusyStates(session, taskStore = null, groupStore = null) {
  const s = normalizeGroupSession(session);
  for (const id of s.members) {
    if (!id) continue;
    const activeTask = countActiveOwnedTasks(id, taskStore);
    const activeGroup = countActiveGroupSessions(id, groupStore);
    setAgentStatus(id, activeTask + activeGroup > 0 ? "busy" : "idle");
  }
}

async function executeGroupSessionTick(sessionId, trigger = "manual") {
  const id = String(sessionId || "").trim();
  if (!id) {
    const e = new Error("Invalid session id.");
    e.code = 400;
    throw e;
  }
  if (inflightGroupSessions.has(id)) {
    const e = new Error("Group session is already running.");
    e.code = 409;
    throw e;
  }
  inflightGroupSessions.add(id);
  try {
    const store = readGroupStore();
    const idx = (store.sessions || []).findIndex((x) => String(x.id || "") === id);
    if (idx < 0) {
      const e = new Error("Group session not found.");
      e.code = 404;
      throw e;
    }
    const session = normalizeGroupSession(store.sessions[idx]);
    if (session.status !== "running") {
      const e = new Error(`Group session is not running: ${session.status}`);
      e.code = 409;
      throw e;
    }
    const missingAgents = getMissingGroupAgents(session);
    if (missingAgents.length > 0) {
      await markGroupSessionUnavailable(id, missingAgents, trigger);
      const e = new Error(`Group session has missing agents: ${missingAgents.join(", ")}`);
      e.code = 409;
      throw e;
    }

    const speakerId = session.turnAgentId || session.agentA;
    const speakerOccupancy = resolveAgentOccupancy(speakerId, null, null, {
      excludeGroupSessionId: id,
      treatExternalAsAssignable: true
    });
    if (!speakerOccupancy.assignable) {
      await mutateGroupStore(async (latestStore) => {
        const i = (latestStore.sessions || []).findIndex((x) => String(x.id || "") === id);
        if (i < 0) return;
        const next = normalizeGroupSession(latestStore.sessions[i]);
        next.status = "paused";
        next.stopReason = `agent_unavailable:${speakerId}`;
        next.updatedAt = nowIso();
        appendGroupEvent(next, "session_paused_busy", {
          speakerId,
          trigger,
          detail: speakerOccupancy.statusReason,
          status: speakerOccupancy.status
        });
        latestStore.sessions[i] = next;
        syncGroupParticipantBusyStates(next, null, latestStore);
      });
      const e = new Error(`Speaker is unavailable: ${speakerId} (${speakerOccupancy.statusReason})`);
      e.code = 409;
      throw e;
    }

    const parsed = parseAgentId(speakerId);
    if (!parsed) {
      const e = new Error(`Invalid speaker agent id: ${speakerId}`);
      e.code = 400;
      throw e;
    }
    const transport = deriveChatTransport(parsed.source, parsed.dirName);
    const prompt = buildGroupTurnPrompt(session, speakerId);
    const sent = await sendTaskPromptWithFallback(transport, prompt, session.mode);
    const raw = sent.replyText || "";
    const parsedReply = extractFirstJsonObject(raw) || {};
    const normalized = normalizeGroupTurnReply(parsedReply, raw);

    const result = await mutateGroupStore(async (latestStore) => {
      const i = (latestStore.sessions || []).findIndex((x) => String(x.id || "") === id);
      if (i < 0) return null;
      const next = normalizeGroupSession(latestStore.sessions[i]);
      if (next.status !== "running") return next;

      appendGroupMessage(next, "agent", normalized.text, {
        agentId: speakerId,
        status: normalized.status,
        payload: {
          position: normalized.position,
          evidence: normalized.evidence,
          proposal: normalized.proposal,
          next_question: normalized.next_question,
          delta: normalized.delta,
          finish_reason: normalized.finish_reason
        },
        round: next.round,
        turnIndex: next.turnCount + 1,
        mode: sent.usedMode
      });
      appendGroupEvent(next, "turn_done", { speakerId, status: normalized.status, trigger, fallbackUsed: sent.fallbackUsed });
      next.turnCount += 1;
      next.round = Math.max(1, Math.ceil(next.turnCount / 2));

      const lowInfo = normalized.delta === "repeat" || !normalized.evidence;
      next.noProgressRounds = lowInfo ? next.noProgressRounds + 1 : 0;

      const reachedTurnLimit = next.turnCount >= next.maxTurns;
      const reachedNoProgress = next.noProgressRounds >= next.maxNoProgressRounds;
      const agentMsgs = (next.messages || [])
        .filter((m) => m.role === "agent")
        .filter((m) => Number(m.turnIndex || 0) > Number(next.runStartTurnCount || 0));
      const last = agentMsgs[agentMsgs.length - 1];
      const prev = agentMsgs[agentMsgs.length - 2];
      const twoSideFinish =
        last &&
        prev &&
        String(last.status || "").toLowerCase() === "finish" &&
        String(prev.status || "").toLowerCase() === "finish" &&
        String(last.agentId || "") !== String(prev.agentId || "");
      const finishWindowTurns = agentMsgs.length;
      const canCloseByFinish = twoSideFinish && finishWindowTurns >= next.minFinishTurns;
      if (canCloseByFinish) {
        next.status = "done";
        next.stopReason = "mutual_finish";
      } else if (normalized.status === "blocked") {
        next.status = "paused";
        next.stopReason = `blocked:${speakerId}`;
      } else if (reachedNoProgress) {
        next.status = "timeout";
        next.stopReason = "no_progress";
      } else if (reachedTurnLimit) {
        next.status = "timeout";
        next.stopReason = "max_rounds";
      } else {
        next.turnAgentId = speakerId === next.agentA ? next.agentB : next.agentA;
      }

      if (next.status === "done" || next.status === "timeout" || next.status === "paused") {
        const closes = (next.messages || [])
          .filter((m) => m.role === "agent")
          .slice(-4)
          .map((m) => `${m.agentId || "agent"}: ${String(m.text || "").replace(/\s+/g, " ").slice(0, 180)}`);
        next.summary = `双人讨论结束(${next.stopReason})：${closes.join(" | ")}`.slice(0, 1200);
        appendGroupEvent(next, "session_closed", { reason: next.stopReason });
      }

      next.updatedAt = nowIso();
      latestStore.sessions[i] = next;
      syncGroupParticipantBusyStates(next, null, latestStore);
      return next;
    });
    if (result && ["done", "timeout", "aborted", "paused"].includes(result.status) && result.masterAgentId) {
      integrateClosedGroupSession(result.id, trigger).catch(() => {});
    }
    return { ok: true, session: result };
  } finally {
    inflightGroupSessions.delete(id);
  }
}

function normalizeStructuredReply(parsedReply, fallbackText, taskId) {
  const statusRaw = String(parsedReply?.status || "").toLowerCase();
  const status = ["ok", "blocked", "failed"].includes(statusRaw) ? statusRaw : "ok";
  const summary = String(parsedReply?.summary || "").trim() || String(fallbackText || "").trim().slice(0, 300);
  const artifact = String(parsedReply?.artifact || "").trim();
  const nextInput = String(parsedReply?.next_input || parsedReply?.nextInput || "").trim();
  return {
    task_id: String(parsedReply?.task_id || taskId || ""),
    status,
    summary,
    artifact,
    next_input: nextInput
  };
}

async function integrateMilestoneByMaster(milestoneId, masterAgentId, mode = "sessions_send", source = "manual") {
  if (!parseAgentId(masterAgentId)) {
    const e = new Error("Invalid masterAgentId.");
    e.code = 400;
    throw e;
  }

  const scoped = collectMilestoneScope(readTaskStore(), milestoneId);
  if (!scoped) {
    const e = new Error("Milestone not found.");
    e.code = 404;
    throw e;
  }
  const pending = scoped.children.filter((x) => x.status !== TASK_STATUS.DONE);
  if (pending.length > 0) {
    const e = new Error("Milestone integration requires all child tasks done.");
    e.code = 409;
    e.pending = pending.map((x) => ({ id: x.id, title: x.title, status: x.status }));
    throw e;
  }
  if ([TASK_STATUS.DONE, TASK_STATUS.INTEGRATED].includes(scoped.milestone.status)) {
    return { skipped: true, reason: "already_integrated", task: scoped.milestone };
  }

  const parsed = parseAgentId(masterAgentId);
  const transport = deriveChatTransport(parsed.source, parsed.dirName);
  const prompt = buildMilestoneIntegratePrompt(scoped.milestone, scoped.children);
  const sent = await sendTaskPromptWithFallback(transport, prompt, mode);
  const parsedReply = extractFirstJsonObject(sent.replyText) || {};
  const ensuredArtifact = ensureArtifactForTask(masterAgentId, scoped.milestone, parsedReply, sent.replyText);
  const statusRaw = String(parsedReply.status || "").toLowerCase();
  const isBlocked = statusRaw === "blocked" || statusRaw === "failed";

  const updated = await mutateTaskStore(async (store) => {
    const idx = store.tasks.findIndex((t) => t.id === milestoneId && Number(t.level) === 1);
    if (idx < 0) return null;
    const current = normalizeTaskRecord(store.tasks[idx]);
    if ([TASK_STATUS.DONE, TASK_STATUS.INTEGRATED].includes(current.status)) {
      return current;
    }
    const next = {
      ...current,
      owner: masterAgentId,
      status: isBlocked ? TASK_STATUS.BLOCKED : TASK_STATUS.INTEGRATED,
      summary: String(parsedReply.summary || "").trim() || current.summary || sent.replyText.slice(0, 1200),
      artifact:
        ensuredArtifact.artifactRef ||
        artifactToRef(masterAgentId, String(parsedReply.artifact || "").trim()) ||
        current.artifact ||
        "",
      nextInput: String(parsedReply.next_input || parsedReply.nextInput || "").trim() || current.nextInput || "",
      updatedAt: nowIso()
    };
    store.tasks[idx] = next;
    appendTaskEvent(store, milestoneId, "milestone_integrated_by_master", {
      masterAgentId,
      mode: sent.usedMode,
      fallbackUsed: sent.fallbackUsed,
      status: next.status,
      source
    });
    appendTaskEvent(store, milestoneId, "task_status_updated", {
      from: current.status,
      to: next.status,
      summary: next.summary
    });
    return next;
  });

  if (!updated) {
    const e = new Error("Milestone not found.");
    e.code = 404;
    throw e;
  }

  return {
    ok: true,
    task: updated,
    replyText: sent.replyText,
    parsedReply,
    dispatchMode: sent.usedMode,
    fallbackUsed: sent.fallbackUsed
  };
}

async function tryAutoIntegrateMilestone(milestoneId, source = "auto") {
  const id = String(milestoneId || "").trim();
  if (!id) return { triggered: false, reason: "empty_milestone_id" };
  if (inflightMilestoneIntegrations.has(id)) return { triggered: false, reason: "integration_inflight" };

  const scoped = collectMilestoneScope(readTaskStore(), id);
  if (!scoped) return { triggered: false, reason: "milestone_not_found" };
  if ([TASK_STATUS.DONE, TASK_STATUS.INTEGRATED].includes(scoped.milestone.status)) {
    return { triggered: false, reason: "already_integrated" };
  }
  if (!scoped.children.length || scoped.children.some((x) => x.status !== TASK_STATUS.DONE)) {
    return { triggered: false, reason: "children_not_all_done" };
  }

  const masterAgentId = String(scoped.milestone.createdBy || scoped.milestone.owner || "").trim();
  if (!parseAgentId(masterAgentId)) {
    await mutateTaskStore(async (store) => {
      appendTaskEvent(store, id, "milestone_auto_integrate_skipped", {
        source,
        reason: "invalid_master_agent",
        masterAgentId
      });
    });
    return { triggered: false, reason: "invalid_master_agent" };
  }

  inflightMilestoneIntegrations.add(id);
  try {
    await mutateTaskStore(async (store) => {
      appendTaskEvent(store, id, "milestone_auto_integrate_triggered", { source, masterAgentId });
    });
    const result = await integrateMilestoneByMaster(id, masterAgentId, "sessions_send", source);
    markRuntimeDispatchOk(source, masterAgentId);
    return { triggered: true, masterAgentId, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markRuntimeDispatchError(source, masterAgentId, msg);
    await mutateTaskStore(async (store) => {
      appendTaskEvent(store, id, "milestone_auto_integrate_failed", { source, masterAgentId, error: msg });
    });
    return { triggered: false, reason: "integration_failed", error: msg };
  } finally {
    inflightMilestoneIntegrations.delete(id);
  }
}

async function executeHeartbeatTick(body, trigger = "api") {
  const agentId = String(body?.agentId || "").trim();
  const milestoneId = String(body?.milestoneId || "").trim();
  const mode = body?.mode === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
  let claimed = null;
  if (!parseAgentId(agentId)) {
    const e = new Error("Invalid agent id.");
    e.code = 400;
    throw e;
  }
  const occupancy = resolveAgentOccupancy(agentId);
  if (!occupancy.assignable) {
    const e = new Error(`Agent is unavailable: ${occupancy.statusReason}`);
    e.code = 409;
    throw e;
  }
  if (inflightHeartbeatAgents.has(agentId)) {
    const e = new Error("Heartbeat for this agent is already running.");
    e.code = 409;
    throw e;
  }
  const parsed = parseAgentId(agentId);
  if (!parsed) {
    const e = new Error("Invalid agent id.");
    e.code = 400;
    throw e;
  }
  inflightHeartbeatAgents.add(agentId);
  try {
    claimed = await mutateTaskStore(async (store) => {
      materializeMissingArtifactsInStore(store, milestoneId || null);
      const reclaimedCount = reclaimStaleClaims(store, milestoneId || null);
      const { picked, blockers } = pickClaimableTask(store, milestoneId || null, true);
      if (!picked) {
        const e = new Error(
          blockers.length > 0
            ? `No dispatchable task available. blocked by: ${blockers
                .map((b) => `${b.title} <- [${(b.missing || []).join(", ")}]`)
                .join(" | ")}`
            : "No dispatchable task available."
        );
        e.code = 409;
        e.blockers = blockers;
        throw e;
      }
      const idx = store.tasks.findIndex((t) => t.id === picked.id);
      if (idx < 0) return null;
      const next = {
        ...normalizeTaskRecord(store.tasks[idx]),
        owner: agentId,
        status: TASK_STATUS.EXECUTING,
        claimedAt: nowIso(),
        claimVersion: (Number(store.tasks[idx].claimVersion) || 0) + 1,
        updatedAt: nowIso()
      };
      store.tasks[idx] = next;
      setAgentStatus(agentId, "busy");
      appendTaskEvent(store, next.id, "task_dispatched_started", {
        owner: agentId,
        mode: "central",
        strategy: "level_release_auto_dispatch",
        reclaimedBeforeClaim: reclaimedCount,
        trigger
      });
      return next;
    });

    if (!claimed) {
      const e = new Error("No dispatchable task available.");
      e.code = 404;
      throw e;
    }

    const transport = deriveChatTransport(parsed.source, parsed.dirName);
    const dispatchStore = readTaskStore();
    const carry = buildCarryContextForTask(dispatchStore, claimed, 10);
    const goalContext = resolveTaskGoalContext(dispatchStore, claimed);
    const prompt = buildTaskDispatchPrompt(claimed, carry, goalContext);
    let nextTask = null;
    try {
      const sent = await sendTaskPromptWithFallback(transport, prompt, mode);
      const parsedReply = extractFirstJsonObject(sent.replyText) || {};
      const normalizedReply = normalizeStructuredReply(parsedReply, sent.replyText, claimed.id);
      const ensuredArtifact = ensureArtifactForTask(agentId, claimed, normalizedReply, sent.replyText);
      const statusMap = { ok: TASK_STATUS.DONE, blocked: TASK_STATUS.BLOCKED, failed: TASK_STATUS.BLOCKED };
      const nextStatus = statusMap[normalizedReply.status] || TASK_STATUS.EXECUTING;

      nextTask = await mutateTaskStore(async (store) => {
        const idx = store.tasks.findIndex((t) => t.id === claimed.id);
        if (idx < 0) return null;
        const latest = normalizeTaskRecord(store.tasks[idx]);
        const merged = {
          ...latest,
          status: nextStatus,
          summary: normalizedReply.summary || latest.summary,
          artifact: ensuredArtifact.artifactRef || artifactToRef(agentId, normalizedReply.artifact) || latest.artifact,
          nextInput: normalizedReply.next_input || latest.nextInput,
          updatedAt: nowIso()
        };
        store.tasks[idx] = merged;
        if (merged.parentTaskId && merged.status === TASK_STATUS.DONE) releaseNextLevelIfReady(store, merged.parentTaskId);
        appendTaskEvent(store, merged.id, "task_heartbeat_dispatched", {
          agentId,
          mode: sent.usedMode,
          fallbackUsed: sent.fallbackUsed,
          nextStatus,
          trigger
        });
        if (ensuredArtifact.created) {
          appendTaskEvent(store, merged.id, "task_artifact_materialized", {
            agentId,
            path: ensuredArtifact.path
          });
        }
        if (nextStatus === TASK_STATUS.DONE && merged.owner) {
          const delta = Number.isFinite(Number(merged.score)) ? Number(merged.score) : 0;
          if (delta > 0) {
            updateAgentScore(merged.owner, delta);
            appendTaskEvent(store, merged.id, "task_rewarded", { owner: merged.owner, delta });
          }
        }
        return merged;
      });
      markRuntimeDispatchOk(trigger, agentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markRuntimeDispatchError(trigger, agentId, msg);
      await mutateTaskStore(async (store) => {
        const idx = store.tasks.findIndex((t) => t.id === claimed.id);
        if (idx < 0) return;
        const latest = normalizeTaskRecord(store.tasks[idx]);
        if (latest.status === TASK_STATUS.EXECUTING && latest.owner === agentId) {
          store.tasks[idx] = {
            ...latest,
            status: isTaskPublished(latest) ? TASK_STATUS.READY : TASK_STATUS.TODO,
            owner: "",
            claimedAt: null,
            updatedAt: nowIso()
          };
          appendTaskEvent(store, latest.id, "task_heartbeat_dispatch_failed", {
            agentId,
            trigger,
            error: msg,
            rolledBack: true
          });
        }
      });
      syncAgentBusyState(agentId);
      throw err;
    }

    if (nextTask?.parentTaskId && nextTask.status === TASK_STATUS.DONE) {
      await tryAutoIntegrateMilestone(nextTask.parentTaskId, "heartbeat_done");
    }
    syncAgentBusyState(agentId);

    return {
      ok: true,
      task: nextTask,
      claimedTaskId: claimed.id,
      replyText: sent.replyText,
      parsedReply: normalizedReply,
      dispatchMode: sent.usedMode,
      fallbackUsed: sent.fallbackUsed
    };
  } finally {
    inflightHeartbeatAgents.delete(agentId);
  }
}

async function ensureBridgeListenerReady(bridgeRoot) {
  const listenerPath = path.join(bridgeRoot, "listener.log");
  const before = safeStat(listenerPath)?.mtimeMs || 0;
  try {
    await runCommand(
      "docker",
      [
        "exec",
        bridgeContainer,
        "sh",
        "-lc",
        "pgrep -f bridge_listener.py >/dev/null || (nohup python3 /workspace/bridge/bridge_listener.py >/workspace/bridge/listener.stdout 2>&1 &)"
      ],
      15000
    );
  } catch {
    return;
  }
  await new Promise((r) => setTimeout(r, 500));
  const after = safeStat(listenerPath)?.mtimeMs || 0;
  if (after < before) {
    // best effort
  }
}

async function waitBridgeReply(outboxDir, requestId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const files = await fsp.readdir(outboxDir).catch(() => []);
    for (const file of files) {
      if (!file.toLowerCase().endsWith(".json")) continue;
      const full = path.join(outboxDir, file);
      try {
        const raw = (await fsp.readFile(full, "utf8")).replace(/^\uFEFF/, "");
        const obj = JSON.parse(raw);
        if (obj.request_id === requestId) {
          return typeof obj.text === "string" ? obj.text : raw;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 450));
  }
  throw new Error("bridge timeout: no reply received (listener may not be running)");
}

async function pruneBridgeInboxBacklog(inboxDir, processedDir) {
  const files = await fsp.readdir(inboxDir).catch(() => []);
  const reqFiles = [];
  for (const file of files) {
    if (!/^req-.*\.json$/i.test(file)) continue;
    const full = path.join(inboxDir, file);
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    reqFiles.push({ file, full, mtimeMs: st.mtimeMs });
  }
  if (reqFiles.length === 0) return;
  reqFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const now = Date.now();
  const maxAgeMs = 10 * 60 * 1000;
  const keepLatest = 20;
  const toPrune = reqFiles.filter((item, idx) => idx >= keepLatest || now - item.mtimeMs > maxAgeMs);
  if (toPrune.length === 0) return;

  await fsp.mkdir(processedDir, { recursive: true });
  for (const item of toPrune) {
    const target = path.join(processedDir, item.file);
    try {
      await fsp.rename(item.full, target);
    } catch {
      try {
        await fsp.unlink(item.full);
      } catch {}
    }
  }
}

async function sendViaBridge(bridgeRoot, to, text, mode) {
  await ensureBridgeListenerReady(bridgeRoot);
  const inboxDir = path.join(bridgeRoot, "inbox");
  const outboxDir = path.join(bridgeRoot, "outbox");
  const processedDir = path.join(bridgeRoot, "processed");
  await fsp.mkdir(inboxDir, { recursive: true });
  await fsp.mkdir(outboxDir, { recursive: true });
  await pruneBridgeInboxBacklog(inboxDir, processedDir);

  const payloadText = buildStructuredTaskPrompt(text, mode);
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const reqName = `req-${new Date().toISOString().replace(/[:.]/g, "-")}-${requestId}.json`;
  const req = {
    request_id: requestId,
    from: "manager-claw",
    to,
    text: payloadText,
    ts: nowIso(),
    mode
  };
  await fsp.writeFile(path.join(inboxDir, reqName), JSON.stringify(req, null, 2), "utf8");
  return await waitBridgeReply(outboxDir, requestId, bridgeTimeoutMs);
}

function getChatMessages(agentId) {
  return chatStore.get(agentId) || [];
}

function appendChatMessage(agentId, role, text, mode) {
  const list = chatStore.get(agentId) || [];
  const msg = {
    id: crypto.randomUUID(),
    role,
    text,
    mode: mode || "sessions_send",
    ts: nowIso()
  };
  list.push(msg);
  chatStore.set(agentId, list.slice(-200));
  return msg;
}

app.get("/api/agents", (req, res) => {
  const agents = collectAgents();
  res.json({ root: roots.join(", "), roots, count: agents.length, agents });
});

app.get("/api/agents/:agentId/files/:fileName", (req, res) => {
  const { agentId, fileName } = req.params;
  if (!/^[\w\-.]+$/.test(agentId) || !/^[\w\-.]+\.md$/i.test(fileName)) {
    return res.status(400).json({ error: "Invalid path parameter." });
  }
  const parsed = parseAgentId(agentId);
  if (!parsed) return res.status(400).json({ error: "Invalid agent id." });
  const filePath = resolveSafePath(parsed.source.root, parsed.dirName, fileName);
  if (!filePath) return res.status(400).json({ error: "Invalid path." });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found." });
  const raw = safeReadFile(filePath);
  return res.json({ agentId, fileName, raw, html: marked.parse(raw) });
});

app.put("/api/agents/:agentId/files/:fileName", (req, res) => {
  const { agentId, fileName } = req.params;
  const { raw } = req.body || {};
  if (!/^[\w\-.]+$/.test(agentId) || !/^[\w\-.]+\.md$/i.test(fileName)) {
    return res.status(400).json({ error: "Invalid path parameter." });
  }
  if (typeof raw !== "string") return res.status(400).json({ error: "`raw` must be a string." });
  const parsed = parseAgentId(agentId);
  if (!parsed) return res.status(400).json({ error: "Invalid agent id." });
  const filePath = resolveSafePath(parsed.source.root, parsed.dirName, fileName);
  if (!filePath) return res.status(400).json({ error: "Invalid path." });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found." });
  fs.writeFileSync(filePath, raw, "utf8");
  return res.json({ ok: true, agentId, fileName, html: marked.parse(raw) });
});

app.get("/api/agents/:agentId/avatar", (req, res) => {
  const { agentId } = req.params;
  const avatarPath = String(req.query.path || "");
  const parsed = parseAgentId(agentId);
  if (!parsed) return res.status(400).json({ error: "Invalid agent id." });
  if (!avatarPath) return res.status(400).json({ error: "Missing path." });
  const filePath = resolveSafePath(parsed.source.root, parsed.dirName, avatarPath);
  if (!filePath) return res.status(400).json({ error: "Invalid path." });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Avatar not found." });
  return res.sendFile(filePath);
});

app.get("/api/artifacts/resolve", (req, res) => {
  const ref = String(req.query.ref || "").trim();
  if (!ref) return res.status(400).json({ error: "ref is required." });
  const resolved = resolveArtifactRef(ref);
  if (!resolved) {
    return res.json({ ok: true, ref, type: "raw", exists: fs.existsSync(ref), fullPath: ref });
  }
  const exists = fs.existsSync(resolved.fullPath);
  const stat = exists ? safeStat(resolved.fullPath) : null;
  res.json({
    ok: true,
    ref,
    type: "clawfs",
    sourceKey: resolved.source.key,
    sourceLabel: resolved.source.label,
    relativePath: resolved.rel,
    fullPath: resolved.fullPath,
    exists,
    size: stat ? stat.size : 0,
    modifiedAt: stat ? stat.mtime.toISOString() : null
  });
});

app.get("/api/chat/agents/:agentId/messages", (req, res) => {
  const { agentId } = req.params;
  const parsed = parseAgentId(agentId);
  if (!parsed) return res.status(400).json({ error: "Invalid agent id." });
  return res.json({ agentId, messages: getChatMessages(agentId) });
});

app.post("/api/chat/agents/:agentId/messages", async (req, res) => {
  const { agentId } = req.params;
  const body = req.body || {};
  const text = String(body.text || "").trim();
  const mode = body.mode === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
  if (!text) return res.status(400).json({ error: "text is required." });

  const parsed = parseAgentId(agentId);
  if (!parsed) return res.status(400).json({ error: "Invalid agent id." });
  if (inflightAgents.has(agentId)) {
    return res.status(409).json({ error: "This agent is still replying, please wait." });
  }

  inflightAgents.add(agentId);
  try {
    const transport = deriveChatTransport(parsed.source, parsed.dirName);
    let messageText = text;
    if (mode === "sessions_spawn") {
      messageText = [
        "请先以当前工作目录中的 IDENTITY.md / SOUL.md / USER.md 为准，忽略旧会话中可能过期的人设记忆。",
        text
      ].join("\n\n");
    }
    appendChatMessage(agentId, "user", text, mode);
    let replyText = "";
    if (transport.mode === "bridge") {
      replyText = await sendViaBridge(transport.bridgeRoot, transport.bridgeTo, messageText, mode);
    } else {
      replyText = await runOpenclawAgentMessage(transport.agentKey, messageText, mode);
    }
    const reply = appendChatMessage(agentId, "assistant", replyText, mode);
    return res.json({ ok: true, reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendChatMessage(agentId, "system", `发送失败: ${msg}`, mode);
    return res.status(500).json({ error: msg });
  } finally {
    inflightAgents.delete(agentId);
  }
});

app.get("/api/tasks", (req, res) => {
  const status = String(req.query.status || "").trim();
  const owner = String(req.query.owner || "").trim();
  const projectId = String(req.query.projectId || "").trim();
  const tasks = listTasks().filter((task) => {
    if (status && task.status !== status) return false;
    if (owner && task.owner !== owner) return false;
    if (projectId && task.projectId !== projectId) return false;
    return true;
  });
  const stats = tasks.reduce(
    (acc, task) => {
      acc.total += 1;
      acc.byStatus[task.status] = (acc.byStatus[task.status] || 0) + 1;
      return acc;
    },
    { total: 0, byStatus: {} }
  );
  const milestones = tasks.filter((t) => t.level === 1).map((m) => {
    const children = tasks.filter((x) => x.parentTaskId === m.id);
    const doneChildren = children.filter((x) => x.status === TASK_STATUS.DONE).length;
    const blockedChildren = children.filter((x) => x.status === TASK_STATUS.BLOCKED).length;
    const inProgressChildren = children.filter((x) => x.status === TASK_STATUS.EXECUTING).length;
    return {
      id: m.id,
      projectId: m.projectId,
      projectTitle: m.projectTitle || m.title,
      title: m.title,
      status: m.status,
      owner: m.owner || "",
      priority: m.priority || "P1",
      updatedAt: m.updatedAt || "",
      childrenTotal: children.length,
      childrenDone: doneChildren,
      childrenBlocked: blockedChildren,
      childrenInProgress: inProgressChildren
    };
  });

  const projectMap = new Map();
  for (const m of milestones) {
    const pid = m.projectId || `PRJ-${m.id}`;
    if (!projectMap.has(pid)) {
      projectMap.set(pid, {
        id: pid,
        title: m.projectTitle || m.title,
        milestoneTotal: 0,
        milestoneDone: 0,
        taskTotal: 0,
        taskDone: 0,
        updatedAt: ""
      });
    }
    const p = projectMap.get(pid);
    p.milestoneTotal += 1;
    if ([TASK_STATUS.DONE, TASK_STATUS.INTEGRATED].includes(m.status)) p.milestoneDone += 1;
    p.taskTotal += Number(m.childrenTotal || 0);
    p.taskDone += Number(m.childrenDone || 0);
    const mTask = tasks.find((x) => x.id === m.id);
    const stamp = String(mTask?.updatedAt || "");
    if (stamp > p.updatedAt) p.updatedAt = stamp;
  }

  const projects = Array.from(projectMap.values()).map((p) => ({
    ...p,
    progressPercent: p.taskTotal > 0 ? Math.round((p.taskDone / p.taskTotal) * 100) : 0
  }));

  res.json({ tasks, stats, milestones, projects });
});

app.get("/api/projects/:projectId", (req, res) => {
  const { projectId } = req.params;
  const all = listTasks();
  const scoped = all.filter((x) => x.projectId === projectId);
  if (scoped.length === 0) return res.status(404).json({ error: "Project not found." });
  const milestones = scoped.filter((x) => x.level === 1);
  const milestoneIds = new Set(milestones.map((x) => x.id));
  const children = scoped.filter((x) => x.parentTaskId && milestoneIds.has(x.parentTaskId));
  const title = milestones[0]?.projectTitle || milestones[0]?.title || projectId;
  res.json({
    ok: true,
    project: {
      id: projectId,
      title,
      milestoneTotal: milestones.length,
      milestoneDone: milestones.filter((x) => [TASK_STATUS.DONE, TASK_STATUS.INTEGRATED].includes(x.status)).length,
      taskTotal: children.length,
      taskDone: children.filter((x) => x.status === TASK_STATUS.DONE).length
    },
    milestones,
    tasks: scoped
  });
});

app.get("/api/tasks/events", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const milestoneId = String(req.query.milestoneId || "").trim();
  const store = readTaskStore();
  if (!milestoneId) return res.json({ events: store.events.slice(-limit).reverse() });
  const scoped = collectMilestoneScope(store, milestoneId);
  if (!scoped) return res.status(404).json({ error: "Milestone not found." });
  return res.json({ events: scoped.events.slice(0, limit) });
});

app.get("/api/task-center/meta", (req, res) => {
  ensureDataFiles();
  const store = readTaskStore();
  const backups = safeReadDir(taskBackupDir).filter((x) => x.isFile() && x.name.endsWith(".json")).length;
  const last = safeStat(taskCenterPath)?.mtime?.toISOString?.() || null;
  res.json({
    ok: true,
    path: taskCenterPath,
    backups,
    lastUpdatedAt: last,
    tasks: Array.isArray(store.tasks) ? store.tasks.length : 0,
    events: Array.isArray(store.events) ? store.events.length : 0
  });
});

app.get("/api/logs", (req, res) => {
  const limit = Math.max(20, Math.min(500, Number(req.query.limit) || 120));
  const store = readTaskStore();
  const taskEvents = (store.events || []).slice(-limit).reverse();
  const bridgeLogs = sources.map((source) => {
    const bridgeRoot = path.join(source.root, "bridge");
    const listenerLogPath = path.join(bridgeRoot, "listener.log");
    const inbox = safeReadDir(path.join(bridgeRoot, "inbox"))
      .filter((x) => x.isFile() && x.name.toLowerCase().endsWith(".json"))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 10)
      .map((x) => x.name);
    const outbox = safeReadDir(path.join(bridgeRoot, "outbox"))
      .filter((x) => x.isFile() && x.name.toLowerCase().endsWith(".json"))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 10)
      .map((x) => x.name);
    return {
      sourceKey: source.key,
      sourceLabel: source.label,
      bridgeRoot,
      listenerLogPath,
      listenerTail: readTailLines(listenerLogPath, limit),
      inboxRecent: inbox,
      outboxRecent: outbox
    };
  });
  res.json({
    ok: true,
    generatedAt: nowIso(),
    taskEvents,
    bridgeLogs
  });
});

app.post("/api/tasks/materialize-missing-artifacts", async (req, res) => {
  return sendError(res, 410, "Artifact maintenance is now internal-only.");
});

app.post("/api/milestones/:milestoneId/repair-flow", async (req, res) => {
  return sendError(res, 410, "Manual flow repair has been removed from the public UI.");
});

app.get("/api/milestones/:milestoneId", (req, res) => {
  const { milestoneId } = req.params;
  const store = readTaskStore();
  const scoped = collectMilestoneScope(store, milestoneId);
  if (!scoped) return res.status(404).json({ error: "Milestone not found." });
  const done = scoped.children.filter((x) => x.status === TASK_STATUS.DONE).length;
  const progress = scoped.children.length > 0 ? Math.round((done / scoped.children.length) * 100) : 0;
  res.json({
    milestone: scoped.milestone,
    children: scoped.children,
    events: scoped.events,
    carryContext: scoped.carryContext,
    progress: { done, total: scoped.children.length, percent: progress }
  });
});

app.post("/api/milestones/:milestoneId/release-next", async (req, res) => {
  return sendError(res, 410, "Manual level release has been removed. Levels release automatically.");
});

app.post("/api/tasks/reclaim-stale", async (req, res) => {
  return sendError(res, 410, "Stale reclaim is now internal-only.");
});

app.post("/api/milestones/:milestoneId/integrate", async (req, res) => {
  const { milestoneId } = req.params;
  const body = req.body || {};
  const masterAgentId = String(body.masterAgentId || "").trim();
  const mode = body.mode === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
  if (!parseAgentId(masterAgentId)) return res.status(400).json({ error: "Invalid masterAgentId." });

  try {
    const result = await integrateMilestoneByMaster(milestoneId, masterAgentId, mode, "manual_api");
    return res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === "object" && "code" in err ? Number(err.code) : 500;
    const pending = err && typeof err === "object" && "pending" in err ? err.pending : undefined;
    return res.status(Number.isFinite(code) && code > 0 ? code : 500).json({ error: msg, pending });
  }
});

app.post("/api/tasks", async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();
  const issueUrl = String(body.issueUrl || "").trim();
  const createdBy = String(body.createdBy || "user").trim() || "user";
  const priority = String(body.priority || "P1").trim().toUpperCase();
  const score = Number(body.score);
  const requestedProjectId = String(body.projectId || "").trim();
  const requestedProjectTitle = String(body.projectTitle || "").trim();
  const parentTaskId = String(body.parentTaskId || "").trim() || null;
  const level = Number(body.level) === 1 ? 1 : 2;
  const projectId = requestedProjectId || (level === 1 ? newProjectId() : parentTaskId ? `PRJ-${parentTaskId}` : newProjectId());
  const projectTitle = requestedProjectTitle || title;

  if (!title) return res.status(400).json({ error: "title is required." });
  if (!["P0", "P1", "P2", "P3"].includes(priority)) {
    return res.status(400).json({ error: "priority must be one of P0/P1/P2/P3." });
  }

  const task = {
    id: newTaskId(),
    title,
    description,
    issueUrl,
    priority,
    score: Number.isFinite(score) ? score : 10,
    createdBy,
    level,
    projectId,
    projectTitle,
    parentTaskId,
    releaseState: level === 1 ? TASK_RELEASE_STATE.PUBLISHED : TASK_RELEASE_STATE.STAGED,
    gateStatus: "open",
    acceptanceChecklist: Array.isArray(body.acceptanceChecklist) ? body.acceptanceChecklist : [],
    owner: "",
    claimedAt: null,
    claimVersion: 0,
    status: level === 1 ? TASK_STATUS.TODO : TASK_STATUS.TODO,
    artifact: "",
    nextInput: "",
    summary: "",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await mutateTaskStore(async (store) => {
    store.tasks.push(task);
    appendTaskEvent(store, task.id, "task_created", { createdBy, priority });
  });
  res.json({ ok: true, task });
});

app.post("/api/tasks/auto-claim", async (req, res) => {
  return sendError(res, 410, "Legacy manual task claim API has been removed. Use central auto dispatch.");
});

app.post("/api/tasks/:taskId/claim", async (req, res) => {
  return sendError(res, 410, "Legacy manual task claim API has been removed. Use central auto dispatch.");
});

app.post("/api/tasks/:taskId/release", async (req, res) => {
  return sendError(res, 410, "Legacy manual task release API has been removed. Use central auto dispatch.");
});

app.delete("/api/tasks/:taskId", async (req, res) => {
  const { taskId } = req.params;
  try {
    const deleted = await mutateTaskStore(async (store) => {
      const tasks = store.tasks.map(normalizeTaskRecord);
      const target = tasks.find((t) => t.id === taskId);
      if (!target) return null;

      const ids = new Set([target.id]);
      if (target.level === 1) {
        tasks.filter((t) => t.parentTaskId === target.id).forEach((t) => ids.add(t.id));
      }

      const deletedTitles = new Set(tasks.filter((t) => ids.has(t.id)).map((t) => t.title));
      store.tasks = tasks
        .filter((t) => !ids.has(t.id))
        .map((t) => {
          const dep = Array.isArray(t.dependency) ? t.dependency : [];
          const nextDep = dep.filter((x) => {
            const key = String(x || "").trim();
            return key && !ids.has(key) && !deletedTitles.has(key);
          });
          return { ...t, dependency: nextDep, updatedAt: nowIso() };
        });
      store.events = store.events.filter((e) => !ids.has(e.taskId));

      const anchorTaskId = target.level === 1 ? target.id : target.parentTaskId || target.id;
      appendTaskEvent(store, anchorTaskId, "task_deleted", {
        taskId: target.id,
        level: target.level,
        cascadeCount: ids.size
      });
      return { target, deletedTaskIds: Array.from(ids) };
    });

    if (!deleted) return res.status(404).json({ error: "Task not found." });
    res.json({ ok: true, deleted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/tasks/:taskId/status", async (req, res) => {
  return sendError(res, 410, "Legacy manual task status API has been removed. Task flow is now system-driven.");
});

app.post("/api/tasks/:taskId/checklist", async (req, res) => {
  res.status(410).json({ error: "Checklist flow has been removed. Use milestone integration instead." });
});

app.post("/api/tasks/:taskId/dispatch", async (req, res) => {
  return sendError(res, 410, "Legacy manual dispatch API has been removed. Tasks are dispatched automatically.");
});

app.post("/api/tasks/heartbeat/tick", async (req, res) => {
  return sendError(res, 410, "Heartbeat pull is now internal-only. Use central dispatch.");
});

app.get("/api/group-sessions", (req, res) => {
  const store = readGroupStore();
  const sessions = (store.sessions || []).map(normalizeGroupSession);
  const summary = sessions
    .slice()
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .map((s) => ({
      id: s.id,
      title: s.title,
      goal: s.goal,
      agentA: s.agentA,
      agentB: s.agentB,
      status: s.status,
      round: s.round,
      maxRounds: s.maxRounds,
      turnAgentId: s.turnAgentId,
      turnCount: s.turnCount,
      autoRun: s.autoRun,
      stopReason: s.stopReason,
      summary: s.summary,
      masterAgentId: s.masterAgentId,
      reportStatus: s.reportStatus,
      reportSummary: s.reportSummary,
      reportArtifact: s.reportArtifact,
      reportDecision: s.reportDecision,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }));
  res.json({ sessions: summary, count: summary.length });
});

app.get("/api/group-sessions/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const store = readGroupStore();
  const found = (store.sessions || []).map(normalizeGroupSession).find((x) => x.id === sessionId);
  if (!found) return res.status(404).json({ error: "Group session not found." });
  res.json({ session: found });
});

app.post("/api/group-sessions", async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || "").trim() || "双人无领导讨论";
  const goal = String(body.goal || "").trim();
  const masterAgentId = String(body.masterAgentId || "").trim();
  const agentA = String(body.agentA || "").trim();
  const agentB = String(body.agentB || "").trim();
  const mode = String(body.mode || "sessions_send").trim() === "sessions_spawn" ? "sessions_spawn" : "sessions_send";
  const maxRounds = Math.max(1, Math.min(20, Number(body.maxRounds) || 6));
  const maxNoProgressRounds = Math.max(1, Math.min(6, Number(body.maxNoProgressRounds) || 2));
  const autoRun = Boolean(body.autoRun);
  if (!goal) return res.status(400).json({ error: "goal is required." });
  if (!parseAgentId(agentA) || !parseAgentId(agentB)) return res.status(400).json({ error: "Invalid agent id." });
  if (masterAgentId && !parseAgentId(masterAgentId)) return res.status(400).json({ error: "Invalid masterAgentId." });
  if (agentA === agentB) return res.status(400).json({ error: "agentA and agentB must be different." });
  if (!getAgentById(agentA) || !getAgentById(agentB)) return res.status(400).json({ error: "Agent not found in current roots." });
  if (masterAgentId && !getAgentById(masterAgentId)) return res.status(400).json({ error: "Master agent not found in current roots." });
  const agentAOccupancy = resolveAgentOccupancy(agentA);
  const agentBOccupancy = resolveAgentOccupancy(agentB);
  if (!agentAOccupancy.assignable || !agentBOccupancy.assignable) {
    return res.status(409).json({
      error: "One of selected agents is unavailable.",
      details: [
        !agentAOccupancy.assignable ? { agentId: agentA, reason: agentAOccupancy.statusReason, status: agentAOccupancy.status } : null,
        !agentBOccupancy.assignable ? { agentId: agentB, reason: agentBOccupancy.statusReason, status: agentBOccupancy.status } : null
      ].filter(Boolean)
    });
  }
  const session = normalizeGroupSession({
    id: `G${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 4)}`,
    title,
    goal,
    masterAgentId,
    agentA,
    agentB,
    status: "draft",
    turnAgentId: agentA,
    turnCount: 0,
    maxRounds,
    maxNoProgressRounds,
    autoRun,
    mode,
    messages: [],
    events: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  appendGroupMessage(session, "system", `讨论目标：${goal}`);
  appendGroupEvent(session, "session_created", { by: "user" });
  await mutateGroupStore(async (store) => {
    store.sessions.push(session);
  });
  res.json({ ok: true, session });
});

app.post("/api/group-sessions/:sessionId/start", async (req, res) => {
  const { sessionId } = req.params;
  const body = req.body || {};
  const autoRun = Object.prototype.hasOwnProperty.call(body, "autoRun") ? Boolean(body.autoRun) : undefined;
  const continueFromClosed = Boolean(body.continueFromClosed);
  const continueTargetRounds = Math.max(1, Math.min(40, Number(body.continueTargetRounds) || Number(body.extraRounds) || 0));
  try {
    const session = await mutateGroupStore(async (store) => {
      const idx = (store.sessions || []).findIndex((x) => String(x.id || "") === sessionId);
      if (idx < 0) return null;
      const cur = normalizeGroupSession(store.sessions[idx]);
      const missingAgents = getMissingGroupAgents(cur);
      if (missingAgents.length > 0) {
        const e = new Error(`Group session has missing agents: ${missingAgents.join(", ")}`);
        e.code = 409;
        throw e;
      }
      const closedStates = new Set(["done", "timeout", "aborted"]);
      const canStartDirect = ["draft", "paused"].includes(cur.status);
      const canContinueClosed = continueFromClosed && closedStates.has(cur.status);
      if (!canStartDirect && !canContinueClosed) {
        const e = new Error(`Session cannot start from status=${cur.status}`);
        e.code = 409;
        throw e;
      }
      const allowExternalResume =
        continueFromClosed ||
        String(cur.status || "") === "paused" ||
        String(cur.status || "") === "running" ||
        ((cur.messages || []).length > 0);
      const occupancyA = resolveAgentOccupancy(cur.agentA, null, null, {
        excludeGroupSessionId: sessionId,
        treatExternalAsAssignable: allowExternalResume
      });
      const occupancyB = resolveAgentOccupancy(cur.agentB, null, null, {
        excludeGroupSessionId: sessionId,
        treatExternalAsAssignable: allowExternalResume
      });
      if (!occupancyA.assignable || !occupancyB.assignable) {
        const e = new Error(
          `Selected agents are unavailable: ${[
            !occupancyA.assignable ? `${cur.agentA}=${occupancyA.statusReason}` : "",
            !occupancyB.assignable ? `${cur.agentB}=${occupancyB.statusReason}` : ""
          ]
            .filter(Boolean)
            .join(" | ")}`
        );
        e.code = 409;
        throw e;
      }
      if (canContinueClosed) {
        const targetRounds = continueTargetRounds > 0 ? continueTargetRounds : cur.round + 1;
        cur.maxRounds = Math.max(cur.maxRounds, targetRounds, cur.round + 1);
        cur.maxTurns = cur.maxRounds * 2;
        cur.noProgressRounds = 0;
        cur.stopReason = "";
        cur.turnAgentId = cur.agentA;
        appendGroupMessage(cur, "system", `继续讨论：目标总轮次调整为 ${cur.maxRounds}。`);
        appendGroupEvent(cur, "session_reopened", { from: cur.status, targetRounds: cur.maxRounds });
      }
      cur.status = "running";
      cur.runStartTurnCount = Number(cur.turnCount || 0);
      if (typeof autoRun === "boolean") cur.autoRun = autoRun;
      cur.updatedAt = nowIso();
      appendGroupEvent(cur, "session_started", { autoRun: cur.autoRun });
      store.sessions[idx] = cur;
      syncGroupParticipantBusyStates(cur, null, store);
      return cur;
    });
    if (!session) return res.status(404).json({ error: "Group session not found." });
    res.json({ ok: true, session });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === "object" && "code" in err ? Number(err.code) : 500;
    res.status(Number.isFinite(code) && code > 0 ? code : 500).json({ error: msg });
  }
});

app.post("/api/group-sessions/:sessionId/pause", async (req, res) => {
  const { sessionId } = req.params;
  const session = await mutateGroupStore(async (store) => {
    const idx = (store.sessions || []).findIndex((x) => String(x.id || "") === sessionId);
    if (idx < 0) return null;
    const cur = normalizeGroupSession(store.sessions[idx]);
    if (cur.status !== "running") return cur;
    cur.status = "paused";
    cur.updatedAt = nowIso();
    appendGroupEvent(cur, "session_paused", { by: "user" });
    store.sessions[idx] = cur;
    syncGroupParticipantBusyStates(cur, null, store);
    return cur;
  });
  if (!session) return res.status(404).json({ error: "Group session not found." });
  res.json({ ok: true, session });
});

app.post("/api/group-sessions/:sessionId/abort", async (req, res) => {
  const { sessionId } = req.params;
  const reason = String((req.body || {}).reason || "").trim() || "aborted_by_user";
  const session = await mutateGroupStore(async (store) => {
    const idx = (store.sessions || []).findIndex((x) => String(x.id || "") === sessionId);
    if (idx < 0) return null;
    const cur = normalizeGroupSession(store.sessions[idx]);
    cur.status = "aborted";
    cur.stopReason = reason;
    cur.updatedAt = nowIso();
    appendGroupEvent(cur, "session_aborted", { reason });
    store.sessions[idx] = cur;
    syncGroupParticipantBusyStates(cur, null, store);
    return cur;
  });
  if (!session) return res.status(404).json({ error: "Group session not found." });
  res.json({ ok: true, session });
});

app.delete("/api/group-sessions/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const deleted = await mutateGroupStore(async (store) => {
    const idx = (store.sessions || []).findIndex((x) => String(x.id || "") === sessionId);
    if (idx < 0) return null;
    const cur = normalizeGroupSession(store.sessions[idx]);
    store.sessions.splice(idx, 1);
    syncGroupParticipantBusyStates(cur, null, store);
    return cur;
  });
  if (!deleted) return res.status(404).json({ error: "Group session not found." });
  res.json({ ok: true, deleted: { id: deleted.id, title: deleted.title } });
});

app.post("/api/group-sessions/:sessionId/export-markdown", async (req, res) => {
  const { sessionId } = req.params;
  const body = req.body || {};
  const fileNameInput = String(body.fileName || "").trim();
  const store = readGroupStore();
  const found = (store.sessions || []).map(normalizeGroupSession).find((x) => x.id === sessionId);
  if (!found) return res.status(404).json({ error: "Group session not found." });
  const markdown = buildGroupSessionMarkdown(found);
  const safeName = slugifyFileName(fileNameInput || found.title || found.id, found.id);
  const fullPath = path.join(groupExportsDir, `${found.id}-${safeName}.md`);
  fs.writeFileSync(fullPath, markdown, "utf8");
  res.json({
    ok: true,
    fileName: path.basename(fullPath),
    fullPath,
    markdown
  });
});

app.post("/api/group-sessions/:sessionId/tick", async (req, res) => {
  const { sessionId } = req.params;
  try {
    const result = await executeGroupSessionTick(sessionId, "api");
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === "object" && "code" in err ? Number(err.code) : 500;
    res.status(Number.isFinite(code) && code > 0 ? code : 500).json({ error: msg });
  }
});

app.post("/api/tasks/decompose", async (req, res) => {
  const body = req.body || {};
  const goal = String(body.goal || "").trim();
  const masterAgentId = String(body.masterAgentId || "").trim();
  const requestedProjectId = String(body.projectId || "").trim();
  const requestedProjectTitle = String(body.projectTitle || "").trim();
  if (!goal) return res.status(400).json({ error: "goal is required." });
  if (!parseAgentId(masterAgentId)) return res.status(400).json({ error: "Invalid masterAgentId." });

  const parsed = parseAgentId(masterAgentId);
  const transport = deriveChatTransport(parsed.source, parsed.dirName);
  const prompt = [
    "你是任务拆解主控。把用户目标拆成可直接认领的任务清单，并按分级流程输出。",
    `目标：${goal}`,
    "",
    "硬约束：",
    "1) 必须使用 level 分级（1,2,3...），同级任务可并行，跨级默认串行",
    "2) 若某任务依赖上一层全部结果，dependency 留空数组（系统会自动补成上一层全部任务）",
    "3) 仅在确需跨级/跨同级依赖时才填写 dependency",
    "4) 每条任务必须单轮可执行",
    "5) 每条 description 必须明确：该任务如何服务总目标、产出什么结果",
    "6) 只返回 JSON，不要任何解释",
    "",
    "注意：不要输出说明文字，不要复述提示词，不要 markdown 代码块。",
    "",
    "输出格式：",
    "{",
    '  "tasks":[',
    "    {",
    '      "title":"任务标题",',
    '      "description":"执行说明",',
    '      "priority":"P0|P1|P2|P3",',
    '      "score":10,',
    '      "issueUrl":"",',
    '      "level":1,',
    '      "dependency":[]',
    "    }",
    "  ]",
    "}",
    "",
    "示例（仅作结构参考）：",
    "{",
    '  "tasks":[',
    '    {"title":"定义目标与边界","description":"明确产出范围","priority":"P0","score":10,"issueUrl":"","level":1,"dependency":[]},',
    '    {"title":"整理核心资料","description":"收集事实素材","priority":"P0","score":10,"issueUrl":"","level":1,"dependency":[]},',
    '    {"title":"产出文章大纲","description":"按素材生成结构","priority":"P0","score":10,"issueUrl":"","level":2,"dependency":[]},',
    '    {"title":"撰写初稿","description":"形成可读正文","priority":"P0","score":10,"issueUrl":"","level":3,"dependency":[]}',
    "  ]",
    "}"
  ].join("\n");

  try {
    let replyText = "";
    if (transport.mode === "bridge") {
      replyText = await sendViaBridge(transport.bridgeRoot, transport.bridgeTo, prompt, "sessions_send");
    } else {
      replyText = await runOpenclawAgentMessage(transport.agentKey, prompt, "sessions_send");
    }

    const rawTaskItems = extractTaskListFromReply(replyText);
    if (!rawTaskItems) {
      return res.status(502).json({ error: "Failed to parse task list from master agent.", replyText });
    }
    const taskItems = normalizeDecomposedTaskItems(rawTaskItems);
    const safeMilestoneTitle = buildSafeMilestoneTitle(goal, taskItems);
    const projectId = requestedProjectId || newProjectId();
    const projectTitle = requestedProjectTitle || safeMilestoneTitle.replace(/^里程碑：/, "").trim() || goal;

    const { milestoneTask, created } = await mutateTaskStore(async (store) => {
      const milestoneId = newTaskId();
      const milestoneTask = {
        id: milestoneId,
        title: safeMilestoneTitle,
        goal,
        projectId,
        projectTitle,
        description: "主虾拆解后的集成里程碑。子任务全部完成后，由主虾统一整合并产出最终结果。",
        issueUrl: "",
        priority: "P0",
        score: 0,
        dependency: [],
        createdBy: masterAgentId,
        level: 1,
        parentTaskId: null,
        gateStatus: "open",
        acceptanceChecklist: [],
        owner: "",
        claimedAt: null,
        claimVersion: 0,
        status: TASK_STATUS.TODO,
        artifact: "",
        nextInput: "",
        summary: "",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      store.tasks.push(milestoneTask);
      appendTaskEvent(store, milestoneTask.id, "milestone_created", { masterAgentId, goal });

      const created = [];
      for (const item of taskItems) {
        const title = String((item || {}).title || "").trim();
        if (!title) continue;
        const priority = String((item || {}).priority || "P1").toUpperCase();
        const task = {
          id: newTaskId(),
          title,
          goalContext: goal,
          projectId,
          projectTitle,
          description: String(item.description || "").trim(),
          issueUrl: String(item.issueUrl || "").trim(),
          priority: ["P0", "P1", "P2", "P3"].includes(priority) ? priority : "P1",
          score: Number.isFinite(Number(item.score)) ? Number(item.score) : 10,
          dependency: Array.isArray(item.dependency) ? item.dependency : [],
          createdBy: masterAgentId,
          level: 2,
          execLevel: Number.isFinite(Number(item.level)) ? Math.floor(Number(item.level)) : 1,
          parentTaskId: milestoneId,
          releaseState:
            (Number.isFinite(Number(item.level)) ? Math.floor(Number(item.level)) : 1) <= 1
              ? TASK_RELEASE_STATE.PUBLISHED
              : TASK_RELEASE_STATE.STAGED,
          gateStatus: "open",
          acceptanceChecklist: [],
          owner: "",
          claimedAt: null,
          claimVersion: 0,
          status:
            (Number.isFinite(Number(item.level)) ? Math.floor(Number(item.level)) : 1) <= 1
              ? TASK_STATUS.READY
              : TASK_STATUS.TODO,
          artifact: "",
          nextInput: "",
          summary: "",
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        store.tasks.push(task);
        appendTaskEvent(store, task.id, "task_created_by_decompose", { masterAgentId });
        created.push(task);
      }
      releaseNextLevelIfReady(store, milestoneId);
      return { milestoneTask, created };
    });
    res.json({
      ok: true,
      project: { id: projectId, title: projectTitle },
      milestone: milestoneTask,
      created,
      replyText
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/heartbeat/jobs", (req, res) => {
  const jobs = readHeartbeatJobs().jobs.map(normalizeHeartbeatJob);
  res.json({ ok: true, ttlMs: taskClaimTtlMs, jobs });
});

app.post("/api/heartbeat/jobs", (req, res) => {
  const body = req.body || {};
  const next = normalizeHeartbeatJob(body);
  if (!parseAgentId(next.agentId)) return res.status(400).json({ error: "Invalid agentId." });
  const payload = readHeartbeatJobs();
  const jobs = (payload.jobs || []).map(normalizeHeartbeatJob);
  const idx = jobs.findIndex((x) => x.agentId === next.agentId);
  if (idx >= 0) {
    jobs[idx] = { ...jobs[idx], ...next, nextRunAt: nowIso() };
  } else {
    jobs.push({ ...next, nextRunAt: nowIso() });
  }
  writeHeartbeatJobs({ jobs });
  res.json({ ok: true, job: jobs.find((x) => x.agentId === next.agentId) });
});

app.delete("/api/heartbeat/jobs/:agentId", (req, res) => {
  const { agentId } = req.params;
  const payload = readHeartbeatJobs();
  const jobs = (payload.jobs || []).map(normalizeHeartbeatJob).filter((x) => x.agentId !== agentId);
  writeHeartbeatJobs({ jobs });
  res.json({ ok: true, agentId });
});

app.post("/api/heartbeat/jobs/:agentId/run", async (req, res) => {
  const { agentId } = req.params;
  const payload = readHeartbeatJobs();
  const jobs = (payload.jobs || []).map(normalizeHeartbeatJob);
  const job = jobs.find((x) => x.agentId === agentId);
  if (!job) return res.status(404).json({ error: "Job not found." });
  try {
    const result = await executeHeartbeatTick(job, "cron_manual");
    const idx = jobs.findIndex((x) => x.agentId === agentId);
    if (idx >= 0) {
      jobs[idx] = {
        ...jobs[idx],
        lastRunAt: nowIso(),
        nextRunAt: new Date(Date.now() + jobs[idx].intervalSec * 1000).toISOString(),
        lastStatus: "ok",
        lastError: "",
        lastTaskId: result?.claimedTaskId || ""
      };
      writeHeartbeatJobs({ jobs });
    }
    return res.json({ ok: true, result });
  } catch (err) {
    const idx = jobs.findIndex((x) => x.agentId === agentId);
    if (idx >= 0) {
      jobs[idx] = {
        ...jobs[idx],
        lastRunAt: nowIso(),
        nextRunAt: new Date(Date.now() + jobs[idx].intervalSec * 1000).toISOString(),
        lastStatus: "failed",
        lastError: err instanceof Error ? err.message : String(err)
      };
      writeHeartbeatJobs({ jobs });
    }
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === "object" && "code" in err ? Number(err.code) : 500;
    return res.status(Number.isFinite(code) && code > 0 ? code : 500).json({ error: msg });
  }
});

app.get("/api/settings/dispatch", (req, res) => {
  const s = readDispatchSettings();
  res.json({ ok: true, ...s });
});

app.put("/api/settings/dispatch", (req, res) => {
  const body = req.body || {};
  const mode = String(body.dispatchMode || dispatchMode).trim().toLowerCase();
  const next = writeDispatchSettings({
    dispatchMode: mode === "agent_pull" ? "agent_pull" : "central",
    centralDispatchIntervalMs: Number(body.centralDispatchIntervalMs) || centralDispatchIntervalMs,
    centralDispatchExclude: Array.isArray(body.centralDispatchExclude)
      ? body.centralDispatchExclude
      : String(body.centralDispatchExclude || Array.from(centralDispatchExclude).join(","))
          .split(/[;,]/)
          .map((x) => x.trim())
          .filter(Boolean)
  });
  nextCentralDispatchAt = Date.now();
  res.json({ ok: true, ...next });
});

function startHeartbeatScheduler() {
  if (heartbeatSchedulerStarted) return;
  heartbeatSchedulerStarted = true;
  setInterval(async () => {
    if (dispatchMode !== "agent_pull") return;
    try {
      const payload = readHeartbeatJobs();
      const jobs = (payload.jobs || []).map(normalizeHeartbeatJob);
      let changed = false;
      for (let i = 0; i < jobs.length; i += 1) {
        const job = jobs[i];
        if (!job.enabled) continue;
        const dueAt = job.nextRunAt ? Date.parse(job.nextRunAt) : 0;
        if (Number.isFinite(dueAt) && dueAt > Date.now()) continue;
        try {
          const result = await executeHeartbeatTick(job, "cron");
          jobs[i] = {
            ...job,
            lastRunAt: nowIso(),
            nextRunAt: new Date(Date.now() + job.intervalSec * 1000).toISOString(),
            lastStatus: "ok",
            lastError: "",
            lastTaskId: result?.claimedTaskId || ""
          };
        } catch (err) {
          jobs[i] = {
            ...job,
            lastRunAt: nowIso(),
            nextRunAt: new Date(Date.now() + job.intervalSec * 1000).toISOString(),
            lastStatus: "failed",
            lastError: err instanceof Error ? err.message : String(err)
          };
        }
        changed = true;
      }
      if (changed) writeHeartbeatJobs({ jobs });
    } catch {}
  }, 15000);
}

function startCentralDispatchScheduler() {
  if (centralDispatchSchedulerStarted) return;
  centralDispatchSchedulerStarted = true;
  nextCentralDispatchAt = Date.now();
  setInterval(async () => {
    if (dispatchMode !== "central") return;
    if (Date.now() < nextCentralDispatchAt) return;
    nextCentralDispatchAt = Date.now() + centralDispatchIntervalMs;
    try {
      const agents = collectAgents()
        .filter((a) => !centralDispatchExclude.has(a.id))
        .filter((a) => String(a.status || "").toLowerCase() !== "offline");
      if (agents.length === 0) return;
      for (const agent of agents) {
        if (inflightHeartbeatAgents.has(agent.id)) continue;
        syncAgentBusyState(agent.id);
        const refreshed = collectAgents().find((x) => x.id === agent.id);
        if (!refreshed) continue;
        const occupancy = resolveAgentOccupancy(refreshed.id);
        if (!occupancy.assignable) continue;
        try {
          await executeHeartbeatTick({ agentId: agent.id, mode: "sessions_send" }, "central_dispatch");
          markRuntimeDispatchOk("central_dispatch", agent.id);
        } catch (err) {
          markRuntimeDispatchError("central_dispatch", agent.id, err);
        }
      }
    } catch {}
  }, 15000);
}

function startGroupChatScheduler() {
  if (groupChatSchedulerStarted) return;
  groupChatSchedulerStarted = true;
  setInterval(async () => {
    try {
      const store = readGroupStore();
      const running = (store.sessions || [])
        .map(normalizeGroupSession)
        .filter((s) => s.status === "running" && s.autoRun);
      for (const s of running) {
        if (inflightGroupSessions.has(s.id)) continue;
        try {
          await executeGroupSessionTick(s.id, "scheduler");
          markRuntimeDispatchOk("discussion_scheduler", s.id);
        } catch (err) {
          markRuntimeDispatchError("discussion_scheduler", s.id, err);
        }
      }
    } catch {}
  }, 8000);
}

function buildRuntimeSnapshot() {
  const taskStore = readTaskStore();
  const groupStore = readGroupStore();
  const normalizedTasks = (taskStore.tasks || []).map(normalizeTaskRecord);
  const normalizedGroups = (groupStore.sessions || []).map(normalizeGroupSession);
  return {
    roots,
    dispatchMode,
    centralDispatchIntervalMs,
    activeTaskCount: normalizedTasks.filter((x) => x.status === TASK_STATUS.EXECUTING).length,
    blockedTaskCount: normalizedTasks.filter((x) => x.status === TASK_STATUS.BLOCKED).length,
    activeDiscussionCount: normalizedGroups.filter((x) => x.status === "running").length,
    heartbeatJobCount: readHeartbeatJobs().jobs.map(normalizeHeartbeatJob).length,
    nextCentralDispatchAt: nextCentralDispatchAt ? new Date(nextCentralDispatchAt).toISOString() : null,
    lastDispatchError: runtimeState.lastDispatchError || "",
    lastDispatchErrorAt: runtimeState.lastDispatchErrorAt,
    lastDispatchSource: runtimeState.lastDispatchSource || "",
    lastDispatchTarget: runtimeState.lastDispatchTarget || "",
    lastDispatchOkAt: runtimeState.lastDispatchOkAt
  };
}

app.get("/health", (req, res) => {
  sendOk(res, {
    ok: true,
    dispatchMode,
    roots,
    sources: sources.map((s) => ({ key: s.key, root: s.root, label: s.label })),
    runtime: buildRuntimeSnapshot()
  });
});

app.listen(port, () => {
  startHeartbeatScheduler();
  startCentralDispatchScheduler();
  startGroupChatScheduler();
  console.log(`[manager-claw] running on http://localhost:${port}`);
  console.log(`[manager-claw] roots: ${roots.join(", ")}`);
  console.log(
    `[manager-claw] dispatch mode: ${dispatchMode} (${dispatchMode === "central" ? `interval=${centralDispatchIntervalMs}ms` : "agent_pull"})`
  );
  console.log(`[manager-claw] claimTTL=${taskClaimTtlMs}ms`);
});
