# Read this first

This repo was built by **four people and their agents in parallel** during Click-a-thon 2026. The
team-coordination scaffolding (task board, journals, lane rules) lived in `context/` during the build
and was removed before submission — it was internal process, not part of the product.

`git log --oneline -30` still shows what each person built, if that context is useful.

Hard rules, repeated here because they matter most:

- **Never commit directly to `main`.** Work on `dev/<handle>/<slug>`.
- **Never edit a file outside your lane's directories.**
- **Never `git push --force`** to `main` or to a branch you do not own.
- **Never resolve a conflict by discarding the other side.** Rebase and keep both.
- If you are blocked on another lane, **mock it and keep moving** — do not edit their code.
