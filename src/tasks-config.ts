// <cwd>/.pi/tasks-config.json — persists extension settings after /tasks Settings changes

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
}

function configPath(cwd: string): string {
  return join(cwd, ".pi", "tasks-config.json");
}

export function loadTasksConfig(cwd: string = process.cwd()): TasksConfig {
  try {
    return JSON.parse(readFileSync(configPath(cwd), "utf-8"));
  } catch { return {}; }
}

export function saveTasksConfig(config: TasksConfig, cwd: string = process.cwd()): void {
  const path = configPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}
