# AGENTS.md

WIP.

This repository contains local n8n Docker Compose infrastructure and automation glue.

Guidelines:
- Do not commit secrets, tokens, OAuth credentials, or local `.env` files.
- Keep Docker Compose changes small and easy to review.
- Prefer documented n8n, ngrok, GitHub, Jira, and Codex configuration patterns.
- Before changing workflow automation, consider how failures are surfaced back to Jira.
- Do not auto-merge pull requests created by Codex.

Verification:
- Run `docker compose config` after editing Compose files.

