# Development instructions

Follow the project requirements and constraints in [`CODEX_INSTRUCTIONS.md`](CODEX_INSTRUCTIONS.md). Preserve those instructions when making project changes.

## Development rules

- Prioritize clean, readable, maintainable code. Follow KISS and YAGNI.
- Keep changes focused on the requested task.
- Run relevant checks before committing.
- After successful checks, automatically create a Git commit with a concise, descriptive message.
- Automatically push commits to `origin main`.
- Use escalated execution for GitHub network operations when necessary.
- Run escalated commands sequentially, never in parallel.
- Do not request manual approval for routine commits and pushes when automatic approval is available.
- Never force-push, rewrite published history, or modify Git credentials.
- If checks or push fail, report the error clearly. Do not claim deployment succeeded.
- Report the commit hash and push result after completing each task.
