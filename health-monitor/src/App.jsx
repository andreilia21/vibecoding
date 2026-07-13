import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Bot, CheckCircle2, Clock3, Radio, XCircle } from "lucide-react";
import { Badge, Card, CardContent, CardHeader } from "./components/ui";

const emptySnapshot = { workers: [], jobs: [], updatedAt: null, error: null };

function relativeTime(value) {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value)) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return new Date(value).toLocaleString();
}

function StatusBadge({ status }) {
  const variant = status === "healthy" || status === "completed"
    ? "default"
    : status === "failed" || status === "unhealthy"
      ? "destructive"
      : status === "running"
        ? "warning"
        : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

function WorkerCard({ worker, jobs }) {
  const active = jobs.filter((job) => job.workerId === worker.id && ["queued", "running"].includes(job.status)).length;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <div className="mb-1 flex items-center gap-2 text-base font-semibold text-zinc-100"><Bot className="h-4 w-4" />{worker.name}</div>
          <p className="font-mono text-xs text-zinc-500">{worker.id}</p>
        </div>
        <StatusBadge status={worker.status} />
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 text-sm">
        <div><p className="text-zinc-500">Active jobs</p><p className="mt-1 text-xl font-semibold text-zinc-100">{active}</p></div>
        <div><p className="text-zinc-500">Last check</p><p className="mt-1 text-zinc-300">{relativeTime(worker.checkedAt)}</p></div>
        <p className="col-span-2 truncate text-xs text-zinc-500">{worker.dockerStatus}</p>
        {worker.error && <p className="col-span-2 rounded-md bg-red-500/10 p-3 text-xs text-red-400">{worker.error}</p>}
      </CardContent>
    </Card>
  );
}

function JobRow({ job }) {
  const statusIcon = job.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
    : job.status === "failed" ? <XCircle className="h-4 w-4 text-red-400" />
      : <Clock3 className="h-4 w-4 text-amber-400" />;
  return (
    <div className="grid gap-3 border-b border-zinc-800 px-6 py-4 last:border-0 md:grid-cols-[1fr_140px_140px] md:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">{statusIcon}<span className="font-medium text-zinc-100">{job.jiraKey}</span><span className="truncate text-sm text-zinc-400">{job.summary}</span></div>
        {job.error && <p className="mt-2 break-words rounded-md bg-red-500/10 p-2 text-xs text-red-400">{job.error}</p>}
      </div>
      <div><StatusBadge status={job.status} /><p className="mt-1 truncate text-xs text-zinc-500">{job.step}</p></div>
      <p className="text-xs text-zinc-500 md:text-right">{relativeTime(job.updatedAt)}</p>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onopen = () => setConnected(true);
    events.onmessage = (event) => setSnapshot(JSON.parse(event.data));
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, []);

  const failedJobs = useMemo(() => snapshot.jobs.filter((job) => job.status === "failed").length, [snapshot.jobs]);
  const healthyWorkers = snapshot.workers.filter((worker) => worker.status === "healthy").length;

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-8 sm:px-8">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="mb-2 text-sm font-medium text-emerald-400">Operations</p><h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Codex health monitor</h1><p className="mt-2 text-sm text-zinc-500">Live worker health and execution history</p></div>
        <div className="flex items-center gap-2 text-xs text-zinc-500"><Radio className={`h-3.5 w-3.5 ${connected ? "text-emerald-400" : "text-red-400"}`} />{connected ? "Live" : "Reconnecting"} · {relativeTime(snapshot.updatedAt)}</div>
      </header>

      {(snapshot.error || snapshot.workers.length === 0) && <div className="mb-6 flex gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-300"><AlertTriangle className="h-5 w-5 shrink-0" /><span>{snapshot.error || "No active codex workers were discovered."}</span></div>}

      <section className="mb-8 grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="flex items-center justify-between p-6"><div><p className="text-sm text-zinc-500">Healthy workers</p><p className="mt-1 text-2xl font-semibold">{healthyWorkers} / {snapshot.workers.length}</p></div><Activity className="h-6 w-6 text-emerald-400" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-6"><div><p className="text-sm text-zinc-500">Executions</p><p className="mt-1 text-2xl font-semibold">{snapshot.jobs.length}</p></div><Clock3 className="h-6 w-6 text-zinc-400" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-6"><div><p className="text-sm text-zinc-500">Failed</p><p className="mt-1 text-2xl font-semibold">{failedJobs}</p></div><XCircle className="h-6 w-6 text-red-400" /></CardContent></Card>
      </section>

      <section className="mb-8"><h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-500">Active workers</h2><div className="grid gap-4 lg:grid-cols-2">{snapshot.workers.map((worker) => <WorkerCard key={worker.id} worker={worker} jobs={snapshot.jobs} />)}</div></section>

      <section><h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-500">Previous executions</h2><Card>{snapshot.jobs.length ? snapshot.jobs.map((job) => <JobRow key={job.id} job={job} />) : <div className="p-10 text-center text-sm text-zinc-500">No executions recorded yet.</div>}</Card></section>
    </main>
  );
}
