import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";

const port = Number(process.env.WORKER_PORT || 3000);
const reposDir = process.env.REPOS_DIR || "/work/repos";
const jobsDir = process.env.JOBS_DIR || "/work/jobs";
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const defaultBaseBranch = process.env.DEFAULT_BASE_BRANCH || "main";
const githubToken = process.env.GITHUB_TOKEN;

await mkdir(reposDir, { recursive: true });
await mkdir(jobsDir, { recursive: true });

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
    req.on("error", reject);
  });
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "task";
}

async function saveJob(job) {
  const file = path.join(jobsDir, `${job.id}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(job, null, 2));
  await rename(tmp, file);
}

async function loadJob(id) {
  const file = path.join(jobsDir, `${id}.json`);
  return JSON.parse(await readFile(file, "utf8"));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`${command} exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

async function updateJob(id, patch) {
  const current = await loadJob(id);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await saveJob(next);
  return next;
}

async function runJob(id) {
  let job = await updateJob(id, { status: "running", step: "preparing repository" });

  if (!owner || !repo || !githubToken) {
    throw new Error("GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN must be configured");
  }

  const repoDir = path.join(reposDir, `${owner}-${repo}`);
  const authRepoUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;
  const publicRepoUrl = `https://github.com/${owner}/${repo}`;
  const baseBranch = job.baseBranch || defaultBaseBranch;
  const branch = `codex/${job.jiraKey}-${slug(job.summary)}`;

  if (!existsSync(repoDir)) {
    await run("git", ["clone", authRepoUrl, repoDir]);
  }

  await run("git", ["fetch", "origin"], { cwd: repoDir });
  await run("git", ["switch", baseBranch], { cwd: repoDir });
  await run("git", ["pull", "--ff-only", "origin", baseBranch], { cwd: repoDir });
  await run("git", ["switch", "-C", branch], { cwd: repoDir });

  const prompt = [
    `Implement Jira issue ${job.jiraKey}.`,
    "",
    "Jira URL:",
    job.jiraUrl,
    "",
    "Summary:",
    job.summary,
    "",
    "Description:",
    job.description,
    "",
    "Requirements:",
    "- Make the smallest correct code change.",
    "- Follow this repository's existing conventions.",
    "- Run relevant tests if available.",
    "- Do not modify unrelated files.",
    "- Leave the repository in a commit-ready state.",
  ].join("\n");

  job = await updateJob(id, { step: "running codex", branch });
  await run("npx", ["codex", "exec", "--sandbox", "workspace-write", prompt], { cwd: repoDir });

  await run("git", ["config", "user.name", "codex-agent"], { cwd: repoDir });
  await run("git", ["config", "user.email", "codex-agent@users.noreply.github.com"], { cwd: repoDir });
  await run("git", ["add", "."], { cwd: repoDir });

  const diff = await run("git", ["diff", "--cached", "--quiet"], { cwd: repoDir }).catch((error) => error);
  if (!diff || !diff.message) {
    await updateJob(id, { status: "completed", step: "no changes", branch, prUrl: null });
    return;
  }

  await updateJob(id, { step: "committing changes" });
  await run("git", ["commit", "-m", `${job.jiraKey}: implement requested change`], { cwd: repoDir });
  await run("git", ["push", "-u", "origin", branch, "--force-with-lease"], { cwd: repoDir });

  await updateJob(id, { step: "creating pull request" });
  const prBody = JSON.stringify({
    title: `${job.jiraKey}: ${job.summary}`,
    head: branch,
    base: baseBranch,
    body: `Implemented by Codex from ${job.jiraUrl}`,
  });

  const pr = await run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "-X",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    `Authorization: Bearer ${githubToken}`,
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    "-d",
    prBody,
  ]);

  const prJson = JSON.parse(pr.stdout);
  await updateJob(id, {
    status: "completed",
    step: "pull request created",
    branch,
    repoUrl: publicRepoUrl,
    prUrl: prJson.html_url,
  });
}

function startJob(job) {
  runJob(job.id).catch(async (error) => {
    await updateJob(job.id, {
      status: "failed",
      step: "failed",
      error: error.message,
      stderr: String(error.stderr || "").slice(-4000),
    });
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/jobs") {
      const body = await readBody(req);
      if (!body.jiraKey || !body.summary || !body.description || !body.jiraUrl) {
        send(res, 400, { error: "jiraKey, summary, description, and jiraUrl are required" });
        return;
      }

      const job = {
        id: crypto.randomUUID(),
        status: "queued",
        step: "queued",
        jiraKey: body.jiraKey,
        summary: body.summary,
        description: body.description,
        jiraUrl: body.jiraUrl,
        baseBranch: body.baseBranch || defaultBaseBranch,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveJob(job);
      startJob(job);
      send(res, 202, job);
      return;
    }

    const match = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && match) {
      send(res, 200, await loadJob(match[1]));
      return;
    }

    send(res, 404, { error: "not found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`codex-worker listening on ${port}`);
});
