import { EventEmitter } from "node:events";
import { access, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_CACHE_MS = 5000;
const MAX_EVENTS = 50;

function codexEnvironment(codexHome) {
  const names = [
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE",
  ];
  return Object.fromEntries([
    ...names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
    ["CODEX_HOME", codexHome],
  ]);
}

function safeError(error, fallback) {
  if (error?.isCodexHome) return "CODEX_HOME is missing or not writable.";
  if (error?.code === "ENOENT") return "Codex CLI is unavailable.";
  if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) return "CODEX_HOME is missing or not writable.";
  return fallback;
}

async function checkCodexHome(codexHome) {
  try {
    await access(codexHome, constants.R_OK | constants.W_OK);
  } catch (error) {
    error.isCodexHome = true;
    throw error;
  }
}

export function sanitizeLoginOutput(value) {
  const text = String(value || "");
  const rawUrl = text.match(/https:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;]+$/, "") || null;
  let url = null;
  try {
    const candidate = new URL(rawUrl);
    if (["auth.openai.com", "chatgpt.com", "platform.openai.com"].includes(candidate.hostname)) {
      candidate.username = "";
      candidate.password = "";
      candidate.search = "";
      candidate.hash = "";
      url = candidate.href;
    }
  } catch {
    // Ignore malformed and non-OpenAI URLs.
  }
  const codeMatch = text.match(/(?:enter|code)[^\r\n]{0,80}\b([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)\b/i)
    || text.split(/\r?\n/).map((line) => line.trim().match(/^([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)$/i)).find(Boolean);
  const userCode = codeMatch?.[1]?.toUpperCase() || null;
  let message = null;
  if (/waiting|complete|browser|device|sign[ -]?in|log[ -]?in/i.test(text)) {
    message = url || userCode
      ? "Complete the ChatGPT sign-in in your browser."
      : "Waiting for ChatGPT authentication to complete."
  }
  return { url, userCode, message };
}

function defaultStatusRunner(codexBin, codexHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ["login", "status"], {
      env: codexEnvironment(codexHome),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error("Codex authentication status check timed out");
      error.code = "ETIMEDOUT";
      reject(error);
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 1) resolve(code);
      else reject(Object.assign(new Error("Codex authentication status check failed"), { code: "ECODEXSTATUS" }));
    });
  });
}

export class AuthManager {
  constructor({
    codexBin,
    codexHome,
    loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
    spawnLogin = (bin, args, env) => spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] }),
    statusRunner = defaultStatusRunner,
    now = () => new Date(),
  }) {
    this.codexBin = codexBin;
    this.codexHome = codexHome;
    this.loginTimeoutMs = loginTimeoutMs;
    this.spawnLogin = spawnLogin;
    this.statusRunner = statusRunner;
    this.now = now;
    this.markerPath = path.join(codexHome, ".codex-worker-login-pending");
    this.emitter = new EventEmitter();
    this.events = [];
    this.child = null;
    this.timer = null;
    this.statusPromise = null;
    this.startPromise = null;
    this.lastStatus = { state: "checking", message: "Checking Codex authentication.", checkedAt: null };
    this.attempt = null;
  }

  async initialize() {
    try {
      await checkCodexHome(this.codexHome);
      await access(this.markerPath, constants.F_OK);
      await rm(this.markerPath, { force: true });
      this.lastStatus = {
        state: "error",
        message: "The worker restarted during the previous login attempt. Start a new login.",
        checkedAt: null,
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.lastStatus = { state: "error", message: safeError(error, "Unable to access CODEX_HOME."), checkedAt: null };
      }
    }
  }

  publicState() {
    if (!this.attempt) return { ...this.lastStatus };
    return {
      state: "login_pending",
      message: this.attempt.message,
      checkedAt: this.lastStatus.checkedAt,
      login: {
        startedAt: this.attempt.startedAt,
        expiresAt: this.attempt.expiresAt,
        url: this.attempt.url,
        userCode: this.attempt.userCode,
      },
    };
  }

  async status({ force = false } = {}) {
    if (this.attempt) return this.publicState();
    const lastCheck = this.lastStatus.checkedAt ? new Date(this.lastStatus.checkedAt).getTime() : 0;
    if (!force && Date.now() - lastCheck < STATUS_CACHE_MS) return this.publicState();
    if (!this.statusPromise) {
      this.statusPromise = (async () => {
        try {
          await checkCodexHome(this.codexHome);
          const exitCode = await this.statusRunner(this.codexBin, this.codexHome);
          const checkedAt = this.now().toISOString();
          this.lastStatus = exitCode === 0
            ? { state: "authenticated", message: "Codex is authenticated.", checkedAt }
            : { state: "unauthenticated", message: "Codex is not authenticated.", checkedAt };
        } catch (error) {
          this.lastStatus = {
            state: "error",
            message: safeError(error, error?.code === "ETIMEDOUT" ? "Codex authentication status check timed out." : "Unable to check Codex authentication."),
            checkedAt: this.lastStatus.checkedAt,
          };
        }
        return this.publicState();
      })();
    }
    const statusPromise = this.statusPromise;
    try {
      return await statusPromise;
    } finally {
      if (this.statusPromise === statusPromise) this.statusPromise = null;
    }
  }

  addEvent(type, fields = {}) {
    const event = { id: `${Date.now()}-${this.events.length}`, type, timestamp: this.now().toISOString(), ...fields };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emitter.emit("event", event);
    return event;
  }

  async start() {
    if (this.attempt) return { reused: true, ...this.publicState() };
    if (this.startPromise) {
      const result = await this.startPromise;
      return result.state === "login_pending" ? { ...result, reused: true } : result;
    }
    const startPromise = this.startAttempt();
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async startAttempt() {
    try {
      await checkCodexHome(this.codexHome);
      await writeFile(this.markerPath, `${this.now().toISOString()}\n`, { mode: 0o600 });
      const startedAt = this.now();
      this.attempt = {
        startedAt: startedAt.toISOString(),
        expiresAt: new Date(startedAt.getTime() + this.loginTimeoutMs).toISOString(),
        url: null,
        userCode: null,
        message: "Starting ChatGPT authentication.",
        outputBuffer: "",
      };
      this.events = [];
      this.addEvent("started", { message: this.attempt.message });
      const child = this.spawnLogin(this.codexBin, ["login", "--device-auth"], codexEnvironment(this.codexHome));
      this.child = child;
      const onOutput = (chunk) => {
        if (!this.attempt) return;
        const outputBuffer = `${this.attempt.outputBuffer}${String(chunk)}`.slice(-4096);
        this.attempt.outputBuffer = outputBuffer;
        const safe = sanitizeLoginOutput(outputBuffer);
        if (!safe.url && !safe.userCode && !safe.message) return;
        if (safe.url === this.attempt.url && safe.userCode === this.attempt.userCode && safe.message === this.attempt.message) return;
        this.attempt = {
          ...this.attempt,
          outputBuffer,
          url: safe.url || this.attempt.url,
          userCode: safe.userCode || this.attempt.userCode,
          message: safe.message || this.attempt.message,
        };
        this.addEvent("progress", {
          message: this.attempt.message,
          url: this.attempt.url,
          userCode: this.attempt.userCode,
        });
      };
      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);
      child.once("error", (error) => this.finish("error", safeError(error, "Unable to start the Codex login process.")));
      child.once("close", (code, signal) => {
        if (!this.attempt) return;
        if (code === 0) this.finish("complete", "ChatGPT authentication completed.");
        else if (signal) this.finish("cancelled", "ChatGPT authentication was cancelled.");
        else this.finish("error", "ChatGPT authentication failed or expired.");
      });
      this.timer = setTimeout(() => {
        this.child?.kill("SIGTERM");
        this.finish("timeout", "ChatGPT authentication timed out. Start a new login.");
      }, this.loginTimeoutMs);
      this.timer.unref?.();
      return { reused: false, ...this.publicState() };
    } catch (error) {
      await rm(this.markerPath, { force: true }).catch(() => {});
      this.attempt = null;
      this.child = null;
      clearTimeout(this.timer);
      this.timer = null;
      this.lastStatus = { state: "error", message: safeError(error, "Unable to start ChatGPT authentication."), checkedAt: this.lastStatus.checkedAt };
      return this.publicState();
    }
  }

  async finish(type, message) {
    if (!this.attempt) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.child = null;
    this.attempt = null;
    await rm(this.markerPath, { force: true }).catch(() => {});
    this.addEvent(type, { message });
    const status = await this.status({ force: true });
    if (type !== "complete") {
      this.lastStatus = status.state === "authenticated"
        ? { ...status, message: `${message} Existing Codex authentication remains valid.` }
        : { state: type === "cancelled" || type === "timeout" ? "unauthenticated" : "error", message, checkedAt: status.checkedAt };
    }
  }

  async cancel() {
    if (this.startPromise && !this.attempt) await this.startPromise;
    if (!this.attempt) return { cancelled: false, ...this.publicState() };
    const child = this.child;
    child?.kill("SIGTERM");
    await this.finish("cancelled", "ChatGPT authentication was cancelled.");
    return { cancelled: true, ...this.publicState() };
  }

  subscribe(listener) {
    for (const event of this.events) listener(event);
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
