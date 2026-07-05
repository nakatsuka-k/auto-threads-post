import { loadAccounts } from "./accountStore.js";

async function main() {
  try {
    const accounts = await loadAccounts();
    console.log(`accounts loaded: ${accounts.length}`);
    const enabled = accounts.filter((a) => a.enabled);
    console.log(`enabled accounts: ${enabled.length}`);
    if (enabled.length === 0) {
      console.warn("No enabled accounts. Add accounts from the browser table UI and enable rows.");
    }
  } catch (error) {
    console.error("Configuration check failed:", error.message);
    process.exitCode = 1;
  }
}

main();
