const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const templatePath = path.join(repoRoot, "docs", "MANAGER_CLAW_PROTOCOL_V1.md");
const envPath = path.join(repoRoot, ".env");
const sectionHeader = "## Manager-Claw Protocol (MANAGER_CLAW_PROTOCOL_V1)";
const targetNames = ["AGENTS.md", "HEARTBEAT.md", "TASK.md"];

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

function parseEnv(filePath) {
  const out = {};
  const raw = readText(filePath);
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(s);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function normalizeRoot(p) {
  if (!p) return "";
  return path.resolve(p.replace(/\\/g, path.sep));
}

function resolveRoots() {
  const env = parseEnv(envPath);
  const roots = [];
  const fromProc = String(process.env.CLAW_AGENTS_ROOTS || "").trim();
  if (fromProc) {
    for (const x of fromProc.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
      roots.push(normalizeRoot(x));
    }
  } else {
    const openclawPath = String(env.OPENCLAW_AGENTS_HOST_PATH || "").trim();
    const localPath = String(env.LOCAL_AGENTS_HOST_PATH || "").trim();
    if (openclawPath) roots.push(normalizeRoot(openclawPath));
    if (localPath) roots.push(normalizeRoot(localPath));
  }
  roots.push(path.join(repoRoot, "data", "agents"));
  return Array.from(new Set(roots.filter(Boolean)));
}

function findTargetsInRoot(root) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    for (const name of targetNames) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) found.push(p);
    }
  }
  for (const name of targetNames) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) found.push(p);
  }
  return Array.from(new Set(found));
}

function injectProtocol(content, protocol) {
  const clean = content.replace(/\r\n/g, "\n");
  const idx = clean.indexOf(sectionHeader);
  if (idx >= 0) {
    const head = clean.slice(0, idx).trimEnd();
    return `${head}\n\n${protocol}\n`;
  }
  const base = clean.trimEnd();
  return `${base}\n\n---\n\n${protocol}\n`;
}

function main() {
  const protocol = readText(templatePath).trim();
  if (!protocol) {
    console.error(`Template not found or empty: ${templatePath}`);
    process.exit(1);
  }
  const roots = resolveRoots();
  const targets = roots.flatMap(findTargetsInRoot);
  if (targets.length === 0) {
    console.log("No target files found.");
    return;
  }
  let changed = 0;
  for (const filePath of targets) {
    const before = readText(filePath);
    if (!before) continue;
    const after = injectProtocol(before, protocol);
    if (after !== before.replace(/\r\n/g, "\n")) {
      fs.writeFileSync(filePath, after, "utf8");
      changed += 1;
      console.log(`[updated] ${filePath}`);
    } else {
      console.log(`[skip] ${filePath}`);
    }
  }
  console.log(`Done. changed=${changed}, total=${targets.length}`);
}

main();
