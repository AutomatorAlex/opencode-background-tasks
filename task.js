import { tool } from "@opencode-ai/plugin";
import fs from "fs/promises";
import path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";


// --- MOE Auto-Assessment Helpers ---
async function callModelForAssessment(model, prompt) {
  const slashIdx = model.indexOf("/");
  const providerID = slashIdx > -1 ? model.slice(0, slashIdx) : "openai";
  const modelID = slashIdx > -1 ? model.slice(slashIdx + 1) : model;

  const providerConfigs = {
    openai: { url: "https://api.openai.com/v1/chat/completions", key: process.env.OPENAI_API_KEY },
    openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", key: process.env.OPENROUTER_API_KEY },
    anthropic: { url: "https://api.anthropic.com/v1/messages", key: process.env.ANTHROPIC_API_KEY },
  };

  const provider = providerConfigs[providerID];
  if (!provider?.key) throw new Error(`No API key found for provider: ${providerID}`);

  const res = await fetch(provider.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.key}` },
    body: JSON.stringify({
      model: modelID,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return providerID === "anthropic" ? data.content[0].text : data.choices[0].message.content;
}

const assessedMessages = new Set();

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;
const MAX_ASSESSED_MESSAGES = 1000;
const QUESTION_RELAY_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETION_RETRY_INTERVAL_MS = 500;
const COMPLETION_RETRY_MAX_MS = 5000;
const STATE_FILE = "bg-task-state.json";

/**
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export default async (ctx) => {
  const { client } = ctx;
  const rootDirectory = ctx.worktree || ctx.directory;
  const homeDirectory = process.env.HOME || rootDirectory;
  let repositoryRoot = null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", rootDirectory, "rev-parse", "--show-toplevel"], { maxBuffer: MAX_BUFFER });
    repositoryRoot = stdout.trim() || null;
  } catch {}

  const artifactRoot = repositoryRoot
    ? path.join(repositoryRoot, ".opencode")
    : path.join(homeDirectory, ".local", "share", "opencode", "background-task-artifacts");

  const trackedSessions = new Map();
  const reconciliations = new Map();
  const delegatedSessionParents = new Map();
  const taskIdToSessionId = new Map();
  const pendingQuestionRelays = new Map();
  const pendingQuestionRelaysBySession = new Map();
  const agentsDirectory = path.join(homeDirectory, ".config", "opencode", "agents");
  const taskArtifactsDirectory = artifactRoot;
  const worktreesDirectory = path.join(taskArtifactsDirectory, "worktrees");
  const patchesDirectory = path.join(taskArtifactsDirectory, "patches");
  const stateFilePath = path.join(taskArtifactsDirectory, STATE_FILE);
  const RESULT_PREFIX = "__OPENCODE_BACKGROUND_TASK_META__";

  await fs.mkdir(taskArtifactsDirectory, { recursive: true });
  await fs.mkdir(worktreesDirectory, { recursive: true });
  await fs.mkdir(patchesDirectory, { recursive: true });

  function pruneAssessedMessages() {
    if (assessedMessages.size <= MAX_ASSESSED_MESSAGES) return;
    const overflow = assessedMessages.size - MAX_ASSESSED_MESSAGES;
    let removed = 0;
    for (const id of assessedMessages) {
      assessedMessages.delete(id);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  function purgeStaleQuestionRelays() {
    const cutoff = Date.now() - QUESTION_RELAY_TTL_MS;
    for (const relay of pendingQuestionRelays.values()) {
      if ((relay.createdAt || 0) < cutoff) {
        deletePendingQuestionRelay(relay);
      }
    }
  }

  function serializeMap(map) {
    return Array.from(map.entries());
  }

  function deserializeMap(entries) {
    return new Map(Array.isArray(entries) ? entries : []);
  }

  async function persistTaskState() {
    const payload = {
      trackedSessions: serializeMap(trackedSessions),
      reconciliations: serializeMap(reconciliations),
      delegatedSessionParents: serializeMap(delegatedSessionParents),
      taskIdToSessionId: serializeMap(taskIdToSessionId),
      pendingQuestionRelays: serializeMap(pendingQuestionRelays),
    };
    await fs.writeFile(stateFilePath, JSON.stringify(payload, null, 2), "utf8");
  }

  async function loadPersistedTaskState() {
    try {
      const raw = await fs.readFile(stateFilePath, "utf8");
      const parsed = JSON.parse(raw);

      for (const [key, value] of deserializeMap(parsed.trackedSessions)) trackedSessions.set(key, value);
      for (const [key, value] of deserializeMap(parsed.reconciliations)) reconciliations.set(key, value);
      for (const [key, value] of deserializeMap(parsed.delegatedSessionParents)) delegatedSessionParents.set(key, value);
      for (const [key, value] of deserializeMap(parsed.taskIdToSessionId)) taskIdToSessionId.set(key, value);
      for (const [key, value] of deserializeMap(parsed.pendingQuestionRelays)) {
        pendingQuestionRelays.set(key, value);
        if (value?.childSessionID) pendingQuestionRelaysBySession.set(value.childSessionID, value);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("[task] Failed to load persisted task state:", error.message);
      }
    }
  }

  async function withPersistedState(mutator) {
    const result = await mutator();
    await persistTaskState();
    return result;
  }

  async function logApp(level, message, extra = {}) {
    try {
      await client.app.log({
        body: {
          service: "bg_task",
          level,
          message,
          extra,
        },
      });
    } catch {}
  }

  await loadPersistedTaskState();

  function normalizeAgentKey(value = "") {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function parseFrontmatterValue(source, key) {
    const match = source.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim();
  }

  function parseModelString(model) {
    if (!model || !model.includes("/")) return undefined;
    const divider = model.indexOf("/");
    return {
      providerID: model.slice(0, divider),
      modelID: model.slice(divider + 1),
    };
  }

  function uniq(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function toPosixPath(value) {
    return value.split(path.sep).join("/");
  }

  function hasGlobSyntax(value = "") {
    return /[*?{}\[\]]/.test(value);
  }

  function normalizeTarget(target, root = rootDirectory) {
    if (!target) return "";

    const trimmed = target.trim();
    if (!trimmed) return "";

    const looksAbsolute = path.isAbsolute(trimmed);
    const resolved = looksAbsolute ? path.normalize(trimmed) : path.normalize(path.join(root, trimmed));
    const normalizedRoot = path.normalize(root);

    if (resolved.startsWith(normalizedRoot + path.sep) || resolved === normalizedRoot) {
      return toPosixPath(path.relative(normalizedRoot, resolved)) || ".";
    }

    return toPosixPath(trimmed.replace(/^\.\//, ""));
  }

  function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }

  function globToRegExp(pattern) {
    let result = "^";

    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      const next = pattern[index + 1];

      if (char === "*" && next === "*") {
        result += ".*";
        index += 1;
        continue;
      }

      if (char === "*") {
        result += "[^/]*";
        continue;
      }

      if (char === "?") {
        result += "[^/]";
        continue;
      }

      result += escapeRegExp(char);
    }

    result += "$";
    return new RegExp(result);
  }

  function globPrefix(pattern) {
    const match = pattern.match(/^[^*?{\[]+/);
    return match ? match[0].replace(/\/+$/, "") : "";
  }

  function targetsOverlap(left, right) {
    if (!left.length || !right.length) return true;

    for (const first of left) {
      for (const second of right) {
        if (first === second) return true;

        const firstGlob = hasGlobSyntax(first);
        const secondGlob = hasGlobSyntax(second);

        if (!firstGlob && !secondGlob) continue;

        if (firstGlob && !secondGlob && globToRegExp(first).test(second)) return true;
        if (!firstGlob && secondGlob && globToRegExp(second).test(first)) return true;

        if (firstGlob && secondGlob) {
          const firstPrefix = globPrefix(first);
          const secondPrefix = globPrefix(second);
          if (!firstPrefix || !secondPrefix) return true;
          if (firstPrefix.startsWith(secondPrefix) || secondPrefix.startsWith(firstPrefix)) return true;
        }
      }
    }

    return false;
  }

  function describeTargets(targets) {
    if (!targets?.length) return "(no explicit targets)";
    return targets.join(", ");
  }

  function normalizeTargets(targets, root) {
    return uniq((targets || []).map((target) => normalizeTarget(target, root)));
  }

  function isTargetInsideRoot(target, root) {
    if (!target || !root) return false;
    const resolved = path.isAbsolute(target) ? path.normalize(target) : path.normalize(path.join(root, target));
    const normalizedRoot = path.normalize(root);
    return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep);
  }

  async function verifyExternalTargets(targets, root) {
    const externalTargets = (targets || []).filter((target) => !hasGlobSyntax(target) && !isTargetInsideRoot(target, root));
    if (!externalTargets.length) {
      return { externalTargets: [], existingTargets: [] };
    }

    const existingTargets = [];
    for (const target of externalTargets) {
      const resolved = path.isAbsolute(target) ? path.normalize(target) : path.normalize(path.join(root, target));
      try {
        await fs.stat(resolved);
        existingTargets.push(toPosixPath(resolved));
      } catch {}
    }

    return { externalTargets, existingTargets };
  }

  async function verifyExternalTargetsInWorkspace(targets, workspacePath, root) {
    const externalTargets = (targets || []).filter((target) => !hasGlobSyntax(target) && !isTargetInsideRoot(target, root));
    if (!externalTargets.length) {
      return { externalTargets: [], existingTargets: [] };
    }

    const existingTargets = [];
    for (const target of externalTargets) {
      const workspaceRelative = target.replace(/^\/+/, "");
      const candidatePaths = [
        path.join(workspacePath, workspaceRelative),
        path.join(workspacePath, target),
      ];

      for (const candidate of candidatePaths) {
        try {
          await fs.stat(candidate);
          existingTargets.push(toPosixPath(candidate));
          break;
        } catch {}
      }
    }

    return { externalTargets, existingTargets };
  }

  async function verifyExternalTargetsOnHost(targets, root) {
    const externalTargets = (targets || []).filter((target) => !hasGlobSyntax(target) && !isTargetInsideRoot(target, root));
    if (!externalTargets.length) {
      return { externalTargets: [], existingTargets: [] };
    }

    const existingTargets = [];
    for (const target of externalTargets) {
      const resolved = path.isAbsolute(target) ? path.normalize(target) : path.normalize(path.join(root, target));
      try {
        await fs.stat(resolved);
        existingTargets.push(toPosixPath(resolved));
      } catch {}
    }

    return { externalTargets, existingTargets };
  }

  function cleanTargetToken(value = "") {
    return value
      .trim()
      .replace(/^[`'"([{<]+/, "")
      .replace(/[`'"\])}>.,;:!?]+$/, "")
      .replace(/^\.\//, "");
  }

  function looksLikeTargetToken(value = "") {
    if (!value) return false;
    if (value.startsWith("--")) return false;
    if (value.includes("://")) return false;
    if (["HEAD", "true", "false", "null", "undefined"].includes(value)) return false;

    const hasPathSeparator = value.includes("/") || value.includes("\\");
    const hasExtension = /\.[a-z0-9]{1,10}$/i.test(value);
    const hasGlob = hasGlobSyntax(value);
    const hasKnownPrefix = /^(src|app|lib|test|tests|spec|specs|docs|scripts|packages|components|pages|routes|api|db|migrations|plugins|agents)\//.test(value);

    return hasGlob || hasExtension || hasPathSeparator || hasKnownPrefix;
  }

  function extractTargetsFromText(text, root) {
    if (!text) return [];

    const collected = [];
    const quotedPattern = /[`'\"]([^`'\"\n]+)[`'\"]/g;
    for (const match of text.matchAll(quotedPattern)) {
      collected.push(match[1]);
    }

    const tokenPattern = /(^|\s)([^\s]+)/g;
    for (const match of text.matchAll(tokenPattern)) {
      collected.push(match[2]);
    }

    return normalizeTargets(
      collected
        .map(cleanTargetToken)
        .filter(looksLikeTargetToken),
      root,
    );
  }

  function inferTargets({ description, prompt, command }, root) {
    return uniq([
      ...extractTargetsFromText(description, root),
      ...extractTargetsFromText(prompt, root),
      ...extractTargetsFromText(command, root),
    ]).slice(0, 25);
  }

  async function loadAgentCatalog() {
    const entries = await fs.readdir(agentsDirectory);
    const files = entries.filter((entry) => entry.endsWith(".md"));

    const catalog = await Promise.all(
      files.map(async (file) => {
        const name = path.basename(file, ".md");
        const source = await fs.readFile(path.join(agentsDirectory, file), "utf8");
        const descriptionLine = parseFrontmatterValue(source, "description") || "Specialized agent";
        const aliasSection = descriptionLine.match(/also known as:\s*(.+)$/i)?.[1] || "";
        const description = descriptionLine.replace(/\s*also known as:.*$/i, "").trim();
        const aliases = aliasSection
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);

        if (name === "build") aliases.push("code");

        const mode = parseFrontmatterValue(source, "mode");
        return {
          name,
          description,
          variant: parseFrontmatterValue(source, "variant"),
          model: parseModelString(parseFrontmatterValue(source, "model")),
          aliases: Array.from(new Set([name, ...aliases])),
          mode,
        };
      }),
    );

    return catalog
      .filter((agent) => !agent.mode || agent.mode === "all" || agent.mode === "subagent")
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const agentCatalog = await loadAgentCatalog();

  let opencodeConfig = {};
  try {
    const rawConfig = await fs.readFile(path.join(homeDirectory, ".config", "opencode", "opencode.json"), "utf8");
    opencodeConfig = JSON.parse(rawConfig);
  } catch (e) {
    console.error("[task] Failed to read opencode.json for MOE assessment:", e.message);
  }


  function resolveAgent(requestedAgent) {
    const normalized = normalizeAgentKey(requestedAgent);
    return agentCatalog.find((agent) =>
      agent.aliases.some((alias) => normalizeAgentKey(alias) === normalized),
    );
  }

  function buildTaskDescription() {
    const agentList = agentCatalog
      .map((agent) => `- ${agent.name}: ${agent.description}`)
      .join("\n");

    return [
      "Launch a new agent to handle complex, multistep tasks autonomously in the background. This allows the current conversation to continue immediately while the task runs asynchronously. Results are queued back here when complete.",
      "",
      "Selection policy:",
      "- Choose the most specialized agent whose primary mission matches the requested deliverable.",
      "- Base the choice on the main output needed (tests, docs, planning, research, exploration, implementation, frontend, infrastructure, database work, etc.), not just on whether the task broadly involves code.",
      "- Prefer a specialist over a generalist when one agent is clearly a closer semantic match.",
      "- Use build as the fallback for mixed or ambiguous coding work, not as the default for every technical task.",
      "",
      "Concurrency & workspace policy:",
      "- For editing tasks, provide targets whenever possible so the task system can detect overlapping file claims.",
      "- Root sessions can fan out multiple tasks in parallel as long as their claimed targets do not overlap.",
      "- Child sessions cannot delegate further; send follow-on delegation back to the root/orchestrator session.",
      "- If a child session asks a question, the plugin relays it back to the parent session. Answer it with bg_task_question_reply or inspect pending items with bg_task_question_list.",
      "- In non-git workspaces, parallel shared tasks without distinct explicit targets are treated as overlapping. To fan out multiple tasks there, give each task unique targets.",
      "- mode=auto will use the main workspace when claims are non-overlapping, and will prefer an isolated git worktree when file claims are missing or overlapping.",
      "- mode=shared keeps the task in the main workspace and should only be used when you are confident the task will not overlap active edits.",
      "- mode=isolated forces the task into a dedicated git worktree when the project is a git repository.",
      "",
      "Available subagents:",
      agentList,
    ].join("\n");
  }

  function unwrapSessionRecord(result) {
    if (!result || typeof result !== "object") {
      return result;
    }
    if ("data" in result && result.data) {
      return unwrapSessionRecord(result.data);
    }
    if ("info" in result && result.info) {
      return unwrapSessionRecord(result.info);
    }
    return result;
  }

  function requireSessionRecord(result, source) {
    const session = unwrapSessionRecord(result);
    if (!session || typeof session !== "object" || !session.id) {
      const responseError = result && typeof result === "object" && "error" in result && result.error
        ? ` Response error: ${result.error.message || JSON.stringify(result.error)}.`
        : "";
      throw new Error(`${source} did not return a session object with an id.${responseError}`);
    }
    return session;
  }

  function extractParentContinuation(messages) {
    for (const msg of [...messages].reverse()) {
      if (msg.info?.role !== "user") continue;
      if (msg.info?.model) {
        return { agent: msg.info.agent, model: msg.info.model, variant: msg.info.variant };
      }
    }
    for (const msg of [...messages].reverse()) {
      if (msg.info?.role !== "assistant") continue;
      if (msg.info?.providerID && msg.info?.modelID) {
        return {
          agent: msg.info.agent,
          model: { providerID: msg.info.providerID, modelID: msg.info.modelID },
          variant: msg.info.variant,
        };
      }
    }
    const lastUser = [...messages].reverse().find((message) => message.info?.role === "user");
    if (lastUser) {
      return { agent: lastUser.info.agent, model: lastUser.info.model, variant: lastUser.info.variant };
    }
    return {};
  }

  function extractFinalResult(messages) {
    const finalMessage = [...messages].reverse().find((message) => {
      if (message.info?.role !== "assistant") return false;
      if (message.info.error) return true;
      return Boolean(message.info.finish) && !["tool-calls", "unknown"].includes(message.info.finish);
    });

    if (!finalMessage) return null;

    const text = finalMessage.parts
      .filter((part) => part.type === "text" && !part.synthetic)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n");

    const errorMessage = finalMessage.info.error?.data?.message || finalMessage.info.error?.name;

    return {
      errorMessage,
      text: text || (errorMessage ? "" : "Task completed with no text output."),
      agent: finalMessage.info.agent,
      modelID: finalMessage.info.modelID,
    };
  }

  function encodeToolResult({ title, metadata = {}, output }) {
    const payload = Buffer.from(JSON.stringify({ title, metadata }), "utf8").toString("base64");
    return `${RESULT_PREFIX}${payload}\n${output}`;
  }

  function decodeToolResult(output = "") {
    if (!output.startsWith(RESULT_PREFIX)) return null;

    const newline = output.indexOf("\n");
    const encoded = newline === -1 ? output.slice(RESULT_PREFIX.length) : output.slice(RESULT_PREFIX.length, newline);
    const visibleOutput = newline === -1 ? "" : output.slice(newline + 1);

    try {
      const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      return {
        title: parsed?.title,
        metadata: parsed?.metadata || {},
        output: visibleOutput,
      };
    } catch {
      return null;
    }
  }

  async function waitForSessionBootstrap(sessionID, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const { data: messages } = await client.session.messages({
          path: { id: sessionID },
          query: { limit: 5 },
        });

        if (messages?.length) return true;
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  async function runGit(cwd, args) {
    return execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER });
  }

  async function getRepositoryRoot() {
    try {
      const { stdout } = await runGit(rootDirectory, ["rev-parse", "--show-toplevel"]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  function buildWorktreeToken() {
    return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function createIsolatedWorkspace(repositoryRoot) {
    const token = buildWorktreeToken();
    const branchName = `opencode-${token}`;
    const workspacePath = path.join(worktreesDirectory, token);

    await runGit(repositoryRoot, ["worktree", "add", "-b", branchName, workspacePath, "HEAD"]);

    return {
      workspacePath,
      branchName,
      baseRef: "HEAD",
    };
  }

  async function safeRemoveWorktree(repositoryRoot, workspacePath) {
    if (!repositoryRoot || !workspacePath) return;
    await runGit(repositoryRoot, ["worktree", "remove", "--force", workspacePath]);
  }

  async function safeDeleteBranch(repositoryRoot, branchName) {
    if (!repositoryRoot || !branchName) return;
    await runGit(repositoryRoot, ["branch", "-D", branchName]);
  }

  function findConflicts(targets, sessionToIgnore) {
    const conflicts = [];

    for (const [sessionID, tracked] of trackedSessions.entries()) {
      if (sessionID === sessionToIgnore) continue;
      if (tracked.status !== "active") continue;
      if (targetsOverlap(targets, tracked.claimedTargets)) {
        conflicts.push({
          sessionID,
          title: tracked.title,
          mode: tracked.effectiveMode,
          targets: tracked.claimedTargets,
        });
      }
    }

    return conflicts;
  }

  async function listTrackedFiles(cwd) {
    const [diffResult, untrackedResult] = await Promise.allSettled([
      runGit(cwd, ["diff", "--name-only", "HEAD"]),
      runGit(cwd, ["ls-files", "--others", "--exclude-standard"]),
    ]);

    const changed = [];

    if (diffResult.status === "fulfilled") {
      changed.push(...diffResult.value.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    }

    if (untrackedResult.status === "fulfilled") {
      changed.push(...untrackedResult.value.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    }

    return uniq(changed.map((file) => toPosixPath(file)));
  }

  async function collectCompletionArtifacts(tracked) {
    const artifact = {
      changedFiles: [],
      patchPath: undefined,
      reconcileStatus: undefined,
      verificationStatus: "summary-only",
      externalTargets: [],
    };

    const externalCheckRoot = tracked.repositoryRoot || rootDirectory;
    const claimedTargets = tracked.claimedTargets || [];
    const [workspaceExternalVerification, hostExternalVerification] = await Promise.all([
      tracked.workspacePath
        ? verifyExternalTargetsInWorkspace(claimedTargets, tracked.workspacePath, externalCheckRoot)
        : Promise.resolve({ externalTargets: [], existingTargets: [] }),
      verifyExternalTargetsOnHost(claimedTargets, externalCheckRoot),
    ]);
    const externalTargets = uniq([
      ...workspaceExternalVerification.existingTargets,
      ...hostExternalVerification.existingTargets,
    ]);
    artifact.externalTargets = externalTargets;

    if (tracked.effectiveMode === "shared" && tracked.repositoryRoot) {
      try {
        const changedFiles = await listTrackedFiles(tracked.repositoryRoot);
        artifact.changedFiles = changedFiles;
        if (changedFiles.length) {
          artifact.reconcileStatus = "shared-unverified";
          artifact.verificationStatus = "workspace-verified";
        } else if (externalTargets.length) {
          artifact.reconcileStatus = "external-only";
          artifact.verificationStatus = "external-target-verified";
        } else {
          artifact.reconcileStatus = "no-changes";
          artifact.verificationStatus = "no-changes";
        }
      } catch {
        artifact.changedFiles = tracked.claimedTargets || [];
        artifact.reconcileStatus = artifact.changedFiles.length ? "shared-unverified" : "summary-only";
      }
      return artifact;
    }

    if (tracked.effectiveMode !== "isolated" || !tracked.workspacePath || !tracked.repositoryRoot) {
      artifact.changedFiles = tracked.claimedTargets || [];
      return artifact;
    }

    const changedFiles = await listTrackedFiles(tracked.workspacePath);
    artifact.changedFiles = changedFiles;

    if (!changedFiles.length) {
      if (externalTargets.length) {
        artifact.reconcileStatus = "external-only";
        artifact.verificationStatus = "external-target-verified";
      } else {
        artifact.reconcileStatus = "no-changes";
        artifact.verificationStatus = "no-changes";
      }
      return artifact;
    }

    const baseRef = tracked.baseRef || "HEAD";
    const [headDiffResult, worktreeDiffResult] = await Promise.all([
      runGit(tracked.workspacePath, ["diff", "--binary", `${baseRef}..HEAD`]).catch(() => ({ stdout: "" })),
      runGit(tracked.workspacePath, ["diff", "--binary", "HEAD"]).catch(() => ({ stdout: "" })),
    ]);
    const stdout = [headDiffResult.stdout, worktreeDiffResult.stdout].filter(Boolean).join("\n");
    const patchPath = path.join(patchesDirectory, `${tracked.sessionID}.patch`);

    if (!stdout.trim()) {
      artifact.reconcileStatus = changedFiles.length ? "needs-attention" : "no-changes";
      artifact.verificationStatus = changedFiles.length ? "artifact-mismatch" : "no-changes";
      return artifact;
    }

    await fs.writeFile(patchPath, stdout, "utf8");

    artifact.patchPath = patchPath;
    artifact.reconcileStatus = "pending";
    artifact.verificationStatus = "artifact-verified";
    return artifact;
  }

  function formatReconciliation(record) {
    if (!record) return "Task not found.";

    const lines = [
      `Task: ${record.title}`,
      `Session: opencode://session/${record.sessionID}`,
      `Mode: ${record.effectiveMode}`,
      `Targets: ${describeTargets(record.claimedTargets)}`,
    ];

    if (record.targetSource) lines.push(`Target source: ${record.targetSource}`);
    if (record.workspacePath) lines.push(`Worktree: ${record.workspacePath}`);
    if (record.branchName) lines.push(`Branch: ${record.branchName}`);
    if (record.changedFiles?.length) lines.push(`Changed files: ${record.changedFiles.join(", ")}`);
    if (record.externalTargets?.length) lines.push(`External targets: ${record.externalTargets.join(", ")}`);
    if (record.patchPath) lines.push(`Patch: ${record.patchPath}`);
    if (record.verificationStatus) lines.push(`Verification: ${record.verificationStatus}`);
    if (record.reconcileStatus) lines.push(`Reconcile status: ${record.reconcileStatus}`);

    return lines.join("\n");
  }

  function taskAliasesForSession(sessionID) {
    return Array.from(taskIdToSessionId.entries())
      .filter(([, mappedSessionID]) => mappedSessionID === sessionID)
      .map(([taskID]) => taskID);
  }

  function formatQuestionPrompt(question, index) {
    const lines = [`Q${index + 1}. ${question.question}`];
    if (question.header) lines.push(`   Header: ${question.header}`);
    lines.push(`   Multiple: ${question.multiple ? "yes" : "no"}`);
    lines.push(`   Custom answers: ${question.custom === false ? "no" : "yes"}`);

    if (question.options?.length) {
      lines.push(`   Options: ${question.options.map((option) => option.label).join(" | ")}`);
      for (const option of question.options) {
        if (option.description) {
          lines.push(`     - ${option.label}: ${option.description}`);
        }
      }
    } else {
      lines.push("   Options: (custom answer only)");
    }

    return lines;
  }

  function formatQuestionRelay(relay, { includeInstructions = false } = {}) {
    const lines = [
      `Task: ${relay.title}`,
      `Child session: opencode://session/${relay.childSessionID}`,
      `Request ID: ${relay.requestID}`,
    ];

    if (relay.taskIDs?.length) {
      lines.push(`Logical task IDs: ${relay.taskIDs.join(", ")}`);
    }

    for (const [index, question] of relay.questions.entries()) {
      lines.push(...formatQuestionPrompt(question, index));
    }

    if (includeInstructions) {
      lines.push(
        "",
        "Use bg_task_question_reply from this parent session after the user answers.",
        "Use bg_task_question_list to review all pending background-task questions.",
      );
    }

    return lines.join("\n");
  }

  function visibleQuestionRelays(parentSessionID, includeAll = false) {
    return Array.from(pendingQuestionRelays.values())
      .filter((relay) => includeAll || !parentSessionID || relay.parentSessionID === parentSessionID)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  function setPendingQuestionRelay(relay) {
    pendingQuestionRelays.set(relay.requestID, relay);
    pendingQuestionRelaysBySession.set(relay.childSessionID, relay);
  }

  function deletePendingQuestionRelay(relayOrRequestID) {
    const relay = typeof relayOrRequestID === "string"
      ? pendingQuestionRelays.get(relayOrRequestID)
      : relayOrRequestID;

    const requestID = typeof relayOrRequestID === "string" ? relayOrRequestID : relayOrRequestID?.requestID;
    if (requestID) pendingQuestionRelays.delete(requestID);
    if (relay?.childSessionID) pendingQuestionRelaysBySession.delete(relay.childSessionID);
  }

  async function getCompletionResultWithRetry(childSessionID) {
    const deadline = Date.now() + COMPLETION_RETRY_MAX_MS;

    while (Date.now() <= deadline) {
      const { data: messages } = await client.session.messages({ path: { id: childSessionID }, query: { limit: 50 } });
      const result = extractFinalResult(messages);
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, COMPLETION_RETRY_INTERVAL_MS));
    }

    return null;
  }

  function removeDelegationStateForSession(sessionID) {
    delegatedSessionParents.delete(sessionID);
  }

  function removeTaskMappingsForSession(sessionID) {
    for (const [taskID, mappedSessionID] of taskIdToSessionId.entries()) {
      if (mappedSessionID === sessionID) taskIdToSessionId.delete(taskID);
    }
  }

  async function markTaskNeedsAttention(tracked, childSessionID, reason, artifacts = {}) {
    const record = {
      ...tracked,
      ...artifacts,
      sessionID: childSessionID,
      status: "needs_attention",
      reconcileStatus: artifacts.reconcileStatus || "needs-attention",
      verificationStatus: artifacts.verificationStatus || "needs-attention",
      completedAt: Date.now(),
      attentionReason: reason,
    };

    trackedSessions.delete(childSessionID);
    removeDelegationStateForSession(childSessionID);
    reconciliations.set(childSessionID, record);
    await persistTaskState();

    await client.session.prompt({
      path: { id: tracked.parentSessionID },
      body: {
        parts: [{
          type: "text",
          text: [
            `⚠ Background Task Needs Attention: ${tracked.title}`,
            `Session: opencode://session/${childSessionID}`,
            "────────────────────",
            reason,
            artifacts.verificationStatus ? `Verification: ${artifacts.verificationStatus}` : undefined,
            artifacts.reconcileStatus ? `Reconcile status: ${artifacts.reconcileStatus}` : undefined,
            artifacts.changedFiles?.length ? `Changed files: ${artifacts.changedFiles.join(", ")}` : undefined,
            artifacts.patchPath ? `Patch: ${artifacts.patchPath}` : undefined,
          ].filter(Boolean).join("\n"),
        }],
        noReply: false,
        agent: tracked.parentAgent,
        model: tracked.parentModel,
        variant: tracked.parentVariant,
        system: "This is an asynchronous background task reliability warning from the task plugin. The task may have incomplete or unverifiable results. Review it before trusting the output.",
      },
    });
  }

  function normalizeQuestionAnswers(answers) {
    if (!Array.isArray(answers)) return [];

    return answers.map((answer) => {
      const values = Array.isArray(answer) ? answer : [answer];
      return uniq(
        values
          .map((value) => (typeof value === "string" ? value : String(value ?? "")))
          .map((value) => value.trim())
          .filter(Boolean),
      );
    });
  }

  function resolveQuestionRelay({ request_id, task_id }, parentSessionID) {
    if (request_id) {
      const relay = pendingQuestionRelays.get(request_id);
      if (!relay) {
        throw new Error(`Unknown request_id: ${request_id}`);
      }
      if (parentSessionID && relay.parentSessionID !== parentSessionID) {
        throw new Error(`Question ${request_id} belongs to a different parent session.`);
      }
      return relay;
    }

    if (!task_id) {
      throw new Error("Provide either request_id or task_id.");
    }

    const resolvedTaskSessionID = taskIdToSessionId.get(task_id) || task_id;
    const allMatches = Array.from(pendingQuestionRelays.values()).filter((relay) => relay.childSessionID === resolvedTaskSessionID);
    const matches = allMatches.filter((relay) => {
      if (relay.childSessionID !== resolvedTaskSessionID) return false;
      if (parentSessionID && relay.parentSessionID !== parentSessionID) return false;
      return true;
    });

    if (!matches.length && allMatches.length && parentSessionID) {
      throw new Error(`Pending question for ${task_id} belongs to a different parent session.`);
    }

    if (!matches.length) {
      throw new Error(`No pending background-task question found for task_id: ${task_id}`);
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple pending questions are waiting for ${task_id}. Use request_id instead: ${matches.map((relay) => relay.requestID).join(", ")}`,
      );
    }

    return matches[0];
  }

  async function notifyParentOfQuestion(relay) {
    await client.session.prompt({
      path: { id: relay.parentSessionID },
      body: {
        parts: [
          {
            type: "text",
            text: [
              "A background task is blocked waiting for user input.",
              "",
              formatQuestionRelay(relay, { includeInstructions: true }),
            ].join("\n"),
          },
        ],
        noReply: false,
        agent: relay.parentAgent,
        model: relay.parentModel,
        variant: relay.parentVariant,
        system: "This is an asynchronous background-task question notice. A child session is waiting for user input. Ask the user for the answer here, then use bg_task_question_reply to send the answer back to the blocked child session. If multiple background questions are pending, inspect them with bg_task_question_list before replying.",
      },
    });
  }

  async function cleanupReconciliation(record) {
    if (!record?.repositoryRoot || !record?.workspacePath) {
      return "✗ Task has no recorded isolated worktree to clean up.";
    }

    if (!["applied", "no-changes", "external-only", "cleaned"].includes(record.reconcileStatus || "")) {
      return `✗ Refusing cleanup for ${record.title} because reconcile status is ${record.reconcileStatus || "pending"}. Apply or inspect it first.`;
    }

    if (record.reconcileStatus === "cleaned") {
      return `✓ Worktree for task ${record.sessionID} has already been cleaned up.`;
    }

    const cleanupErrors = [];
    try {
      await safeRemoveWorktree(record.repositoryRoot, record.workspacePath);
    } catch (error) {
      cleanupErrors.push(`worktree: ${error.message}`);
    }
    try {
      await safeDeleteBranch(record.repositoryRoot, record.branchName);
    } catch (error) {
      cleanupErrors.push(`branch: ${error.message}`);
    }

    if (cleanupErrors.length) {
      record.reconcileStatus = "cleanup-failed";
      reconciliations.set(record.sessionID, record);
      await persistTaskState();
      return [
        `✗ Failed to fully clean up isolated worktree for ${record.title}.`,
        ...cleanupErrors,
      ].join("\n");
    }

    record.reconcileStatus = "cleaned";
    record.cleanedAt = Date.now();
    record.workspaceRemoved = true;
    reconciliations.set(record.sessionID, record);
    removeTaskMappingsForSession(record.sessionID);
    removeDelegationStateForSession(record.sessionID);
    await persistTaskState();

    return [
      `✓ Cleaned up isolated worktree for ${record.title}.`,
      `Session: opencode://session/${record.sessionID}`,
      `Branch removed: ${record.branchName || "(none)"}`,
      `Patch retained: ${record.patchPath || "(none)"}`,
    ].join("\n");
  }

  async function queueCompletion(tracked, childSessionID) {
    if (tracked.completionQueued) return;
    if (pendingQuestionRelaysBySession.has(childSessionID)) return;
    tracked.completionQueued = true;

    const result = await getCompletionResultWithRetry(childSessionID);
    if (!result) {
      const artifacts = await collectCompletionArtifacts(tracked);
      tracked.completionQueued = false;
      await markTaskNeedsAttention(tracked, childSessionID, "Session went idle but no final result was persisted before retry timeout.", artifacts);
      return;
    }

    const artifacts = await collectCompletionArtifacts(tracked);
    if (artifacts.reconcileStatus === "needs-attention" || artifacts.reconcileStatus === "verification-failed") {
      tracked.completionQueued = false;
      await markTaskNeedsAttention(tracked, childSessionID, "Task completed with unverifiable artifacts. Review patch/worktree manually.", artifacts);
      return;
    }

    const reconciliationRecord = {
      ...tracked,
      ...artifacts,
      sessionID: childSessionID,
      completedAt: Date.now(),
    };

    const header = result.errorMessage ? "✗ Background Task Failed" : "✓ Background Task Completed";
    const footer = [];

    footer.push(`Mode: ${tracked.effectiveMode}`);
    footer.push(`Target source: ${tracked.targetSource || "none"}`);
    if (tracked.claimedTargets?.length) footer.push(`Targets: ${tracked.claimedTargets.join(", ")}`);
    if (tracked.workspacePath) footer.push(`Worktree: ${tracked.workspacePath}`);
    if (artifacts.changedFiles?.length) footer.push(`Changed files: ${artifacts.changedFiles.join(", ")}`);
    if (artifacts.verificationStatus) footer.push(`Verification: ${artifacts.verificationStatus}`);
    if (artifacts.reconcileStatus) footer.push(`Reconcile status: ${artifacts.reconcileStatus}`);
    if (artifacts.patchPath) {
      footer.push(`Patch: ${artifacts.patchPath}`);
      footer.push(`Reconcile: bg_task_reconcile(task_id: "${childSessionID}", action: "status" | "apply" | "cleanup")`);
    }

    const text = [
      `${header}: ${tracked.title}`,
      `Session: opencode://session/${childSessionID}`,
      "────────────────────",
      result.errorMessage ? result.errorMessage : result.text,
      footer.length ? "" : undefined,
      ...footer,
    ].filter(Boolean).join("\n");

    await client.session.prompt({
      path: { id: tracked.parentSessionID },
      body: {
        parts: [{ type: "text", text }],
        noReply: false,
        agent: tracked.parentAgent,
        model: tracked.parentModel,
        variant: tracked.parentVariant,
        system: "This is an asynchronous background task completion notice from the task plugin. Use the completed result below as fresh context for the existing conversation and continue naturally without changing the current session behavior.",
      },
    });

    tracked.status = "completed";
    trackedSessions.delete(childSessionID);
    removeDelegationStateForSession(childSessionID);
    if (reconciliationRecord.effectiveMode === "isolated") {
      reconciliations.set(childSessionID, reconciliationRecord);
    }
    await persistTaskState();
  }

  return {
    tool: {
      bg_task: tool({
        description: buildTaskDescription(),
        args: {
          prompt: tool.schema.string().describe("The task for the agent to perform."),
          subagent_type: tool.schema.string().describe("The type of specialized agent to use for this task."),
          description: tool.schema.string().describe("A short (3-5 words) description of the task."),
          command: tool.schema.string().optional().describe("The command that triggered this task."),
          task_id: tool.schema.string().optional().describe("A logical task identifier. If a session was previously created with this task_id, it will be reused. Otherwise a new session is created and mapped to this ID."),
          targets: tool.schema.array(tool.schema.string()).optional().describe("Expected files or globs this task may edit. Strongly recommended for coding tasks so overlap detection can work."),
          mode: tool.schema.enum(["auto", "shared", "isolated"]).optional().describe("Workspace mode. auto chooses shared vs isolated based on overlap risk. shared uses the main workspace. isolated uses a dedicated git worktree."),
        },
        async execute({ prompt, subagent_type, description, command, task_id, targets = [], mode = "auto" }, context) {
          const parentSessionID = context.sessionID;
          let createdWorkspace;

          try {
            if (!parentSessionID) {
              return "✗ Task delegation requires a valid parent session ID.";
            }

            let isDelegatedChildSession = delegatedSessionParents.has(parentSessionID)
              || trackedSessions.has(parentSessionID)
              || reconciliations.has(parentSessionID);

            if (!isDelegatedChildSession) {
              try {
                const currentSessionResult = await client.session.get({ path: { id: parentSessionID } });
                const currentSession = unwrapSessionRecord(currentSessionResult);
                isDelegatedChildSession = Boolean(currentSession?.parentID);
              } catch {}
            }

            if (isDelegatedChildSession) {
              return [
                "✗ Child sessions cannot delegate further.",
                "Return to the root/orchestrator session to launch additional tasks.",
              ].join("\n");
            }

            const { data: parentMessages } = await client.session.messages({
              path: { id: parentSessionID },
              query: { limit: 20 },
            });
            const parentContinuation = extractParentContinuation(parentMessages);

            const title = description?.trim() || prompt.slice(0, 50);
            const resolvedAgent = resolveAgent(subagent_type);
            if (!resolvedAgent) {
              const availableAgents = agentCatalog.map((agent) => agent.name).join(", ");
              return `✗ Unknown agent type: ${subagent_type}. Available agents: ${availableAgents}`;
            }

            const selectedAgent = resolvedAgent.name;
            const selectedModel = resolvedAgent.model || parentContinuation.model;
            const selectedVariant = resolvedAgent.variant || parentContinuation.variant;
            const repositoryRoot = await getRepositoryRoot();
            const explicitTargets = normalizeTargets(targets, repositoryRoot || rootDirectory);
            const inferredTargets = explicitTargets.length ? [] : inferTargets({ description, prompt, command }, repositoryRoot || rootDirectory);
            const claimedTargets = explicitTargets.length ? explicitTargets : inferredTargets;
            const targetSource = explicitTargets.length ? "explicit" : inferredTargets.length ? "inferred" : "none";
            const resolvedTaskSessionId = task_id ? taskIdToSessionId.get(task_id) || task_id : null;
            const existingState = resolvedTaskSessionId ? trackedSessions.get(resolvedTaskSessionId) || reconciliations.get(resolvedTaskSessionId) : null;
            const conflicts = findConflicts(claimedTargets, resolvedTaskSessionId);

            let effectiveMode = existingState?.effectiveMode || mode;
            if (!existingState && mode === "auto") {
              const needsIsolation = Boolean(repositoryRoot) && (conflicts.length > 0 || (!claimedTargets.length && trackedSessions.size > 0));
              effectiveMode = needsIsolation ? "isolated" : "shared";
            }

            if (effectiveMode === "shared" && conflicts.length > 0) {
              const response = [
                `✗ Task target conflict for ${title}.`,
                `Conflicts: ${conflicts.map((item) => `${item.title} [${describeTargets(item.targets)}]`).join("; ")}`,
              ];

              if (!repositoryRoot) {
                if (!claimedTargets.length) {
                  response.push(
                    "This workspace is not a git repository, so shared tasks without explicit targets are treated as overlapping after the first launch.",
                  );
                  response.push(
                    "To fan out multiple root tasks here, give each task distinct explicit targets or run them sequentially.",
                  );
                } else {
                  response.push(
                    "This workspace is not a git repository, so shared tasks must keep their explicit targets disjoint.",
                  );
                  response.push("Retry with distinct targets, or run conflicting tasks sequentially.");
                }
              } else {
                response.push('Retry with mode: "isolated" or provide more precise targets.');
              }

              return response.join("\n");
            }

            if (effectiveMode === "isolated" && !repositoryRoot) {
              return "✗ Isolated task mode requires the current project to be a git repository.";
            }

            let workspacePath = existingState?.workspacePath;
            let branchName = existingState?.branchName;
            let baseRef = existingState?.baseRef;

            if (!workspacePath && effectiveMode === "isolated") {
              createdWorkspace = await createIsolatedWorkspace(repositoryRoot);
              workspacePath = createdWorkspace.workspacePath;
              branchName = createdWorkspace.branchName;
              baseRef = createdWorkspace.baseRef;
            }

            let session;
            if (task_id && taskIdToSessionId.has(task_id)) {
              const realSessionId = taskIdToSessionId.get(task_id);
              const result = await client.session.get({ path: { id: realSessionId } });
              session = requireSessionRecord(result, "session.get");
            } else {
              const request = {
                body: {
                  parentID: parentSessionID,
                  title: `[Background] ${title}`,
                },
                ...(workspacePath ? { query: { directory: workspacePath } } : {}),
              };

              const result = await client.session.create(request);
              session = requireSessionRecord(result, "session.create");
            }

            const tracked = {
              sessionID: session.id,
              parentSessionID,
              title,
              parentAgent: parentContinuation.agent,
              parentModel: parentContinuation.model,
              parentVariant: parentContinuation.variant,
              completionQueued: false,
              claimedTargets,
              targetSource,
              requestedMode: mode,
              effectiveMode,
              repositoryRoot,
              workspacePath,
              branchName,
              baseRef,
              status: "active",
              conflicts: conflicts.map((item) => ({ sessionID: item.sessionID, title: item.title })),
            };

            await withPersistedState(async () => {
              delegatedSessionParents.set(session.id, parentSessionID);
              trackedSessions.set(session.id, tracked);
              if (task_id) {
                taskIdToSessionId.set(task_id, session.id);
              }
            });

            await client.session.promptAsync({
              path: { id: session.id },
              body: {
                agent: selectedAgent,
                ...(selectedModel ? { model: selectedModel } : {}),
                ...(selectedVariant ? { variant: selectedVariant } : {}),
                parts: [{ type: "text", text: prompt }],
              },
            });

            await waitForSessionBootstrap(session.id);

            return encodeToolResult({
              title,
              metadata: {
                sessionId: session.id,
                ...(selectedModel ? { model: selectedModel } : {}),
                background: true,
                mode: effectiveMode,
                targets: claimedTargets,
                targetSource,
                ...(workspacePath ? { workspacePath } : {}),
              },
              output: [
                `✓ Task delegated and running in background.`,
                `Track it here: opencode://session/${session.id}`,
                `Mode: ${effectiveMode}`,
                `Targets (${targetSource}): ${describeTargets(claimedTargets)}`,
                ...(workspacePath ? [`Worktree: ${workspacePath}`] : []),
                ...(conflicts.length ? [`Conflict avoidance: isolated from ${conflicts.map((item) => item.title).join(", ")}`] : []),
              ].join("\n"),
            });
          } catch (error) {
            if (createdWorkspace) {
              const repoRoot = await getRepositoryRoot();
              try {
                await safeRemoveWorktree(repoRoot, createdWorkspace.workspacePath);
              } catch (cleanupError) {
                await logApp("warn", "Failed to remove worktree after delegation error", { error: cleanupError.message, workspacePath: createdWorkspace.workspacePath });
              }
              try {
                await safeDeleteBranch(repoRoot, createdWorkspace.branchName);
              } catch (cleanupError) {
                await logApp("warn", "Failed to delete branch after delegation error", { error: cleanupError.message, branchName: createdWorkspace.branchName });
              }
            }
            return `✗ Failed to delegate task: ${error.message}`;
          }
        },
      }),
      bg_task_list: tool({
        description: "List all active background tasks and any completed isolated tasks waiting for reconciliation.",
        args: {},
        async execute() {
          const active = Array.from(trackedSessions.values()).map((data) => {
            return [
              `• ${data.title}`,
              `  session: opencode://session/${data.sessionID}`,
              `  mode: ${data.effectiveMode}`,
              `  targets (${data.targetSource || "none"}): ${describeTargets(data.claimedTargets)}`,
              ...(data.workspacePath ? [`  worktree: ${data.workspacePath}`] : []),
            ].join("\n");
          });

          const pending = Array.from(reconciliations.values()).map((data) => {
            return [
              `• ${data.title}`,
              `  session: opencode://session/${data.sessionID}`,
              `  reconcile: ${data.reconcileStatus || "pending"}`,
              `  targets (${data.targetSource || "none"}): ${describeTargets(data.claimedTargets)}`,
              ...(data.patchPath ? [`  patch: ${data.patchPath}`] : []),
              ...(data.changedFiles?.length ? [`  changed: ${data.changedFiles.join(", ")}`] : []),
            ].join("\n");
          });

          if (!active.length && !pending.length) return "No active background tasks.";

          return [
            active.length ? `Active background tasks\n${active.join("\n")}` : undefined,
            pending.length ? `Pending reconciliation\n${pending.join("\n")}` : undefined,
          ].filter(Boolean).join("\n\n");
        },
      }),
      bg_task_reconcile: tool({
        description: "Inspect or apply the recorded patch from an isolated background task back onto the main workspace.",
        args: {
          task_id: tool.schema.string().describe("The task session ID to inspect or reconcile."),
          action: tool.schema.enum(["status", "apply", "cleanup"]).describe("status shows the recorded reconciliation metadata. apply attempts to apply the recorded patch back onto the main workspace using git apply --3way. cleanup removes a reconciled isolated worktree and its branch while retaining the patch artifact."),
        },
        async execute({ task_id, action }) {
          const resolvedId = taskIdToSessionId.get(task_id) || task_id;
          const record = reconciliations.get(resolvedId) || trackedSessions.get(resolvedId);
          if (!record) return `✗ Unknown task_id: ${task_id} (resolved: ${resolvedId})`;

          if (action === "status") {
            return formatReconciliation(record);
          }

          if (action === "cleanup") {
            return cleanupReconciliation(record);
          }

          if (record.effectiveMode !== "isolated") {
            return `✗ Task ${task_id} does not use isolated worktree mode.`;
          }

          if (!record.patchPath || !record.repositoryRoot) {
            return `✗ Task ${task_id} has no recorded patch to apply.`;
          }

          try {
            const patchStat = await fs.stat(record.patchPath);
            if (!patchStat.size) {
              return `✗ Task ${task_id} patch artifact is empty.`;
            }
          } catch (error) {
            return `✗ Task ${task_id} patch artifact is unavailable: ${error.message}`;
          }

          if (record.reconcileStatus === "applied") {
            return `✓ Patch for task ${task_id} has already been applied.`;
          }

          const overlappingChanges = record.changedFiles?.length
            ? await runGit(record.repositoryRoot, ["status", "--porcelain", "--", ...record.changedFiles]).then((result) =>
                result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
              )
            : [];

          if (overlappingChanges.length) {
            return [
              `✗ Cannot apply task ${task_id} because the main workspace already has overlapping changes.`,
              ...overlappingChanges,
            ].join("\n");
          }

          try {
            await runGit(record.repositoryRoot, ["apply", "--3way", record.patchPath]);
            record.reconcileStatus = "applied";
            record.reconciledAt = Date.now();
            reconciliations.set(resolvedId, record);
            await persistTaskState();
            return [
              `✓ Applied isolated task patch for ${record.title}.`,
              `Patch: ${record.patchPath}`,
              `Worktree retained for audit: ${record.workspacePath}`,
            ].join("\n");
          } catch (error) {
            return `✗ Failed to apply task patch: ${error.message}`;
          }
        },
      }),
      bg_task_question_list: tool({
        description: "List pending background-task questions from child sessions. By default this is scoped to the current parent session.",
        args: {
          all: tool.schema.boolean().optional().describe("Set true to list pending questions across all parent sessions instead of only the current one."),
        },
        async execute({ all = false }, context) {
          const relays = visibleQuestionRelays(context.sessionID, all);
          if (!relays.length) return "No pending background-task questions.";

          return relays
            .map((relay) => [
              formatQuestionRelay(relay),
              `Reply with: bg_task_question_reply(request_id: "${relay.requestID}", action: "reply", answers: [["..."]])`,
            ].join("\n"))
            .join("\n\n────────────────────\n\n");
        },
      }),
      bg_task_question_reply: tool({
        description: "Reply to or reject a pending background-task question from a child session without opening that child session.",
        args: {
          request_id: tool.schema.string().optional().describe("The pending question request ID from bg_task_question_list."),
          task_id: tool.schema.string().optional().describe("Optional logical task ID or child session ID. Use this instead of request_id when there is only one pending question for that task."),
          action: tool.schema.enum(["reply", "reject"]).describe("reply sends answers back to the blocked child session. reject dismisses the pending question."),
          answers: tool.schema.array(tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.string())])).optional().describe("Answers in question order. Each item may be a single string for a normal/custom answer, or an array of strings for a multi-select question."),
        },
        async execute({ request_id, task_id, action, answers = [] }, context) {
          try {
            const relay = resolveQuestionRelay({ request_id, task_id }, context.sessionID);

            if (action === "reject") {
              await client.question.reject({ requestID: relay.requestID });
              deletePendingQuestionRelay(relay);
              return [
                `✓ Rejected background-task question for ${relay.title}.`,
                `Child session: opencode://session/${relay.childSessionID}`,
                `Request ID: ${relay.requestID}`,
              ].join("\n");
            }

            const normalizedAnswers = normalizeQuestionAnswers(answers);
            if (normalizedAnswers.length !== relay.questions.length) {
              return [
                `✗ Expected ${relay.questions.length} answer set(s) for request ${relay.requestID}, but received ${normalizedAnswers.length}.`,
                "Provide one answer entry per question in order.",
                formatQuestionRelay(relay),
              ].join("\n\n");
            }

            await client.question.reply({
              requestID: relay.requestID,
              answers: normalizedAnswers,
            });
            deletePendingQuestionRelay(relay);

            return [
              `✓ Sent answers to background task ${relay.title}.`,
              `Child session: opencode://session/${relay.childSessionID}`,
              `Request ID: ${relay.requestID}`,
            ].join("\n");
          } catch (error) {
            return `✗ Failed to respond to background-task question: ${error.message}`;
          }
        },
      }),
    },

    "tool.execute.after": async (input, output) => {
      if (!["bg_task", "bg_task_reconcile"].includes(input.tool)) return;
      if (!output?.output) return;

      const decoded = decodeToolResult(output.output);
      if (!decoded) return;

      output.title = decoded.title || output.title;
      output.metadata = {
        ...(output.metadata || {}),
        ...(decoded.metadata || {}),
      };
      output.output = decoded.output;
    },

    event: async ({ event }) => {
      const isIdle = event.type === "session.idle" || (event.type === "session.status" && event.properties?.status?.type === "idle");

      // MOE Auto-Assessment
      if (event.type === "message.updated" && event.message?.role === "user" && event.message?.id) {
        const msgId = event.message.id;
        const text = event.message.content || event.message.text || event.message.parts?.[0]?.text || "";
        const sessionId = event.properties?.sessionID || context.sessionID;
        
        // Only run assessment on substantial user messages that haven't been assessed yet
        // and avoid triggering on short commands or generic chat
        if (text.length > 50 && !assessedMessages.has(msgId)) {
          // We mark it as assessed immediately to avoid multiple triggers during streaming
          assessedMessages.add(msgId);
          pruneAssessedMessages();
          
          // Fire and forget the assessment
          (async () => {
            try {
              const model = opencodeConfig.small_model || "openrouter/google/gemini-3-flash-preview";
              const prompt = `Analyze this user request and determine if it should be delegated to specialized agents using the Mixture of Experts (MoE) pattern.
The primary agent has access to a 'bg_task' tool that can launch background subagents.

User request: "${text}"

Available agents:
${agentCatalog.map(a => "- " + a.name + ": " + a.description).join("\n")}

A task should be delegated if:
1. It involves multiple distinct domains (e.g. frontend vs backend, database vs UI).
2. It requires significant research + implementation.
3. It can be parallelized into multiple independent tasks.

Agent Selection Rules:
- ONLY use the agents explicitly listed in the 'Available agents' list above.
- Match the user's request to the agent's description carefully.
- Pay close attention to whether an agent is meant for coding vs non-coding tasks. Do not use non-coding/business agents for software architecture or programming.

If delegation is needed, recommend a strategy.
Return ONLY valid JSON in this exact format:
{
  "delegate": true|false,
  "reason": "Brief explanation of why",
  "strategy": "Sequential, Parallel, or MoE",
  "agents": ["agent1", "agent2"],
  "advice": "Short prompt to the primary agent telling it exactly how to use bg_task to delegate this."
}`;

              const resultText = await callModelForAssessment(model, prompt);
              
              // Clean up the response in case it's wrapped in markdown
              const jsonStr = resultText.replace(/^\s*\x60\x60\x60json\n/, '').replace(/\n\x60\x60\x60\s*$/, '').trim();
              const assessment = JSON.parse(jsonStr);

              if (assessment.delegate) {
                // Inject the assessment advice as a system message to guide the primary agent
                const adviceText = `[System: MOE Delegation Assessment]
The user's request is complex and should be delegated.
Reasoning: ${assessment.reason}
Recommended Strategy: ${assessment.strategy}
Agents to use: ${assessment.agents.join(", ")}

Advice for you (the orchestrator): ${assessment.advice}
Please use the bg_task or bg_task_start_batch tools to execute this strategy before responding to the user.`;

                await client.session.prompt({
                  path: { id: sessionId },
                  body: {
                    parts: [{ type: "text", text: adviceText }],
                    noReply: true,
                    system: "This is an internal system directive. Acknowledge it by following the delegation advice."
                  }
                });
                console.log(`[task] MOE assessment completed and injected for session ${sessionId}`);
              }
            } catch (err) {
              console.error("[task] MOE assessment failed:", err.message);
            }
          })();
        }
      }

      const childSessionID = event.properties?.sessionID;

      if (event.type === "question.asked") {
        purgeStaleQuestionRelays();
        const childQuestionSessionID = event.properties?.sessionID;
        const parentSessionID = childQuestionSessionID
          ? trackedSessions.get(childQuestionSessionID)?.parentSessionID || delegatedSessionParents.get(childQuestionSessionID)
          : undefined;
        const tracked = childQuestionSessionID ? trackedSessions.get(childQuestionSessionID) : undefined;

        if (childQuestionSessionID && parentSessionID && tracked) {
          const relay = {
              requestID: event.properties.requestID,
              childSessionID: childQuestionSessionID,
              parentSessionID,
            title: tracked.title,
            questions: event.properties.questions,
            parentAgent: tracked.parentAgent,
            parentModel: tracked.parentModel,
            parentVariant: tracked.parentVariant,
            taskIDs: taskAliasesForSession(childQuestionSessionID),
            createdAt: Date.now(),
          };

          if (!relay.requestID) {
            try {
              await client.app.log({
                body: {
                  service: "bg_task",
                  level: "warn",
                  message: "Delegated session question missing requestID",
                  extra: { childSessionID: childQuestionSessionID, eventProperties: event.properties },
                },
              });
            } catch {}
            return;
          }

          setPendingQuestionRelay(relay);
          await persistTaskState();

          try {
            await notifyParentOfQuestion(relay);
          } catch (error) {
            deletePendingQuestionRelay(relay);
            await persistTaskState();
            try {
              await client.app.log({
                body: {
                  service: "bg_task",
                  level: "error",
                  message: "Error relaying delegated session question to parent",
                  extra: { childSessionID: childQuestionSessionID, requestID: relay.requestID, error: error.message },
                },
              });
            } catch {}
          }
        }
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        deletePendingQuestionRelay(event.properties?.requestID);
        await persistTaskState();
      }

      if (childSessionID && isIdle) {
        const tracked = trackedSessions.get(childSessionID);
        if (tracked) {
          try {
            await queueCompletion(tracked, childSessionID);
          } catch (error) {
            tracked.status = "failed";
            tracked.completionQueued = false;

            try {
              await client.app.log({
                body: {
                  service: "bg_task",
                  level: "error",
                  message: "Error processing delegated session completion",
                  extra: { childSessionID, error: error.message },
                },
              });
            } catch {}
          }
        }
      }
    },
  };
};
