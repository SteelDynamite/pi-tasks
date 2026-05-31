/**
 * types.ts — Type definitions for the task management system.
 */

export type TaskStatus = "pending" | "in_progress" | "blocked" | "stopped" | "failed" | "completed";

export interface TaskCreateFields {
  subject: string;
  description: string;
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  dependents: string[];
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
  nextId: number;
  tasks: Task[];
}
