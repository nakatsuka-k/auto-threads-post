import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAccounts, listEnabledAccounts, replaceAccounts } from "./accountStore.js";
import { postToThreads } from "./threadsPoster.js";

const app = express();
const DEFAULT_PORT = 3000;
const MAX_FALLBACK_PORT = 3010;
const requestedPort = Number(process.env.PORT || DEFAULT_PORT);
const hasExplicitPort = typeof process.env.PORT !== "undefined";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

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
  const { text, mode, accountIds, spreadMinutes, headless } = req.body || {};

  try {
    const allAccounts = await listEnabledAccounts();

    const targets = mode === "all"
      ? allAccounts
      : allAccounts.filter((account) => (accountIds || []).includes(account.id));

    const results = await postToThreads({
      accounts: targets,
      text,
      spreadMinutes: Number(spreadMinutes) || 0,
      headless: Boolean(headless)
    });

    res.json({
      requested: {
        mode,
        spreadMinutes: Number(spreadMinutes) || 0,
        targetCount: targets.length
      },
      results
    });
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
