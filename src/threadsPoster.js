import { chromium } from "playwright";
import { deleteSession, loadSession, saveSession } from "./sessionStore.js";
import { generateTOTP } from "./totpGenerator.js";

const THREADS_HOME_URL = "https://www.threads.com/";
const THREADS_LOGIN_URL = "https://www.threads.com/login";
const TWO_FA_INPUT_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[placeholder*="code" i]',
  'input[placeholder*="2fa" i]',
  'input[placeholder*="authentication" i]',
  'input[placeholder*="security" i]',
  'input[placeholder*="セキュリティ" i]',
  'input[placeholder*="認証" i]'
].join(", ");

const LOGIN_USERNAME_SELECTORS = [
  'input[name="username"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[placeholder*="ユーザー" i]',
  'input[placeholder*="電話" i]',
  'input[placeholder*="メール" i]',
  'input[placeholder*="username" i]',
  'input[placeholder*="email" i]'
];

const LOGIN_PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[type="password"]',
  'input[autocomplete="current-password"]'
];

const DESKTOP_CONTEXT_OPTIONS = {
  viewport: { width: 1440, height: 1100 },
  screen: { width: 1440, height: 1100 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1
};

const COMPOSER_OPEN_SETTLE_MS = 700;
const TEXT_ENTRY_SETTLE_MS = 500;
const PRE_SUBMIT_SETTLE_MS = 700;
const POST_SUBMIT_SETTLE_MS = 800;
const HOME_READY_TIMEOUT_MS = 2500;

async function hasAnyVisibleField(page, selectors, timeoutPerSelector = 800) {
  for (const selector of selectors) {
    const visible = await page.locator(selector).first().isVisible({ timeout: timeoutPerSelector }).catch(() => false);
    if (visible) {
      return true;
    }
  }
  return false;
}

async function waitForAnyVisibleField(page, selectors, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = await page
      .evaluate((selectorList) => {
        for (const selector of selectorList) {
          const elements = Array.from(document.querySelectorAll(selector));
          for (const el of elements) {
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") {
              continue;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return true;
            }
          }
        }
        return false;
      }, selectors)
      .catch(() => false);

    if (found) {
      return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class JobCancelledError extends Error {
  constructor(message = "Job cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}

function assertNotCancelled(shouldCancel) {
  if (typeof shouldCancel === "function" && shouldCancel()) {
    throw new JobCancelledError();
  }
}

async function sleepWithCancel(ms, shouldCancel) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    assertNotCancelled(shouldCancel);
    const remaining = ms - (Date.now() - startedAt);
    await sleep(Math.min(remaining, 250));
  }
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

function normalizeLocalStorageEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map((entry) => {
      const name = entry?.name ?? entry?.key ?? "";
      const value = entry?.value ?? "";
      return {
        name: String(name),
        value: String(value)
      };
    })
    .filter((entry) => entry.name.length > 0);
}

function normalizeStorageOrigins(origins) {
  if (!Array.isArray(origins)) {
    return [];
  }

  return origins
    .filter((item) => item && item.origin)
    .map((item) => ({
      origin: String(item.origin),
      localStorage: normalizeLocalStorageEntries(item.localStorage)
    }));
}

function normalizeButtonText(value) {
  return String(value || "")
    .replaceAll(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function isPrimaryPostLabel(value) {
  const normalized = normalizeButtonText(value);
  return normalized === "投稿" || normalized === "post" || normalized === "publish" || normalized === "share";
}

function isExcludedPostLabel(value) {
  return /(下書き|draft|キャンセル|cancel|オプション|options|追加|トピック|コミュニティ)/i.test(String(value || ""));
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

function buildThreadsProfileUrl(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) {
    return THREADS_HOME_URL;
  }

  return `https://www.threads.com/@${normalized}`;
}

function isLikelyThreadsPostUrl(url, username = "") {
  try {
    const parsed = new URL(String(url));
    if (!/threads\.com$/i.test(parsed.hostname)) {
      return false;
    }

    const path = parsed.pathname || "";
    const normalized = normalizeUsername(username);
    if (/\/post\//i.test(path) || /^\/t\//i.test(path)) {
      return true;
    }

    if (normalized && path.startsWith(`/@${normalized}/`) && path !== `/@${normalized}`) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function detectCurrentAccountUsername(page) {
  try {
    const current = await page.evaluate(() => {
      const profileLink = document.querySelector('a[href^="/@"]');
      const href = profileLink?.getAttribute("href") || "";
      if (href.startsWith("/@")) {
        return href.slice(2).split(/[/?#]/)[0] || "";
      }

      const profileImage = document.querySelector('img[alt*="プロフィール写真" i], img[alt*="profile photo" i]');
      const alt = profileImage?.getAttribute("alt") || "";
      const jp = alt.match(/^([^\s]+)のプロフィール写真/);
      if (jp?.[1]) {
        return jp[1];
      }

      const en = alt.match(/^([^\s]+)['’]s profile picture/i);
      return en?.[1] || "";
    });

    return normalizeUsername(current);
  } catch {
    return "";
  }
}

async function waitForLoginForm(page) {
  const directVisible = await waitForAnyVisibleField(page, [...LOGIN_USERNAME_SELECTORS, ...LOGIN_PASSWORD_SELECTORS], 20000);
  if (directVisible) {
    return true;
  }

  const loginEntryPoints = [
    page.getByRole("button", { name: /ログイン|login|log in|sign in/i }).first(),
    page.getByRole("link", { name: /ログイン|login|log in|sign in/i }).first(),
    page.locator('a[href*="/login"], button[data-testid*="login" i], div[role="button"]:has-text("ログイン")').first()
  ];

  for (const entry of loginEntryPoints) {
    const visible = await entry.isVisible({ timeout: 1000 }).catch(() => false);
    if (!visible) {
      continue;
    }

    const clicked = await clickLocatorWithFallback(entry);
    if (!clicked) {
      continue;
    }

    const appeared = await waitForAnyVisibleField(page, [...LOGIN_USERNAME_SELECTORS, ...LOGIN_PASSWORD_SELECTORS], 10000);
    if (appeared) {
      return true;
    }
  }

  return false;
}

async function isLoggedInOnCurrentPage(page) {
  const isComposerTriggerVisible = await page
    .getByRole("button", { name: /new thread|post|create|最新情報|新規スレッド|新しい投稿|投稿/i })
    .first()
    .isVisible()
    .catch(() => false);

  if (isComposerTriggerVisible) {
    return true;
  }

  const hasProfileLink = await page
    .locator('a[href^="/@"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (hasProfileLink) {
    return true;
  }

  const hasComposerTextbox = await page
    .locator('[contenteditable="true"][role="textbox"], [aria-placeholder*="最新情報" i]')
    .first()
    .isVisible()
    .catch(() => false);

  return hasComposerTextbox;
}

async function checkIfLoggedIn(page) {
  await page.goto(THREADS_HOME_URL, { waitUntil: "domcontentloaded" });
  return isLoggedInOnCurrentPage(page);
}

async function waitForThreadsHomeReady(page, timeoutMs = 7000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const ready = await page
      .evaluate(() => {
        const isVisible = (el) => {
          if (!el) {
            return false;
          }

          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }

          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const modalEditor = document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"], [aria-modal="true"] [role="textbox"][contenteditable="true"]');
        if (isVisible(modalEditor)) {
          return true;
        }

        const composerTriggers = Array.from(document.querySelectorAll('a[href="/intent/post"], a[href*="/intent/post?"], [role="button"], button, div[role="button"]'));
        for (const el of composerTriggers) {
          if (!isVisible(el)) {
            continue;
          }

          if (el.getAttribute("aria-disabled") === "true" || el.getAttribute("disabled") !== null) {
            continue;
          }

          const label = [el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          if (/new thread|create|最新情報|新しい投稿|新規投稿|新しいスレッド|新規スレッド|投稿を開始|テキストフィールド/.test(label)) {
            return true;
          }
        }

        return false;
      })
      .catch(() => false);

    if (ready) {
      return true;
    }

    await page.waitForTimeout(150);
  }

  return false;
}

function reportProgress(onProgress, account, stage, percent, message) {
  if (typeof onProgress !== "function") {
    return;
  }

  onProgress({
    accountId: account.id,
    account: account.label,
    stage,
    percent,
    message
  });
}

async function publishInspection(page, account, onInspection, stage) {
  if (typeof onInspection !== "function") {
    return;
  }

  try {
    const [title, screenshotBuffer] = await Promise.all([
      page.title().catch(() => ""),
      page.screenshot({ type: "jpeg", quality: 55, fullPage: false }).catch(() => null)
    ]);

    onInspection({
      accountId: account.id,
      account: account.label,
      username: account.username,
      stage,
      url: page.url(),
      title,
      screenshotDataUrl: screenshotBuffer ? `data:image/jpeg;base64,${screenshotBuffer.toString("base64")}` : ""
    });
  } catch {
  }
}

async function waitForUserTo2FA(page, account, timeoutMs = 300000) {
  const startTime = Date.now();
  const checkInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    const isLoggedIn = await isLoggedInOnCurrentPage(page);
    if (isLoggedIn) {
      return;
    }

    const passwordFieldVisible = await page
      .locator('input[name="password"], input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);

    if (passwordFieldVisible) {
      throw new Error(`Login failed: still on login page. Check ID/PW.`);
    }

    await page.waitForTimeout(checkInterval);
  }

  throw new Error(`2FA timeout (${timeoutMs}ms). Please try again or clear session.`);
}

async function waitForUserToLogin(page, account, timeoutMs = 300000) {
  const startTime = Date.now();
  const checkInterval = 2000;

  console.log(`[Threads] Waiting for manual login: ${account.username}`);

  while (Date.now() - startTime < timeoutMs) {
    const isLoggedIn = await isLoggedInOnCurrentPage(page);
    if (isLoggedIn) {
      console.log(`[Threads] Manual login completed: ${account.username}`);
      return;
    }

    await page.waitForTimeout(checkInterval);
  }

  throw new Error(`Manual login timeout (${timeoutMs}ms) for ${account.label}.`);
}

async function clickLocatorWithFallback(locator) {
  try {
    await locator.click({ timeout: 5000 });
    return true;
  } catch {
  }

  try {
    await locator.click({ timeout: 5000, force: true });
    return true;
  } catch {
  }

  try {
    const handle = await locator.elementHandle();
    if (!handle) {
      return false;
    }

    await handle.evaluate((el) => {
      if (typeof el.click === "function") {
        el.click();
        return;
      }

      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    return true;
  } catch {
    return false;
  }
}

async function detectLoginTransition(page) {
  const isLoggedIn = await isLoggedInOnCurrentPage(page);

  if (isLoggedIn) {
    return "loggedIn";
  }

  const twoFAVisible = await page
    .locator(TWO_FA_INPUT_SELECTOR)
    .first()
    .isVisible()
    .catch(() => false);

  if (twoFAVisible) {
    return "twoFA";
  }

  const passwordVisible = await page
    .locator('input[name="password"], input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (!passwordVisible) {
    return "transitioned";
  }

  return "login";
}

async function collectLoginErrorHint(page) {
  try {
    const hint = await page.evaluate(() => {
      const keyword = /(incorrect|wrong|invalid|try again|error|failed|確認|間違|無効|失敗)/i;
      const nodes = Array.from(document.querySelectorAll("div, span, p"));
      for (const node of nodes) {
        const text = (node.textContent || "").trim();
        if (!text) {
          continue;
        }
        if (keyword.test(text) && text.length <= 180) {
          return text;
        }
      }
      return "";
    });
    return hint || "";
  } catch {
    return "";
  }
}

async function getTotpFromTrendSns(page, secretKey) {
  if (!secretKey || !secretKey.trim()) {
    return null;
  }

  const helperPage = await page.context().newPage();
  try {
    await helperPage.goto("https://trend-sns.com/tools/2fa", { waitUntil: "domcontentloaded", timeout: 30000 });

    const injected = await helperPage.evaluate((secret) => {
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const fields = Array.from(document.querySelectorAll("input, textarea")).filter((el) => {
        if (!isVisible(el)) {
          return false;
        }
        const hint = [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("placeholder"), el.getAttribute("aria-label")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return /secret|2fa|otp|totp|key|キー|秘密/.test(hint) || el.type === "text";
      });

      const target = fields[0] || null;
      if (!target) {
        return false;
      }

      target.focus();
      if ("value" in target) {
        target.value = secret;
      } else {
        target.textContent = secret;
      }
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, secretKey.trim());

    if (!injected) {
      return null;
    }

    await helperPage.evaluate(() => {
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const trigger = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], div[role="button"]')).find((el) => {
        if (!isVisible(el)) {
          return false;
        }
        const text = [el.textContent, el.getAttribute("value"), el.getAttribute("aria-label")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return /generate|create|get|code|otp|totp|生成|取得|表示/.test(text);
      });

      if (!trigger) {
        return;
      }

      if (typeof trigger.click === "function") {
        trigger.click();
      }
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 8000) {
      const code = await helperPage.evaluate(() => {
        const extract = (raw) => {
          const text = String(raw || "").replace(/\s+/g, " ").trim();
          const match = text.match(/\b(\d{6})\b/);
          return match?.[1] || "";
        };

        const candidates = [
          ...Array.from(document.querySelectorAll('input, textarea, div, span, p, strong, code')),
        ];

        for (const node of candidates) {
          const direct = extract(node.value ?? node.textContent);
          if (direct) {
            return direct;
          }
        }

        return "";
      });

      if (code) {
        return code;
      }

      await helperPage.waitForTimeout(400);
    }

    return null;
  } catch {
    return null;
  } finally {
    await helperPage.close().catch(() => {});
  }
}

async function submitLogin(page, passwordInput) {
  const clickTargets = [
    page.locator('input[type="submit"]').first(),
    page.locator('button[type="submit"]').first(),
    page.getByRole("button", { name: /ログイン|login|log in|sign in/i }).first(),
    page.locator('div[role="button"]').filter({ hasText: /ログイン|login|log in|sign in/i }).first(),
    page.locator('button').filter({ hasText: /ログイン|login|log in|sign in/i }).first(),
    page.locator('input[value*="Log in" i], input[value*="Login" i], input[value*="ログイン" i]').first()
  ];

  for (const target of clickTargets) {
    try {
      if (await target.isVisible({ timeout: 1000 }).catch(() => false)) {
        const clicked = await clickLocatorWithFallback(target);
        if (clicked) {
          return true;
        }
      }
    } catch {
    }
  }

  try {
    await passwordInput.press("Enter");
    return true;
  } catch {
  }

  try {
    const submitted = await page.evaluate(() => {
      const password = document.querySelector('input[name="password"], input[type="password"]');
      const form = password?.closest("form");
      if (!form) {
        return false;
      }

      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return true;
    });

    return submitted;
  } catch {
  }

  try {
    const clickedByText = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'));
      const loginLike = /(ログイン|login|log\s*in|sign\s*in)/i;

      for (const el of elements) {
        const text = [el.textContent, el.getAttribute("aria-label"), el.getAttribute("value")]
          .filter(Boolean)
          .join(" ")
          .trim();

        if (!loginLike.test(text)) {
          continue;
        }

        if (typeof el.click === "function") {
          el.click();
        }
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      }

      return false;
    });

    return clickedByText;
  } catch {
    return false;
  }
}

async function fillLoginField(page, selectors, value, fieldName) {
  const text = String(value || "");
  if (!text) {
    return false;
  }

  const selectorList = Array.isArray(selectors) ? selectors : [String(selectors)];
  const selectorText = selectorList.join(", ");
  const input = page.locator(selectorText).first();

  const ready = await hasAnyVisibleField(page, selectorList, 1500);
  if (!ready) {
    console.log(`[Threads] Login ${fieldName} field not visible`);
    return false;
  }

  try {
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.click({ timeout: 3000, force: true }).catch(() => {});
    await input.fill(text);

    const current = await input.inputValue().catch(() => "");
    if (current === text) {
      return true;
    }

    await input.press("Meta+a").catch(() => {});
    await input.type(text, { delay: 10 }).catch(() => {});
    const typedCurrent = await input.inputValue().catch(() => "");
    if (typedCurrent === text) {
      return true;
    }
  } catch {
  }

  const fallbackSet = await page.evaluate(({ selectorArray, inputValue, selectorText }) => {
    const setNativeValue = (element, newValue) => {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      const setter = descriptor?.set;
      if (setter) {
        setter.call(element, newValue);
      } else {
        element.value = newValue;
      }
    };

    const candidates = Array.from(document.querySelectorAll(selectorText));
    const target = candidates.find((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    if (!target) {
      return false;
    }

    target.focus();
    setNativeValue(target, inputValue);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    return true;
  }, { selectorArray: selectorList, inputValue: text, selectorText }).catch(() => false);

  if (!fallbackSet) {
    console.log(`[Threads] Login ${fieldName} fill failed: no target element`);
    return false;
  }

  const ok = await page.evaluate(({ selectorArray, expected }) => {
    for (const selector of selectorArray) {
      const el = document.querySelector(selector);
      if (!el) {
        continue;
      }
      const value = el.value ?? "";
      if (value === expected) {
        return true;
      }
    }
    return false;
  }, { selectorArray: selectorList, expected: text }).catch(() => false);

  if (!ok) {
    console.log(`[Threads] Login ${fieldName} fill mismatch`);
  }
  return ok;
}

async function ensureLoggedIn(page, account, headless, hasSavedSession = false, onProgress, onInspection, shouldCancel) {
  assertNotCancelled(shouldCancel);
  reportProgress(onProgress, account, "session_load", hasSavedSession ? 10 : 5, hasSavedSession ? "保存済みセッション確認" : "新規ログイン開始");

  if (hasSavedSession) {
    reportProgress(onProgress, account, "login_check", 15, "ログイン状態を確認");
    const isLoggedIn = await checkIfLoggedIn(page);
    if (isLoggedIn) {
      const expected = normalizeUsername(account.username);
      const current = await detectCurrentAccountUsername(page);

      if (current && expected && current !== expected) {
        throw new Error(
          `Session account mismatch: logged in as ${current}, expected ${expected}. Clear session for this account and retry.`
        );
      }

      reportProgress(onProgress, account, "login_done", 35, "セッションを再利用");
      return;
    }
  }

  reportProgress(onProgress, account, "login_check", 15, "ログインページへ移動");
  await page.goto(THREADS_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await publishInspection(page, account, onInspection, "login_check");

  if (!page.url().includes("/login")) {
    await page.goto(THREADS_LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    await publishInspection(page, account, onInspection, "login_check");
  }

  console.log(`[Threads] Navigated to login page for account: ${account.username}`);

  let loginFormReady = await waitForLoginForm(page);
  if (!loginFormReady) {
    const delayedReady = await waitForAnyVisibleField(page, [...LOGIN_USERNAME_SELECTORS, ...LOGIN_PASSWORD_SELECTORS], 10000);
    if (delayedReady) {
      console.log("[Threads] Login form detected by delayed visibility check.");
      loginFormReady = true;
    }

    if (loginFormReady) {
      // Continue to credential autofill path below.
    } else if (!page.url().includes("/login")) {
      await page.goto(THREADS_LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      loginFormReady = await waitForLoginForm(page);
      await publishInspection(page, account, onInspection, "login_check");
    }

    if (loginFormReady) {
      // Continue to credential autofill path below.
    } else if (!headless) {
      console.log("[Threads] Login form not detected; waiting for manual login as fallback.");
      await waitForUserToLogin(page, account);
      return;
    }

    if (!loginFormReady) {
      throw new Error(`Could not reach login form for ${account.label}. currentUrl=${page.url()}`);
    }

  }

  if (!headless && (!account.username || !account.password)) {
    await waitForUserToLogin(page, account);
    return;
  }

  const usernameSelector = LOGIN_USERNAME_SELECTORS.join(", ");
  const passwordSelector = LOGIN_PASSWORD_SELECTORS.join(", ");
  const usernameInput = page.locator(usernameSelector).first();
  const passwordInput = page.locator(passwordSelector).first();

  console.log(
    `[Threads] Attempting auto-login fill: usernameLen=${String(account.username || "").length} passwordLen=${String(account.password || "").length}`
  );

  const usernameFilled = await fillLoginField(page, LOGIN_USERNAME_SELECTORS, account.username, "username");
  const passwordFilled = await fillLoginField(page, LOGIN_PASSWORD_SELECTORS, account.password, "password");

  if (!usernameFilled || !passwordFilled) {
    if (!headless) {
      console.log("[Threads] Auto fill failed on login form; waiting for manual login.");
      await waitForUserToLogin(page, account);
      return;
    }
    throw new Error(`Could not fill login form for ${account.label}.`);
  }
  
  await page.waitForTimeout(250);

  console.log(`[Threads] Filled credentials for ${account.username}`);
  reportProgress(onProgress, account, "login_check", 22, "認証情報を入力");
  await publishInspection(page, account, onInspection, "login_check");

  let transitionState = "login";
  let submitted = false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const clickSuccess = await submitLogin(page, passwordInput);
    submitted = submitted || clickSuccess;

    if (!clickSuccess) {
      continue;
    }

    await page.waitForLoadState("domcontentloaded").catch(() => {});

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      transitionState = await detectLoginTransition(page);
      if (transitionState !== "login") {
        break;
      }
      assertNotCancelled(shouldCancel);
      await page.waitForTimeout(350);
    }

    if (transitionState !== "login") {
      break;
    }
  }

  if (!submitted) {
    throw new Error(`Could not submit login form for ${account.label}.`);
  }

  if (transitionState === "login") {
    const hint = await collectLoginErrorHint(page);
    if (!headless) {
      console.log(`[Threads] Auto login did not complete; waiting for manual login. hint=${hint || "none"}`);
      await waitForUserToLogin(page, account);
      return;
    }

    const suffix = hint ? ` hint: ${hint}` : "";
    throw new Error(`Login failed for ${account.label}: still on login page after submit.${suffix}`);
  }

  const twoFAInput = transitionState === "twoFA" || await page
    .locator(TWO_FA_INPUT_SELECTOR)
    .first()
    .isVisible()
    .catch(() => false);

  if (twoFAInput && account.secret_key) {
    reportProgress(onProgress, account, "login_check", 28, "2FAコードを入力");
    let totp = await getTotpFromTrendSns(page, account.secret_key);
    if (!totp) {
      totp = generateTOTP(account.secret_key);
    }

    if (totp) {
      const input = page
        .locator(TWO_FA_INPUT_SELECTOR)
        .first();
      await input.fill(totp);
      await page.waitForTimeout(200);
      await input.press("Enter").catch(() => {});

      // Try multiple selectors for the 2FA confirm button
      let submitButton = page
        .getByRole("button", { name: /confirm|submit|verify|確認/i })
        .first();

      let clickSuccess = false;
      try {
        clickSuccess = await clickLocatorWithFallback(submitButton);
      } catch {
        // Fallback: look for button with "送信" / "確認" / "Confirm" text
        const buttons = page.locator('div[role="button"], button');
        const count = await buttons.count();
        for (let i = 0; i < count; i++) {
          const btn_text = await buttons.nth(i).textContent();
          if (btn_text && (btn_text.includes("送信") || btn_text.includes("確認") || btn_text.includes("Confirm") || btn_text.includes("Submit"))) {
            try {
              clickSuccess = await clickLocatorWithFallback(buttons.nth(i));
              if (clickSuccess) {
                break;
              }
            } catch {
            }
          }
        }
      }

      if (!clickSuccess) {
        clickSuccess = await page.evaluate(() => {
          const form = document.querySelector('input[autocomplete="one-time-code"]')?.closest("form") || document.querySelector("form");
          if (!form) {
            return false;
          }
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
          } else {
            form.submit();
          }
          return true;
        }).catch(() => false);
      }

      if (clickSuccess) {
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(500);
        await publishInspection(page, account, onInspection, "login_check");
      }
    } else {
      throw new Error(`2FA code generation failed for ${account.label}. Check secret_key format.`);
    }
  } else if (twoFAInput && !account.secret_key) {
    if (!headless) {
      await waitForUserTo2FA(page, account);
    } else {
      throw new Error(`2FA required but no secret_key configured for ${account.label}.`);
    }
  }

  await page.goto(THREADS_HOME_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await publishInspection(page, account, onInspection, "login_done");

  reportProgress(onProgress, account, "login_done", 35, "ホーム画面を確認");
  const homeReady = await waitForThreadsHomeReady(page, HOME_READY_TIMEOUT_MS);
  if (!homeReady) {
    console.warn(`[Threads] Home ready check timed out for ${account.username}; continue with composer detection.`);
  }

  reportProgress(onProgress, account, "login_done", 40, "投稿導線を確認");
}

async function createPost(page, text, account, onProgress, onInspection, shouldCancel) {
  const modalEditorSelector = [
    'div[role="textbox"][contenteditable="true"][data-lexical-editor="true"][aria-label*="テキストフィールド" i]',
    'div[role="textbox"][contenteditable="true"][data-lexical-editor="true"][aria-placeholder*="最新情報" i]',
    'div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]',
    '[role="dialog"] div[role="textbox"][contenteditable="true"]',
    '[aria-modal="true"] div[role="textbox"][contenteditable="true"]'
  ].join(", ");
  const logCreatePost = (step, details = "") => {
    const suffix = details ? ` ${details}` : "";
    console.log(`[Threads][createPost] ${step}${suffix}`);
  };

  async function waitForModalEditorReady(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      assertNotCancelled(shouldCancel);
      const ready = await page
        .evaluate((selector) => {
          const el = Array.from(document.querySelectorAll(selector))
            .filter((node) => {
              const style = window.getComputedStyle(node);
              if (style.display === "none" || style.visibility === "hidden") {
                return false;
              }
              const rect = node.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) {
                return false;
              }

              const dialog = node.closest('[role="dialog"], [aria-modal="true"]');
              if (!dialog) {
                return false;
              }

              const dialogRect = dialog.getBoundingClientRect();
              return dialogRect.width > 0 && dialogRect.height > 0;
            })
            .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];

          return Boolean(el);
        }, modalEditorSelector)
        .catch(() => false);

      if (ready) {
        logCreatePost("modal_ready", `elapsedMs=${Date.now() - start}`);
        return true;
      }

      await page.waitForTimeout(250);
    }

    logCreatePost("modal_ready_timeout", `timeoutMs=${timeoutMs}`);
    return false;
  }

  const clickAndWaitForModal = async (locator, label, timeoutMs = 5000) => {
    const visible = await locator.isVisible({ timeout: 250 }).catch(() => false);
    if (!visible) {
      logCreatePost(label, "visible=false");
      return false;
    }

    const clicked = await clickLocatorWithFallback(locator);
    logCreatePost(label, `visible=${visible} clicked=${clicked}`);
    if (!clicked) {
      return false;
    }

    return waitForModalEditorReady(timeoutMs);
  };

  const getModalEditorState = async () => {
    return page
      .evaluate((selector) => {
        const all = Array.from(document.querySelectorAll(selector));
        const visible = all.filter((node) => {
          const style = window.getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

        const target = visible.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
        const activeMatch = target ? document.activeElement === target : false;
        const textLength = target ? (target.textContent || "").trim().length : 0;

        return {
          total: all.length,
          visible: visible.length,
          hasTarget: Boolean(target),
          activeMatch,
          textLength
        };
      }, modalEditorSelector)
      .catch(() => ({ total: 0, visible: 0, hasTarget: false, activeMatch: false, textLength: 0 }));
  };

  const modalAlreadyOpen = await page
    .locator(modalEditorSelector)
    .last()
    .isVisible({ timeout: 300 })
    .catch(() => false);
  logCreatePost("modal_precheck", `alreadyOpen=${modalAlreadyOpen}`);

  const openComposerFromHomeCard = async () => {
    const normalizedAccountUsername = normalizeUsername(account.username);
    const homeCardReady = await page
      .locator('div[role="button"][aria-label*="テキストフィールドが空です" i]')
      .first()
      .isVisible({ timeout: 150 })
      .catch(() => false);
    logCreatePost("home_card_ready", `visible=${homeCardReady}`);

    const clickedOwnCardTrigger = await page
      .evaluate((expectedUsername) => {
        const isVisible = (el) => {
          if (!el) {
            return false;
          }
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const normalize = (value) => String(value || "").trim().replace(/^@+/, "").toLowerCase();
        const expected = normalize(expectedUsername);
        if (!expected) {
          return false;
        }

        const profileLink = document.querySelector(`a[href="/@${expected}"]`);
        if (!profileLink) {
          return false;
        }

        let card = profileLink.parentElement;
        while (card) {
          const textfieldButton = Array.from(card.querySelectorAll('div[role="button"][aria-label*="テキストフィールド" i]'))
            .find((el) => isVisible(el));
          if (textfieldButton) {
            textfieldButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            textfieldButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            textfieldButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            if (typeof textfieldButton.click === "function") {
              textfieldButton.click();
            }
            return "textfield";
          }

          const postButton = Array.from(card.querySelectorAll('div[role="button"], button'))
            .find((el) => {
              const label = (el.textContent || "").trim().toLowerCase();
              return isVisible(el) && (label === "投稿" || label === "post");
            });
          if (postButton) {
            postButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            postButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            postButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            if (typeof postButton.click === "function") {
              postButton.click();
            }
            return "post";
          }

          card = card.parentElement;
        }

        return false;
      }, normalizedAccountUsername)
      .catch(() => false);
    logCreatePost("home_card_own_trigger", `trigger=${clickedOwnCardTrigger || "none"}`);

    if (clickedOwnCardTrigger) {
      const opened = await waitForModalEditorReady(1800);
      logCreatePost("home_card_own_modal", `opened=${opened}`);
      if (opened) {
        return true;
      }
    }

    const clickedTextFieldButton = await clickAndWaitForModal(
      page.locator('div[role="button"][aria-label*="テキストフィールド" i]').first(),
      "home_card_textfield_click",
      1800
    );

    logCreatePost("home_card_textfield_modal", `opened=${clickedTextFieldButton}`);
    if (clickedTextFieldButton) {
      return true;
    }

    const clickedAvatarButton = await clickAndWaitForModal(
      page.locator('svg[aria-label*="プロフィール" i], svg[aria-label*="profile" i]').locator('xpath=ancestor::*[@role="button"][1]').first(),
      "home_card_avatar_click",
      5000
    );

    logCreatePost("home_card_avatar_modal", `opened=${clickedAvatarButton}`);
    if (clickedAvatarButton) {
      return true;
    }

    const clickedTopPost = await page
      .evaluate(() => {
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const cards = Array.from(document.querySelectorAll('div[role="button"][aria-label*="テキストフィールドが空です" i]'));
        for (const cardTrigger of cards) {
          let card = cardTrigger.parentElement;
          while (card) {
            const hasProfile = Boolean(card.querySelector('a[href^="/@"]'));
            const hasPostButton = Array.from(card.querySelectorAll('div[role="button"], button')).some((el) => {
              const label = (el.textContent || "").trim();
              return label === "投稿" || label.toLowerCase() === "post";
            });

            if (hasProfile && hasPostButton) {
              break;
            }

            card = card.parentElement;
          }

          if (!card) {
            continue;
          }

          const postButton = Array.from(card.querySelectorAll('div[role="button"], button')).find((el) => {
            if (el === cardTrigger) {
              return false;
            }
            const label = (el.textContent || "").trim();
            if (label !== "投稿" && label.toLowerCase() !== "post") {
              return false;
            }
            if (!isVisible(el)) {
              return false;
            }
            if (el.getAttribute("aria-disabled") === "true" || el.getAttribute("disabled") !== null) {
              return false;
            }
            return true;
          });

          if (!postButton) {
            continue;
          }

          postButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          postButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          postButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          if (typeof postButton.click === "function") {
            postButton.click();
          }
          return true;
        }

        return false;
      })
      .catch(() => false);

    logCreatePost("home_card_post_click", `clicked=${clickedTopPost}`);
    if (clickedTopPost) {
      const opened = await waitForModalEditorReady(1800);
      logCreatePost("home_card_post_modal", `opened=${opened}`);
      if (opened) {
        return true;
      }
    }

    return false;
  };

  const openTargets = [
    page.getByRole("button", { name: /new thread|create|新しいスレッド|新規スレッド|作成/i }).first(),
    page.locator('a[href="/intent/post"], a[href*="/intent/post?"]').first(),
    page.locator('[role="button"][aria-label*="new thread" i], [role="button"][aria-label*="新しいスレッド" i]').first(),
    page.locator('div[role="button"][aria-label*="テキストフィールド" i]').first(),
    page.locator('div[role="button"]:has-text("最新情報")').first(),
    page.locator('[aria-label*="テキストフィールド" i][role="button"]').first()
  ];

  if (!modalAlreadyOpen) {
    reportProgress(onProgress, account, "compose_open", 50, "投稿画面を開く");
    const openedFromHomeCard = await openComposerFromHomeCard();
    logCreatePost("open_from_home_card", `opened=${openedFromHomeCard}`);
    if (!openedFromHomeCard) {
      for (const target of openTargets) {
        const opened = await clickAndWaitForModal(target, "open_target_click", 2500);
        if (opened) {
          break;
        }
      }
    }
  } else {
    logCreatePost("open_target_skip", "reason=modal_already_open");
  }

  if (!modalAlreadyOpen) {
    await waitForModalEditorReady(1500).catch(() => false);
  }
  await page.waitForTimeout(COMPOSER_OPEN_SETTLE_MS);
  await publishInspection(page, account, onInspection, "compose_open");

  const getPrimaryModalEditor = () => {
    return page
      .locator(modalEditorSelector)
      .last();
  };

  const clickAndTypePrimaryModalEditor = async (content) => {
    const modalReady = await waitForModalEditorReady(12000);
    if (!modalReady) {
      return false;
    }

    const editor = getPrimaryModalEditor();
    const visible = await editor.isVisible({ timeout: 2000 }).catch(() => false);
    logCreatePost("primary_editor_visible", `visible=${visible}`);
    if (!visible) {
      return false;
    }

    await editor.click({ timeout: 2000, force: true }).catch(() => {});
    const afterClickState = await getModalEditorState();
    logCreatePost(
      "after_click",
      `total=${afterClickState.total} visible=${afterClickState.visible} active=${afterClickState.activeMatch} textLength=${afterClickState.textLength}`
    );

    // Intentionally do not wait for focus; type immediately after click.
    await page.keyboard.insertText(content).catch(() => {});

    const typedByKeyboard = await editor
      .evaluate((el) => {
        const text = (el.textContent || "").trim();
        return text.length > 0 && text !== "最新情報";
      })
      .catch(() => false);
    const afterInsertState = await getModalEditorState();
    logCreatePost(
      "after_insertText",
      `typed=${typedByKeyboard} active=${afterInsertState.activeMatch} textLength=${afterInsertState.textLength}`
    );

    if (typedByKeyboard) {
      return true;
    }

    const injected = await editor
      .evaluate((el, value) => {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        if (typeof el.focus === "function") {
          el.focus();
        }

        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.addRange(range);
        }

        const inserted = document.execCommand("insertText", false, value);
        if (!inserted) {
          el.textContent = value;
          el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        }

        return (el.textContent || "").trim().length > 0;
      }, content)
      .catch(() => false);

    const afterInjectState = await getModalEditorState();
    logCreatePost(
      "after_dom_inject",
      `typed=${injected} active=${afterInjectState.activeMatch} textLength=${afterInjectState.textLength}`
    );

    return injected;
  };

  const clickModalComposerTextbox = async () => {
    const modalEditors = [
      page.locator('[data-lexical-editor="true"][contenteditable="true"][role="textbox"][aria-label*="テキストフィールドが空です" i]').first(),
      page.locator('[data-lexical-editor="true"][contenteditable="true"][role="textbox"][aria-placeholder*="最新情報" i]').first(),
      page.locator('[contenteditable="true"][role="textbox"][aria-placeholder*="最新情報" i]').first(),
      page.locator('[contenteditable="true"][role="textbox"]').last()
    ];

    for (const editor of modalEditors) {
      const visible = await editor.isVisible({ timeout: 2000 }).catch(() => false);
      if (!visible) {
        continue;
      }

      const clicked = await clickLocatorWithFallback(editor);
      if (clicked) {
        return true;
      }
    }

    return false;
  };

  const inputTextToModalComposer = async (content) => {
    return page.evaluate((value) => {
      const isVisible = (el) => {
        if (!el) {
          return false;
        }
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const candidates = Array.from(document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"][role="textbox"], [contenteditable="true"][role="textbox"]'))
        .filter((el) => isVisible(el))
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

      const editor = candidates[0];
      if (!editor) {
        return false;
      }

      editor.focus();

      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.addRange(range);
      }

      const inserted = document.execCommand("insertText", false, value);
      if (!inserted) {
        editor.textContent = value;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      }

      return (editor.textContent || "").trim().length > 0;
    }, content).catch(() => false);
  };

  const hasTextInEditor = async (editor) => {
    return editor
      .evaluate((el) => {
        const text = (el.textContent || "").trim();
        return text.length > 0 && text !== "最新情報";
      })
      .catch(() => false);
  };

  // Explicitly click modal textbox after opening the composer.
  await waitForModalEditorReady(12000);
  const clickedModalTextbox = await clickModalComposerTextbox();
  logCreatePost("click_modal_textbox", `clicked=${clickedModalTextbox}`);

  let textFilled = false;

  textFilled = await clickAndTypePrimaryModalEditor(text);
  logCreatePost("initial_fill_result", `filled=${textFilled}`);

  const tryFillComposer = async () => {
    const fastTyped = await clickAndTypePrimaryModalEditor(text);
    if (fastTyped) {
      return true;
    }

    const editors = [
      page.locator('[data-lexical-editor="true"][contenteditable="true"][role="textbox"][aria-label*="テキストフィールドが空です" i]').first(),
      page.locator('[data-lexical-editor="true"][contenteditable="true"][role="textbox"][aria-placeholder*="最新情報" i]').first(),
      page.locator('[contenteditable="true"][role="textbox"]').last(),
      page.locator('[data-lexical-editor="true"][contenteditable="true"]').first(),
      page.locator('[contenteditable="true"][aria-placeholder*="最新情報" i]').first(),
      page.locator('[aria-label*="テキストフィールド" i][contenteditable="true"]').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('[role="textbox"]').first(),
      page.locator('textarea').first()
    ];

    for (const editor of editors) {
      const visible = await editor.isVisible({ timeout: 1500 }).catch(() => false);
      if (!visible) {
        continue;
      }

      try {
        await editor.click({ timeout: 3000 });
        await editor.evaluate((el) => {
          if (typeof el.focus === "function") {
            el.focus();
          }
        });
        await page.keyboard.press("Meta+a").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        await page.keyboard.insertText(text);

        const typed = await hasTextInEditor(editor);
        if (typed) {
          return true;
        }

        await editor.type(text, { delay: 20 }).catch(() => {});
        const typedByType = await hasTextInEditor(editor);
        if (typedByType) {
          return true;
        }
      } catch {
        try {
          await editor.click({ timeout: 3000 });
          await editor.evaluate((el) => {
            if (typeof el.focus === "function") {
              el.focus();
            }
          });
          await page.keyboard.press("Meta+a").catch(() => {});
          await page.keyboard.press("Backspace").catch(() => {});
          await page.keyboard.insertText(text);
          const typed = await hasTextInEditor(editor);
          if (typed) {
            return true;
          }

          await editor.type(text, { delay: 20 }).catch(() => {});
          const typedByType = await hasTextInEditor(editor);
          if (typedByType) {
            return true;
          }
        } catch {
        }
      }
    }

    const fallbackTyped = await inputTextToModalComposer(text);
    if (fallbackTyped) {
      return true;
    }

    return page.evaluate((content) => {
      const candidateSelectors = [
        '[contenteditable="true"][role="textbox"]',
        '[data-lexical-editor="true"][contenteditable="true"]',
        '[contenteditable="true"][aria-placeholder*="最新情報" i]',
        '[aria-label*="テキストフィールド" i][contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea'
      ];

      for (const selector of candidateSelectors) {
        const el = document.querySelector(selector);
        if (!el) {
          continue;
        }

        if (el.getAttribute("contenteditable") === "true") {
          el.focus();
          el.textContent = content;
          el.dispatchEvent(new InputEvent("input", { bubbles: true }));
          return true;
        }

        if (el.tagName === "TEXTAREA") {
          el.focus();
          el.value = content;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
      }

      return false;
    }, text).catch(() => false);
  };

  const hasComposerText = async () => {
    return page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"], [data-lexical-editor="true"][contenteditable="true"], [contenteditable="true"], textarea'));
      for (const node of nodes) {
        const text = (node.textContent || node.value || "").trim();
        if (text.length > 0 && text !== "最新情報") {
          return true;
        }
      }
      return false;
    }).catch(() => false);
  };

  const clickModalPostButtonByDom = async () => {
    return page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('div[role="button"], button'))
        .filter((el) => {
          const text = (el.textContent || "").trim();
          if (text !== "投稿" && text.toLowerCase() !== "post") {
            return false;
          }
          if (el.getAttribute("aria-disabled") === "true") {
            return false;
          }
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          return true;
        })
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

      const target = candidates[0];
      if (!target) {
        return false;
      }

      if (typeof target.click === "function") {
        target.click();
        return true;
      }

      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    }).catch(() => false);
  };

  if (!textFilled) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      logCreatePost("fill_attempt_start", `attempt=${attempt}`);
      textFilled = await tryFillComposer();
      if (textFilled) {
        const hasText = await hasComposerText();
        const state = await getModalEditorState();
        logCreatePost(
          "fill_attempt_state",
          `attempt=${attempt} hasText=${hasText} active=${state.activeMatch} textLength=${state.textLength}`
        );
        if (hasText) {
          break;
        }
        textFilled = false;
      }

      if (!textFilled) {
        await clickLocatorWithFallback(page.locator('[aria-label*="テキストフィールド" i][role="button"]').first());
        await clickLocatorWithFallback(page.locator('div[role="button"]:has-text("最新情報")').first());
        await clickModalComposerTextbox();
        await page.waitForTimeout(700);
      }
    }
  }

  if (!textFilled) {
    textFilled = await hasComposerText();
  }

  if (!textFilled) {
    throw new Error("Could not find post editor");
  }

  reportProgress(onProgress, account, "compose_fill", 70, "本文を入力");
  await publishInspection(page, account, onInspection, "compose_fill");

  await page.waitForTimeout(TEXT_ENTRY_SETTLE_MS);

  let postSuccess = false;

  const getModalSubmitButtons = () => {
    return [
      page.locator('[role="dialog"] [role="button"]').filter({ hasText: /^投稿$/ }).last(),
      page.locator('[role="dialog"] [role="button"]').filter({ hasText: /^Post$/i }).last(),
      page.locator('[aria-modal="true"] [role="button"]').filter({ hasText: /^投稿$/ }).last(),
      page.locator('[aria-modal="true"] [role="button"]').filter({ hasText: /^Post$/i }).last(),
      page.locator('[role="dialog"] button:has-text("投稿")').last(),
      page.locator('[role="dialog"] button:has-text("Post")').last(),
      page.locator('[aria-modal="true"] button:has-text("投稿")').last(),
      page.locator('[aria-modal="true"] button:has-text("Post")').last(),
      page.locator('[role="dialog"] input[type="submit"][value="投稿" i], [role="dialog"] input[type="submit"][value="Post" i]').last(),
      page.locator('[aria-modal="true"] input[type="submit"][value="投稿" i], [aria-modal="true"] input[type="submit"][value="Post" i]').last()
    ];
  };

  const clickModalSubmitByDomOnce = async () => {
    return page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, "").trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) {
          return false;
        }

        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }

        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const isExactPostButton = (el) => {
        const label = normalize([
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("value"),
          el.getAttribute("title")
        ].filter(Boolean).join(" "));

        if (!(label === "投稿" || label === "post" || label === "publish" || label === "share")) {
          return false;
        }

        return !/(下書き|draft|キャンセル|cancel|オプション|options|追加|トピック|コミュニティ)/i.test(label);
      };

      const scoreCandidate = (el) => {
        const rect = el.getBoundingClientRect();
        return (rect.top * 10000) + rect.left;
      };

      const findCandidates = (root) => {
        if (!root) {
          return [];
        }

        return Array.from(root.querySelectorAll('button, input[type="submit"], div[role="button"]'))
          .filter((el) => isVisible(el))
          .filter((el) => el.getAttribute("aria-disabled") !== "true" && el.getAttribute("disabled") === null)
          .filter((el) => isExactPostButton(el))
          .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
      };

      const editors = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"], [contenteditable="true"][data-lexical-editor="true"]'))
        .filter((el) => isVisible(el))
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

      const editor = editors[0] || null;
      let candidates = [];

      if (editor) {
        let ancestor = editor.parentElement;
        while (ancestor && ancestor !== document.body) {
          candidates = findCandidates(ancestor);
          if (candidates.length > 0) {
            break;
          }
          ancestor = ancestor.parentElement;
        }
      }

      if (candidates.length === 0) {
        const containers = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
        .filter((el) => isVisible(el))
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

        const container = containers[0] || null;
        candidates = findCandidates(container);
      }

      if (candidates.length === 0) {
        candidates = findCandidates(document);
      }

      const target = candidates[0] || null;
      if (!target) {
        return false;
      }

      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      if (typeof target.click === "function") {
        target.click();
      }
      return true;
    }).catch(() => false);
  };

  const clickModalSubmitButtonOnce = async (locator) => {
    try {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click({ timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  };

  const waitForComposerSubmission = async (timeoutMs = 12000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      assertNotCancelled(shouldCancel);

      const modalVisible = await page.locator(modalEditorSelector).last().isVisible({ timeout: 200 }).catch(() => false);
      if (!modalVisible) {
        return true;
      }

      const submitStillEnabled = await page.evaluate(() => {
        const containers = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'));
        for (const container of containers) {
          const buttons = Array.from(container.querySelectorAll('button, input[type="submit"], div[role="button"]'));
          for (const button of buttons) {
            const label = [button.textContent, button.getAttribute('aria-label'), button.getAttribute('value')]
              .filter(Boolean)
              .join(' ')
              .trim()
              .toLowerCase();
            if (label !== '投稿' && label !== 'post') {
              continue;
            }
            if (button.getAttribute('aria-disabled') === 'true' || button.getAttribute('disabled') !== null) {
              return false;
            }
            return true;
          }
        }
        return false;
      }).catch(() => true);

      if (!submitStillEnabled) {
        return true;
      }

      await page.waitForTimeout(350);
    }

    return false;
  };

  logCreatePost("submit_start");
  reportProgress(onProgress, account, "submit_post", 85, "投稿ボタンを押下");
  await publishInspection(page, account, onInspection, "submit_post");
  await page.waitForTimeout(PRE_SUBMIT_SETTLE_MS);

  const modalSubmitButtons = getModalSubmitButtons();
  for (const target of modalSubmitButtons) {
    const visible = await target.isVisible({ timeout: 300 }).catch(() => false);
    if (!visible) {
      continue;
    }

    const ariaDisabled = await target.getAttribute("aria-disabled").catch(() => "");
    if (ariaDisabled === "true") {
      continue;
    }

    postSuccess = await clickModalSubmitButtonOnce(target);
    logCreatePost("submit_modal_button", `clicked=${postSuccess}`);
    if (postSuccess) {
      break;
    }
  }

  if (!postSuccess) {
    postSuccess = await clickModalSubmitByDomOnce();
    logCreatePost("submit_modal_dom_button", `clicked=${postSuccess}`);
  }

  if (!postSuccess) {
    throw new Error("Could not find modal post button");
  }

  const submitCompleted = await waitForComposerSubmission(12000);
  logCreatePost("submit_completion", `completed=${submitCompleted}`);
  if (!submitCompleted) {
    throw new Error("Post submit did not settle");
  }

  const waitForPostedUrl = async (timeoutMs = 8000) => {
    const startedAt = Date.now();
    const username = normalizeUsername(account.username);
    const textProbe = String(text || "").replaceAll(/\s+/g, " ").trim().slice(0, 32);

    while (Date.now() - startedAt < timeoutMs) {
      assertNotCancelled(shouldCancel);

      const currentUrl = page.url();
      if (isLikelyThreadsPostUrl(currentUrl, username)) {
        return currentUrl;
      }

      const discoveredUrl = await page.evaluate(({ expectedUsername, probe }) => {
        const normalize = (value) => String(value || "").trim().replace(/^@+/, "").toLowerCase();
        const isVisible = (el) => {
          if (!el) {
            return false;
          }
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const toAbsolute = (href) => {
          try {
            return new URL(href, location.origin).href;
          } catch {
            return "";
          }
        };
        const isLikelyPostUrl = (href) => {
          try {
            const url = new URL(href, location.origin);
            if (!/threads\.com$/i.test(url.hostname)) {
              return false;
            }
            const path = url.pathname || "";
            return /\/post\//i.test(path) || /^\/t\//i.test(path) || (expectedUsername && path.startsWith(`/@${expectedUsername}/`) && path !== `/@${expectedUsername}`);
          } catch {
            return false;
          }
        };

        const expected = normalize(expectedUsername);
        const profileAnchor = expected ? document.querySelector(`a[href="/@${expected}"]`) : null;
        const candidates = [];

        if (profileAnchor) {
          let card = profileAnchor.parentElement;
          while (card) {
            const textContent = (card.textContent || "").replace(/\s+/g, " ").trim();
            if (!probe || textContent.includes(probe)) {
              const links = Array.from(card.querySelectorAll('a[href]'));
              for (const link of links) {
                const href = link.getAttribute('href') || '';
                const absolute = toAbsolute(href);
                if (isVisible(link) && isLikelyPostUrl(absolute)) {
                  return absolute;
                }
              }
            }
            card = card.parentElement;
          }
        }

        const pageLinks = Array.from(document.querySelectorAll('a[href]'));
        for (const link of pageLinks) {
          const absolute = toAbsolute(link.getAttribute('href') || '');
          if (!isVisible(link) || !isLikelyPostUrl(absolute)) {
            continue;
          }

          const containerText = (link.closest('article, div')?.textContent || '').replace(/\s+/g, ' ').trim();
          if (probe && !containerText.includes(probe)) {
            continue;
          }
          candidates.push(absolute);
        }

        return candidates[0] || "";
      }, { expectedUsername: username, probe: textProbe }).catch(() => "");

      if (discoveredUrl && isLikelyThreadsPostUrl(discoveredUrl, username)) {
        return discoveredUrl;
      }

      await page.waitForTimeout(400);
    }

    return "";
  };

  await page.waitForTimeout(POST_SUBMIT_SETTLE_MS);
  const postedUrl = await waitForPostedUrl(3500);

  return {
    postUrl: postedUrl || buildThreadsProfileUrl(account.username)
  };
}

async function runSingleAccount({ browser, account, text, delayMs, headless, onProgress, onInspection, shouldCancel }) {
  if (delayMs > 0) {
    reportProgress(onProgress, account, "waiting", 0, `開始まで ${Math.ceil(delayMs / 1000)} 秒待機`);
    await sleepWithCancel(delayMs, shouldCancel);
  }

  assertNotCancelled(shouldCancel);
  reportProgress(onProgress, account, "session_load", 3, "処理を開始");

  const initialSavedSession = await loadSession(account.id);
  const maxAttempts = initialSavedSession ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const savedSession = attempt === 1 ? initialSavedSession : null;
    const contextOptions = { ...DESKTOP_CONTEXT_OPTIONS };

    if (savedSession) {
      const normalizedOrigins = normalizeStorageOrigins(savedSession.localStorage || savedSession.origins);
      contextOptions.storageState = {
        cookies: Array.isArray(savedSession.cookies) ? savedSession.cookies : [],
        origins: normalizedOrigins
      };
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    let runError = null;

    try {
      await publishInspection(page, account, onInspection, "session_load");
      await ensureLoggedIn(page, account, headless, Boolean(savedSession), onProgress, onInspection, shouldCancel);
      assertNotCancelled(shouldCancel);
      const postResult = await createPost(page, text, account, onProgress, onInspection, shouldCancel);

      const cookies = await context.cookies();
      const localStorage = await page.evaluate(() => {
        return Object.keys(window.localStorage).map((key) => ({
          name: key,
          value: window.localStorage.getItem(key) ?? ""
        }));
      });

      reportProgress(onProgress, account, "session_save", 92, "セッションを保存");
      await saveSession(account.id, cookies, [
        {
          origin: THREADS_HOME_URL,
          localStorage
        }
      ]);

      reportProgress(onProgress, account, "done", 100, "投稿完了");
      await publishInspection(page, account, onInspection, "done");

      return {
        account: account.label,
        status: "ok",
        postUrl: postResult?.postUrl || ""
      };
    } catch (error) {
      runError = error;
      const message = String(error?.message || "");
      const shouldRetryFromMismatch = attempt === 1 && savedSession && message.includes("Session account mismatch");

      if (error instanceof JobCancelledError) {
        reportProgress(onProgress, account, "cancelled", 100, "キャンセルしました");
        await publishInspection(page, account, onInspection, "cancelled");
        return {
          account: account.label,
          status: "cancelled",
          message: "キャンセルしました"
        };
      }

      if (shouldRetryFromMismatch) {
        console.warn(`[Threads] Session mismatch detected for ${account.username}; clearing saved session and retrying once.`);
        await deleteSession(account.id).catch(() => {});
        reportProgress(onProgress, account, "session_load", 5, "セッション不一致のため再試行");
        runError = null;
      } else {
        console.error(`[Threads] Account run failed: ${account.label} (${account.username}) - ${message}`);
        reportProgress(onProgress, account, "error", 100, message || "投稿失敗");
        return {
          account: account.label,
          status: "error",
          message
        };
      }
    } finally {
      if (runError && !headless) {
        console.log("[Threads] Non-headless error: keeping browser open for 20s for inspection.");
        await page.waitForTimeout(20000).catch(() => {});
      }

      await context.close().catch(() => {});
    }
  }

  return {
    account: account.label,
    status: "error",
    message: "Unknown error while posting"
  };
}

export async function postToThreads({ accounts, text, spreadMinutes = 0, headless = false, onProgress, onInspection, shouldCancel }) {
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
      assertNotCancelled(shouldCancel);
      const result = await runSingleAccount({
        browser,
        account: item.account,
        text,
        delayMs: item.delayMs,
        headless,
        onProgress,
        onInspection,
        shouldCancel
      });
      results.push({ ...result, delayMs: item.delayMs });

      if (result.status === "cancelled") {
        break;
      }
    }

    return results;
  } finally {
    await browser.close();
  }
}
