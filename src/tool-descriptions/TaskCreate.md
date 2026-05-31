Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user. It also helps the user understand the progress of the task and overall progress of their requests.

## Using TaskCreate

Use this tool proactively in these scenarios:

- Non-trivial and complex tasks
- User provides multiple tasks
- After receiving new instructions
- Before you start working on a task
- After completing a task

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task is purely conversational or informational

## Fields

- **tasks**: Array of tasks to create. Must contain at least one task.
- **tasks[].subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **tasks[].description**: Detailed description of what needs to be done, including context and acceptance criteria
- **tasks[].agentType** (optional): Agent type for subagent execution via TaskExecute.
- **tasks[].metadata** (optional): Arbitrary metadata to attach to the task.

All tasks are created with status `pending`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (dependents/dependsOn) if needed
- Check TaskList first to avoid creating duplicate tasks
- Include `agentType` (e.g., "general-purpose", "Explore") to mark tasks for subagent execution via TaskExecute
