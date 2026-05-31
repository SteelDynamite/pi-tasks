# @tintinweb/pi-tasks

A [pi](https://pi.dev) extension for structured task tracking: task lists, status, dependencies, persistence, and a visual widget.

> **Status:** Early release.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/tintinweb/pi-tasks/raw/master/media/screenshot.png" />

## Features

- **4 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`
- **Persistent widget** — live task list above the editor with status icons and active task elapsed time/token counts
- **System-reminder injection** — periodic task-tool nudges when useful
- **Dependency management** — bidirectional `dependents`/`dependsOn` relationships with warnings
- **Session or project storage** — per-session state by default, optional shared project file
- **File locking** — safe concurrent access for shared project task lists

## Install

```bash
pi install npm:@tintinweb/pi-tasks
```

Development:

```bash
pi -e ./src/index.ts
```

## Widget

```
● 6 tasks (1 done, 1 in progress, 1 blocked, 1 stopped, 1 failed, 1 pending)
  ✓ #1 Design the flux capacitor
  ▸ #2 Acquire plutonium… (2m 49s · ↑ 4.1k ↓ 1.2k)
  ○ #3 Install flux capacitor in DeLorean › depends on #2
  ⊘ #4 Waiting for plutonium permit
  ■ #5 Test time travel at 88 mph
  ✗ #6 Repair irrecoverable paradox
```

| Icon | Meaning |
|------|---------|
| `○` | Pending |
| `▶` | In progress |
| `▹`/`▸`/`▶` | Active in-progress animation |
| `■` | Stopped |
| `✓` | Completed |
| `✗` | Failed |
| `⊘` | Blocked |

## Tools

### `TaskCreate`

Create tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tasks` | array | yes | Tasks to create |
| `tasks[].subject` | string | yes | Brief imperative title |
| `tasks[].description` | string | yes | Detailed context and acceptance criteria |

### `TaskList`

List tasks with status and dependency info.

```text
#1 [pending] Fix authentication bug
#2 [in_progress] Write unit tests
#3 [pending] Update docs [depends on #1, #2]
```

Sort order: pending, in-progress, blocked, stopped, failed, completed. Each group is sorted by ID.

### `TaskGet`

Get full details for one task.

```text
Task #2: Write unit tests
Status: in_progress
Description: Add tests for the auth module
Depends on: #1
Dependents: #3
```

### `TaskUpdate`

Update task fields, status, and dependencies.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `blocked` / `stopped` / `failed` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `addDependents` | string[] | Task IDs that depend on this task |
| `addDependsOn` | string[] | Task IDs this task depends on |

Setting `status: "deleted"` permanently removes the task.

Dependencies are bidirectional: `addDependents: ["3"]` on task 1 also adds `dependsOn: ["1"]` to task 3.

## Task Lifecycle

```text
pending → in_progress → completed
                      → stopped
                      → failed
pending → blocked → pending/in_progress
any state → deleted
```

## Storage

Task storage is controlled by `/tasks` → Settings → Task storage:

| Mode | File | Behaviour |
|------|------|-----------|
| `memory` | none | In-memory only |
| `session` default | Pi session custom entries | Per-session, branch-aware, survives resume |
| `project` | `<cwd>/.pi/tasks/tasks.json` | Shared across sessions in the project |

Completed tasks can auto-clear via `/tasks` → Settings → Auto-clear completed tasks.

Settings are saved to `<cwd>/.pi/tasks-config.json` only when changed.

## Environment

| Variable | Value | Behaviour |
|----------|-------|-----------|
| `PI_TASKS` | `off` | In-memory only |
| `PI_TASKS` | `sprint-1` | Named shared list at `~/.pi/tasks/sprint-1.json` |
| `PI_TASKS` | `/abs/path/tasks.json` | Explicit file path |
| `PI_TASKS` | `./tasks.json` | Relative path resolved from cwd |
| unset | | Uses taskScope setting |

## `/tasks` Command

Interactive task menu:

- View all tasks
- Create task
- Clear completed
- Clear all
- Settings

## Architecture

```text
src/
├── index.ts              # Extension entry: tools, command, widget
├── types.ts              # Task types
├── task-store.ts         # CRUD, dependencies, snapshots, file locking
├── auto-clear.ts         # Turn-based completed-task cleanup
├── tasks-config.ts       # taskScope and autoClearCompleted config
└── ui/
    ├── task-widget.ts
    └── settings-menu.ts
```

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
