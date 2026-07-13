# Jira to Codex Automation

Local Docker Compose infrastructure for turning selected Jira issues into GitHub pull requests with n8n and the Codex CLI.

Jira sends webhook events to n8n through an ngrok HTTPS tunnel. An n8n workflow decides whether an issue should be handled, submits it to the internal `codex-worker` service, polls the job status, and reports the result back to Jira. The worker runs Codex in an isolated checkout, commits the generated changes, pushes a `codex/*` branch, and opens a pull request. Reviewers can request another pass by commenting `/codex fix` on that pull request. The local health monitor shows live worker health and execution history. Pull requests are never merged automatically.

## Architecture

```text
Jira -> ngrok -> n8n -> codex-worker -> Codex CLI
                    |          |       ^
                    |          |       |
                    |          |   health-monitor
                    |          +-> GitHub branch and pull request
                    +-> Jira comment and transition
```

The Compose project contains four services:

- `n8n`: workflow orchestration and Jira integration.
- `ngrok`: public HTTPS tunnel to the local n8n webhook endpoint.
- `codex-worker`: local job API that runs Codex and creates GitHub pull requests.
- `health-monitor`: local React dashboard for active workers, failures, and previous executions.

## Prerequisites

- Docker Desktop with Docker Compose v2.
- A reserved ngrok domain and an ngrok authentication token.
- A GitHub repository and a fine-grained personal access token with permission to read and write repository contents and pull requests.
- A Jira project with permission to configure webhooks, comments, and issue transitions.
- A ChatGPT account with access to Codex.

## Installation

1. Clone the repository:

   ```powershell
   git clone https://github.com/andreilia21/vibecoding.git
   cd vibecoding
   ```

2. Create the local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Edit `.env` and replace every placeholder:

   ```dotenv
   N8N_PUBLIC_URL=https://your-reserved-domain.ngrok-free.dev
   NGROK_DOMAIN=your-reserved-domain.ngrok-free.dev
   GENERIC_TIMEZONE=Europe/Minsk
   NGROK_AUTHTOKEN=replace-me

   GITHUB_OWNER=your-github-user-or-org
   GITHUB_REPO=your-repo-name
   GITHUB_TOKEN=github_pat_replace_me
   DEFAULT_BASE_BRANCH=main

   JIRA_TODO_NAMES=To Do,К выполнению
   JIRA_IN_PROGRESS_NAMES=In Progress,Start Progress,В работе
   JIRA_IN_REVIEW_NAMES=In Review,To Review,Review,Code Review,Ready for Review,В процессе проверки,На проверке
   JIRA_DONE_NAMES=Done,Complete,Completed,Closed,Resolved,Готово,Выполнено,Завершено,Закрыто
   ```

   Do not commit `.env`. It is ignored by Git.

4. Validate the Compose configuration:

   ```powershell
   docker compose config
   ```

5. Build the worker without forcing a base-image update:

   ```powershell
   docker compose build --pull=false codex-worker
   ```

6. Authenticate Codex interactively. The login state is stored in the persistent `codex_home` volume:

   ```powershell
   docker compose run --rm codex-worker /app/node_modules/.bin/codex login
   ```

   Follow the URL and instructions printed by the CLI. Never copy `auth.json` into the repository, GitHub Actions, or other public CI systems. See the official [Codex authentication documentation](https://developers.openai.com/codex/auth/).

7. Start the stack:

   ```powershell
   docker compose up -d
   ```

8. Confirm that the services are running:

   ```powershell
   docker compose ps
   curl.exe http://127.0.0.1:3000/healthz
   ```

   The worker health endpoint should return:

   ```json
   { "ok": true }
   ```

   Open the health monitor at `http://127.0.0.1:3001`. It discovers running Compose `codex-worker` containers and refreshes the dashboard every two seconds.

9. Open n8n at the configured public URL and import `n8n-workflows/jira-automation.json`. Confirm its Jira credential and transition names, then activate it. It will:

   - receive and validate Jira webhook events;
   - process issues assigned to `codex-worker` (or carrying the `codex-worker` label) when they move to `In Progress`;
   - submit a job to `http://codex-worker:3000/jobs`;
   - poll `http://codex-worker:3000/jobs/<job-id>` until it completes or fails;
   - add a Jira comment containing the result or failure details;
   - move successful issues to `In Review` and failed issues back to `To Do`.

10. Import `n8n-workflows/github-review-automation.json`. In its GitHub Trigger:

   - replace `YOUR_GITHUB_OWNER` and `YOUR_GITHUB_REPO`;
   - select a GitHub credential whose token can administer repository webhooks, read pull requests, and write repository contents;
   - confirm the Jira credential used by the remaining nodes;
   - activate the workflow so n8n registers its signed `issue_comment` webhook.

11. Import `n8n-workflows/github-accept-pull-request.json`, configure the same GitHub and Jira credentials, and activate it. This workflow listens for merged Codex pull requests, extracts the Jira key, moves the issue to a Done-category status, and adds a Jira comment with the PR and merge commit links.

12. Configure Jira to send the desired issue events to the production webhook URL generated by the Jira Trigger node.

## Pull request review loop

Every pull request created by the worker includes the Jira key in its title, branch, and a machine-readable marker in its body:

```html
<!-- codex-jira-key: PROJ-123 -->
```

Leave normal review comments, including inline comments on changed files, and then add this standalone PR conversation comment:

```text
/codex fix
```

Only repository owners, members, and collaborators can issue the command. n8n extracts the Jira key, moves the issue from `In Review` to `In Progress`, comments on Jira, and creates a review job. The worker checks out the existing `codex/*` PR branch, merges the latest base branch without rewriting published history, and gives any merge conflicts to Codex together with the review context. It retrieves review submissions, inline comments, conversation comments, and changed-file patches through the GitHub API, verifies that no conflict markers remain, then pushes a new commit to the same pull request. On success n8n returns Jira to `In Review`; on failure it comments with the error and moves the issue to `To Do`.

The command comment ID is used as an idempotency key, so a duplicate delivery reuses the existing worker job. A pull request must be open, belong to the configured repository, use a `codex/*` branch, and contain the matching Jira key.

### Portable Jira transitions

The workflows never hard-code Jira transition or status IDs. Jira's standard status categories identify `To Do` (`new`) and `Done` (`done`). Because both `In Progress` and `In Review` commonly use the `indeterminate` category, their transition and destination-status names are matched against the comma-separated aliases configured in `.env`.

Adjust `JIRA_TODO_NAMES`, `JIRA_IN_PROGRESS_NAMES`, `JIRA_IN_REVIEW_NAMES`, and `JIRA_DONE_NAMES` when a Jira project uses different names or another locale, then recreate the n8n container. Transition errors include both the configured aliases and every transition Jira made available to the n8n credential.

## Worker API

### Health check

```http
GET /healthz
```

### Create a job

```http
POST /jobs
Content-Type: application/json
```

Example request:

```json
{
  "jiraKey": "PROJ-123",
  "summary": "Add validation to the import endpoint",
  "description": "Validate the uploaded document before processing it.",
  "jiraUrl": "https://example.atlassian.net/browse/PROJ-123",
  "baseBranch": "main"
}
```

The endpoint returns HTTP `202` with a job object. Jobs move through `queued`, `running`, `completed`, or `failed` states.

### Read a job

```http
GET /jobs/<job-id>
```

A completed job includes its branch and pull request URL. A failed job includes an error message and the tail of stderr. Jobs interrupted by a worker restart are marked as failed instead of remaining stuck in a running state.

### List jobs

```http
GET /jobs?limit=50
```

Returns the most recently updated persisted jobs. The health monitor uses this endpoint for execution history and error details.

### Create a pull request review job

```http
POST /review-jobs
Content-Type: application/json
```

```json
{
  "jiraKey": "PROJ-123",
  "prNumber": 42,
  "reviewCommandId": "2250338190",
  "requestedBy": "reviewer-login"
}
```

The worker validates the PR-to-Jira link and updates the existing PR branch. GitHub credentials remain inside the worker and are not passed to the Codex child process.

## Persistence and backups

Docker named volumes preserve state when containers are recreated:

- `n8n_data`: n8n database, workflows, credentials, and instance settings.
- `codex_home`: persisted Codex login and configuration.
- `codex_worker_data`: job records and per-job repository checkouts.

`docker compose down` keeps these volumes. `docker compose down -v` deletes them and must not be used unless permanent data removal is intended.

For reliable backups, stop n8n briefly and back up the `n8n_data` volume. Workflow JSON exports alone do not provide a complete backup of credentials and instance settings. Treat all volume backups as sensitive because they may contain encrypted credentials, authentication state, repository data, or job input.

## Operations

View service status and logs:

```powershell
docker compose ps
docker compose logs -f n8n
docker compose logs -f ngrok
docker compose logs -f codex-worker
docker compose logs -f health-monitor
```

While a job is running, `codex-worker` emits Codex JSONL events as structured log entries, so commands and agent progress are visible immediately instead of only after completion.

Recreate containers after configuration changes:

```powershell
docker compose up -d --force-recreate
```

Rebuild only the worker after changing worker files:

```powershell
docker compose build --pull=false codex-worker
docker compose up -d --no-deps --force-recreate codex-worker
```

Stop the stack without deleting data:

```powershell
docker compose down
```

Each service uses `on-failure:5`, limiting automatic restart loops to five attempts. Docker applies its own increasing delay between failed restarts.

## Security notes

- Never commit `.env`, GitHub tokens, ngrok tokens, Jira credentials, OAuth credentials, or Codex authentication files.
- Give the GitHub token access only to the target repository and only the permissions required for contents and pull requests.
- Keep ports `5678`, `3000`, and `3001` bound to `127.0.0.1`. Jira should reach n8n only through ngrok.
- The health monitor has read-only access to the local Docker socket for worker discovery. Keep it local and do not expose it publicly.
- Validate Jira webhook requests in n8n before creating worker jobs.
- Do not expose the worker API directly to the internet.
- Codex runs with `danger-full-access` inside the worker container because nested Bubblewrap namespaces are not available under Docker Desktop. Treat the container as the sandbox: do not add unrelated host mounts or secrets to it. The worker removes `GITHUB_TOKEN` from the Codex child process environment.
- Review every generated pull request. The worker intentionally does not auto-merge.
- Avoid placing decrypted n8n credential exports in this repository.

## Troubleshooting

### Worker exits with `EACCES` under `/work`

Rebuild the current Dockerfile and recreate the worker:

```powershell
docker compose build --pull=false codex-worker
docker compose up -d --no-deps --force-recreate codex-worker
```

The image prepares `/work/repos` and `/work/jobs` for the non-root `codex` user.

### Worker health check is unavailable

```powershell
docker compose ps -a
docker compose logs --tail 100 codex-worker
```

If the container has exhausted its five restart attempts, fix the reported error and start it again with `docker compose up -d codex-worker`.

### ngrok does not expose n8n

Confirm that `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`, and `N8N_PUBLIC_URL` match the reserved ngrok domain, then inspect `docker compose logs ngrok`.

### GitHub pull request creation fails

Confirm the repository owner, repository name, default branch, and token permissions. The worker stores a credential-free Git remote URL and supplies authorization only to individual Git processes.

## Development and verification

Run these checks before committing infrastructure changes:

```powershell
node --check codex-worker/src/server.js
node --check health-monitor/server.js
docker compose config
```

After changing worker files, also run:

```powershell
docker compose build --pull=false codex-worker
```

After changing the monitor, run `docker compose build health-monitor`.

Keep changes small, surface automation failures back to Jira, and do not modify unrelated repositories or automatically merge generated pull requests.
