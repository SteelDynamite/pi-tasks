/**
 * @tintinweb/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *   TaskExecute  — Execute tasks as subagents (requires @tintinweb/pi-subagents)
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, formatSize, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import { TaskStore } from "./task-store.js";
import { loadTasksConfig, type TasksConfig } from "./tasks-config.js";
import type { TaskStoreData } from "./types.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

// ---- Helpers ----

type TruncateMode = "head" | "tail";

function truncateForTool(msg: string, mode: TruncateMode = "head"): string {
  const truncation = mode === "tail" ? truncateTail(msg) : truncateHead(msg);
  if (!truncation.truncated) return msg;
  const notice = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
  return truncation.content ? `${truncation.content}\n\n${notice}` : notice;
}

function textResult(msg: string, mode: TruncateMode = "head") {
  return { content: [{ type: "text" as const, text: truncateForTool(msg, mode) }], details: undefined as any };
}

const TOOL_DESCRIPTION_NAMES = ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"] as const;
type ToolDescriptionName = (typeof TOOL_DESCRIPTION_NAMES)[number];

function loadToolDescription(name: ToolDescriptionName): string {
  const localUrl = new URL(`./tool-descriptions/${name}.md`, import.meta.url);
  const sourceUrl = new URL(`../src/tool-descriptions/${name}.md`, import.meta.url);
  return readFileSync(existsSync(localUrl) ? localUrl : sourceUrl, "utf8").trimEnd();
}

const toolDescriptions = Object.fromEntries(
  TOOL_DESCRIPTION_NAMES.map(name => [name, loadToolDescription(name)]),
) as Record<ToolDescriptionName, string>;

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

const SYSTEM_REMINDER = `<system-reminder>
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user
</system-reminder>`;

const SESSION_STATE_CUSTOM_TYPE = "pi-tasks";

type StoreMode = "memory" | "session" | "file";

type PersistedTaskState = TaskStoreData & { version?: 1 };

function isTaskStoreData(data: unknown): data is TaskStoreData {
  const maybe = data as Partial<TaskStoreData> | undefined;
  return !!maybe && typeof maybe === "object" &&
    typeof maybe.nextId === "number" && Array.isArray(maybe.tasks);
}

export default function (pi: ExtensionAPI) {
  // Initialize store and config lazily from ExtensionContext.cwd.
  const piTasks = process.env.PI_TASKS;
  let cfg: TasksConfig = {};
  let taskScope: NonNullable<TasksConfig["taskScope"]> = "session";
  let storeMode: StoreMode = "session";

  /** Resolve storage backend. Default session storage uses Pi session custom entries, not project files. */
  function resolveStoreMode(): StoreMode {
    if (piTasks === "off") return "memory";
    if (piTasks) return "file";
    if (taskScope === "memory") return "memory";
    if (taskScope === "project") return "file";
    return "session";
  }

  function refreshConfig(cwd: string): void {
    cfg = loadTasksConfig(cwd);
    taskScope = cfg.taskScope ?? "session";
    storeMode = resolveStoreMode();
  }

  /** Resolve explicit/shared file store path. */
  function resolveFileStorePath(cwd: string): string | undefined {
    if (piTasks === "off") return undefined;
    if (piTasks && isAbsolute(piTasks)) return piTasks;
    if (piTasks?.startsWith(".")) return resolve(cwd, piTasks);
    if (piTasks) return piTasks;
    if (taskScope === "project") return join(cwd, ".pi", "tasks", "tasks.json");
    return undefined;
  }

  let store = new TaskStore();
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store);

  function persistSessionState(): void {
    if (storeMode !== "session" || typeof pi.appendEntry !== "function") return;
    pi.appendEntry<PersistedTaskState>(SESSION_STATE_CUSTOM_TYPE, {
      version: 1,
      ...store.snapshot(),
    });
  }

  function addTask(...args: Parameters<TaskStore["create"]>) {
    const task = store.create(...args);
    persistSessionState();
    return task;
  }

  function addTasks(...args: Parameters<TaskStore["createMany"]>) {
    const tasks = store.createMany(...args);
    if (tasks.length > 0) persistSessionState();
    return tasks;
  }

  function updateTask(...args: Parameters<TaskStore["update"]>) {
    const result = store.update(...args);
    if (result.changedFields.length > 0) persistSessionState();
    return result;
  }

  function clearAllTasks() {
    const count = store.clearAll();
    if (count > 0) persistSessionState();
    return count;
  }

  function clearCompletedTasks() {
    const count = store.clearCompleted();
    if (count > 0) persistSessionState();
    return count;
  }

  function getLegacySessionFilePath(ctx: ExtensionContext): string {
    return join(ctx.cwd ?? process.cwd(), ".pi", "tasks", `tasks-${ctx.sessionManager.getSessionId()}.json`);
  }

  function restoreSessionStore(ctx: ExtensionContext): void {
    if (storeMode !== "session") return;

    let snapshot: TaskStoreData | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SESSION_STATE_CUSTOM_TYPE && isTaskStoreData(entry.data)) {
        snapshot = entry.data;
      }
    }

    if (snapshot) {
      store.loadSnapshot(snapshot);
      widget.clearActiveTasks();
      widget.setStore(store);
      return;
    }

    // One-time compatibility: import old per-session file if it exists. This check does not create .pi.
    const legacyPath = getLegacySessionFilePath(ctx);
    if (existsSync(legacyPath)) {
      const legacyStore = new TaskStore(legacyPath);
      const legacySnapshot = legacyStore.snapshot();
      if (legacySnapshot.tasks.length > 0) {
        store.loadSnapshot(legacySnapshot);
        widget.clearActiveTasks();
        widget.setStore(store);
        persistSessionState();
        return;
      }
    }

    store.loadSnapshot({ nextId: 1, tasks: [] });
    widget.clearActiveTasks();
    widget.setStore(store);
  }

  // ── Subagent integration state ──
  /** Latest ExtensionContext — refreshed on every tool execution so cascade always has a valid one. */
  let latestCtx: ExtensionContext | undefined;
  /** Cascade config — set by TaskExecute, consumed by completion listener. */
  let cascadeConfig: { additionalContext?: string; model?: string; maxTurns?: number } | undefined;
  /** Maps agent IDs to task IDs for O(1) completion lookup. */
  const agentTaskMap = new Map<string, string>();

  function rehydrateAgentTaskMap(): void {
    agentTaskMap.clear();
    for (const task of store.list()) {
      const agentId = task.metadata?.agentId;
      if (task.status === "in_progress" && typeof agentId === "string" && agentId) {
        agentTaskMap.set(agentId, task.id);
      }
    }
  }

  function resolveTaskIdForAgent(agentId: string): string | undefined {
    const mapped = agentTaskMap.get(agentId);
    if (mapped) return mapped;

    for (const task of store.list()) {
      const storedAgentId = task.metadata?.agentId;
      if (task.status === "in_progress" && typeof storedAgentId === "string" &&
        (storedAgentId === agentId || storedAgentId.startsWith(agentId))) {
        agentTaskMap.set(storedAgentId, task.id);
        return task.id;
      }
    }
  }

  // ── Subagent RPC helpers ──

  /** RPC reply envelope — matches pi-mono's RpcResponse shape. */
  type RpcReply<T = void> =
    | { success: true; data?: T }
    | { success: false; error: string };

  /** Call a subagents RPC method: emit request, wait for scoped reply, unwrap envelope. */
  function rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const requestId = randomUUID();
    debug(`rpc:send ${channel}`, { requestId });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        debug(`rpc:timeout ${channel}`, { requestId });
        reject(new Error(`${channel} timeout`));
      }, timeoutMs);
      const unsub = pi.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        unsub(); clearTimeout(timer);
        debug(`rpc:reply ${channel}`, { requestId, raw });
        const reply = raw as RpcReply<T>;
        if (reply.success) resolve(reply.data as T);
        else reject(new Error(reply.error));
      });
      pi.events.emit(channel, { requestId, ...params });
      debug(`rpc:emitted ${channel}`, { requestId });
    });
  }

  /** Spawn a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function spawnSubagent(type: string, prompt: string, options?: any): Promise<string> {
    debug("spawn:call", { type, options: { ...options, prompt: undefined } });
    return rpcCall<{ id: string }>("subagents:rpc:spawn", { type, prompt, options }, 30_000)
      .then(d => { debug("spawn:ok", d); return d.id; });
  }

  /** Stop a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function stopSubagent(agentId: string): Promise<void> {
    return rpcCall<void>("subagents:rpc:stop", { agentId }, 10_000).catch(() => {});
  }

  // ── Subagent extension presence & version detection ──
  const PROTOCOL_VERSION = 2;
  let subagentsAvailable = false;
  let pendingWarning: string | undefined;

  /** Ping subagents and check protocol version. Works with any handler version. */
  function checkSubagentsVersion() {
    const requestId = randomUUID();
    const timer = setTimeout(() => { unsub(); }, 5_000);
    const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
      unsub(); clearTimeout(timer);
      const remoteVersion = (raw as any)?.data?.version as number | undefined;
      if (remoteVersion === undefined) {
        pendingWarning =
          "@tintinweb/pi-subagents is outdated — please update for task execution support.";
      } else if (remoteVersion > PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-tasks is outdated (protocol v${PROTOCOL_VERSION}, ` +
          `pi-subagents has v${remoteVersion}) — please update for task execution support.`;
      } else if (remoteVersion < PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-subagents is outdated (protocol v${remoteVersion}, ` +
          `pi-tasks has v${PROTOCOL_VERSION}) — please update for task execution support.`;
      } else {
        subagentsAvailable = true;
      }
    });
    pi.events.emit("subagents:rpc:ping", { requestId });
  }

  checkSubagentsVersion();
  pi.events.on("subagents:ready", () => checkSubagentsVersion());

  /** Build a prompt for a task being executed by a subagent.
   *  Injects completed dependency results so cascaded agents have context from prerequisites.
   */
  function buildTaskPrompt(
    task: { id: string; subject: string; description: string; dependsOn?: string[] },
    additionalContext?: string,
  ): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;

    // Inject completed dependency results so cascaded agents have full context
    if (task.dependsOn && task.dependsOn.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.dependsOn) {
        const dep = store.get(depId);
        if (dep?.metadata?.result) {
          const result = dep.metadata.result.length > 4000
            ? dep.metadata.result.slice(0, 4000) + "\n\n[... truncated — use TaskGet for full output]"
            : dep.metadata.result;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${result}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  // ── Subagent completion listener ──
  // Listens for subagent lifecycle events to update task status and optionally cascade.

  function markTaskStopped(taskId: string, stopReason: string) {
    const task = store.get(taskId);
    if (!task || task.status !== "in_progress") return false;
    updateTask(task.id, {
      status: "stopped",
      metadata: { ...task.metadata, stoppedAt: Date.now(), stopReason },
    });
    widget.setActiveTask(task.id, false);
    autoClear.resetBatchCountdown();
    return true;
  }

  function stopInProgressTasksForAbortedTurn() {
    let changed = false;
    for (const task of store.list()) {
      if (task.status === "in_progress" && !task.metadata?.agentId) {
        changed = markTaskStopped(task.id, "aborted") || changed;
      }
    }
    if (changed) widget.update();
  }

  // Success → mark task completed, cascade if enabled
  pi.events.on("subagents:completed", async (data) => {
    const { id, result } = data as { id: string; result?: string };
    const taskId = resolveTaskIdForAgent(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    updateTask(task.id, { status: "completed", metadata: { ...task.metadata, result } });
    widget.setActiveTask(task.id, false);

    // Auto-cascade: find eligible dependents with agentType
    if ((cfg.autoCascade ?? false) && cascadeConfig && latestCtx) {
      const eligible = store.list().filter(t =>
        t.status === "pending" &&
        t.metadata?.agentType &&
        t.dependsOn.includes(task.id) &&
        t.dependsOn.every(depId => store.get(depId)?.status === "completed")
      );
      for (const next of eligible) {
        updateTask(next.id, { status: "in_progress" });
        const prompt = buildTaskPrompt(next, cascadeConfig.additionalContext);
        try {
          const agentId = await spawnSubagent(next.metadata.agentType, prompt, {
            description: next.subject,
            isBackground: true,
            maxTurns: cascadeConfig.maxTurns,
            ...(cascadeConfig.model ? { model: cascadeConfig.model } : {}),
          });
          agentTaskMap.set(agentId, next.id);
          updateTask(next.id, { owner: agentId, metadata: { ...next.metadata, agentId } });
          widget.setActiveTask(next.id);
        } catch (err: any) {
          updateTask(next.id, { status: "failed", metadata: { ...next.metadata, lastError: err.message } });
        }
      }
    }
    autoClear.trackCompletion(task.id, currentTurn);
    widget.update();
  });

  // Failure → store error and mark failed; intentional stop preserves partial result.
  pi.events.on("subagents:failed", (data) => {
    const { id, error, result, status } = data as { id: string; error?: string; result?: string; status: string };
    const taskId = resolveTaskIdForAgent(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    if (status === "stopped") {
      // Intentional stop — mark stopped, preserve partial result
      markTaskStopped(task.id, "subagent_stopped");
      if (result) updateTask(task.id, { metadata: { ...task.metadata, result } });
    } else {
      // Actual error — mark failed
      updateTask(task.id, { status: "failed", metadata: { ...task.metadata, lastError: error || status } });
      autoClear.resetBatchCountdown();
    }
    widget.setActiveTask(task.id, false);
    widget.update();
  });

  // ── Session-entry restore ──
  let storeRestored = false;
  let persistedTasksShown = false;

  function restoreStoreIfNeeded(ctx: ExtensionContext, force = false) {
    if (storeRestored && !force) return;

    const cwd = ctx.cwd ?? process.cwd();
    refreshConfig(cwd);
    store = new TaskStore(storeMode === "file" ? resolveFileStorePath(cwd) : undefined);
    widget.clearActiveTasks();
    widget.setStore(store);

    if (storeMode === "session") restoreSessionStore(ctx);
    rehydrateAgentTaskMap();
    storeRestored = true;
  }

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => t.status === "completed")) {
        clearCompletedTasks();
      } else {
        widget.update();
      }
    }
  }

  // ── Turn tracking for system-reminder injection ──
  let currentTurn = 0;
  let lastTaskToolUseTurn = 0;
  let reminderInjectedThisCycle = false;

  pi.on("turn_start", async (_event, ctx) => {
    currentTurn++;
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    restoreStoreIfNeeded(ctx);
    if (autoClear.onTurnStart(currentTurn)) {
      persistSessionState();
      widget.update();
    }
  });

  // ── Token usage tracking ──
  // Feed per-turn token counts from assistant messages into the widget.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }
    if (msg?.role === "assistant" && msg.stopReason === "aborted") {
      stopInProgressTasksForAbortedTurn();
    }
  });

  pi.on("message_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.stopReason === "aborted") {
      stopInProgressTasksForAbortedTurn();
    }
  });

  // ── System-reminder injection via tool_result event ──
  // Appends a <system-reminder> nudge to non-task tool results when tasks exist
  // but task tools haven't been used recently (mimics Claude Code's behavior).
  pi.on("tool_result", async (event) => {
    // Task tool usage resets the reminder timer
    if (TASK_TOOL_NAMES.has(event.toolName)) {
      lastTaskToolUseTurn = currentTurn;
      reminderInjectedThisCycle = false;
      return {};
    }

    // Cheap checks first — avoid store.list() disk I/O when possible
    if (currentTurn - lastTaskToolUseTurn < REMINDER_INTERVAL) return {};
    if (reminderInjectedThisCycle) return {};

    const tasks = store.list();
    if (tasks.length === 0) return {};

    // Append system-reminder to tool result content.
    // Reset the baseline so the next reminder fires REMINDER_INTERVAL turns later.
    reminderInjectedThisCycle = true;
    lastTaskToolUseTurn = currentTurn;
    return {
      content: [...event.content, { type: "text" as const, text: SYSTEM_REMINDER }],
    };
  });

  // Grab UI context early — before_agent_start fires before any tool calls,
  // so persisted tasks show up immediately on session start.
  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    restoreStoreIfNeeded(ctx);
    showPersistedTasks();
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // On /new, /resume, or /fork the extension runtime is recreated. Reset
  // session-scoped in-memory state in session_start for the new runtime.
  pi.on("session_start", async (event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);

    const isResume = event.reason === "resume";

    storeRestored = false;
    persistedTasksShown = false;
    currentTurn = 0;
    lastTaskToolUseTurn = 0;
    reminderInjectedThisCycle = false;
    autoClear.reset();

    restoreStoreIfNeeded(ctx, true);
    if (!isResume && taskScope === "memory") clearAllTasks();
    showPersistedTasks(isResume);
  });

  pi.on("session_tree", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    restoreStoreIfNeeded(ctx, true);
    widget.update();
  });

  pi.on("session_shutdown", async () => {
    widget.dispose();
  });

  // Keep latestCtx fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    restoreStoreIfNeeded(ctx);
    widget.update();
  });

  // ──────────────────────────────────────────────────
  // Tool 1: TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: toolDescriptions.TaskCreate,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        subject: Type.String({ description: "A brief title for the task" }),
        description: Type.String({ description: "A detailed description of what needs to be done" }),
        agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'general-purpose', 'Explore'). Tasks with agentType can be started via TaskExecute." })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
      }), { description: "Tasks to create", minItems: 1 }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      autoClear.resetBatchCountdown();
      if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
        return Promise.resolve(textResult("TaskCreate requires a non-empty tasks array"));
      }
      const tasks = addTasks(params.tasks.map((item: any) => {
        const meta = { ...(item.metadata ?? {}) };
        if (item.agentType) meta.agentType = item.agentType;
        return {
          subject: item.subject,
          description: item.description,
          metadata: Object.keys(meta).length > 0 ? meta : undefined,
        };
      }));
      widget.update();
      const noun = tasks.length === 1 ? "task" : "tasks";
      return Promise.resolve(textResult(`Created ${tasks.length} ${noun}:\n${tasks.map(task => `#${task.id} ${task.subject}`).join("\n")}`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: toolDescriptions.TaskList,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      // Sort by workflow state, then ID.
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, blocked: 2, stopped: 3, failed: 4, completed: 5 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;

        if (task.owner) {
          line += ` (${task.owner})`;
        }

        // Only show non-completed dependencies
        if (task.dependsOn.length > 0) {
          const openDependencies = task.dependsOn.filter(bid => {
            const dependency = store.get(bid);
            return dependency && dependency.status !== "completed";
          });
          if (openDependencies.length > 0) {
            line += ` [depends on ${openDependencies.map(id => "#" + id).join(", ")}]`;
          }
        }

        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: toolDescriptions.TaskGet,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) {
        lines.push(`Owner: ${task.owner}`);
      }
      lines.push(`Description: ${desc}`);

      if (task.dependsOn.length > 0) {
        const openDependencies = task.dependsOn.filter(bid => {
          const dependency = store.get(bid);
          return dependency && dependency.status !== "completed";
        });
        if (openDependencies.length > 0) {
          lines.push(`Depends on: ${openDependencies.map(id => "#" + id).join(", ")}`);
        }
      }
      if (task.dependents.length > 0) {
        lines.push(`Dependents: ${task.dependents.map(id => "#" + id).join(", ")}`);
      }

      // Show metadata if non-empty
      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) {
        lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: toolDescriptions.TaskUpdate,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(StringEnum(["pending", "in_progress", "blocked", "stopped", "failed", "completed", "deleted"] as const, {
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
      addDependents: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that depend on this task" })),
      addDependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params;
      const { task, changedFields, warnings } = updateTask(taskId, fields);

      if (changedFields.length === 0 && !task) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }

      // Update widget active task tracking
      if (fields.status === "in_progress") {
        widget.setActiveTask(taskId);
        autoClear.resetBatchCountdown();
      } else if (fields.status === "pending" || fields.status === "blocked" || fields.status === "stopped" || fields.status === "failed") {
        widget.setActiveTask(taskId, false);
        autoClear.resetBatchCountdown();
      } else if (fields.status === "completed" || fields.status === "deleted") {
        widget.setActiveTask(taskId, false);
        if (fields.status === "completed") autoClear.trackCompletion(taskId, currentTurn);
      }

      widget.update();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) {
        msg += ` (warning: ${warnings.join("; ")})`;
      }
      return Promise.resolve(textResult(msg));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: TaskOutput
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: toolDescriptions.TaskOutput,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params;

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs (resolve agent ID → task ID)
        let resolvedId = task_id;
        if (!store.get(resolvedId)) {
          // Check if this is an agent ID mapped to a task
          for (const [agentId, taskId] of agentTaskMap) {
            if (agentId === task_id || agentId.startsWith(task_id)) { resolvedId = taskId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);

        if (task.metadata?.agentId) {
          // Subagent task — wait for completion if blocking
          if (block && task.status === "in_progress") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => { unsubOk(); unsubFail(); resolve(); }, timeout ?? 30000);
              const cleanup = () => { clearTimeout(timer); resolve(); };
              const unsubOk = pi.events.on("subagents:completed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              const unsubFail = pi.events.on("subagents:failed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              // Re-check in case status changed between the outer check and listener registration
              const current = store.get(task_id);
              if (current && current.status !== "in_progress") { unsubOk(); unsubFail(); cleanup(); }
              signal?.addEventListener("abort", () => { unsubOk(); unsubFail(); cleanup(); }, { once: true });
            });
          }
          const updated = store.get(task_id) ?? task;
          return textResult(`Task #${task_id} [${updated.status}] — subagent ${task.metadata.agentId}`);
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
            "tail",
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
        "tail",
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: TaskStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: toolDescriptions.TaskStop,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs
        let resolvedId = taskId;
        if (!store.get(resolvedId)) {
          for (const [agentId, tId] of agentTaskMap) {
            if (agentId === taskId || agentId.startsWith(taskId)) { resolvedId = tId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (task?.metadata?.agentId && task.status === "in_progress") {
          markTaskStopped(resolvedId, "task_stop");
          await stopSubagent(task.metadata.agentId);
          widget.update();
          return textResult(`Task #${taskId} stopped successfully`);
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      markTaskStopped(taskId, "task_stop");
      widget.update();
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: TaskExecute
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: toolDescriptions.TaskExecute,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!subagentsAvailable) {
        return textResult(
          "Subagent execution is currently unavailable. " +
          "Ensure the @tintinweb/pi-subagents extension is loaded and try again."
        );
      }

      const results: string[] = [];
      const launched: string[] = [];

      for (const taskId of params.task_ids) {
        const task = store.get(taskId);
        if (!task) {
          results.push(`#${taskId}: not found`);
          continue;
        }
        if (task.status !== "pending") {
          results.push(`#${taskId}: not pending (status: ${task.status})`);
          continue;
        }
        if (!task.metadata?.agentType) {
          results.push(`#${taskId}: no agentType set — create with agentType parameter or update metadata`);
          continue;
        }

        // Check all dependencies are completed
        const openDependencies = task.dependsOn.filter(bid => {
          const dependency = store.get(bid);
          return !dependency || dependency.status !== "completed";
        });
        if (openDependencies.length > 0) {
          results.push(`#${taskId}: depends on ${openDependencies.map(id => "#" + id).join(", ")}`);
          continue;
        }

        // Mark in_progress and spawn agent via RPC
        updateTask(taskId, { status: "in_progress" });
        const prompt = buildTaskPrompt(task, params.additional_context);
        try {
          const agentId = await spawnSubagent(task.metadata.agentType, prompt, {
            description: task.subject,
            isBackground: true,
            maxTurns: params.max_turns,
            ...(params.model ? { model: params.model } : {}),
          });
          agentTaskMap.set(agentId, taskId);
          updateTask(taskId, { owner: agentId, metadata: { ...task.metadata, agentId } });
          widget.setActiveTask(taskId);
          launched.push(`#${taskId} → agent ${agentId}`);
        } catch (err: any) {
          debug(`spawn:error task=#${taskId}`, err);
          updateTask(taskId, { status: "failed", metadata: { ...task.metadata, lastError: err.message } });
          results.push(`#${taskId}: spawn failed — ${err.message}`);
        }
      }

      // Save cascade config for the completion listener
      cascadeConfig = {
        additionalContext: params.additional_context,
        model: params.model,
        maxTurns: params.max_turns,
      };

      widget.update();

      const lines: string[] = [];
      if (launched.length > 0) {
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.`
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          clearCompletedTasks();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          clearAllTasks();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusIcon = (status: string) => {
          switch (status) {
            case "pending": return "○";
            case "in_progress": return "▶";
            case "blocked": return "⊘";
            case "stopped": return "■";
            case "failed": return "✗";
            case "completed": return "✓";
            default: return "○";
          }
        };

        const choices = tasks.map(t =>
          `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Extract task ID from selection
        const match = selected.match(/#(\d+)/);
        if (match) await viewTaskDetail(match[1]);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.status === "pending" || task.status === "blocked" || task.status === "stopped" || task.status === "failed") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          updateTask(taskId, { status: "in_progress" });
          widget.setActiveTask(taskId);
          widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          updateTask(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, currentTurn);
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          updateTask(taskId, { status: "deleted" });
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY, ctx.cwd ?? process.cwd());

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        addTask(subject, description);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}
