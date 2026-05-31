/**
 * @tintinweb/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoClearManager } from "./auto-clear.js";
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

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

const TOOL_DESCRIPTION_NAMES = ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"] as const;
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
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);

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

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  function stopInProgressTasksForAbortedTurn() {
    let changed = false;
    for (const task of store.list()) {
      if (task.status === "in_progress") {
        updateTask(task.id, { status: "stopped" });
        widget.setActiveTask(task.id, false);
        autoClear.resetBatchCountdown();
        changed = true;
      }
    }
    if (changed) widget.update();
  }

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
    widget.setUICtx(ctx.ui as UICtx);
    restoreStoreIfNeeded(ctx);
    showPersistedTasks();
  });

  // On /new, /resume, or /fork the extension runtime is recreated. Reset
  // session-scoped in-memory state in session_start for the new runtime.
  pi.on("session_start", async (event, ctx) => {
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
    widget.setUICtx(ctx.ui as UICtx);
    restoreStoreIfNeeded(ctx, true);
    widget.update();
  });

  pi.on("session_shutdown", async () => {
    widget.dispose();
  });

  // Keep UI context fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
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
      }), { description: "Tasks to create", minItems: 1 }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      autoClear.resetBatchCountdown();
      if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
        return Promise.resolve(textResult("TaskCreate requires a non-empty tasks array"));
      }
      const tasks = addTasks(params.tasks.map((item: any) => ({
        subject: item.subject,
        description: item.description,
      })));
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
