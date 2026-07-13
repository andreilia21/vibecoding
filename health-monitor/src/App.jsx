import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Bot, CheckCircle2, ChevronDown, Clock3, ExternalLink, Radio, X, XCircle } from "lucide-react";
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

function dateTime(value) {
  return value ? new Date(value).toLocaleString() : "Unknown";
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
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

function JobCard({ job, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const statusIcon = job.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
    : job.status === "failed" ? <XCircle className="h-4 w-4 text-red-400" />
      : <Clock3 className="h-4 w-4 text-amber-400" />;
  return (
    <div className="border-b border-zinc-800 last:border-0">
      <button type="button" className="grid w-full gap-3 px-6 py-4 text-left transition hover:bg-zinc-900/70 md:grid-cols-[1fr_180px_160px] md:items-center" onClick={() => onOpen(job)}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">{statusIcon}<span className="font-medium text-zinc-100">{job.jiraKey}</span><span className="truncate text-sm text-zinc-400">{job.summary}</span></div>
          <p className="mt-2 text-xs text-zinc-500">{job.mode === "review" ? "Review feedback" : "Implementation"} · Created {dateTime(job.createdAt)}</p>
          {job.error && <p className="mt-2 break-words rounded-md bg-red-500/10 p-2 text-xs text-red-400">{job.error}</p>}
        </div>
        <div><StatusBadge status={job.status} /><p className="mt-1 truncate text-xs text-zinc-500">Current step: {job.step}</p></div>
        <div className="text-xs text-zinc-500 md:text-right"><p>{relativeTime(job.updatedAt)}</p><p className="mt-1">{job.steps?.length || 0} steps</p></div>
      </button>
      <div className="border-t border-zinc-800/70 bg-zinc-950/40">
        <button type="button" className="flex w-full items-center justify-between px-6 py-3 text-left text-xs font-medium text-zinc-400 hover:text-zinc-200" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          Execution steps
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
        {expanded && <ol className="space-y-3 px-6 pb-4">
          {job.steps?.length ? job.steps.map((step, index) => <li key={`${step.timestamp}-${index}`} className="grid grid-cols-[12px_1fr_auto] items-start gap-3 text-xs">
            <span className="mt-1 h-2 w-2 rounded-full bg-emerald-500" />
            <div><p className="text-zinc-300">{step.step}</p><p className="mt-0.5 text-zinc-600">{dateTime(step.timestamp)}</p></div>
            <StatusBadge status={step.status} />
          </li>) : <li className="text-xs text-zinc-500">No step history recorded.</li>}
        </ol>}
      </div>
    </div>
  );
}

function eventDetails(event) {
  const details = Object.fromEntries(Object.entries(event).filter(([key, value]) => (
    !["jobId", "timestamp", "level", "message", "step", "status", "kind", "title"].includes(key) && value !== undefined && value !== ""
  )));
  return Object.keys(details).length ? JSON.stringify(details, null, 2) : null;
}

function executionEvents(job) {
  const actions = job.actions || [];
  const actionKeys = new Set(actions.map((action) => `${action.timestamp}:${action.message}:${action.level}`));
  return [
    ...(job.history || []).map((event) => ({ ...event, kind: "Status", title: `Status changed to ${event.status}` })),
    ...(job.steps || []).map((event) => ({ ...event, kind: "Step", title: event.step })),
    ...actions.map((event) => ({ ...event, kind: event.level === "error" ? "Error" : "Action", title: event.message })),
    ...(job.errors || []).filter((event) => !actionKeys.has(`${event.timestamp}:${event.message}:${event.level}`)).map((event) => ({ ...event, kind: "Error", title: event.message })),
  ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function JobModal({ job, loading, error, onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => event.key === "Escape" && onClose();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const events = executionEvents(job);
  const jiraUrl = externalUrl(job.jiraUrl);
  const prUrl = externalUrl(job.prUrl);
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-zinc-950" role="dialog" aria-modal="true" aria-labelledby="execution-title">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 px-4 py-4 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-6xl items-start justify-between gap-4">
          <div><p className="text-sm font-medium text-emerald-400">{job.jiraKey}</p><h2 id="execution-title" className="mt-1 text-2xl font-semibold text-zinc-50">{job.summary}</h2></div>
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-800 p-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" aria-label="Close execution details"><X className="h-5 w-5" /></button>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card><CardContent className="p-5"><p className="text-xs uppercase tracking-wide text-zinc-500">Status</p><div className="mt-2"><StatusBadge status={job.status} /></div></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-xs uppercase tracking-wide text-zinc-500">Last updated</p><p className="mt-2 text-sm text-zinc-200">{dateTime(job.updatedAt)}</p></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-xs uppercase tracking-wide text-zinc-500">Jira task</p>{jiraUrl ? <a className="mt-2 inline-flex items-center gap-1 text-sm text-emerald-400 hover:text-emerald-300" href={jiraUrl} target="_blank" rel="noreferrer">{job.jiraKey}<ExternalLink className="h-3.5 w-3.5" /></a> : <p className="mt-2 text-sm text-zinc-500">Not available</p>}</CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-xs uppercase tracking-wide text-zinc-500">Pull request</p>{prUrl ? <a className="mt-2 inline-flex items-center gap-1 text-sm text-emerald-400 hover:text-emerald-300" href={prUrl} target="_blank" rel="noreferrer">PR {job.prNumber ? `#${job.prNumber}` : "link"}<ExternalLink className="h-3.5 w-3.5" /></a> : <p className="mt-2 text-sm text-zinc-500">Not available</p>}</CardContent></Card>
        </section>

        <section className="mt-8"><h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-500">Step breakdown</h3>
          {loading ? <Card><CardContent className="p-8 text-center text-sm text-zinc-500">Loading execution details…</CardContent></Card>
            : error ? <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">{error}</div>
              : <Card><ol>{events.length ? events.map((event, index) => {
                const details = eventDetails(event);
                return <li key={`${event.kind}-${event.timestamp}-${index}`} className="grid gap-3 border-b border-zinc-800 px-6 py-5 last:border-0 sm:grid-cols-[90px_1fr_180px]">
                  <span className={`text-xs font-medium uppercase tracking-wide ${event.kind === "Error" ? "text-red-400" : event.kind === "Step" ? "text-emerald-400" : "text-zinc-500"}`}>{event.kind}</span>
                  <div className="min-w-0"><p className="break-words text-sm text-zinc-200">{event.title}</p>{event.status && <p className="mt-1 text-xs text-zinc-500">Status: {event.status}</p>}{details && <pre className={`mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-xs ${event.kind === "Error" ? "bg-red-500/10 text-red-300" : "bg-zinc-900 text-zinc-400"}`}>{details}</pre>}</div>
                  <time className="text-xs text-zinc-500 sm:text-right" dateTime={event.timestamp}>{dateTime(event.timestamp)}</time>
                </li>;
              }) : <li className="p-10 text-center text-sm text-zinc-500">No execution events recorded.</li>}</ol></Card>}
        </section>
      </div>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [connected, setConnected] = useState(false);
  const [selectedJob, setSelectedJob] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState(null);
  const detailsRequest = useRef(null);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onopen = () => setConnected(true);
    events.onmessage = (event) => setSnapshot(JSON.parse(event.data));
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, []);

  useEffect(() => {
    if (!selectedJob) return;
    const controller = new AbortController();
    detailsRequest.current = controller;

    async function refreshDetails() {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(selectedJob.id)}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        setSelectedJob(body);
        setDetailsError(null);
      } catch (error) {
        if (error.name !== "AbortError") setDetailsError(error.message);
      } finally {
        if (detailsRequest.current === controller) setDetailsLoading(false);
      }
    }

    refreshDetails();
    return () => controller.abort();
  }, [snapshot.updatedAt, selectedJob?.id]);

  const failedJobs = useMemo(() => snapshot.jobs.filter((job) => job.status === "failed").length, [snapshot.jobs]);
  const healthyWorkers = snapshot.workers.filter((worker) => worker.status === "healthy").length;

  function openJob(job) {
    detailsRequest.current?.abort();
    setSelectedJob(job);
    setDetailsLoading(true);
    setDetailsError(null);
  }

  function closeJob() {
    detailsRequest.current?.abort();
    detailsRequest.current = null;
    setSelectedJob(null);
  }

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

      <section><h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-500">Previous executions</h2><Card>{snapshot.jobs.length ? snapshot.jobs.map((job) => <JobCard key={job.id} job={job} onOpen={openJob} />) : <div className="p-10 text-center text-sm text-zinc-500">No executions recorded yet.</div>}</Card></section>
      {selectedJob && <JobModal job={selectedJob} loading={detailsLoading} error={detailsError} onClose={closeJob} />}
    </main>
  );
}
