import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const port = Number(process.env.MONITOR_PORT || 3001);
const dockerSocket = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const workerPort = Number(process.env.WORKER_PORT || 3000);
const refreshMs = Number(process.env.REFRESH_INTERVAL_MS || 2000);
const distDir = path.resolve("dist");
const clients = new Set();

let snapshot = { workers: [], jobs: [], updatedAt: null, error: null };
let refreshing = false;

function dockerRequest(pathname) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: dockerSocket, path: pathname }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Docker API returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function discoverWorkers() {
  const filters = encodeURIComponent(JSON.stringify({
    label: ["com.docker.compose.service=codex-worker"],
    status: ["running"],
  }));
  const [containers, self] = await Promise.all([
    dockerRequest(`/containers/json?filters=${filters}`),
    dockerRequest(`/containers/${process.env.HOSTNAME}/json`),
  ]);
  const monitorNetworks = new Set(Object.keys(self.NetworkSettings?.Networks || {}));

  return containers.flatMap((container) => {
    const networks = container.NetworkSettings?.Networks || {};
    const networkName = Object.keys(networks).find((name) => monitorNetworks.has(name));
    const address = networkName && networks[networkName]?.IPAddress;
    if (!address) return [];
    return [{
      id: container.Id.slice(0, 12),
      name: container.Names?.[0]?.replace(/^\//, "") || container.Id.slice(0, 12),
      dockerStatus: container.Status,
      address,
    }];
  });
}

async function inspectWorker(worker) {
  const baseUrl = `http://${worker.address}:${workerPort}`;
  const checkedAt = new Date().toISOString();
  try {
    const [health, jobs] = await Promise.all([
      getJson(`${baseUrl}/healthz`),
      getJson(`${baseUrl}/jobs?limit=100`),
    ]);
    return {
      worker: { ...worker, status: health.ok ? "healthy" : "unhealthy", checkedAt, error: null },
      jobs,
    };
  } catch (error) {
    return {
      worker: { ...worker, status: "unhealthy", checkedAt, error: error.message },
      jobs: [],
    };
  }
}

function broadcast() {
  const message = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of clients) client.write(message);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const discovered = await discoverWorkers();
    const results = await Promise.all(discovered.map(inspectWorker));
    const jobsById = new Map();
    for (const result of results) {
      for (const job of result.jobs) jobsById.set(job.id, job);
    }
    snapshot = {
      workers: results.map((result) => result.worker),
      jobs: [...jobsById.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
      updatedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    snapshot = { ...snapshot, updatedAt: new Date().toISOString(), error: error.message };
  } finally {
    refreshing = false;
    broadcast();
  }
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(snapshot));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    try {
      if (snapshot.workers.length === 0) throw new Error("No active workers are available");
      const jobId = encodeURIComponent(decodeURIComponent(jobMatch[1]));
      const details = await Promise.any(snapshot.workers.map((worker) => (
        getJson(`http://${worker.address}:${workerPort}/jobs/${jobId}/execution`)
      )));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(details));
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  try {
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    let file = path.resolve(distDir, requested);
    if (!file.startsWith(`${distDir}${path.sep}`) && file !== path.join(distDir, "index.html")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": contentTypes[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      file = path.join(distDir, "index.html");
      res.writeHead(200, { "content-type": contentTypes[".html"] });
      res.end(await readFile(file));
    }
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

await refresh();
setInterval(refresh, refreshMs).unref();
server.listen(port, "0.0.0.0", () => console.log(`health-monitor listening on ${port}`));
