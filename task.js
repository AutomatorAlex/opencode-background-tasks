import { tool } from "@opencode-ai/plugin";
import fs from "fs/promises";
import path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;

/**
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export default async (ctx) => {
  const { client } = ctx;
  const rootDirectory = ctx.worktree || ctx.directory;
  const homeDirectory = process.env.HOME || rootDirectory;
  const trackedSessions = new Map();
  const reconciliations = new Map();
  const delegatedSessionParents = new Map();
  const taskIdToSessionId = new Map();
  const agentsDirectory = path.join(homeDirectory, ".config", "opencode", "agents");
  const coreAgentNames = new Set(["build", "consultant", "debug", "plan"]);
  const taskArtifactsDirectory = path.join(homeDirectory, ".local", "share", "opencode", "background-task-artifacts");
  const worktreesDirectory = path.join(taskArtifactsDirectory, "worktrees");
  const patchesDirectory = path.join(taskArtifactsDirectory, "patches");
  const RESULT_PREFIX = "__OPENCODE_BACKGROUND_TASK_META__";
  let cachedRepositoryRoot;

  await fs.mkdir(worktreesDirectory, { recursive: true });
  await fs.mkdir(patchesDirectory, { recursive: true });

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

        return {
          name,
          description,
          variant: parseFrontmatterValue(source, "variant"),
          model: parseModelString(parseFrontmatterValue(source, "model")),
          aliases: Array.from(new Set([name, ...aliases])),
        };
      }),
    );

    return catalog
      .filter((agent) => coreAgentNames.has(agent.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const agentCatalog = await loadAgentCatalog();

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
    if (cachedRepositoryRoot !== undefined) return cachedRepositoryRoot;
    try {
      const { stdout } = await runGit(rootDirectory, ["rev-parse", "--show-toplevel"]);
      cachedRepositoryRoot = stdout.trim();
    } catch {
      cachedRepositoryRoot = null;
    }
    return cachedRepositoryRoot;
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
    };
  }

  async function safeRemoveWorktree(repositoryRoot, workspacePath) {
    if (!repositoryRoot || !workspacePath) return;
    try {
      await runGit(repositoryRoot, ["worktree", "remove", "--force", workspacePath]);
    } catch {}
  }

  async function safeDeleteBranch(repositoryRoot, branchName) {
    if (!repositoryRoot || !branchName) return;
    try {
      await runGit(repositoryRoot, ["branch", "-D", branchName]);
    } catch {}
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
      changedFiles: tracked.claimedTargets || [],
      patchPath: undefined,
      reconcileStatus: undefined,
    };

    if (tracked.effectiveMode !== "isolated" || !tracked.workspacePath || !tracked.repositoryRoot) {
      return artifact;
    }

    const changedFiles = await listTrackedFiles(tracked.workspacePath);
    artifact.changedFiles = changedFiles;

    if (!changedFiles.length) {
      artifact.reconcileStatus = "clean";
      return artifact;
    }

    const { stdout } = await runGit(tracked.workspacePath, ["diff", "--binary", "HEAD"]);
    const patchPath = path.join(patchesDirectory, `${tracked.sessionID}.patch`);
    await fs.writeFile(patchPath, stdout, "utf8");

    artifact.patchPath = patchPath;
    artifact.reconcileStatus = "pending";
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
    if (record.patchPath) lines.push(`Patch: ${record.patchPath}`);
    if (record.reconcileStatus) lines.push(`Reconcile status: ${record.reconcileStatus}`);

    return lines.join("\n");
  }

  async function cleanupReconciliation(record) {
    if (!record?.repositoryRoot || !record?.workspacePath) {
      return "✗ Task has no recorded isolated worktree to clean up.";
    }

    if (!["applied", "clean", "cleaned"].includes(record.reconcileStatus || "")) {
      return `✗ Refusing cleanup for ${record.title} because reconcile status is ${record.reconcileStatus || "pending"}. Apply or inspect it first.`;
    }

    if (record.reconcileStatus === "cleaned") {
      return `✓ Worktree for task ${record.sessionID} has already been cleaned up.`;
    }

    await safeRemoveWorktree(record.repositoryRoot, record.workspacePath);
    await safeDeleteBranch(record.repositoryRoot, record.branchName);

    record.reconcileStatus = "cleaned";
    record.cleanedAt = Date.now();
    record.workspaceRemoved = true;
    reconciliations.set(record.sessionID, record);

    return [
      `✓ Cleaned up isolated worktree for ${record.title}.`,
      `Session: opencode://session/${record.sessionID}`,
      `Branch removed: ${record.branchName || "(none)"}`,
      `Patch retained: ${record.patchPath || "(none)"}`,
    ].join("\n");
  }

  async function queueCompletion(tracked, childSessionID) {
    if (tracked.completionQueued) return;
    tracked.completionQueued = true;

    const { data: messages } = await client.session.messages({ path: { id: childSessionID }, query: { limit: 50 } });
    const result = extractFinalResult(messages);
    if (!result) {
      tracked.completionQueued = false;
      return;
    }

    tracked.status = "completed";
    const artifacts = await collectCompletionArtifacts(tracked);
    const reconciliationRecord = {
      ...tracked,
      ...artifacts,
      sessionID: childSessionID,
      completedAt: Date.now(),
    };

    trackedSessions.delete(childSessionID);
    if (reconciliationRecord.effectiveMode === "isolated") {
      reconciliations.set(childSessionID, reconciliationRecord);
    }

    const header = result.errorMessage ? "✗ Background Task Failed" : "✓ Background Task Completed";
    const footer = [];

    footer.push(`Mode: ${tracked.effectiveMode}`);
    footer.push(`Target source: ${tracked.targetSource || "none"}`);
    if (tracked.claimedTargets?.length) footer.push(`Targets: ${tracked.claimedTargets.join(", ")}`);
    if (tracked.workspacePath) footer.push(`Worktree: ${tracked.workspacePath}`);
    if (artifacts.changedFiles?.length) footer.push(`Changed files: ${artifacts.changedFiles.join(", ")}`);
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

            if (!workspacePath && effectiveMode === "isolated") {
              createdWorkspace = await createIsolatedWorkspace(repositoryRoot);
              workspacePath = createdWorkspace.workspacePath;
              branchName = createdWorkspace.branchName;
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
              status: "active",
              conflicts: conflicts.map((item) => ({ sessionID: item.sessionID, title: item.title })),
            };

            delegatedSessionParents.set(session.id, parentSessionID);
            trackedSessions.set(session.id, tracked);
            if (task_id) {
              taskIdToSessionId.set(task_id, session.id);
            }

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
              await safeRemoveWorktree(await getRepositoryRoot(), createdWorkspace.workspacePath);
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
      const childSessionID = event.properties?.sessionID;

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
