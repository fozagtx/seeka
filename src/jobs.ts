// ─── src/jobs.ts ──────────────────────────────────────────────────────────────
// Cron job manager — add, remove, enable/disable custom search schedules

import cron, { type ScheduledTask } from "node-cron";
import type { CronJob } from "./types.js";
import { runSearch } from "./pipeline.js";

// In-memory job store (persists to jobs.json)
const JOBS_FILE = "./jobs.json";
let jobs: Map<string, CronJob> = new Map();
let taskHandles: Map<string, ScheduledTask> = new Map();

// ─── Persistence ──────────────────────────────────────────────────────────────

export async function loadJobs(): Promise<void> {
  try {
    const file = Bun.file(JOBS_FILE);
    if (await file.exists()) {
      const data: CronJob[] = await file.json();
      for (const job of data) {
        jobs.set(job.id, job);
      }
      console.log(`[Jobs] Loaded ${jobs.size} jobs from disk`);
    } else {
      await addDefaultJobs();
    }
  } catch (err) {
    console.error("[Jobs] Error loading jobs:", err);
    await addDefaultJobs();
  }
}

async function saveJobs(): Promise<void> {
  const data = Array.from(jobs.values());
  await Bun.write(JOBS_FILE, JSON.stringify(data, null, 2));
}

// ─── Default jobs ─────────────────────────────────────────────────────────────

function getEvery4HoursSchedule(): string {
  const now = new Date();
  const m = now.getMinutes();
  const h = now.getHours();
  const hours: number[] = [];
  for (let i = 0; i < 6; i++) {
    hours.push((h + i * 4) % 24);
  }
  hours.sort((a, b) => a - b);
  return `${m} ${hours.join(",")} * * *`;
}

async function addDefaultJobs(): Promise<void> {
  const defaults: CronJob[] = [
    {
      id: "every-4-hours",
      name: "Continuous Hackathon Search",
      schedule: getEvery4HoursSchedule(),
      query: "hackathon competition contest 2026 prize open registration",
      enabled: true,
    }
  ];

  for (const job of defaults) {
    jobs.set(job.id, job);
  }
  await saveJobs();
  console.log("[Jobs] Created default jobs");
}

// ─── Job management ───────────────────────────────────────────────────────────

export function startAllJobs(
  onResult: (msg: string) => void
): void {
  for (const job of jobs.values()) {
    if (job.enabled) {
      startJob(job, onResult);
    }
  }
  console.log(`[Jobs] Started ${taskHandles.size} active cron jobs`);
}

function startJob(job: CronJob, onResult: (msg: string) => void): void {
  if (taskHandles.has(job.id)) {
    taskHandles.get(job.id)!.stop();
    taskHandles.delete(job.id);
  }

  if (!cron.validate(job.schedule)) {
    console.error(`[Jobs] Invalid cron expression for job ${job.id}: ${job.schedule}`);
    return;
  }

  const runTask = async () => {
    console.log(`[Jobs] Running job: ${job.name}`);
    jobs.get(job.id)!.lastRun = new Date().toISOString();
    await saveJobs();

    try {
      const { found, pushed, message } = await runSearch(job.query || undefined);
      const summary = `🔄 *[Cron: ${job.name}]*\n${message}\nFound: ${found} | Sent to Notion: ${pushed}`;
      onResult(summary);
    } catch (err) {
      onResult(`❌ *[Cron: ${job.name}]* Error: ${String(err)}`);
    }
  };

  // Run the job immediately when it starts
  setTimeout(runTask, 0);

  const task = cron.schedule(job.schedule, runTask);

  taskHandles.set(job.id, task);
}

export async function addJob(
  job: Omit<CronJob, "id">,
  onResult: (msg: string) => void
): Promise<CronJob> {
  const id = `custom-${Date.now()}`;
  const newJob: CronJob = { ...job, id };
  jobs.set(id, newJob);
  await saveJobs();

  if (newJob.enabled) {
    startJob(newJob, onResult);
  }

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
  onResult: (msg: string) => void
): Promise<CronJob | null> {
  const job = jobs.get(id);
  if (!job) return null;

  job.enabled = !job.enabled;
  if (job.enabled) {
    startJob(job, onResult);
  } else {
    taskHandles.get(id)?.stop();
    taskHandles.delete(id);
  }

  await saveJobs();
  return job;
}

export async function updateJobSchedule(
  id: string,
  schedule: string,
  onResult: (msg: string) => void
): Promise<CronJob | null> {
  if (!cron.validate(schedule)) return null;
  const job = jobs.get(id);
  if (!job) return null;

  job.schedule = schedule;
  jobs.set(id, job);
  await saveJobs();

  if (job.enabled) {
    startJob(job, onResult);
  }

  return job;
}

export function listJobs(): CronJob[] {
  return Array.from(jobs.values());
}

export function getJob(id: string): CronJob | undefined {
  return jobs.get(id);
}

export async function runJobNow(
  id: string,
  onResult: (msg: string) => void
): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;

  job.lastRun = new Date().toISOString();
  await saveJobs();

  runSearch(job.query || undefined)
    .then(({ found, pushed, message }) => {
      onResult(
        `✅ *[Manual: ${job.name}]*\n${message}\nFound: ${found} | Sent to Notion: ${pushed}`
      );
    })
    .catch((err) => {
      onResult(`❌ *[Manual: ${job.name}]* Error: ${String(err)}`);
    });

  return true;
}
