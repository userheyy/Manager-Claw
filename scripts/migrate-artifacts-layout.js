const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const taskCenterPath = path.join(repoRoot, "data", "task-center.json");
const envPath = path.join(repoRoot, ".env");

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function parseEnv(filePath) {
  const out = {};
  const raw = readText(filePath);
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(s);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function resolveRoots() {
  const env = parseEnv(envPath);
  const fromProc = String(process.env.CLAW_AGENTS_ROOTS || "").trim();
  const roots = [];
  if (fromProc) {
    roots.push(...fromProc.split(/[;,]/).map((x) => x.trim()).filter(Boolean));
  } else {
    const a = String(env.OPENCLAW_AGENTS_HOST_PATH || "").trim();
    const b = String(env.LOCAL_AGENTS_HOST_PATH || "").trim();
    if (a) roots.push(a);
    if (b) roots.push(b);
  }
  roots.push(path.join(repoRoot, "data", "agents"));
  return Array.from(new Set(roots.map((r) => path.resolve(r))));
}

function parseRef(ref) {
  const m = /^clawfs:\/\/(s\d+)\/(.+)$/.exec(String(ref || "").trim());
  if (!m) return null;
  return { sourceKey: m[1], rel: m[2].replace(/\\/g, "/") };
}

function bucketForTask(task) {
  const parent = String(task?.parentTaskId || "").trim();
  const self = String(task?.id || "").trim();
  return (parent || self || "misc").replace(/[^A-Za-z0-9_-]+/g, "_");
}

function main() {
  const store = readJson(taskCenterPath);
  if (!store || !Array.isArray(store.tasks)) {
    console.error("task-center.json missing or invalid");
    process.exit(1);
  }

  const roots = resolveRoots();
  const sourceRootByKey = new Map(roots.map((r, i) => [`s${i + 1}`, r]));
  const tasks = store.tasks;
  const taskById = new Map(tasks.map((t) => [String(t.id || ""), t]));

  let changed = 0;
  let moved = 0;

  for (const task of tasks) {
    const ref = parseRef(task.artifact);
    if (!ref) continue;
    const sourceRoot = sourceRootByKey.get(ref.sourceKey);
    if (!sourceRoot) continue;
    if (!ref.rel.startsWith("artifacts/")) continue;

    const parts = ref.rel.split("/");
    if (parts.length >= 3) continue; // already nested, keep
    const fileName = parts[1];
    if (!fileName) continue;

    const bucket = bucketForTask(taskById.get(String(task.id || "")) || task);
    const nextRel = `artifacts/${bucket}/${fileName}`;
    const from = path.resolve(sourceRoot, ref.rel);
    const to = path.resolve(sourceRoot, nextRel);

    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!fs.existsSync(to)) {
      fs.renameSync(from, to);
      moved += 1;
    }
    task.artifact = `clawfs://${ref.sourceKey}/${nextRel}`;
    changed += 1;
  }

  const tmp = `${taskCenterPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  fs.renameSync(tmp, taskCenterPath);
  console.log(`Done. taskRefsUpdated=${changed}, filesMoved=${moved}`);
}

main();
