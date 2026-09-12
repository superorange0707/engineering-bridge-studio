import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  acquireControlPlaneRuntimeLease,
  applyControlPlaneRegistryWrite,
  applyControlPlaneTransaction,
  recordControlPlaneRegistryCatchUp,
  recoverControlPlaneTransactions,
  withControlPlaneRegistryWriteLock
} from "../../../src/workspaces/control-plane-transaction.js";
import type {
  ControlPlaneTransactionCheckpoint,
  ControlPlaneTransactionInput,
  ControlPlaneTransactionOperation
} from "../../../src/workspaces/control-plane-transaction.js";

const WORKER = fileURLToPath(new URL("../../fixtures/control-plane-transaction-worker.js", import.meta.url));

interface Fixture {
  readonly root: string;
  readonly configPath: string;
  readonly registryPath: string;
  readonly input: ControlPlaneTransactionInput;
  readonly configPreimage: Buffer;
  readonly registryPreimage: Buffer;
  readonly configResult: Buffer;
  readonly registryResult: Buffer;
}

const hash = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");

function fixture(proposalId = `transaction-${randomUUID()}`): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-control-plane-transaction-")));
  const configDirectory = join(root, "config");
  const stateDirectory = join(root, "state");
  mkdirSync(configDirectory, { mode: 0o700 });
  mkdirSync(stateDirectory, { mode: 0o700 });
  const configPath = join(configDirectory, "workspaces.json");
  const registryPath = join(stateDirectory, "workspace-registry.json");
  const configPreimage = Buffer.from('{"generation":"config-pre"}\n');
  const registryPreimage = Buffer.from('{"generation":"registry-pre"}\n');
  const configResult = Buffer.from('{"generation":"config-result"}\n');
  const registryResult = Buffer.from('{"generation":"registry-result"}\n');
  writeFileSync(configPath, configPreimage, { mode: 0o600 });
  writeFileSync(registryPath, registryPreimage, { mode: 0o600 });
  return {
    root,
    configPath,
    registryPath,
    configPreimage,
    registryPreimage,
    configResult,
    registryResult,
    input: {
      configPath,
      proposalId,
      configPreimageSha256: hash(configPreimage),
      configResultSha256: hash(configResult),
      configResult,
      registryPreimageSha256: hash(registryPreimage),
      registryResultSha256: hash(registryResult),
      registryResult
    }
  };
}

function transactionDirectory(value: Fixture): string {
  return join(value.root, "state", "control-plane-transactions", value.input.proposalId);
}

function journal(value: Fixture): { phase: string; token: string } {
  return JSON.parse(readFileSync(join(transactionDirectory(value), "journal.json"), "utf8")) as {
    phase: string;
    token: string;
  };
}

function requirePreimages(value: Fixture): void {
  assert.deepEqual(readFileSync(value.configPath), value.configPreimage);
  assert.deepEqual(readFileSync(value.registryPath), value.registryPreimage);
}

function requireResults(value: Fixture): void {
  assert.deepEqual(readFileSync(value.configPath), value.configResult);
  assert.deepEqual(readFileSync(value.registryPath), value.registryResult);
}

function descriptor(value: Fixture): string {
  const path = join(value.root, "descriptor.json");
  writeFileSync(path, `${JSON.stringify({
    ...value.input,
    configResult: undefined,
    registryResult: undefined,
    configResultBase64: value.configResult.toString("base64"),
    registryResultBase64: value.registryResult.toString("base64")
  }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function waitForFile(path: string, child: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before checkpoint: ${child.exitCode ?? child.signalCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("worker checkpoint timed out");
}

async function crashWorker(
  value: Fixture,
  action: "apply" | "recover",
  checkpoint: ControlPlaneTransactionCheckpoint
): Promise<void> {
  const marker = join(value.root, `${action}-${checkpoint}-${randomUUID()}.marker`);
  const child = spawn(process.execPath, [WORKER, action, descriptor(value), checkpoint, marker], {
    stdio: "ignore"
  });
  await waitForFile(marker, child);
  assert.equal(child.kill("SIGKILL"), true);
  const [, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(signal, "SIGKILL");
}

test("actual process crashes at every APPLY commit boundary recover deterministically", async () => {
  const beforeJournal = fixture();
  await crashWorker(beforeJournal, "apply", "before_journal");
  requirePreimages(beforeJournal);
  await recoverControlPlaneTransactions(beforeJournal.configPath);
  requirePreimages(beforeJournal);

  const prepared = fixture();
  await crashWorker(prepared, "apply", "after_prepared");
  assert.equal(journal(prepared).phase, "PREPARED");
  await recoverControlPlaneTransactions(prepared.configPath);
  assert.equal(journal(prepared).phase, "ABORTED");
  requirePreimages(prepared);

  for (const checkpoint of [
    "after_commit_intent",
    "after_config_replace",
    "after_registry_replace",
    "before_committed",
    "after_committed"
  ] as const) {
    const value = fixture();
    await crashWorker(value, "apply", checkpoint);
    await recoverControlPlaneTransactions(value.configPath);
    requireResults(value);
    assert.equal(journal(value).phase, "COMMITTED");
  }
});

test("actual process crashes during recovery are idempotently recoverable", async () => {
  for (const checkpoint of ["after_recovery_config", "after_recovery_registry"] as const) {
    const value = fixture();
    await crashWorker(value, "apply", "after_commit_intent");
    await crashWorker(value, "recover", checkpoint);
    await recoverControlPlaneTransactions(value.configPath);
    requireResults(value);
    assert.equal(journal(value).phase, "COMMITTED");
  }
});

test("stale or unknown target bytes fail closed before and after COMMIT_INTENT", async () => {
  const stale = fixture();
  await assert.rejects(applyControlPlaneTransaction(stale.input, {
    checkpoint: (value) => {
      if (value === "after_prepared") writeFileSync(stale.registryPath, "stale\n");
    }
  }));
  assert.equal(journal(stale).phase, "PREPARED");
  assert.deepEqual(readFileSync(stale.configPath), stale.configPreimage);
  assert.equal(readFileSync(stale.registryPath, "utf8"), "stale\n");
  await assert.rejects(recoverControlPlaneTransactions(stale.configPath));

  const unknown = fixture();
  await assert.rejects(applyControlPlaneTransaction(unknown.input, {
    checkpoint: (value) => {
      if (value === "after_commit_intent") throw new Error("stop");
    }
  }));
  writeFileSync(unknown.configPath, "unknown\n");
  await assert.rejects(recoverControlPlaneTransactions(unknown.configPath));
  assert.equal(readFileSync(unknown.configPath, "utf8"), "unknown\n");
  assert.deepEqual(readFileSync(unknown.registryPath), unknown.registryPreimage);
});

test("payload, journal, path evidence, schema, and missing recovery material are rejected", async () => {
  for (const corruption of [
    "payload", "payload-symlink", "journal", "journal-version", "journal-path", "missing"
  ] as const) {
    const value = fixture();
    await assert.rejects(applyControlPlaneTransaction(value.input, {
      checkpoint: (checkpoint) => {
        if (checkpoint === "after_prepared") throw new Error("stop");
      }
    }));
    if (corruption === "payload") {
      writeFileSync(join(transactionDirectory(value), "config.result"), "corrupt\n");
    } else if (corruption === "payload-symlink") {
      const payload = join(transactionDirectory(value), "config.result");
      const outside = join(value.root, "outside-payload");
      writeFileSync(outside, value.configResult, { mode: 0o600 });
      unlinkSync(payload);
      symlinkSync(outside, payload);
    } else if (corruption === "journal") {
      writeFileSync(join(transactionDirectory(value), "journal.json"), "not json\n");
    } else if (corruption === "journal-version" || corruption === "journal-path") {
      const path = join(transactionDirectory(value), "journal.json");
      const retained = JSON.parse(readFileSync(path, "utf8")) as {
        version: number;
        targets: { config: { path: string } };
      };
      if (corruption === "journal-version") retained.version = 2;
      else retained.targets.config.path = join(value.root, "outside-target");
      writeFileSync(path, `${JSON.stringify(retained, null, 2)}\n`);
    } else {
      unlinkSync(join(transactionDirectory(value), "registry.result"));
    }
    await assert.rejects(recoverControlPlaneTransactions(value.configPath));
    requirePreimages(value);
  }
});

test("file fsync, directory fsync, and rename failures leave a recoverable commit intent", async () => {
  const cases: Array<{
    operation: ControlPlaneTransactionOperation;
    matches: (path: string, value: Fixture) => boolean;
  }> = [
    { operation: "file_fsync", matches: (path, value) => path === value.configPath },
    { operation: "directory_fsync", matches: (path, value) => path === dirname(value.configPath) },
    { operation: "rename", matches: (path, value) => path === value.configPath }
  ];
  for (const item of cases) {
    const value = fixture();
    let failed = false;
    await assert.rejects(applyControlPlaneTransaction(value.input, {
      operation: (operation, path) => {
        if (!failed && operation === item.operation && item.matches(path, value)) {
          failed = true;
          throw new Error("injected durable operation failure");
        }
      }
    }));
    assert.equal(failed, true);
    assert.equal(journal(value).phase, "COMMIT_INTENT");
    await recoverControlPlaneTransactions(value.configPath);
    requireResults(value);
  }
});

test("multiple incomplete transactions fail closed without selecting one", async () => {
  const value = fixture("transaction-one");
  await assert.rejects(applyControlPlaneTransaction(value.input, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_prepared") throw new Error("stop");
    }
  }));
  const second = { ...value.input, proposalId: "transaction-two" };
  await assert.rejects(applyControlPlaneTransaction(second, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_prepared") throw new Error("stop");
    }
  }));
  await assert.rejects(recoverControlPlaneTransactions(value.configPath));
  requirePreimages(value);
});

test("trusted target and transaction paths reject symlink and hardlink ambiguity", async () => {
  const target = fixture();
  const outsideTarget = join(target.root, "outside-config");
  writeFileSync(outsideTarget, target.configPreimage, { mode: 0o600 });
  unlinkSync(target.configPath);
  symlinkSync(outsideTarget, target.configPath);
  await assert.rejects(applyControlPlaneTransaction(target.input));
  assert.deepEqual(readFileSync(outsideTarget), target.configPreimage);

  const transaction = fixture();
  const outsideDirectory = realpathSync(mkdtempSync(join(tmpdir(), "bridge-transaction-outside-")));
  symlinkSync(outsideDirectory, join(transaction.root, "state", "control-plane-transactions"));
  await assert.rejects(applyControlPlaneTransaction(transaction.input));
  requirePreimages(transaction);

  const parent = fixture();
  const outsideParent = realpathSync(mkdtempSync(join(tmpdir(), "bridge-config-outside-")));
  const originalConfig = readFileSync(parent.configPath);
  unlinkSync(parent.configPath);
  rmdirSync(dirname(parent.configPath));
  writeFileSync(join(outsideParent, "workspaces.json"), originalConfig, { mode: 0o600 });
  symlinkSync(outsideParent, dirname(parent.configPath));
  await assert.rejects(applyControlPlaneTransaction(parent.input));
  assert.deepEqual(readFileSync(join(outsideParent, "workspaces.json")), originalConfig);

  const stack = fixture();
  const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), "bridge-stack-alias-")));
  const aliasRoot = join(aliasParent, "stack");
  symlinkSync(stack.root, aliasRoot);
  await assert.rejects(applyControlPlaneTransaction({
    ...stack.input,
    configPath: join(aliasRoot, "config", "workspaces.json")
  }));
  requirePreimages(stack);

  const hardlink = fixture();
  linkSync(hardlink.configPath, join(hardlink.root, "config-hardlink"));
  await assert.rejects(applyControlPlaneTransaction(hardlink.input));
  requirePreimages(hardlink);
});

test("missing target directories or files are never created by the transaction protocol", async () => {
  const missingFile = fixture();
  unlinkSync(missingFile.configPath);
  await assert.rejects(applyControlPlaneTransaction(missingFile.input));
  assert.equal(existsSync(missingFile.configPath), false);
  assert.equal(existsSync(join(missingFile.root, "state", "control-plane-transactions")), false);

  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-missing-control-plane-")));
  const missingDirectories = {
    ...missingFile.input,
    configPath: join(root, "config", "workspaces.json"),
    proposalId: "missing-control-plane-directories"
  };
  await assert.rejects(applyControlPlaneTransaction(missingDirectories));
  assert.equal(existsSync(join(root, "config")), false);
  assert.equal(existsSync(join(root, "state")), false);
});

test("target mode and owner policy is validated and preserved", async () => {
  const invalid = fixture();
  chmodSync(invalid.configPath, 0o644);
  await assert.rejects(applyControlPlaneTransaction(invalid.input));
  assert.deepEqual(readFileSync(invalid.registryPath), invalid.registryPreimage);

  const unsafeParent = fixture();
  chmodSync(dirname(unsafeParent.configPath), 0o777);
  await assert.rejects(applyControlPlaneTransaction(unsafeParent.input));
  requirePreimages(unsafeParent);

  const valid = fixture();
  const uid = lstatSync(valid.configPath).uid;
  await applyControlPlaneTransaction(valid.input);
  requireResults(valid);
  assert.equal(lstatSync(valid.configPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(valid.registryPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(valid.configPath).uid, uid);
  assert.equal(lstatSync(valid.registryPath).uid, uid);
});

test("a crash before staging publication leaves no discoverable transaction", async () => {
  const value = fixture("transaction-staging-window");
  await assert.rejects(applyControlPlaneTransaction(value.input, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_staged_journal") throw new Error("crash before publication");
    }
  }));
  assert.equal(existsSync(transactionDirectory(value)), false);
  await recoverControlPlaneTransactions(value.configPath);
  requirePreimages(value);
});

test("a committed transaction can be followed by a config-only transaction", async () => {
  const value = fixture("transaction-baseline");
  await applyControlPlaneTransaction(value.input);
  const configResult = Buffer.from('{"generation":"config-follow-up"}\n');
  const followUp: ControlPlaneTransactionInput = {
    ...value.input,
    proposalId: "transaction-config-follow-up",
    configPreimageSha256: hash(value.configResult),
    configResultSha256: hash(configResult),
    configResult,
    registryPreimageSha256: hash(value.registryResult),
    registryResultSha256: hash(value.registryResult),
    registryResult: value.registryResult
  };
  await applyControlPlaneTransaction(followUp);
  await recoverControlPlaneTransactions(value.configPath);
  assert.deepEqual(readFileSync(value.configPath), configResult);
  assert.deepEqual(readFileSync(value.registryPath), value.registryResult);
  assert.equal(journal(value).phase, "COMMITTED");
  assert.equal(journal({ ...value, input: followUp }).phase, "COMMITTED");
});

test("an aborted terminal can be followed from its preimage without blocking recovery", async () => {
  const value = fixture("transaction-aborted-baseline");
  await assert.rejects(applyControlPlaneTransaction(value.input, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_prepared") throw new Error("stop before commit");
    }
  }));
  await recoverControlPlaneTransactions(value.configPath);
  assert.equal(journal(value).phase, "ABORTED");
  const configResult = Buffer.from('{"generation":"config-after-abort"}\n');
  const followUp: ControlPlaneTransactionInput = {
    ...value.input,
    proposalId: "transaction-after-abort",
    configPreimageSha256: hash(value.configPreimage),
    configResultSha256: hash(configResult),
    configResult,
    registryPreimageSha256: hash(value.registryPreimage),
    registryResultSha256: hash(value.registryPreimage),
    registryResult: value.registryPreimage
  };
  await applyControlPlaneTransaction(followUp);
  await recoverControlPlaneTransactions(value.configPath);
  assert.deepEqual(readFileSync(value.configPath), configResult);
  assert.deepEqual(readFileSync(value.registryPath), value.registryPreimage);
  assert.equal(journal(value).phase, "ABORTED");
  assert.equal(journal({ ...value, input: followUp }).phase, "COMMITTED");
});

test("recovery follows an incomplete successor and then preserves the old audit journal", async () => {
  const value = fixture("transaction-recovery-baseline");
  await applyControlPlaneTransaction(value.input);
  const configResult = Buffer.from('{"generation":"config-recovered-follow-up"}\n');
  const followUp: ControlPlaneTransactionInput = {
    ...value.input,
    proposalId: "transaction-recovery-follow-up",
    configPreimageSha256: hash(value.configResult),
    configResultSha256: hash(configResult),
    configResult,
    registryPreimageSha256: hash(value.registryResult),
    registryResultSha256: hash(value.registryResult),
    registryResult: value.registryResult
  };
  await assert.rejects(applyControlPlaneTransaction(followUp, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_commit_intent") throw new Error("simulated restart");
    }
  }));
  await recoverControlPlaneTransactions(value.configPath);
  assert.deepEqual(readFileSync(value.configPath), configResult);
  assert.deepEqual(readFileSync(value.registryPath), value.registryResult);
  assert.equal(journal(value).phase, "COMMITTED");
  assert.equal(journal({ ...value, input: followUp }).phase, "COMMITTED");
});

test("a registry-only writer transaction is recoverable after a crash at commit intent", async () => {
  const value = fixture("transaction-registry-recovery-baseline");
  await applyControlPlaneTransaction(value.input);
  const registryResult = Buffer.from('{"generation":"registry-recovered-follow-up"}\n');
  const followUp: ControlPlaneTransactionInput = {
    ...value.input,
    proposalId: "transaction-registry-recovery-follow-up",
    configPreimageSha256: hash(value.configResult),
    configResultSha256: hash(value.configResult),
    configResult: value.configResult,
    registryPreimageSha256: hash(value.registryResult),
    registryResultSha256: hash(registryResult),
    registryResult
  };
  await assert.rejects(applyControlPlaneTransaction(followUp, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_commit_intent") throw new Error("simulated restart");
    }
  }));
  await recoverControlPlaneTransactions(value.configPath);
  assert.deepEqual(readFileSync(value.configPath), value.configResult);
  assert.deepEqual(readFileSync(value.registryPath), registryResult);
  assert.equal(journal(value).phase, "COMMITTED");
  assert.equal(journal({ ...value, input: followUp }).phase, "COMMITTED");
});

test("the registry writer records a durable successor for routine mutable state", async () => {
  const value = fixture("transaction-registry-baseline");
  await applyControlPlaneTransaction(value.input);
  const registryResult = Buffer.from('{"generation":"registry-writer-result"}\n');
  await applyControlPlaneRegistryWrite(join(value.root, "state"), registryResult, async () => {
    throw new Error("bootstrap path should not be used when registry exists");
  });
  await recoverControlPlaneTransactions(value.configPath);
  assert.deepEqual(readFileSync(value.configPath), value.configResult);
  assert.deepEqual(readFileSync(value.registryPath), registryResult);
  const history = readdirSync(join(value.root, "state", "control-plane-transactions"));
  assert.equal(history.some((entry) => entry.startsWith("registry-writer-")), true);
});

test("a registry writer successor still fails closed when its current bytes are tampered", async () => {
  const value = fixture("transaction-registry-tamper-baseline");
  await applyControlPlaneTransaction(value.input);
  const registryResult = Buffer.from('{"generation":"registry-writer-tamper-result"}\n');
  await applyControlPlaneRegistryWrite(join(value.root, "state"), registryResult, async () => {
    throw new Error("bootstrap path should not be used when registry exists");
  });
  writeFileSync(value.registryPath, "tampered\n");
  await assert.rejects(recoverControlPlaneTransactions(value.configPath));
});

test("an explicit registry catch-up journals an already authorized external advance", async () => {
  const value = fixture("transaction-catch-up-baseline");
  await applyControlPlaneTransaction(value.input);
  const registryResult = Buffer.from('{"generation":"registry-catch-up-result"}\n');
  writeFileSync(value.registryPath, registryResult);
  await recordControlPlaneRegistryCatchUp({
    configPath: value.configPath,
    proposalId: "transaction-registry-catch-up",
    predecessorProposalId: value.input.proposalId,
    registryPreimageSha256: hash(value.registryResult),
    registryResultSha256: hash(registryResult),
    registryResult
  });
  await recoverControlPlaneTransactions(value.configPath);
  assert.deepEqual(readFileSync(value.configPath), value.configResult);
  assert.deepEqual(readFileSync(value.registryPath), registryResult);
  assert.equal(journal(value).phase, "COMMITTED");
  assert.equal(journal({ ...value, input: {
    ...value.input,
    proposalId: "transaction-registry-catch-up"
  }}).phase, "COMMITTED");
});

test("recovery publishes a complete staged transaction named by a stale lock", async () => {
  const value = fixture("transaction-staged-catch-up");
  await applyControlPlaneTransaction(value.input);
  const registryResult = Buffer.from('{"generation":"registry-staged-catch-up-result"}\n');
  writeFileSync(value.registryPath, registryResult);
  await assert.rejects(recordControlPlaneRegistryCatchUp({
    configPath: value.configPath,
    proposalId: "transaction-staged-catch-up-successor",
    predecessorProposalId: value.input.proposalId,
    registryPreimageSha256: hash(value.registryResult),
    registryResultSha256: hash(registryResult),
    registryResult
  }, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_staged_journal") throw new Error("crash before staged publication");
    }
  }));
  assert.equal(existsSync(join(value.root, "state", "control-plane-transactions", ".writer-lock")), false);
  const stagingRoot = join(value.root, "state", ".control-plane-transaction-staging");
  const [stagingEntry] = readdirSync(stagingRoot);
  assert.notEqual(stagingEntry, undefined);
  const stagedJournalPath = join(stagingRoot, stagingEntry!, "journal.json");
  const stagedJournal = JSON.parse(readFileSync(stagedJournalPath, "utf8")) as {
    token: string;
    proposal_id: string;
  };
  const lockDirectory = join(value.root, "state", "control-plane-transactions", ".writer-lock");
  mkdirSync(lockDirectory, { mode: 0o700 });
  writeFileSync(join(lockDirectory, "owner.json"), `${JSON.stringify({
    version: 1,
    kind: "transaction",
    token: stagedJournal.token,
    proposal_id: stagedJournal.proposal_id,
    pid: 999999999
  })}\n`, { mode: 0o600 });
  await recoverControlPlaneTransactions(value.configPath);
  assert.deepEqual(readFileSync(value.registryPath), registryResult);
  assert.equal(journal({ ...value, input: {
    ...value.input,
    proposalId: stagedJournal.proposal_id
  }}).phase, "COMMITTED");
});

test("SIGKILL after catch-up lock acquisition recovers the already staged audit record", async () => {
  const value = fixture("transaction-catch-up-killed-lock");
  await applyControlPlaneTransaction(value.input);
  const registryResult = Buffer.from('{"generation":"catch-up-after-kill"}\n');
  writeFileSync(value.registryPath, registryResult);
  const marker = join(value.root, "catch-up-lock.marker");
  const moduleUrl = new URL("../../../src/workspaces/control-plane-transaction.js", import.meta.url).href;
  const args = { configPath: value.configPath, proposalId: "catch-up-killed-successor",
    predecessorProposalId: value.input.proposalId, registryPreimageSha256: hash(value.registryResult),
    registryResultSha256: hash(registryResult) };
  const code = `import {writeFileSync} from "node:fs";
    import {recordControlPlaneRegistryCatchUp} from ${JSON.stringify(moduleUrl)};
    await recordControlPlaneRegistryCatchUp({...${JSON.stringify(args)},
      registryResult:Buffer.from(${JSON.stringify(registryResult.toString("base64"))},"base64")}, {
      checkpoint: async checkpoint => {if(checkpoint === "after_catch_up_lock") {
        writeFileSync(${JSON.stringify(marker)},"ready");
        await new Promise(() => {setInterval(() => {},1000)});
      }}
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
  try {
    await waitForFile(marker, child);
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    await exited;
    await recoverControlPlaneTransactions(value.configPath);
    assert.deepEqual(readFileSync(value.registryPath), registryResult);
    assert.deepEqual(readFileSync(value.configPath), value.configResult);
    assert.equal(existsSync(join(value.root, "state", "control-plane-transactions", ".writer-lock")), false);
    assert.equal(journal({...value, input:{...value.input, proposalId:args.proposalId}}).phase, "COMMITTED");
  } finally { child.kill("SIGKILL"); }
});

test("a dead bootstrap registry-writer lock is recoverable only with no history", async () => {
  const value = fixture("transaction-bootstrap-lock");
  unlinkSync(value.registryPath);
  const transactionRoot = join(value.root, "state", "control-plane-transactions");
  mkdirSync(transactionRoot, { mode: 0o700 });
  const lockDirectory = join(transactionRoot, ".writer-lock");
  mkdirSync(lockDirectory, { mode: 0o700 });
  writeFileSync(join(lockDirectory, "owner.json"), `${JSON.stringify({
    version: 1,
    kind: "registry-writer",
    token: randomUUID(),
    pid: 999999999
  })}\n`, { mode: 0o600 });
  await recoverControlPlaneTransactions(value.configPath);
  assert.equal(existsSync(lockDirectory), false);
});

test("missing registry bytes are not treated as bootstrap once transaction history exists", async () => {
  const value = fixture("transaction-missing-historical-registry");
  await applyControlPlaneTransaction(value.input);
  unlinkSync(value.registryPath);
  let bootstrapCalled = false;
  await assert.rejects(applyControlPlaneRegistryWrite(
    join(value.root, "state"),
    Buffer.from('{"generation":"must-not-write"}\n'),
    async () => { bootstrapCalled = true; }
  ));
  assert.equal(bootstrapCalled, false);
});

test("registry writes reject an incomplete transaction before touching the target", async () => {
  const value = fixture("transaction-registry-incomplete-guard");
  await assert.rejects(applyControlPlaneTransaction(value.input, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_prepared") throw new Error("leave incomplete");
    }
  }));
  await assert.rejects(applyControlPlaneRegistryWrite(
    join(value.root, "state"),
    Buffer.from('{"generation":"must-not-write"}\n'),
    async () => { throw new Error("bootstrap callback must not run"); }
  ));
  requirePreimages(value);
});

test("terminal COMMITTED and ABORTED journals require their exact terminal generations", async () => {
  const committed = fixture();
  await applyControlPlaneTransaction(committed.input);
  writeFileSync(committed.configPath, committed.configPreimage);
  await assert.rejects(recoverControlPlaneTransactions(committed.configPath));
  assert.deepEqual(readFileSync(committed.configPath), committed.configPreimage);
  assert.deepEqual(readFileSync(committed.registryPath), committed.registryResult);

  const aborted = fixture();
  await assert.rejects(applyControlPlaneTransaction(aborted.input, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_prepared") throw new Error("stop");
    }
  }));
  await recoverControlPlaneTransactions(aborted.configPath);
  assert.equal(journal(aborted).phase, "ABORTED");
  writeFileSync(aborted.registryPath, aborted.registryResult);
  await assert.rejects(recoverControlPlaneTransactions(aborted.configPath));
  assert.deepEqual(readFileSync(aborted.configPath), aborted.configPreimage);
  assert.deepEqual(readFileSync(aborted.registryPath), aborted.registryResult);
});

test("the transaction lock excludes the live registry writer", async () => {
  const value = fixture();
  let reached!: () => void;
  let continueApply!: () => void;
  const atIntent = new Promise<void>((resolve) => { reached = resolve; });
  const resume = new Promise<void>((resolve) => { continueApply = resolve; });
  const applying = applyControlPlaneTransaction(value.input, {
    checkpoint: async (checkpoint) => {
      if (checkpoint !== "after_commit_intent") return;
      reached();
      await resume;
    }
  });
  await atIntent;
  await assert.rejects(withControlPlaneRegistryWriteLock(join(value.root, "state"), async () => undefined));
  continueApply();
  await applying;
  requireResults(value);
});

test("runtime and migration leases are mutually exclusive and release cleanly", async () => {
  const runtime = fixture();
  const releaseRuntime = await acquireControlPlaneRuntimeLease(runtime.configPath, "runtime");
  await assert.rejects(acquireControlPlaneRuntimeLease(runtime.configPath, "migration"));
  await releaseRuntime();
  const releaseMigration = await acquireControlPlaneRuntimeLease(runtime.configPath, "migration");
  await assert.rejects(acquireControlPlaneRuntimeLease(runtime.configPath, "runtime"));
  await releaseMigration();
  assert.equal(existsSync(join(runtime.root, "state", "control-plane-transactions", ".runtime-lease.json")), false);
});
