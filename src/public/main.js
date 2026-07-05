const accountSelect = document.getElementById("accountSelect");
const reloadAccountsBtn = document.getElementById("reloadAccounts");
const submitPostBtn = document.getElementById("submitPost");
const logArea = document.getElementById("logArea");
const headlessCheckbox = document.getElementById("headless");
const resetSessionsBeforeRunCheckbox = document.getElementById("resetSessionsBeforeRun");
const accountsTableBody = document.getElementById("accountsTableBody");
const addAccountRowBtn = document.getElementById("addAccountRow");
const saveAccountsBtn = document.getElementById("saveAccounts");
const importCSVBtn = document.getElementById("importCSV");
const exportTemplateCSVBtn = document.getElementById("exportTemplateCSV");
const exportDataCSVBtn = document.getElementById("exportDataCSV");
const deleteAllAccountsBtn = document.getElementById("deleteAllAccounts");
const csvFileInput = document.getElementById("csvFileInput");
const jobStatus = document.getElementById("jobStatus");
const jobStatusLabel = document.getElementById("jobStatusLabel");
const jobStatusTitle = document.getElementById("jobStatusTitle");
const jobStatusPercent = document.getElementById("jobStatusPercent");
const jobProgressFill = document.getElementById("jobProgressFill");
const jobAccountsProgress = document.getElementById("jobAccountsProgress");
const cancelJobBtn = document.getElementById("cancelJob");
const openJobInspectorBtn = document.getElementById("openJobInspector");
const dismissJobBtn = document.getElementById("dismissJob");

let currentAccounts = [];
let currentSessions = [];
let activeJobId = null;
let activeJobTimer = null;
let sessionsReloadedForJob = false;
let displayedJobId = null;
let displayedJobStatus = null;
let resolvedApiOrigin = window.location.origin;

function log(message, data) {
  const ts = new Date().toLocaleTimeString();
  const suffix = data ? `\n${JSON.stringify(data, null, 2)}` : "";
  logArea.textContent = `[${ts}] ${message}${suffix}\n\n${logArea.textContent}`;
}

function getCandidateApiOrigins() {
  const origins = [];
  const pushOrigin = (value) => {
    if (!value) {
      return;
    }
    if (!origins.includes(value)) {
      origins.push(value);
    }
  };

  pushOrigin(resolvedApiOrigin);
  pushOrigin(window.location.origin);

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    for (let port = 3000; port <= 3010; port += 1) {
      pushOrigin(`${window.location.protocol}//${window.location.hostname}:${port}`);
    }
  }

  return origins;
}

async function fetchJsonWithApiFallback(path, init) {
  let lastError = null;

  for (const origin of getCandidateApiOrigins()) {
    try {
      const res = await fetch(`${origin}${path}`, init);
      const contentType = res.headers.get("content-type") || "";
      const raw = await res.text();

      if (!contentType.includes("application/json")) {
        throw new Error(`Non-JSON response from ${origin}`);
      }

      const payload = JSON.parse(raw);
      if (!res.ok) {
        throw new Error(payload.error || `Request failed (${res.status})`);
      }

      resolvedApiOrigin = origin;
      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("API request failed");
}

function setRunState(isRunning) {
  submitPostBtn.disabled = isRunning;
  cancelJobBtn.disabled = !isRunning || !activeJobId;
}

function isTerminalJobStatus(status) {
  return status === "completed" || status === "error" || status === "cancelled";
}

function getJobStatusText(status) {
  switch (status) {
    case "running":
      return "実行中";
    case "completed":
      return "完了";
    case "error":
      return "エラー";
    case "cancel_requested":
      return "キャンセル中";
    case "cancelled":
      return "キャンセル済み";
    default:
      return "待機中";
  }
}

function renderJob(job) {
  if (!job) {
    jobStatus.classList.add("is-hidden");
    displayedJobId = null;
    displayedJobStatus = null;
    jobStatusLabel.textContent = "待機中";
    jobStatusTitle.textContent = "ジョブ未実行";
    jobStatusPercent.textContent = "0%";
    jobProgressFill.style.width = "0%";
    jobAccountsProgress.innerHTML = "";
    cancelJobBtn.disabled = true;
    openJobInspectorBtn.disabled = true;
    dismissJobBtn.disabled = true;
    return;
  }

  jobStatus.classList.remove("is-hidden");
  displayedJobId = job.id;
  displayedJobStatus = job.status;
  openJobInspectorBtn.disabled = isTerminalJobStatus(job.status);
  cancelJobBtn.disabled = !(job.status === "running" || job.status === "cancel_requested");
  dismissJobBtn.disabled = false;

  const percent = Math.max(0, Math.min(100, Number(job.overallProgress || 0)));
  jobStatusLabel.textContent = getJobStatusText(job.status);
  jobStatusTitle.textContent = `ジョブ ${job.id.slice(0, 8)} / ${job.requested?.targetCount || 0} アカウント`;
  jobStatusPercent.textContent = `${percent}%`;
  jobProgressFill.style.width = `${percent}%`;

  const accounts = Array.isArray(job.accounts) ? job.accounts : [];
  jobAccountsProgress.innerHTML = accounts.map((account) => {
    const accountPercent = Math.max(0, Math.min(100, Number(account.progress || 0)));
    const stageLabel = escapeHtml(account.stageLabel || account.stage || "進行中");
    const message = escapeHtml(account.message || "");
    const name = escapeHtml(account.label || account.username || account.accountId || "account");
    const postUrl = String(account.postUrl || "").trim();
    const postUrlHtml = postUrl
      ? `<a class="job-account-link" href="${escapeHtml(postUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(postUrl)}</a>`
      : "";

    return `
      <article class="job-account-card">
        <div class="job-account-head">
          <span class="job-account-name">${name}</span>
          <span class="job-account-meta">${stageLabel} / ${accountPercent}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${accountPercent}%"></div>
        </div>
        <div class="job-account-message">${message}</div>
        ${postUrlHtml}
      </article>
    `;
  }).join("");
}

function stopJobPolling() {
  if (activeJobTimer) {
    window.clearTimeout(activeJobTimer);
    activeJobTimer = null;
  }
}

async function fetchJob(jobId) {
  const payload = await fetchJsonWithApiFallback(`/api/jobs/${jobId}`);
  return payload.job;
}

async function cancelActiveJob() {
  if (!activeJobId) {
    return;
  }

  const payload = await fetchJsonWithApiFallback(`/api/jobs/${activeJobId}/cancel`, { method: "POST" });

  renderJob(payload.job);
  log("キャンセル要求を送信しました", { jobId: activeJobId });
}

function openInspectorWindow() {
  const targetJobId = activeJobId || displayedJobId;
  if (!targetJobId || isTerminalJobStatus(displayedJobStatus)) {
    return;
  }

  const params = new URLSearchParams({
    jobId: targetJobId,
    apiOrigin: window.location.origin
  });
  window.open(`/job-view.html?${params.toString()}`, "_blank", "noopener,noreferrer");
}

async function dismissDisplayedJob() {
  const targetJobId = displayedJobId || activeJobId;
  if (!targetJobId) {
    return;
  }

  if (!window.confirm("このジョブ履歴を消しますか？")) {
    return;
  }

  await fetchJsonWithApiFallback(`/api/jobs/${targetJobId}`, { method: "DELETE" });

  if (activeJobId === targetJobId) {
    activeJobId = null;
    stopJobPolling();
    setRunState(false);
  }

  renderJob(null);
  log("ジョブ履歴を削除しました", { jobId: targetJobId });
}

async function pollJob(jobId) {
  try {
    const job = await fetchJob(jobId);
    renderJob(job);

    if ((job.status === "completed" || job.status === "error" || job.status === "cancelled") && !sessionsReloadedForJob) {
      sessionsReloadedForJob = true;
      await loadSessions().catch(() => {});
      renderAccountTable(currentAccounts);
    }

    if (job.status === "completed") {
      setRunState(false);
      activeJobId = null;
      stopJobPolling();
      log("投稿ジョブ完了", {
        jobId: job.id,
        overallProgress: job.overallProgress,
        results: job.results || []
      });
      return;
    }

    if (job.status === "error") {
      setRunState(false);
      activeJobId = null;
      stopJobPolling();
      log("投稿ジョブエラー", {
        jobId: job.id,
        error: job.error || "unknown error"
      });
      return;
    }

    if (job.status === "cancelled") {
      setRunState(false);
      activeJobId = null;
      stopJobPolling();
      log("投稿ジョブをキャンセルしました", {
        jobId: job.id,
        results: job.results || []
      });
      return;
    }

    activeJobTimer = window.setTimeout(() => {
      pollJob(jobId);
    }, 1000);
  } catch (error) {
    setRunState(false);
    activeJobId = null;
    stopJobPolling();
    log("進捗取得エラー", { error: error.message });
  }
}

async function loadSessions() {
  const res = await fetch("/api/sessions");
  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.error || "Failed to load sessions");
  }

  currentSessions = payload.sessions || [];
  return currentSessions;
}

async function loadAccounts() {
  const res = await fetch("/api/accounts");
  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.error || "Failed to load accounts");
  }

  currentAccounts = payload.accounts;
  await loadSessions();
  renderAccountTable(currentAccounts);
  renderAccountSelect(currentAccounts);

  log("アカウントを読み込みました", {
    total: currentAccounts.length,
    enabled: currentAccounts.filter((a) => a.enabled).length,
    savedSessions: currentSessions.length
  });
}

function renderAccountSelect(accounts) {
  accountSelect.innerHTML = "";
  accounts
    .filter((account) => account.enabled)
    .forEach((account) => {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${account.username}`;
      accountSelect.appendChild(option);
    });
}

function renderAccountTable(accounts) {
  accountsTableBody.innerHTML = "";

  accounts.forEach((account) => {
    const sessionInfo = currentSessions.find((s) => s.accountId === account.id);
    const sessionStatus = sessionInfo
      ? `✓ ${new Date(sessionInfo.savedAt).toLocaleDateString()}`
      : "-";

    const tr = document.createElement("tr");
    tr.dataset.id = account.id || "";
    tr.innerHTML = `
      <td><input data-field="enabled" type="checkbox" ${account.enabled ? "checked" : ""} /></td>
      <td><input data-field="username" type="text" value="${escapeHtml(account.username || "")}" /></td>
      <td><input data-field="password" type="text" value="${escapeHtml(account.password || "")}" /></td>
      <td><input data-field="secret_key" type="text" value="${escapeHtml(account.secret_key || "")}" placeholder="Base32秘密鍵" /></td>
      <td><span class="session-status">${sessionStatus}</span></td>
      <td>
        <button class="danger" data-action="delete-account" type="button">削除</button>
        ${sessionInfo ? `<button class="warning" data-action="delete-session" type="button">クリア</button>` : ""}
      </td>
    `;
    accountsTableBody.appendChild(tr);
  });
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function collectAccountsFromTable() {
  return Array.from(accountsTableBody.querySelectorAll("tr")).map((tr) => {
    const get = (field) => tr.querySelector(`[data-field='${field}']`);
    const username = get("username").value.trim();
    return {
      id: tr.dataset.id || undefined,
      enabled: get("enabled").checked,
      label: username || "unnamed",
      username,
      password: get("password").value,
      secret_key: get("secret_key").value.trim()
    };
  });
}

async function saveAccounts() {
  const accounts = collectAccountsFromTable();

  const res = await fetch("/api/accounts", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ accounts })
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || "Failed to save accounts");
  }

  currentAccounts = payload.accounts;
  renderAccountTable(currentAccounts);
  renderAccountSelect(currentAccounts);
  log("アカウントを保存しました", { total: currentAccounts.length });
}

async function clearSessionForAccount(accountId) {
  const res = await fetch(`/api/sessions/${accountId}`, { method: "DELETE" });
  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.error || "Failed to clear session");
  }

  await loadSessions();
  renderAccountTable(currentAccounts);
  log("セッションをクリアしました", { accountId });
}

async function importCSVFile() {
  const file = csvFileInput.files[0];
  if (!file) {
    throw new Error("ファイルが選択されていません");
  }

  const text = await file.text();
  const res = await fetch("/api/accounts/import-csv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv: text })
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || "CSV import failed");
  }

  currentAccounts = payload.accounts;
  await loadSessions();
  renderAccountTable(currentAccounts);
  renderAccountSelect(currentAccounts);
  log("CSV インポート完了", { imported: payload.imported });
}

async function exportDataCSV() {
  const res = await fetch("/api/accounts/export-csv");
  if (!res.ok) {
    throw new Error("Export failed");
  }

  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = res.headers.get("content-disposition").split("filename=")[1].replaceAll('"', "");
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);

  log("CSV エクスポート完了（データ）");
}

async function exportTemplateCSV() {
  const res = await fetch("/api/accounts/export-csv-template");
  if (!res.ok) {
    throw new Error("Export failed");
  }

  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "threads-accounts-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);

  log("CSV エクスポート完了（テンプレート）");
}

async function deleteAllAccounts() {
  if (!window.confirm("全てのアカウントを削除してもよろしいですか？")) {
    return;
  }

  const res = await fetch("/api/accounts", { method: "DELETE" });
  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.error || "Delete all failed");
  }

  currentAccounts = [];
  await loadSessions();
  renderAccountTable(currentAccounts);
  renderAccountSelect(currentAccounts);
  log("全てのアカウントを削除しました");
}

function getSelectedAccountIds() {
  return Array.from(accountSelect.selectedOptions).map((option) => option.value);
}

async function submitPost() {
  const text = document.getElementById("postText").value;
  const mode = document.querySelector("input[name='mode']:checked").value;
  const spreadMinutes = Number(document.getElementById("spreadMinutes").value || 0);
  const headless = headlessCheckbox.checked;
  const resetSessionsBeforeRun = resetSessionsBeforeRunCheckbox.checked;

  let accountIds = getSelectedAccountIds();

  // If no accounts selected, use the first available for single mode
  if (accountIds.length === 0 && mode === "single" && currentAccounts.length > 0) {
    accountIds = [currentAccounts[0].id];
  }

  const body = {
    text,
    mode,
    accountIds,
    spreadMinutes,
    headless,
    resetSessionsBeforeRun
  };

  log("投稿リクエスト送信", body);

  const res = await fetch("/api/post", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.error || "Posting failed");
  }

  activeJobId = payload.jobId;
  sessionsReloadedForJob = false;
  renderJob({
    id: payload.jobId,
    status: "running",
    overallProgress: 0,
    requested: payload.requested,
    accounts: []
  });
  log("投稿ジョブ開始", payload);
  stopJobPolling();
  await pollJob(payload.jobId);
}

reloadAccountsBtn.addEventListener("click", async () => {
  try {
    await loadAccounts();
  } catch (error) {
    log("アカウント読み込みエラー", { error: error.message });
  }
});

addAccountRowBtn.addEventListener("click", () => {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input data-field="enabled" type="checkbox" checked /></td>
    <td><input data-field="username" type="text" value="" placeholder="username" /></td>
    <td><input data-field="password" type="text" value="" placeholder="password" /></td>
    <td><input data-field="secret_key" type="text" value="" placeholder="Base32秘密鍵（オプション）" /></td>
    <td><span class="session-status">-</span></td>
    <td><button class="danger" data-action="delete-account" type="button">削除</button></td>
  `;
  accountsTableBody.appendChild(tr);
});

saveAccountsBtn.addEventListener("click", async () => {
  saveAccountsBtn.disabled = true;
  try {
    await saveAccounts();
  } catch (error) {
    log("アカウント保存エラー", { error: error.message });
  } finally {
    saveAccountsBtn.disabled = false;
  }
});

accountsTableBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const tr = target.closest("tr");
  if (!tr) {
    return;
  }

  if (target.dataset.action === "delete-account") {
    tr.remove();
  } else if (target.dataset.action === "delete-session") {
    try {
      await clearSessionForAccount(tr.dataset.id);
    } catch (error) {
      log("セッション削除エラー", { error: error.message });
    }
  }
});

submitPostBtn.addEventListener("click", async () => {
  setRunState(true);
  try {
    await submitPost();
  } catch (error) {
    setRunState(false);
    log("投稿エラー", { error: error.message });
  }
});

importCSVBtn.addEventListener("click", () => {
  csvFileInput.click();
});

csvFileInput.addEventListener("change", async () => {
  try {
    await importCSVFile();
  } catch (error) {
    log("CSV インポートエラー", { error: error.message });
  } finally {
    csvFileInput.value = "";
  }
});

exportTemplateCSVBtn.addEventListener("click", async () => {
  try {
    await exportTemplateCSV();
  } catch (error) {
    log("CSV エクスポートエラー", { error: error.message });
  }
});

exportDataCSVBtn.addEventListener("click", async () => {
  try {
    await exportDataCSV();
  } catch (error) {
    log("CSV エクスポートエラー", { error: error.message });
  }
});

deleteAllAccountsBtn.addEventListener("click", async () => {
  try {
    await deleteAllAccounts();
  } catch (error) {
    log("全削除エラー", { error: error.message });
  }
});

loadAccounts().catch((error) => {
  log("初期化エラー", { error: error.message });
});

renderJob(null);

cancelJobBtn.addEventListener("click", async () => {
  try {
    await cancelActiveJob();
  } catch (error) {
    log("キャンセルエラー", { error: error.message });
  }
});

openJobInspectorBtn.addEventListener("click", () => {
  openInspectorWindow();
});

dismissJobBtn.addEventListener("click", async () => {
  try {
    await dismissDisplayedJob();
  } catch (error) {
    log("履歴削除エラー", { error: error.message });
  }
});
