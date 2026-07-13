# AGENTS.md

This repository contains local Docker Compose infrastructure and automation glue for Jira, n8n, GitHub, and the Codex CLI.

## Services

- `n8n` receives Jira and GitHub events, orchestrates jobs, comments on Jira, and transitions issues.
- `ngrok` exposes only the n8n webhook endpoint through a public HTTPS tunnel.
- `codex-worker` runs the Codex CLI in isolated per-job checkouts with a persisted local ChatGPT login, pushes `codex/*` branches, and creates or updates pull requests.
- `health-monitor` serves a local React dashboard on port `3001`, discovers Compose workers through a read-only Docker socket, and reads worker health and job history.

## Automation flow

- Moving an issue assigned or labeled for `codex-worker` to `In Progress` starts an implementation job.
- A successful implementation creates a Jira-linked pull request and moves the issue to `In Review`; a failure returns it to `To Do` with details.
- A collaborator can leave PR feedback and post `/codex fix`. n8n moves Jira to `In Progress`, and the worker merges the latest base branch, resolves conflicts, addresses review feedback, and updates the same PR.
- Merging a linked `codex/*` pull request moves the Jira issue to a Done-category status and adds the PR result to Jira.
- Jira transitions must be selected from transitions currently available to the n8n credential. Never hard-code Jira transition or status IDs; use standard status categories and the aliases configured through `JIRA_*_NAMES`.

## Guidelines

- Do not commit secrets, tokens, OAuth credentials, local `.env` files, or Codex authentication data.
- Commit repository changes as `codex <codex@users.noreply.github.com>` unless the user explicitly requests another author identity.
- Keep Docker Compose and workflow changes small and easy to review.
- Prefer documented n8n, ngrok, GitHub, Jira, and Codex configuration patterns.
- Surface worker, GitHub, and transition failures back to Jira with actionable details.
- Preserve webhook signature validation and restrict command-triggered automation to authorized repository collaborators.
- Do not auto-merge pull requests created by Codex.
- Do not copy `~/.codex/auth.json` into GitHub Actions or public CI.
- Keep ports `5678`, `3000`, and `3001` bound to localhost. Do not expose `codex-worker`, `health-monitor`, or the Docker socket publicly.
- Treat access to `/var/run/docker.sock` as privileged even when mounted read-only; do not expand monitor capabilities without reviewing the security impact.
- Codex sessions launched by `codex-worker` have no Docker daemon or container access. They must not run Docker/Compose commands, inspect containers, or attempt container health checks; use available static checks and report Docker verification as not run.

## Verification

- Run `docker compose config` after editing Compose files.
- Run `node --check codex-worker/src/server.js` and `docker compose build codex-worker` after changing worker files.
- Run `node --check health-monitor/server.js` and `docker compose build health-monitor` after changing monitor files.
- Validate edited workflow JSON before importing it into n8n.
- After runtime changes, run `docker compose up -d --build`, inspect `docker compose ps`, and check `http://127.0.0.1:3000/healthz`, `http://127.0.0.1:3001/healthz`, and `http://127.0.0.1:3001/api/status`.
