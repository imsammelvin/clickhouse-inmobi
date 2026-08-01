# Langfuse — self-hosted (Docker)

Only ClickHouse runs in the cloud. Langfuse runs locally via Docker Compose, **outside this repo**
(it's Langfuse's own repo, not ours).

```bash
git clone https://github.com/langfuse/langfuse.git ~/langfuse
cd ~/langfuse
# open docker-compose.yml, replace every value marked #CHANGEME
docker compose up -d
# wait for "langfuse-web-1 ... Ready" in the logs, then open http://localhost:3000
```

Create an org + project in the UI, then Settings -> API Keys -> generate. Put those in this repo's
root `.env` (copy `backend/langfuse/.env.example`):

```
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
LANGFUSE_HOST=http://localhost:3000
```

Then from the repo root: `bun install && bun run langfuse:trace`. Stop the stack later with
`docker compose down` (from `~/langfuse`).
