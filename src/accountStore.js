import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DEFAULT_DB_PATH = path.join(DATA_DIR, "accounts.db");
const LEGACY_MARKDOWN_PATH = path.join(DATA_DIR, "accounts.md");

let db;

function normalizeBoolean(value) {
  return ["true", "1", "yes", "on"].includes(String(value || "").toLowerCase());
}

function toAccount(row) {
  return {
    id: row.id,
    label: row.label,
    username: row.username,
    password: row.password,
    enabled: Boolean(row.enabled)
  };
}

function parseMarkdownTable(mdText) {
  const lines = mdText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const tableLines = lines.filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (tableLines.length < 3) {
    return [];
  }

  const headers = tableLines[0]
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim().toLowerCase());

  const rows = tableLines.slice(2);

  return rows
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
    .filter((cells) => cells.length === headers.length)
    .map((cells) => {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = cells[index] ?? "";
      });
      return row;
    });
}

function migrateFromMarkdownIfNeeded(database) {
  const countRow = database.prepare("SELECT COUNT(*) AS count FROM accounts").get();
  if (countRow.count > 0 || !fs.existsSync(LEGACY_MARKDOWN_PATH)) {
    return;
  }

  const mdText = fs.readFileSync(LEGACY_MARKDOWN_PATH, "utf-8");
  const rows = parseMarkdownTable(mdText);

  const insertStmt = database.prepare(
    "INSERT INTO accounts (id, label, username, password, enabled) VALUES (?, ?, ?, ?, ?)"
  );

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const label = row.label?.trim() || `account_${i + 1}`;
    const username = (row.username || row.id || "").trim();
    const password = (row.password || "").trim();

    if (!username || !password) {
      continue;
    }

    insertStmt.run(
      crypto.randomUUID(),
      label,
      username,
      password,
      normalizeBoolean(row.enabled) ? 1 : 0
    );
  }
}

function getDb() {
  if (db) {
    return db;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DEFAULT_DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  migrateFromMarkdownIfNeeded(db);
  return db;
}

function validateAccount(input, index) {
  const label = String(input.label || "").trim();
  const username = String(input.username || "").trim();
  const password = String(input.password || "").trim();
  const enabled = Boolean(input.enabled);

  if (!label) {
    throw new Error(`Account row ${index + 1}: label is required.`);
  }

  if (!username) {
    throw new Error(`Account row ${index + 1}: username is required.`);
  }

  if (!password) {
    throw new Error(`Account row ${index + 1}: password is required.`);
  }

  return {
    id: input.id || crypto.randomUUID(),
    label,
    username,
    password,
    enabled
  };
}

export async function loadAccounts() {
  const database = getDb();
  const rows = database
    .prepare("SELECT id, label, username, password, enabled FROM accounts ORDER BY created_at ASC")
    .all();
  return rows.map(toAccount);
}

export async function listEnabledAccounts() {
  const all = await loadAccounts();
  return all.filter((account) => account.enabled);
}

export async function replaceAccounts(accountsInput) {
  const database = getDb();
  const safeAccounts = (accountsInput || []).map((input, index) => validateAccount(input, index));

  const seenLabels = new Set();
  for (const account of safeAccounts) {
    if (seenLabels.has(account.label)) {
      throw new Error(`Duplicate label: ${account.label}`);
    }
    seenLabels.add(account.label);
  }

  const insertStmt = database.prepare(
    "INSERT INTO accounts (id, label, username, password, enabled) VALUES (?, ?, ?, ?, ?)"
  );

  database.exec("BEGIN");
  try {
    database.exec("DELETE FROM accounts");
    for (const account of safeAccounts) {
      insertStmt.run(
        account.id,
        account.label,
        account.username,
        account.password,
        account.enabled ? 1 : 0
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return loadAccounts();
}

export { DEFAULT_DB_PATH, LEGACY_MARKDOWN_PATH };
