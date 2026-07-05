import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function getSessionPath(accountId) {
  return path.join(SESSIONS_DIR, `${accountId}.json`);
}

export async function saveSession(accountId, cookies, localStorage) {
  ensureSessionsDir();
  const sessionData = {
    accountId,
    cookies,
    localStorage,
    savedAt: new Date().toISOString()
  };
  fs.writeFileSync(getSessionPath(accountId), JSON.stringify(sessionData, null, 2));
}

export async function loadSession(accountId) {
  ensureSessionsDir();
  const sessionPath = getSessionPath(accountId);
  if (!fs.existsSync(sessionPath)) {
    return null;
  }
  const data = fs.readFileSync(sessionPath, "utf-8");
  return JSON.parse(data);
}

export async function deleteSession(accountId) {
  const sessionPath = getSessionPath(accountId);
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}

export async function listSessions() {
  ensureSessionsDir();
  if (!fs.existsSync(SESSIONS_DIR)) {
    return [];
  }
  const files = fs.readdirSync(SESSIONS_DIR);
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8"));
      return {
        accountId: data.accountId,
        savedAt: data.savedAt
      };
    });
}
