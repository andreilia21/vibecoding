# AGENTS.md

WIP.

This repository contains local n8n Docker Compose infrastructure and automation glue.

Current workflow:
- n8n receives Jira events through an ngrok public HTTPS tunnel.
- n8n filters Jira issues that should be handled by the agent.
- n8n calls the internal `codex-worker` service.
- `codex-worker` runs Codex CLI locally with a persisted ChatGPT login.
- `codex-worker` pushes a GitHub branch and opens a pull request.
- n8n comments on Jira and transitions the issue after the worker reports success.

Guidelines:
- Do not commit secrets, tokens, OAuth credentials, or local `.env` files.
- Keep Docker Compose changes small and easy to review.
- Prefer documented n8n, ngrok, GitHub, Jira, and Codex configuration patterns.
- Before changing workflow automation, consider how failures are surfaced back to Jira.
- Do not auto-merge pull requests created by Codex.
- Do not copy `~/.codex/auth.json` into GitHub Actions or public CI.

Verification:
- Run `docker compose config` after editing Compose files.
- Run `docker compose build codex-worker` after changing worker files.
