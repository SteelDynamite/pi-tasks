Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**

- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If blocked waiting on the user, set status to blocked and explain what user action is needed
- If intentionally stopped/cancelled, set status to stopped
- If fundamentally failed and the assistant cannot recover, set status to failed
- If waiting on another task, use addDependsOn and keep status pending
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**

- When a task is no longer relevant or was created in error
- Setting status to `deleted` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Status Workflow

Statuses: `pending`, `in_progress`, `blocked`, `stopped`, `failed`, `completed`.

- `pending`: queued/not started, including normal dependency waits
- `in_progress`: actively being worked
- `blocked`: waiting on user action/input/permission
- `stopped`: intentionally interrupted/cancelled
- `failed`: fundamentally failed; assistant cannot recover without a new plan or external fix
- `completed`: fully done

Use `deleted` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using `TaskGet` before updating it.

## Examples

Mark task as in progress when starting work:
```json
{"taskId": "1", "status": "in_progress"}
```

Mark task as completed after finishing work:
```json
{"taskId": "1", "status": "completed"}
```

Delete a task:
```json
{"taskId": "1", "status": "deleted"}
```


Set up task dependencies:
```json
{"taskId": "2", "addDependsOn": ["1"]}
```
