List all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', dependencies complete)
- To check overall progress on the project
- To find tasks that are blocked waiting on user action
- After completing a task, to check for newly eligible work
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', 'blocked', 'stopped', 'failed', or 'completed'
- **dependsOn**: List of dependency task IDs that must complete first

Use TaskGet with a specific task ID to view full details including description and comments.
