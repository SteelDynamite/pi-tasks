import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockEntry = { type: "custom"; customType: string; data?: unknown };

function mockPi(entries: MockEntry[] = [], cwd = process.cwd()) {
  const tools = new Map<string, any>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand: vi.fn(),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
  };

  const ctx = {
    cwd,
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => entries,
    },
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };

  return {
    pi,
    ctx,
    entries,
    async executeTool(name: string, params: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx);
    },
    async fireLifecycle(event: string, eventData: any = {}) {
      for (const h of lifecycleHandlers.get(event) ?? []) {
        await h(eventData, ctx);
      }
    },
    emitEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
  };
}

describe("session-entry task persistence", () => {
  let originalCwd: string;
  let tmp: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "pi-tasks-session-"));
    process.chdir(tmp);
    delete process.env.PI_TASKS;
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.PI_TASKS;
    vi.resetModules();
  });

  it("persists default session tasks as custom session entries without creating project .pi", async () => {
    const { default: initExtension } = await import("../src/index.js");
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "startup" });
    await mock.executeTool("TaskCreate", { tasks: [
      { subject: "Session task", description: "Stored in session" },
      { subject: "Second session task", description: "Stored in session" },
    ] });

    expect(mock.pi.appendEntry).toHaveBeenCalledWith("pi-tasks", expect.objectContaining({
      version: 1,
      nextId: 3,
      tasks: [
        expect.objectContaining({ id: "1", subject: "Session task" }),
        expect.objectContaining({ id: "2", subject: "Second session task" }),
      ],
    }));
    expect(existsSync(join(tmp, ".pi"))).toBe(false);
  });

  it("restores default session tasks from the current branch", async () => {
    const { default: initExtension } = await import("../src/index.js");
    const entries: MockEntry[] = [{
      type: "custom",
      customType: "pi-tasks",
      data: {
        version: 1,
        nextId: 2,
        tasks: [{
          id: "1",
          subject: "Restored task",
          description: "From session entry",
          status: "pending",
          dependents: [],
          dependsOn: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }],
      },
    }];
    const mock = mockPi(entries);
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "resume" });
    const result = await mock.executeTool("TaskList", {});

    expect(result.content[0].text).toContain("#1 [pending] Restored task");
    expect(existsSync(join(tmp, ".pi"))).toBe(false);
  });

  it("uses ctx.cwd for project-scope task config and storage", async () => {
    const { default: initExtension } = await import("../src/index.js");
    const project = join(tmp, "project");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "tasks-config.json"), JSON.stringify({ taskScope: "project" }));

    const mock = mockPi([], project);
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "startup" });
    await mock.executeTool("TaskCreate", { tasks: [{ subject: "Project task", description: "Stored under ctx.cwd" }] });

    expect(existsSync(join(project, ".pi", "tasks", "tasks.json"))).toBe(true);
    expect(existsSync(join(tmp, ".pi", "tasks", "tasks.json"))).toBe(false);
    expect(mock.pi.appendEntry).not.toHaveBeenCalledWith("pi-tasks", expect.anything());
  });

});
