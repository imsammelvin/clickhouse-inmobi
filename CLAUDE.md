# Read this first

This repo is worked on by **four people and their agents in parallel**. Uncoordinated edits will
destroy someone else's work.

Before doing anything, read in this order:

1. **[AGENTS.md](AGENTS.md)** — the operating rules. Non-negotiable. Covers branch discipline, file
   ownership, how to claim work, and how to communicate.
2. **[goal.md](goal.md)** — what we are building.
3. **[TASKS.md](TASKS.md)** — the shared task board. Claim a task here before you write code.
4. `git log --oneline -30` — what the other three have done recently.
5. `coordination/journal/<your-handle>.md` — your own notes from last session.

Hard rules, repeated here because they matter most:

- **Never commit directly to `main`.** Work on `dev/<handle>/<slug>`.
- **Never edit a file outside your lane's directories** (see AGENTS.md § Lanes and ownership).
- **Never `git push --force`** to `main` or to a branch you do not own.
- **Never resolve a conflict by discarding the other side.** Rebase and keep both.
- If you are blocked on another lane, **mock it and keep moving** — do not edit their code.
