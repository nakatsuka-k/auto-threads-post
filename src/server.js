import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAccounts, listEnabledAccounts, replaceAccounts } from "./accountStore.js";
import { postToThreads } from "./threadsPoster.js";
import { listSessions, deleteSession } from "./sessionStore.js";

const app = express();
const DEFAULT_PORT = 3000;
const MAX_FALLBACK_PORT = 3010;
const requestedPort = Number(process.env.PORT || DEFAULT_PORT);
const hasExplicitPort = typeof process.env.PORT !== "undefined";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const jobs = new Map();
const MAX_JOB_HISTORY = 30;
const accountLastJobAt = new Map();
const ACCOUNT_JOB_COOLDOWN_MS = 30000;

function stageLabel(stage) {
  const map = {
    queued: "待機中",
    waiting: "待機スケジュール",
    cancel_requested: "キャンセル要求",
    cancelled: "キャンセル済み",
    session_load: "セッション読み込み",
    login_check: "ログイン確認",
    login_done: "ログイン完了",
    compose_open: "投稿画面を開く",
    compose_fill: "本文入力",
    submit_post: "投稿送信",
    session_save: "セッション保存",
    done: "完了",
    error: "エラー"
  };
  return map[stage] || stage;
}

function createJob({ requested, targets }) {
  const id = randomUUID();
  const job = {
    id,
    status: "running",
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requested,
    results: [],
    overallProgress: 0,
    inspection: null,
    accounts: targets.map((account) => ({
      accountId: account.id,
      username: account.username,
      label: account.label,
      status: "queued",
      progress: 0,
      stage: "queued",
      stageLabel: stageLabel("queued"),
      message: "開始待ち",
      steps: []
    }))
  };

  jobs.set(id, job);

  if (jobs.size > MAX_JOB_HISTORY) {
    const oldest = jobs.keys().next().value;
    jobs.delete(oldest);
  }

  return job;
}

function getRunningTargetAccountIds() {
  const running = new Set();
  for (const job of jobs.values()) {
    if (job.status !== "running") {
      continue;
    }

    for (const account of job.accounts || []) {
      if (account?.accountId) {
        running.add(account.accountId);
      }
    }
  }
  return running;
}

function recalcOverallProgress(job) {
  if (!job.accounts.length) {
    job.overallProgress = 0;
    return;
  }

  const total = job.accounts.reduce((sum, account) => sum + (account.progress || 0), 0);
  job.overallProgress = Math.max(0, Math.min(100, Math.round(total / job.accounts.length)));
}

function updateJobProgress(jobId, payload) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  const target = job.accounts.find((account) => account.accountId === payload.accountId || account.label === payload.account);
  if (!target) {
    return;
  }

  if (typeof payload.percent === "number") {
    target.progress = Math.max(target.progress, Math.max(0, Math.min(100, payload.percent)));
  }

  if (payload.stage) {
    target.stage = payload.stage;
    target.stageLabel = stageLabel(payload.stage);
  }

  if (payload.message) {
    target.message = payload.message;
  }

  if (payload.stage === "done") {
    target.status = "ok";
    target.progress = 100;
  } else if (payload.stage === "cancelled") {
    target.status = "cancelled";
  } else if (payload.stage === "error") {
    target.status = "error";
  } else {
    target.status = "running";
  }

  target.steps.push({
    at: new Date().toISOString(),
    stage: target.stage,
    stageLabel: target.stageLabel,
    message: target.message,
    progress: target.progress
  });

  if (target.steps.length > 30) {
    target.steps = target.steps.slice(-30);
  }

  job.updatedAt = new Date().toISOString();
  recalcOverallProgress(job);
}

function updateJobInspection(jobId, payload) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  job.inspection = {
    ...(job.inspection || {}),
    ...payload,
    updatedAt: new Date().toISOString()
  };
  job.updatedAt = new Date().toISOString();
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir, {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
}));

app.get("/api/accounts", async (_req, res) => {
  try {
    const accounts = await loadAccounts();
    res.json({ accounts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/accounts", async (req, res) => {
  const { accounts } = req.body || {};

  try {
    if (!Array.isArray(accounts)) {
      throw new Error("accounts must be an array.");
    }

    const saved = await replaceAccounts(accounts);
    res.json({ accounts: saved });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/post", async (req, res) => {
  const { text, mode, accountIds, spreadMinutes, headless, resetSessionsBeforeRun } = req.body || {};

  try {
    const allAccounts = await listEnabledAccounts();

    const targets = mode === "all"
      ? allAccounts
      : allAccounts.filter((account) => (accountIds || []).includes(account.id));

    const runningAccountIds = getRunningTargetAccountIds();
    const blocked = targets.filter((account) => runningAccountIds.has(account.id));
    if (blocked.length > 0) {
      res.status(409).json({
        error: `Selected account is already running: ${blocked.map((a) => a.label).join(", ")}`,
        blockedAccountIds: blocked.map((a) => a.id)
      });
      return;
    }

    const now = Date.now();
    const coolingDown = targets.filter((account) => {
      const lastAt = accountLastJobAt.get(account.id) || 0;
      return now - lastAt < ACCOUNT_JOB_COOLDOWN_MS;
    });

    if (coolingDown.length > 0) {
      res.status(429).json({
        error: `Please wait before retrying: ${coolingDown.map((a) => a.label).join(", ")}`,
        retryAfterMs: ACCOUNT_JOB_COOLDOWN_MS,
        blockedAccountIds: coolingDown.map((a) => a.id)
      });
      return;
    }

    if (Boolean(resetSessionsBeforeRun)) {
      await Promise.all(targets.map((account) => deleteSession(account.id)));
    }

    const requested = {
      mode,
      spreadMinutes: Number(spreadMinutes) || 0,
      targetCount: targets.length,
      resetSessionsBeforeRun: Boolean(resetSessionsBeforeRun),
      headless: Boolean(headless)
    };

    const job = createJob({ requested, targets });

    for (const account of targets) {
      accountLastJobAt.set(account.id, now);
    }

    postToThreads({
      accounts: targets,
      text,
      spreadMinutes: Number(spreadMinutes) || 0,
      headless: Boolean(headless),
      onProgress: (progress) => updateJobProgress(job.id, progress),
      onInspection: (inspection) => updateJobInspection(job.id, inspection),
      shouldCancel: () => Boolean(jobs.get(job.id)?.cancelRequested)
    })
      .then((results) => {
        const targetJob = jobs.get(job.id);
        if (!targetJob) {
          return;
        }

        targetJob.status = targetJob.cancelRequested ? "cancelled" : "completed";
        targetJob.results = results;
        targetJob.updatedAt = new Date().toISOString();

        results.forEach((result) => {
          const account = targetJob.accounts.find((item) => item.label === result.account);
          if (!account) {
            return;
          }
          if (result.status === "ok") {
            account.status = "ok";
            account.stage = "done";
            account.stageLabel = stageLabel("done");
            account.message = "投稿完了";
            account.postUrl = result.postUrl || "";
            account.progress = 100;
          } else if (result.status === "cancelled") {
            account.status = "cancelled";
            account.stage = "cancelled";
            account.stageLabel = stageLabel("cancelled");
            account.message = result.message || "キャンセルしました";
          } else {
            account.status = "error";
            account.stage = "error";
            account.stageLabel = stageLabel("error");
            account.message = result.message || "投稿失敗";
          }
        });

        recalcOverallProgress(targetJob);
      })
      .catch((error) => {
        const targetJob = jobs.get(job.id);
        if (!targetJob) {
          return;
        }
        targetJob.status = "error";
        targetJob.error = error.message;
        targetJob.updatedAt = new Date().toISOString();
      });

    res.json({ jobId: job.id, requested });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/jobs/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.json({ job });
});

app.post("/api/jobs/:jobId/cancel", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  if (job.status === "completed" || job.status === "error" || job.status === "cancelled") {
    res.status(400).json({ error: "Job is already finished." });
    return;
  }

  job.cancelRequested = true;
  job.status = "cancel_requested";
  job.updatedAt = new Date().toISOString();

  for (const account of job.accounts) {
    if (account.status === "queued" || account.status === "running") {
      account.stage = "cancel_requested";
      account.stageLabel = stageLabel("cancel_requested");
      account.message = "キャンセルを要求しました";
    }
  }

  recalcOverallProgress(job);
  res.json({ ok: true, job });
});

app.get("/api/jobs/:jobId/inspect", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.json({
    jobId: job.id,
    status: job.status,
    cancelRequested: job.cancelRequested,
    inspection: job.inspection
  });
});

app.delete("/api/jobs/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  jobs.delete(jobId);
  res.json({ ok: true, jobId });
});

app.get("/api/sessions", async (_req, res) => {
  try {
    const sessions = await listSessions();
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/sessions/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!accountId) {
      throw new Error("accountId is required.");
    }

    await deleteSession(accountId);
    res.json({ ok: true, accountId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/accounts/import-csv", async (req, res) => {
  try {
    const { csv } = req.body || {};
    if (!csv || typeof csv !== "string") {
      throw new Error("CSV text is required.");
    }

    const lines = csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) {
      throw new Error("CSV must have header and at least one data row.");
    }

    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const accounts = [];

    for (let i = 1; i < lines.length; i += 1) {
      const values = lines[i].split(",").map((v) => v.trim());
      const account = {};

      headers.forEach((header, index) => {
        account[header] = values[index] || "";
      });

      // Auto-generate label from username if not provided
      if (!account.label) {
        account.label = account.username || `imported_${i}`;
      }

      accounts.push(account);
    }

    const saved = await replaceAccounts(accounts);
    res.json({ accounts: saved, imported: accounts.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/accounts/export-csv", async (_req, res) => {
  try {
    const accounts = await loadAccounts();
    const headers = ["enabled", "username", "password", "secret_key"];
    const rows = [headers.join(",")];

    accounts.forEach((account) => {
      const row = [
        account.enabled ? "true" : "false",
        account.username,
        account.password,
        account.secret_key || ""
      ]
        .map((val) => {
          const str = String(val);
          return str.includes(",") || str.includes('"') ? `"${str.replaceAll('"', '""')}"` : str;
        })
        .join(",");
      rows.push(row);
    });

    const csv = rows.join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="threads-accounts-${new Date().toISOString().split("T")[0]}.csv"`);
    res.send(csv);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/accounts/export-csv-template", (_req, res) => {
  try {
    const headers = ["enabled", "username", "password", "secret_key"];
    const example = ["true", "your_username", "your_password", "ILOUNT6ZLNFDXN3EYB5Q4JMOXVQMZH7E"];
    const csv = [headers.join(","), example.join(",")].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"threads-accounts-template.csv\"");
    res.send(csv);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/accounts", async (_req, res) => {
  try {
    await replaceAccounts([]);
    res.json({ ok: true, message: "All accounts deleted." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function startServer(portToTry) {
  const server = app.listen(portToTry, () => {
    if (portToTry !== requestedPort) {
      console.warn(`Port ${requestedPort} is in use. Fallback to ${portToTry}.`);
    }
    console.log(`Auto Threads Post UI: http://localhost:${portToTry}`);
  });

  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") {
      throw error;
    }

    if (hasExplicitPort) {
      throw new Error(`PORT=${requestedPort} is already in use. Choose another PORT.`);
    }

    if (portToTry >= MAX_FALLBACK_PORT) {
      throw new Error(`No available port in ${DEFAULT_PORT}-${MAX_FALLBACK_PORT}.`);
    }

    startServer(portToTry + 1);
  });
}

startServer(requestedPort);
