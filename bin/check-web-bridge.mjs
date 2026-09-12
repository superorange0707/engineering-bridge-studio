#!/usr/bin/env node
// Read-only observations. Health checks cannot establish remote tunnel identity.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  profile: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" }
} });
if (values.help) {
  process.stdout.write("Usage: node bin/check-web-bridge.mjs --profile /absolute/tunnel.yaml [--json]\nReports local health observations only; verify tunnel identity and a Web round trip separately.\n");
  process.exit(0);
}
const profile = values.profile ?? process.env.ENGINEERING_BRIDGE_TUNNEL_PROFILE;
if (!profile || !isAbsolute(profile) || normalize(profile) !== profile) {
  process.stderr.write("Provide --profile /absolute/tunnel.yaml or ENGINEERING_BRIDGE_TUNNEL_PROFILE.\n");
  process.exit(2);
}
function command(name, args) {
  const result = spawnSync(name, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 256 * 1024
  });
  return result.error ? undefined : result;
}
function profileValue(text, key) {
  return text.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\s#]+)`, "mu"))?.[1];
}
let snapshot;
try {
  const content = readFileSync(profile, "utf8");
  const address = profileValue(content, "listen_addr");
  const port = Number(address?.match(/:(\d+)$/u)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Profile requires an explicit listen_addr port.");
  const result = command("tunnel-client", ["health", "--port", String(port), "--require-control-plane-poll", "--json"]);
  let report;
  try { report = JSON.parse(result?.stdout ?? "null"); } catch { /* Unknown health is not readiness. */ }
  const status = item => item?.ok === true ? "up" : item?.ok === false ? "down" : "unknown";
  const healthy = result?.status === 0 && report?.result === "ok" && report?.control_plane_poll?.ok === true;
  snapshot = {
    profile: { path: profile, listen_addr: address, port },
    health: { healthz: status(report?.healthz), readyz: status(report?.readyz), control_plane_poll: status(report?.control_plane_poll) },
    result: healthy ? "health_checks_passed" : "health_checks_incomplete",
    configured_tunnel_identity: "not_verified",
    profile_credential_access: "not_checked",
    web_round_trip: "not_verified",
    next: "Confirm the running tunnel uses this profile, then verify Bridge capabilities and a new synthetic collaboration run from Web. Port health alone does not prove the intended tunnel is connected."
  };
  process.exitCode = healthy ? 0 : 1;
} catch (error) {
  snapshot = { profile: { path: profile }, result: "unavailable", error: error.code === "ENOENT" ? "Profile does not exist." : "Profile could not be read or has no valid explicit listen_addr port.", web_round_trip: "not_verified" };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
