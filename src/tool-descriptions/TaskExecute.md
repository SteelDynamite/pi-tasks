Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have `agentType` set (created via TaskCreate with agentType parameter)
- Tasks must be `pending` with all dependsOn dependencies `completed`
- Each task runs as an independent background subagent

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent
