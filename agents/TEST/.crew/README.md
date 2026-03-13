# Claude Crew Workspace Pointers

This agent keeps its own workspace as the default cwd.
Use the pointers below to access the active collaboration context without changing the runtime cwd.

- `current-project/` -> canonical project assets
- `current-workplace/` -> derived artifacts and active execution outputs
- `context.json` -> machine-readable metadata for the current assignment
