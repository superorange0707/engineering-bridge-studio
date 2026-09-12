import { readFile, writeFile } from "node:fs/promises";

import {
  applyControlPlaneTransaction,
  recoverControlPlaneTransactions
} from "../../src/workspaces/control-plane-transaction.js";
import type {
  ControlPlaneTransactionCheckpoint,
  ControlPlaneTransactionInput
} from "../../src/workspaces/control-plane-transaction.js";

interface SerializedInput extends Omit<ControlPlaneTransactionInput, "configResult" | "registryResult"> {
  readonly configResultBase64: string;
  readonly registryResultBase64: string;
}

const [action, descriptorPath, stopAt, markerPath] = process.argv.slice(2);
if ((action !== "apply" && action !== "recover") || descriptorPath === undefined ||
    stopAt === undefined || markerPath === undefined) throw new Error("invalid worker arguments");

const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as SerializedInput;
const input: ControlPlaneTransactionInput = {
  configPath: descriptor.configPath,
  proposalId: descriptor.proposalId,
  configPreimageSha256: descriptor.configPreimageSha256,
  configResultSha256: descriptor.configResultSha256,
  configResult: Buffer.from(descriptor.configResultBase64, "base64"),
  registryPreimageSha256: descriptor.registryPreimageSha256,
  registryResultSha256: descriptor.registryResultSha256,
  registryResult: Buffer.from(descriptor.registryResultBase64, "base64")
};
const checkpoint = async (value: ControlPlaneTransactionCheckpoint) => {
  if (value !== stopAt) return;
  await writeFile(markerPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  process.kill(process.pid, "SIGSTOP");
};

if (action === "apply") {
  await applyControlPlaneTransaction(input, { checkpoint });
} else {
  await recoverControlPlaneTransactions(input.configPath, { checkpoint });
}
