import { createServer } from "node:http";
import { chown, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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
const codexHome = process.env.CODEX_HOME || "/home/codex/.codex";
const workerId = process.env.HOSTNAME || "codex-worker";
const codexUid = 1000;
const codexGid = 1000;

const githubAuthEnv = githubToken
  ? {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString("base64")}`,
    }
  : {};

for (const directory of [codexHome, reposDir, jobsDir]) {
  await mkdir(directory, { recursive: true });
  if (process.getuid?.() === 0) {
    await chown(directory, codexUid, codexGid);
  }
}

if (process.getuid?.() === 0) {
  process.setgroups([]);
  process.setgid(codexGid);
  process.setuid(codexUid);
}

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
        err.exitCode = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function tail(value, limit = 4000) {
  return String(value || "").slice(-limit);
}

function logJob(level, jobId, message, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    jobId,
    message,
    ...details,
  };
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  logger(JSON.stringify(entry));
}

function runGit(args, options = {}) {
  return run("git", args, {
    ...options,
    env: { ...githubAuthEnv, ...options.env },
  });
}

async function updateJob(id, patch) {
  const current = await loadJob(id);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await saveJob(next);
  if (patch.status || patch.step) {
    logJob(patch.status === "failed" ? "error" : "info", id, "Job state changed", {
      status: next.status,
      step: next.step,
      ...(patch.error ? { error: tail(patch.error) } : {}),
    });
  }
  return next;
}

async function runJob(id) {
  let job = await updateJob(id, { status: "running", step: "preparing repository" });

  if (!owner || !repo || !githubToken) {
    throw new Error("GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN must be configured");
  }

  // Each job gets its own checkout so concurrent Jira events cannot switch,
  // stage, or commit files in another job's working tree.
  const repoDir = path.join(reposDir, id);
  const cloneRepoUrl = `https://github.com/${owner}/${repo}.git`;
  const publicRepoUrl = `https://github.com/${owner}/${repo}`;
  const baseBranch = job.baseBranch || defaultBaseBranch;
  const branch = `codex/${job.jiraKey}-${slug(job.summary)}`;

  if (!existsSync(repoDir)) {
    await runGit(["clone", cloneRepoUrl, repoDir]);
  }

  await runGit(["fetch", "origin"], { cwd: repoDir });
  await runGit(["switch", baseBranch], { cwd: repoDir });
  await runGit(["pull", "--ff-only", "origin", baseBranch], { cwd: repoDir });
  await runGit(["switch", "-C", branch], { cwd: repoDir });

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
  const codexResult = await run("npx", ["codex", "exec", "--sandbox", "workspace-write", prompt], {
    cwd: repoDir,
  });
  const codexStdout = tail(codexResult.stdout, 8000);
  const codexStderr = tail(codexResult.stderr, 8000);
  logJob("info", id, "Codex command completed", {
    stdout: codexStdout,
    stderr: codexStderr,
  });

  await runGit(["config", "user.name", "codex-agent"], { cwd: repoDir });
  await runGit(["config", "user.email", "codex-agent@users.noreply.github.com"], { cwd: repoDir });
  await runGit(["add", "."], { cwd: repoDir });

  let hasChanges = false;
  try {
    await runGit(["diff", "--cached", "--quiet"], { cwd: repoDir });
  } catch (error) {
    if (error.exitCode !== 1) {
      throw error;
    }
    hasChanges = true;
  }

  if (!hasChanges) {
    logJob("warn", id, "Codex completed successfully but produced no Git changes", {
      branch,
      stdout: codexStdout,
      stderr: codexStderr,
    });
    await updateJob(id, {
      status: "completed",
      step: "no changes",
      branch,
      prUrl: null,
      codexStdout,
      codexStderr,
    });
    return;
  }

  await updateJob(id, { step: "committing changes" });
  await runGit(["commit", "-m", `${job.jiraKey}: implement requested change`], { cwd: repoDir });
  await runGit(["push", "-u", "origin", branch, "--force-with-lease"], { cwd: repoDir });

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
    const stdout = tail(error.stdout);
    const stderr = tail(error.stderr);
    logJob("error", job.id, "Job failed", {
      error: error.message,
      exitCode: error.exitCode,
      stdout,
      stderr,
      stack: tail(error.stack),
    });
    try {
      await updateJob(job.id, {
        status: "failed",
        step: "failed",
        error: error.message,
        stdout,
        stderr,
      });
    } catch (updateError) {
      logJob("error", job.id, "Unable to persist failed job state", {
        error: updateError.message,
        stack: tail(updateError.stack),
      });
    }
  });
}

async function failInterruptedJobs() {
  const files = await readdir(jobsDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const job = await loadJob(file.slice(0, -5));
      if (job.status === "queued" || job.status === "running") {
        await updateJob(job.id, {
          status: "failed",
          step: "interrupted",
          error: "Worker restarted before the job completed",
        });
      }
    } catch (error) {
      console.error(`Unable to recover job file ${file}:`, error);
    }
  }
}

async function sanitizeLegacyCheckout() {
  if (!owner || !repo) return;

  const legacyRepoDir = path.join(reposDir, `${owner}-${repo}`);
  if (!existsSync(path.join(legacyRepoDir, ".git"))) return;

  try {
    await run("git", ["remote", "set-url", "origin", `https://github.com/${owner}/${repo}.git`], {
      cwd: legacyRepoDir,
    });
  } catch (error) {
    console.error("Unable to remove credentials from the legacy checkout:", error);
  }
}

await sanitizeLegacyCheckout();
await failInterruptedJobs();

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
        workerId,
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
      logJob("info", job.id, "Job accepted", { jiraKey: job.jiraKey });
      startJob(job);
      send(res, 202, job);
      return;
    }

    if (req.method === "GET" && url.pathname === "/jobs") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
      const files = await readdir(jobsDir);
      const jobs = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => loadJob(file.slice(0, -5))),
      );
      jobs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      send(res, 200, jobs.slice(0, limit));
      return;
    }

    const match = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && match) {
      send(res, 200, await loadJob(match[1]));
      return;
    }

    send(res, 404, { error: "not found" });
  } catch (error) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "Request handling failed",
      method: req.method,
      url: req.url,
      error: error.message,
      stack: tail(error.stack),
    }));
    send(res, 500, { error: error.message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`codex-worker listening on ${port}`);
});
