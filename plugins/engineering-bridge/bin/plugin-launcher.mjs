import { runStudioPlugin } from "./studio-mcp.mjs";

function fail(message) {
  process.stderr.write(`Engineering Bridge plugin: ${message}\n`);
  process.exit(1);
}

if (process.env.ENGINEERING_BRIDGE_EXECUTOR_CHILD === "1") {
  fail("refusing recursive executor-child startup");
}

if (process.platform !== "darwin") {
  fail("this unified beta currently supports macOS only");
}

await runStudioPlugin().catch(error => fail(error.message));
