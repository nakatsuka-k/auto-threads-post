const accountSelect = document.getElementById("accountSelect");
const reloadAccountsBtn = document.getElementById("reloadAccounts");
const submitPostBtn = document.getElementById("submitPost");
const logArea = document.getElementById("logArea");
const accountsTableBody = document.getElementById("accountsTableBody");
const addAccountRowBtn = document.getElementById("addAccountRow");
const saveAccountsBtn = document.getElementById("saveAccounts");

let currentAccounts = [];

function log(message, data) {
  const ts = new Date().toLocaleTimeString();
  const suffix = data ? `\n${JSON.stringify(data, null, 2)}` : "";
  logArea.textContent = `[${ts}] ${message}${suffix}\n\n${logArea.textContent}`;
}

async function loadAccounts() {
  const res = await fetch("/api/accounts");
  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.error || "Failed to load accounts");
  }

  currentAccounts = payload.accounts;
  renderAccountTable(currentAccounts);
  renderAccountSelect(currentAccounts);

  log("アカウントを読み込みました", {
    total: currentAccounts.length,
    enabled: currentAccounts.filter((a) => a.enabled).length
  });
}

function renderAccountSelect(accounts) {
  accountSelect.innerHTML = "";
  accounts
    .filter((account) => account.enabled)
    .forEach((account) => {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${account.label} (${account.username})`;
      accountSelect.appendChild(option);
    });
}

function renderAccountTable(accounts) {
  accountsTableBody.innerHTML = "";

  accounts.forEach((account) => {
    const tr = document.createElement("tr");
    tr.dataset.id = account.id || "";
    tr.innerHTML = `
      <td><input data-field="enabled" type="checkbox" ${account.enabled ? "checked" : ""} /></td>
      <td><input data-field="label" type="text" value="${escapeHtml(account.label || "")}" /></td>
      <td><input data-field="username" type="text" value="${escapeHtml(account.username || "")}" /></td>
      <td><input data-field="password" type="text" value="${escapeHtml(account.password || "")}" /></td>
      <td><button class="danger" data-action="delete" type="button">削除</button></td>
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
    return {
      id: tr.dataset.id || undefined,
      enabled: get("enabled").checked,
      label: get("label").value.trim(),
      username: get("username").value.trim(),
      password: get("password").value
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

function getSelectedAccountIds() {
  return Array.from(accountSelect.selectedOptions).map((option) => option.value);
}

async function submitPost() {
  const text = document.getElementById("postText").value;
  const mode = document.querySelector("input[name='mode']:checked").value;
  const spreadMinutes = Number(document.getElementById("spreadMinutes").value || 0);
  const headless = document.getElementById("headless").checked;

  const body = {
    text,
    mode,
    accountIds: getSelectedAccountIds(),
    spreadMinutes,
    headless
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

  log("投稿ジョブ完了", payload);
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
    <td><input data-field="label" type="text" value="" placeholder="label" /></td>
    <td><input data-field="username" type="text" value="" placeholder="username" /></td>
    <td><input data-field="password" type="text" value="" placeholder="password" /></td>
    <td><button class="danger" data-action="delete" type="button">削除</button></td>
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

accountsTableBody.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.dataset.action === "delete") {
    const tr = target.closest("tr");
    if (tr) {
      tr.remove();
    }
  }
});

submitPostBtn.addEventListener("click", async () => {
  submitPostBtn.disabled = true;
  try {
    await submitPost();
  } catch (error) {
    log("投稿エラー", { error: error.message });
  } finally {
    submitPostBtn.disabled = false;
  }
});

loadAccounts().catch((error) => {
  log("初期化エラー", { error: error.message });
});
