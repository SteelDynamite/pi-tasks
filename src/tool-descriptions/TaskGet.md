Retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it depends on and what depends on it)
- After being assigned a task, to get complete requirements

## Output

- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', 'blocked', 'stopped', 'failed', or 'completed'
- **dependents**: Tasks waiting on this one to complete
- **dependsOn**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its dependsOn dependencies are complete before beginning work.
- Use TaskList to see all tasks in summary form.
