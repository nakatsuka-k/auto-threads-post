import { chromium } from "playwright";

const THREADS_HOME_URL = "https://www.threads.net/";
const THREADS_LOGIN_URL = "https://www.threads.net/login";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSchedule(selectedAccounts, spreadMinutes) {
  if (selectedAccounts.length <= 1 || spreadMinutes <= 0) {
    return selectedAccounts.map((account) => ({ account, delayMs: 0 }));
  }

  const spreadMs = spreadMinutes * 60 * 1000;
  const interval = Math.floor(spreadMs / (selectedAccounts.length - 1));

  return selectedAccounts.map((account, index) => ({
    account,
    delayMs: interval * index
  }));
}

async function ensureLoggedIn(page, account) {
  await page.goto(THREADS_HOME_URL, { waitUntil: "domcontentloaded" });

  const isCreateVisible = await page
    .getByRole("button", { name: /new thread|post|create/i })
    .first()
    .isVisible()
    .catch(() => false);

  if (isCreateVisible) {
    return;
  }

  await page.goto(THREADS_LOGIN_URL, { waitUntil: "domcontentloaded" });

  const usernameInput = page.locator('input[name="username"], input[autocomplete="username"]').first();
  const passwordInput = page.locator('input[name="password"], input[type="password"]').first();

  await usernameInput.waitFor({ state: "visible", timeout: 15000 });
  await usernameInput.fill(account.username);
  await passwordInput.fill(account.password);

  const loginButton = page.getByRole("button", { name: /log in|login/i }).first();
  await loginButton.click();

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2500);

  const loginStillVisible = await page
    .locator('input[name="password"], input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (loginStillVisible) {
    throw new Error(`Login failed for ${account.label}. Check ID/PW or 2FA challenge.`);
  }
}

async function createPost(page, text) {
  const openComposerButton = page.getByRole("button", { name: /new thread|post|create/i }).first();
  await openComposerButton.click().catch(() => {});

  const editor = page
    .locator('[contenteditable="true"][role="textbox"], div[contenteditable="true"]')
    .first();
  await editor.waitFor({ state: "visible", timeout: 15000 });
  await editor.fill(text);

  const postButton = page
    .locator('div[role="button"]:has-text("Post"), button:has-text("Post")')
    .first();
  await postButton.click();

  await page.waitForTimeout(2000);
}

async function runSingleAccount({ browser, account, text, delayMs }) {
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await ensureLoggedIn(page, account);
    await createPost(page, text);
    return {
      account: account.label,
      status: "ok"
    };
  } catch (error) {
    return {
      account: account.label,
      status: "error",
      message: error.message
    };
  } finally {
    await context.close();
  }
}

export async function postToThreads({ accounts, text, spreadMinutes = 0, headless = false }) {
  if (!text || !text.trim()) {
    throw new Error("Post text is empty.");
  }

  if (!accounts.length) {
    throw new Error("No target accounts selected.");
  }

  const schedule = buildSchedule(accounts, Number(spreadMinutes) || 0);
  const browser = await chromium.launch({ headless });

  try {
    const results = [];

    for (const item of schedule) {
      const result = await runSingleAccount({
        browser,
        account: item.account,
        text,
        delayMs: item.delayMs
      });
      results.push({ ...result, delayMs: item.delayMs });
    }

    return results;
  } finally {
    await browser.close();
  }
}
