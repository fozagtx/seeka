// ─── src/jobs.ts ──────────────────────────────────────────────────────────────

import cron, { type ScheduledTask } from "node-cron";
import type { CronJob, PipelineCallbacks } from "./types.js";
import { runSearch } from "./pipeline.js";

const JOBS_FILE = "./jobs.json";
let jobs: Map<string, CronJob> = new Map();
let taskHandles: Map<string, ScheduledTask> = new Map();

// ─── Persistence ──────────────────────────────────────────────────────────────

export async function loadJobs(): Promise<void> {
  try {
    const file = Bun.file(JOBS_FILE);
    if (await file.exists()) {
      const data: CronJob[] = await file.json();
      for (const job of data) jobs.set(job.id, job);
      console.log(`[Jobs] Loaded ${jobs.size} jobs`);
    } else {
      await addDefaultJobs();
    }
  } catch {
    await addDefaultJobs();
  }
}

async function saveJobs(): Promise<void> {
  await Bun.write(JOBS_FILE, JSON.stringify(Array.from(jobs.values()), null, 2));
}

async function addDefaultJobs(): Promise<void> {
  const defaults: CronJob[] = [
    {
      id: "every-4h",
      name: "Every 4 Hours — Full Sweep",
      schedule: "0 */4 * * *",
      query: "",
      enabled: true,
    },
    {
      id: "daily-ai",
      name: "Daily AI/ML Search",
      schedule: "0 10 * * *",
      query: "AI machine learning hackathon 2026 prize pool",
      enabled: true,
    },
    {
      id: "daily-web3",
      name: "Daily Web3 Search",
      schedule: "0 14 * * *",
      query: "blockchain web3 hackathon 2026 crypto competition",
      enabled: true,
    },
  ];
  for (const job of defaults) jobs.set(job.id, job);
  await saveJobs();
  console.log("[Jobs] Created default jobs");
}

// ─── Job runner ───────────────────────────────────────────────────────────────

// makeCbs factory is passed in from index.ts so bot.api is available
export function startAllJobs(makeCbs: (label: string) => PipelineCallbacks): void {
  for (const job of jobs.values()) {
    if (job.enabled) startJob(job, makeCbs);
  }
  console.log(`[Jobs] Started ${taskHandles.size} cron jobs`);
}

function startJob(job: CronJob, makeCbs: (label: string) => PipelineCallbacks): void {
  if (taskHandles.has(job.id)) {
    taskHandles.get(job.id)!.stop();
    taskHandles.delete(job.id);
  }
  if (!cron.validate(job.schedule)) {
    console.error(`[Jobs] Invalid cron for ${job.id}: ${job.schedule}`);
    return;
  }

  const task = cron.schedule(job.schedule, async () => {
    console.log(`[Jobs] Running: ${job.name}`);
    const j = jobs.get(job.id);
    if (j) { j.lastRun = new Date().toISOString(); await saveJobs(); }

    const cbs = makeCbs(job.name);
    // Prepend cron timing info
    const nextRun = getNextRunLabel(job.schedule);
    await cbs.onStatus(
      `⏰ *Cron triggered:* ${job.name}\n🕐 Time: ${new Date().toLocaleString()}\n🔁 Next run: ${nextRun}`
    ).catch(() => {});

    await runSearch(job.query || undefined, cbs).catch((err) =>
      cbs.onSummary(`❌ Job error: ${String(err)}`).catch(() => {})
    );
  });

  taskHandles.set(job.id, task);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function addJob(
  job: Omit<CronJob, "id">,
  makeCbs: (label: string) => PipelineCallbacks
): Promise<CronJob> {
  const id = `custom-${Date.now()}`;
  const newJob: CronJob = { ...job, id };
  jobs.set(id, newJob);
  await saveJobs();
  if (newJob.enabled) startJob(newJob, makeCbs);
  return newJob;
}

export async function removeJob(id: string): Promise<boolean> {
  if (!jobs.has(id)) return false;
  taskHandles.get(id)?.stop();
  taskHandles.delete(id);
  jobs.delete(id);
  await saveJobs();
  return true;
}

export async function toggleJob(
  id: string,
  makeCbs: (label: string) => PipelineCallbacks
): Promise<CronJob | null> {
  const job = jobs.get(id);
  if (!job) return null;
  job.enabled = !job.enabled;
  if (job.enabled) startJob(job, makeCbs);
  else { taskHandles.get(id)?.stop(); taskHandles.delete(id); }
  await saveJobs();
  return job;
}

export async function updateJobSchedule(
  id: string,
  schedule: string,
  makeCbs: (label: string) => PipelineCallbacks
): Promise<CronJob | null> {
  if (!cron.validate(schedule)) return null;
  const job = jobs.get(id);
  if (!job) return null;
  job.schedule = schedule;
  await saveJobs();
  if (job.enabled) startJob(job, makeCbs);
  return job;
}

export async function runJobNow(
  id: string,
  makeCbs: (label: string) => PipelineCallbacks
): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;
  job.lastRun = new Date().toISOString();
  await saveJobs();
  const cbs = makeCbs(`Manual: ${job.name}`);
  runSearch(job.query || undefined, cbs).catch((err) =>
    cbs.onSummary(`❌ Error: ${String(err)}`).catch(() => {})
  );
  return true;
}

export function listJobs(): CronJob[] { return Array.from(jobs.values()); }
export function getJob(id: string): CronJob | undefined { return jobs.get(id); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getNextRunLabel(schedule: string): string {
  try {
    const parts = schedule.split(" ");
    if (parts[1] === "*/4") return "in ~4 hours";
    if (parts[0] === "0" && parts[1] === "9") return "tomorrow 9 AM";
    if (parts[0] === "0" && parts[1] === "10") return "tomorrow 10 AM";
    if (parts[0] === "0" && parts[1] === "14") return "tomorrow 2 PM";
    return `next: ${schedule}`;
  } catch { return "scheduled"; }
}
