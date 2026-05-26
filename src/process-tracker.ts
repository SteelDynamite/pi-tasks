/**
 * process-tracker.ts — Background process management for tasks.
 *
 * Tracks spawned child processes, buffers their output, and supports
 * blocking wait and graceful stop (SIGTERM → 5s → SIGKILL).
 */

import type { ChildProcess } from "node:child_process";
import { DEFAULT_MAX_BYTES, truncateTail } from "@earendil-works/pi-coding-agent";
import type { BackgroundProcess } from "./types.js";

export interface ProcessOutput {
  output: string;
  status: BackgroundProcess["status"];
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  command?: string;
}

const MAX_BUFFER_BYTES = DEFAULT_MAX_BYTES * 2;

export class ProcessTracker {
  private processes = new Map<string, BackgroundProcess>();

  /** Register a spawned process for a task. */
  track(taskId: string, proc: ChildProcess, command?: string): void {
    const bp: BackgroundProcess = {
      taskId,
      pid: proc.pid!,
      command,
      output: [],
      status: "running",
      startedAt: Date.now(),
      proc,
      abortController: new AbortController(),
      waiters: [],
    };

    let outputBytes = 0;
    const appendOutput = (raw: string) => {
      const chunk = Buffer.byteLength(raw, "utf8") > MAX_BUFFER_BYTES
        ? truncateTail(raw, { maxBytes: MAX_BUFFER_BYTES, maxLines: Number.MAX_SAFE_INTEGER }).content
        : raw;
      bp.output.push(chunk);
      outputBytes += Buffer.byteLength(chunk, "utf8");
      while (outputBytes > MAX_BUFFER_BYTES && bp.output.length > 1) {
        const removed = bp.output.shift()!;
        outputBytes -= Buffer.byteLength(removed, "utf8");
      }
    };

    // Buffer stdout
    proc.stdout?.on("data", (data: Buffer) => {
      appendOutput(data.toString());
    });

    // Buffer stderr
    proc.stderr?.on("data", (data: Buffer) => {
      appendOutput(data.toString());
    });

    // Handle process exit
    proc.on("close", (code, _signal) => {
      if (bp.status === "running") {
        bp.status = code === 0 ? "completed" : "error";
      }
      bp.exitCode = code ?? undefined;
      bp.completedAt = Date.now();
      // Notify all waiters
      for (const resolve of bp.waiters) resolve();
      bp.waiters = [];
    });

    proc.on("error", (err) => {
      if (bp.status === "running") {
        bp.status = "error";
        appendOutput(`Process error: ${err.message}`);
        bp.completedAt = Date.now();
        for (const resolve of bp.waiters) resolve();
        bp.waiters = [];
      }
    });

    this.processes.set(taskId, bp);
  }

  /** Get current output and status for a task's process. */
  getOutput(taskId: string): ProcessOutput | undefined {
    const bp = this.processes.get(taskId);
    if (!bp) return undefined;
    return {
      output: bp.output.join(""),
      status: bp.status,
      exitCode: bp.exitCode,
      startedAt: bp.startedAt,
      completedAt: bp.completedAt,
      command: bp.command,
    };
  }

  /** Wait for a task's process to complete, with timeout. */
  waitForCompletion(taskId: string, timeout: number, signal?: AbortSignal): Promise<ProcessOutput | undefined> {
    const bp = this.processes.get(taskId);
    if (!bp) return Promise.resolve(undefined);
    if (bp.status !== "running") return Promise.resolve(this.getOutput(taskId));

    return new Promise<ProcessOutput | undefined>((resolve) => {
      let settled = false;
      const timer = setTimeout(finish, timeout);

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(self.getOutput(taskId));
      }

      const self = this;
      bp.waiters.push(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /** Stop a task's background process. SIGTERM → 5s → SIGKILL. */
  async stop(taskId: string): Promise<boolean> {
    const bp = this.processes.get(taskId);
    if (!bp || bp.status !== "running") return false;

    bp.status = "stopped";
    bp.proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { bp.proc.kill("SIGKILL"); } catch { /* already dead */ }
        resolve();
      }, 5000);

      bp.proc.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    bp.completedAt = Date.now();
    for (const resolve of bp.waiters) resolve();
    bp.waiters = [];
    return true;
  }

  /** Get the process record for a task. */
  getProcess(taskId: string): BackgroundProcess | undefined {
    return this.processes.get(taskId);
  }
}
