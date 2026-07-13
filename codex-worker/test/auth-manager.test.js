import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthManager, sanitizeLoginOutput } from "../src/auth-manager.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
    return true;
  }
}

async function fixture(options = {}) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-auth-test-"));
  const children = [];
  const manager = new AuthManager({
    codexBin: "/opt/codex",
    codexHome,
    statusRunner: async () => 1,
    spawnLogin: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    ...options,
  });
  await manager.initialize();
  return { manager, children, codexHome, cleanup: () => rm(codexHome, { recursive: true, force: true }) };
}

test("sanitizes login output to allowlisted URL, code, and fixed messages", () => {
  const safe = sanitizeLoginOutput([
    "Open https://auth.openai.com/codex/device?access_token=secret",
    "Enter this code:",
    "ABCD-EFGH",
    "Authorization: Bearer should-never-appear",
  ].join("\n"));
  assert.equal(safe.url, "https://auth.openai.com/codex/device");
  assert.equal(safe.userCode, "ABCD-EFGH");
  assert.equal(safe.message, "Complete the ChatGPT sign-in in your browser.");
  assert.doesNotMatch(JSON.stringify(safe), /secret|Bearer|Authorization/);
  assert.equal(sanitizeLoginOutput("https://evil.example/?refresh_token=secret").url, null);
});

test("detects authenticated and unauthenticated status without reading auth.json", async (t) => {
  let exitCode = 0;
  const item = await fixture({ statusRunner: async () => exitCode });
  t.after(item.cleanup);
  assert.equal((await item.manager.status({ force: true })).state, "authenticated");
  exitCode = 1;
  assert.equal((await item.manager.status({ force: true })).state, "unauthenticated");
});

test("reuses an in-flight authentication status check", async (t) => {
  let resolveStatus;
  let calls = 0;
  const item = await fixture({ statusRunner: () => {
    calls += 1;
    return new Promise((resolve) => { resolveStatus = resolve; });
  } });
  t.after(item.cleanup);
  const first = item.manager.status({ force: true });
  const second = item.manager.status({ force: true });
  while (!resolveStatus) await new Promise((resolve) => setTimeout(resolve, 1));
  resolveStatus(0);
  assert.equal((await first).state, "authenticated");
  assert.equal((await second).state, "authenticated");
  assert.equal(calls, 1);
});

test("reports unavailable CLI without exposing process errors", async (t) => {
  const error = Object.assign(new Error("spawn /secret/path/codex ENOENT"), { code: "ENOENT" });
  const item = await fixture({ statusRunner: async () => { throw error; } });
  t.after(item.cleanup);
  assert.deepEqual(await item.manager.status({ force: true }), {
    state: "error",
    message: "Codex CLI is unavailable.",
    checkedAt: null,
  });
});

test("reports a missing CODEX_HOME separately from an unavailable CLI", async () => {
  const codexHome = path.join(os.tmpdir(), `missing-codex-home-${Date.now()}`);
  const manager = new AuthManager({ codexBin: "/opt/codex", codexHome });
  assert.deepEqual(await manager.status({ force: true }), {
    state: "error",
    message: "CODEX_HOME is missing or not writable.",
    checkedAt: null,
  });
});

test("reuses one active login and publishes safe progress", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  const [first, second] = await Promise.all([item.manager.start(), item.manager.start()]);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(item.children.length, 1);
  item.children[0].stdout.emit("data", "Open https://auth.openai.com/codex/de");
  item.children[0].stdout.emit("data", "vice\nCode:\nWXYZ-1234\nrefresh_token=hidden");
  const state = item.manager.publicState();
  assert.equal(state.login.url, "https://auth.openai.com/codex/device");
  assert.equal(state.login.userCode, "WXYZ-1234");
  assert.doesNotMatch(JSON.stringify(state), /refresh_token|hidden/);
});

test("detects successful login completion", async (t) => {
  const item = await fixture({ statusRunner: async () => 0 });
  t.after(item.cleanup);
  await item.manager.start();
  item.children[0].emit("close", 0, null);
  while (item.manager.publicState().state !== "authenticated") {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(item.manager.publicState().state, "authenticated");
});

test("reports login process startup failure", async (t) => {
  const item = await fixture({
    spawnLogin: () => { throw Object.assign(new Error("sensitive command details"), { code: "ENOENT" }); },
  });
  t.after(item.cleanup);
  const result = await item.manager.start();
  assert.equal(result.state, "error");
  assert.equal(result.message, "Codex CLI is unavailable.");
  assert.doesNotMatch(JSON.stringify(result), /sensitive command details/);
});

test("cancels an active login without deleting an existing session", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  await item.manager.start();
  const result = await item.manager.cancel();
  assert.equal(result.cancelled, true);
  assert.equal(result.state, "unauthenticated");
  assert.equal(item.children[0].killedWith, "SIGTERM");
});

test("keeps an existing authenticated state after cancellation", async (t) => {
  const item = await fixture({ statusRunner: async () => 0 });
  t.after(item.cleanup);
  await item.manager.status({ force: true });
  await item.manager.start();
  const result = await item.manager.cancel();
  assert.equal(result.state, "authenticated");
  assert.match(result.message, /remains valid/i);
});

test("times out an abandoned login", async (t) => {
  const item = await fixture({ loginTimeoutMs: 10 });
  t.after(item.cleanup);
  await item.manager.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const state = item.manager.publicState();
  assert.equal(state.state, "unauthenticated");
  assert.match(state.message, /timed out/i);
  assert.equal(item.children[0].killedWith, "SIGTERM");
});

test("reports a worker restart that interrupted login", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-auth-restart-test-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  await writeFile(path.join(codexHome, ".codex-worker-login-pending"), "pending\n");
  const manager = new AuthManager({ codexBin: "/opt/codex", codexHome });
  await manager.initialize();
  assert.equal(manager.publicState().state, "error");
  assert.match(manager.publicState().message, /restarted/);
});
