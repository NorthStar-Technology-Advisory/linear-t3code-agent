import { loadConfig } from "./config.js";
try {
  const { config, policy } = loadConfig();
  console.log(JSON.stringify({ ok: true, projects: policy.projectIds.length, trackedStates: policy.trackedStateIds.length,
    actionableStates: policy.actionableStateIds.length, destinationHost: new URL(config.T3_WEBHOOK_URL).host,
    separateDestinationSecret: !!config.T3_WEBHOOK_SECRET }));
} catch {
  console.error("Invalid forwarder configuration or policy. Check .env.example and policy.example.json; no network action was taken.");
  process.exitCode = 1;
}
