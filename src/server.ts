import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Receipts } from "./receipts.js";

process.umask(0o077);
const { config, policy } = loadConfig();
const receipts = new Receipts(config.FORWARDER_DB_PATH);
const app = createApp(config, policy, receipts, result => console.log(JSON.stringify({ time: new Date().toISOString(), ...result })));
const server = app.listen(config.PORT, config.HOST, () => console.log(JSON.stringify({ service: "linear-t3code-filter-forwarder", listening: true })));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => { receipts.close(); process.exit(0); }));
}
server.on("error", () => { console.error("Forwarder listener failed"); receipts.close(); process.exit(1); });
