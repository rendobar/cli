/**
 * `rb telemetry [on|off|status]` -- Control anonymous usage telemetry.
 *
 * Anonymous by design: no files, arguments, URLs, credentials, or account
 * identity are ever sent. See src/lib/telemetry.ts for exactly what is collected.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { setTelemetryEnabled, telemetryStatus } from "../lib/telemetry.js";

export default defineCommand({
  meta: { name: "telemetry", description: "Control anonymous usage telemetry (on|off|status)" },
  args: {
    action: {
      type: "positional",
      required: false,
      description: "on | off | status (default: status)",
    },
  },
  run({ args }) {
    const action = (args.action ?? "status").toString().toLowerCase();

    if (action === "on") {
      setTelemetryEnabled(true);
      process.stderr.write(`  ${pc.green("✓")} Anonymous telemetry enabled. Thank you for helping improve Rendobar.\n`);
      return;
    }
    if (action === "off") {
      setTelemetryEnabled(false);
      process.stderr.write(`  ${pc.green("✓")} Telemetry disabled. Nothing further will be sent.\n`);
      return;
    }
    if (action === "status") {
      const s = telemetryStatus();
      const state = s.enabled ? pc.green("on") : pc.dim("off");
      process.stderr.write(`  Telemetry: ${state}\n`);
      if (s.optedOutByEnv) {
        process.stderr.write(pc.dim("  Disabled by environment (DO_NOT_TRACK / RENDOBAR_TELEMETRY / CI).\n"));
      }
      if (!s.keyPresent) {
        process.stderr.write(pc.dim("  No telemetry endpoint configured in this build.\n"));
      }
      process.stderr.write(pc.dim(`  Anonymous id: ${s.anonymousId}\n`));
      process.stderr.write(pc.dim("  Anonymous only: no files, arguments, or credentials are collected.\n"));
      return;
    }

    process.stderr.write(pc.red(`  Unknown action "${action}". Use: on | off | status\n`));
    process.exitCode = 2;
  },
});
