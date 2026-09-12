import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { CoreError } from "../core/errors.js";

const TRANSACTION_VERSION = 1;
const TRANSACTION_ROOT_NAME = "control-plane-transactions";
const STAGING_ROOT_NAME = ".control-plane-transaction-staging";
const STAGING_DIRECTORY_PREFIX = "transaction-";
const LOCK_NAME = ".writer-lock";
const RUNTIME_LEASE_NAME = ".runtime-lease.json";
const JOURNAL_NAME = "journal.json";
const OWNER_NAME = "owner.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PROPOSAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/;

export type ControlPlaneTransactionPhase = "PREPARED" | "COMMIT_INTENT" | "COMMITTED" | "ABORTED";

export type ControlPlaneTransactionCheckpoint =
  | "before_journal"
  | "after_staged_journal"
  | "after_catch_up_lock"
  | "after_prepared"
  | "after_commit_intent"
  | "after_config_replace"
  | "after_registry_replace"
  | "before_committed"
  | "after_committed"
  | "after_recovery_config"
  | "after_recovery_registry";

export type ControlPlaneTransactionOperation = "file_fsync" | "directory_fsync" | "rename";

export interface ControlPlaneTransactionTestHooks {
  readonly checkpoint?: (checkpoint: ControlPlaneTransactionCheckpoint) => void | Promise<void>;
  readonly operation?: (operation: ControlPlaneTransactionOperation, path: string) => void | Promise<void>;
}

export interface ControlPlaneTransactionInput {
  readonly configPath: string;
  readonly proposalId: string;
  readonly configPreimageSha256: string;
  readonly configResultSha256: string;
  readonly configResult: Buffer;
  readonly registryPreimageSha256: string;
  readonly registryResultSha256: string;
  readonly registryResult: Buffer;
}

interface TrustedTargets {
  readonly stackRoot: string;
  readonly configDirectory: string;
  readonly stateDirectory: string;
  readonly transactionRoot: string;
  readonly configPath: string;
  readonly registryPath: string;
  readonly ownerUid: number;
}

interface TargetEvidence {
  readonly path: string;
  readonly preimage_sha256: string;
  readonly result_sha256: string;
  readonly mode: number;
  readonly owner_uid: number;
}

interface TransactionJournal {
  readonly version: 1;
  readonly proposal_id: string;
  readonly token: string;
  readonly phase: ControlPlaneTransactionPhase;
  readonly trusted_stack_root: string;
  readonly targets: {
    readonly config: TargetEvidence;
    readonly registry: TargetEvidence;
  };
}

interface LockOwner {
  readonly version: 1;
  readonly kind: "transaction" | "recovery" | "registry-writer" | "runtime" | "migration";
  readonly token: string;
  readonly proposal_id?: string | undefined;
  readonly pid: number;
}

interface PreparedTransaction {
  readonly directory: string;
  readonly journalPath: string;
  readonly journal: TransactionJournal;
}

interface StagedTransaction {
  readonly stagingRoot: string;
  readonly stagingDirectory: string;
  readonly publicationDirectory: string;
  readonly transaction: PreparedTransaction;
}

type TargetGeneration = "pre" | "result" | "same";

function fail(): never {
  throw new CoreError("INTERNAL_ERROR");
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) fail();
  return uid;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is ControlPlaneTransactionPhase {
  return value === "PREPARED" || value === "COMMIT_INTENT" || value === "COMMITTED" || value === "ABORTED";
}

function isSecureMode(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

async function checkpoint(hooks: ControlPlaneTransactionTestHooks | undefined, value: ControlPlaneTransactionCheckpoint) {
  await hooks?.checkpoint?.(value);
}

async function operation(
  hooks: ControlPlaneTransactionTestHooks | undefined,
  value: ControlPlaneTransactionOperation,
  path: string
) {
  await hooks?.operation?.(value, path);
}

async function requireCanonicalDirectory(path: string, ownerUid: number, exactMode?: number): Promise<void> {
  const metadata = await lstat(path).catch(() => fail());
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== ownerUid) fail();
  const mode = metadata.mode & 0o777;
  if ((exactMode !== undefined && mode !== exactMode) || (mode & 0o022) !== 0) fail();
  if (await realpath(path).catch(() => fail()) !== path) fail();
}

async function requireSecureFile(path: string, ownerUid: number, expectedMode = FILE_MODE): Promise<void> {
  const metadata = await lstat(path).catch(() => fail());
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== ownerUid ||
      metadata.nlink !== 1 || !isSecureMode(metadata.mode, expectedMode)) fail();
  if (await realpath(path).catch(() => fail()) !== path) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail());
  try {
    const opened = await handle.stat().catch(() => fail());
    if (!opened.isFile() || opened.uid !== ownerUid || opened.nlink !== 1 ||
        !isSecureMode(opened.mode, expectedMode)) fail();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function resolveTrustedTargets(configPath: string): Promise<TrustedTargets> {
  if (!isAbsolute(configPath) || normalize(configPath) !== configPath) fail();
  const configDirectory = dirname(configPath);
  const stackRoot = resolve(configDirectory, "..");
  const stateDirectory = join(stackRoot, "state");
  const registryPath = join(stateDirectory, "workspace-registry.json");
  if (configPath !== join(stackRoot, "config", "workspaces.json")) fail();
  const ownerUid = currentUid();
  await requireCanonicalDirectory(stackRoot, ownerUid);
  await requireCanonicalDirectory(configDirectory, ownerUid);
  await requireCanonicalDirectory(stateDirectory, ownerUid);
  await requireSecureFile(configPath, ownerUid);
  await requireSecureFile(registryPath, ownerUid);
  return {
    stackRoot,
    configDirectory,
    stateDirectory,
    transactionRoot: join(stateDirectory, TRANSACTION_ROOT_NAME),
    configPath,
    registryPath,
    ownerUid
  };
}

async function resolveRecoveryTargets(configPath: string): Promise<TrustedTargets> {
  if (!isAbsolute(configPath) || normalize(configPath) !== configPath) fail();
  const configDirectory = dirname(configPath);
  const stackRoot = resolve(configDirectory, "..");
  const stateDirectory = join(stackRoot, "state");
  const registryPath = join(stateDirectory, "workspace-registry.json");
  if (configPath !== join(stackRoot, "config", "workspaces.json")) fail();
  const ownerUid = currentUid();
  await requireCanonicalDirectory(stackRoot, ownerUid);
  await requireCanonicalDirectory(configDirectory, ownerUid);
  await requireCanonicalDirectory(stateDirectory, ownerUid);
  await requireSecureFile(configPath, ownerUid);
  const registryExists = await lstat(registryPath).then(() => true, (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail();
  });
  if (registryExists) await requireSecureFile(registryPath, ownerUid);
  return {
    stackRoot,
    configDirectory,
    stateDirectory,
    transactionRoot: join(stateDirectory, TRANSACTION_ROOT_NAME),
    configPath,
    registryPath,
    ownerUid
  };
}

async function syncDirectory(path: string, hooks?: ControlPlaneTransactionTestHooks): Promise<void> {
  await operation(hooks, "directory_fsync", path);
  const handle = await open(path, "r").catch(() => fail());
  try {
    await handle.sync().catch(() => fail());
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensureTransactionRoot(targets: TrustedTargets, hooks?: ControlPlaneTransactionTestHooks): Promise<void> {
  try {
    await requireCanonicalDirectory(targets.transactionRoot, targets.ownerUid, DIRECTORY_MODE);
    return;
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
  }
  try {
    await mkdir(targets.transactionRoot, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail();
  }
  await requireCanonicalDirectory(targets.transactionRoot, targets.ownerUid, DIRECTORY_MODE);
  await syncDirectory(targets.stateDirectory, hooks);
}

async function ensureStagingRoot(targets: TrustedTargets, hooks?: ControlPlaneTransactionTestHooks): Promise<string> {
  const stagingRoot = join(targets.stateDirectory, STAGING_ROOT_NAME);
  try {
    await requireCanonicalDirectory(stagingRoot, targets.ownerUid, DIRECTORY_MODE);
    return stagingRoot;
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
  }
  try {
    await mkdir(stagingRoot, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail();
  }
  await requireCanonicalDirectory(stagingRoot, targets.ownerUid, DIRECTORY_MODE);
  await syncDirectory(targets.stateDirectory, hooks);
  return stagingRoot;
}

async function publishStagedTransaction(
  stagingDirectory: string,
  publicationDirectory: string,
  stagingRoot: string,
  targets: TrustedTargets,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<void> {
  await operation(hooks, "rename", publicationDirectory);
  await rename(stagingDirectory, publicationDirectory).catch(() => fail());
  await syncDirectory(stagingRoot, hooks);
  await syncDirectory(targets.transactionRoot, hooks);
  await requireCanonicalDirectory(publicationDirectory, targets.ownerUid, DIRECTORY_MODE);
}

async function durableReplace(
  target: string,
  contents: Buffer,
  directory: string,
  ownerUid: number,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<void> {
  await requireCanonicalDirectory(directory, ownerUid);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", FILE_MODE).catch(() => fail());
  let renamed = false;
  try {
    await handle.writeFile(contents).catch(() => fail());
    await operation(hooks, "file_fsync", target);
    await handle.sync().catch(() => fail());
    await handle.close().catch(() => fail());
    await operation(hooks, "rename", target);
    await rename(temporary, target).catch(() => fail());
    renamed = true;
    await syncDirectory(directory, hooks);
    await requireSecureFile(target, ownerUid);
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

async function readBoundedSecureFile(
  path: string,
  ownerUid: number,
  maximumBytes: number,
  expectedMode = FILE_MODE
): Promise<Buffer> {
  if (await realpath(path).catch(() => fail()) !== path) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail());
  try {
    const metadata = await handle.stat().catch(() => fail());
    if (!metadata.isFile() || metadata.uid !== ownerUid || metadata.nlink !== 1 ||
        !isSecureMode(metadata.mode, expectedMode) || metadata.size > maximumBytes) fail();
    const contents = await handle.readFile().catch(() => fail());
    if (contents.length !== metadata.size) fail();
    return contents;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseTargetEvidence(value: unknown, expectedPath: string, ownerUid: number): TargetEvidence {
  if (!isObject(value) || !exactKeys(value,
    ["path", "preimage_sha256", "result_sha256", "mode", "owner_uid"])) fail();
  if (value.path !== expectedPath || typeof value.preimage_sha256 !== "string" ||
      !HASH_PATTERN.test(value.preimage_sha256) || typeof value.result_sha256 !== "string" ||
      !HASH_PATTERN.test(value.result_sha256) || value.mode !== FILE_MODE || value.owner_uid !== ownerUid) fail();
  return {
    path: expectedPath,
    preimage_sha256: value.preimage_sha256,
    result_sha256: value.result_sha256,
    mode: FILE_MODE,
    owner_uid: ownerUid
  };
}

function parseJournal(value: unknown, targets: TrustedTargets): TransactionJournal {
  if (!isObject(value) || !exactKeys(value,
    ["version", "proposal_id", "token", "phase", "trusted_stack_root", "targets"])) fail();
  if (value.version !== TRANSACTION_VERSION || typeof value.proposal_id !== "string" ||
      !PROPOSAL_PATTERN.test(value.proposal_id) || typeof value.token !== "string" ||
      !TOKEN_PATTERN.test(value.token) || !isPhase(value.phase) || value.trusted_stack_root !== targets.stackRoot ||
      !isObject(value.targets) || !exactKeys(value.targets, ["config", "registry"])) fail();
  return {
    version: TRANSACTION_VERSION,
    proposal_id: value.proposal_id,
    token: value.token,
    phase: value.phase,
    trusted_stack_root: targets.stackRoot,
    targets: {
      config: parseTargetEvidence(value.targets.config, targets.configPath, targets.ownerUid),
      registry: parseTargetEvidence(value.targets.registry, targets.registryPath, targets.ownerUid)
    }
  };
}

function parseLockOwner(value: unknown): LockOwner {
  if (!isObject(value)) fail();
  const hasProposal = value.proposal_id !== undefined;
  if (!exactKeys(value, hasProposal
    ? ["version", "kind", "token", "proposal_id", "pid"]
    : ["version", "kind", "token", "pid"])) fail();
  if (value.version !== 1 || (value.kind !== "transaction" && value.kind !== "recovery" &&
      value.kind !== "registry-writer" && value.kind !== "runtime" && value.kind !== "migration") ||
      typeof value.token !== "string" ||
      !TOKEN_PATTERN.test(value.token) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
      (hasProposal && (typeof value.proposal_id !== "string" || !PROPOSAL_PATTERN.test(value.proposal_id))) ||
      ((value.kind === "runtime" || value.kind === "migration" || value.kind === "registry-writer") && hasProposal)) fail();
  return {
    version: 1,
    kind: value.kind,
    token: value.token,
    ...(hasProposal ? { proposal_id: value.proposal_id as string } : {}),
    pid: value.pid as number
  };
}

async function writeJson(
  target: string,
  value: unknown,
  directory: string,
  ownerUid: number,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<void> {
  await durableReplace(target, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), directory, ownerUid, hooks);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function releaseLock(
  targets: TrustedTargets,
  lockDirectory: string,
  expectedToken: string,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<void> {
  const ownerPath = join(lockDirectory, OWNER_NAME);
  const owner = parseLockOwner(JSON.parse((await readBoundedSecureFile(
    ownerPath, targets.ownerUid, MAX_JOURNAL_BYTES)).toString("utf8")));
  if (owner.token !== expectedToken || owner.pid !== process.pid) fail();
  await unlink(ownerPath).catch(() => fail());
  await syncDirectory(lockDirectory, hooks);
  await rmdir(lockDirectory).catch(() => fail());
  await syncDirectory(targets.transactionRoot, hooks);
}

async function acquireLock(
  targets: TrustedTargets,
  owner: LockOwner,
  recoverableToken?: string,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<() => Promise<void>> {
  await ensureTransactionRoot(targets, hooks);
  const lockDirectory = join(targets.transactionRoot, LOCK_NAME);
  try {
    await mkdir(lockDirectory, { mode: DIRECTORY_MODE });
    await syncDirectory(targets.transactionRoot, hooks);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || recoverableToken === undefined) fail();
    await requireCanonicalDirectory(lockDirectory, targets.ownerUid, DIRECTORY_MODE);
    const staleOwner = parseLockOwner(JSON.parse((await readBoundedSecureFile(
      join(lockDirectory, OWNER_NAME), targets.ownerUid, MAX_JOURNAL_BYTES)).toString("utf8")));
    if (staleOwner.token !== recoverableToken || processIsAlive(staleOwner.pid)) fail();
    await unlink(join(lockDirectory, OWNER_NAME)).catch(() => fail());
    await syncDirectory(lockDirectory, hooks);
    await rmdir(lockDirectory).catch(() => fail());
    await syncDirectory(targets.transactionRoot, hooks);
    await mkdir(lockDirectory, { mode: DIRECTORY_MODE }).catch(() => fail());
    await syncDirectory(targets.transactionRoot, hooks);
  }
  await requireCanonicalDirectory(lockDirectory, targets.ownerUid, DIRECTORY_MODE);
  await writeJson(join(lockDirectory, OWNER_NAME), owner, lockDirectory, targets.ownerUid, hooks);
  return () => releaseLock(targets, lockDirectory, owner.token, hooks);
}

async function targetGeneration(path: string, evidence: TargetEvidence, ownerUid: number): Promise<TargetGeneration> {
  const actual = sha256(await readBoundedSecureFile(path, ownerUid, MAX_PAYLOAD_BYTES));
  const matchesPreimage = actual === evidence.preimage_sha256;
  const matchesResult = actual === evidence.result_sha256;
  if (matchesPreimage && matchesResult) return "same";
  if (matchesPreimage) return "pre";
  if (matchesResult) return "result";
  fail();
}

function isPreGeneration(value: TargetGeneration): boolean {
  return value === "pre" || value === "same";
}

function isResultGeneration(value: TargetGeneration): boolean {
  return value === "result" || value === "same";
}

function payloadPath(transaction: PreparedTransaction, name: "config" | "registry", generation: "pre" | "result") {
  return join(transaction.directory, `${name}.${generation}`);
}

async function validatePayloads(transaction: PreparedTransaction, ownerUid: number): Promise<{
  configResult: Buffer;
  registryResult: Buffer;
}> {
  const readPayload = async (name: "config" | "registry", generation: "pre" | "result") => {
    const contents = await readBoundedSecureFile(payloadPath(transaction, name, generation), ownerUid, MAX_PAYLOAD_BYTES);
    if (sha256(contents) !== transaction.journal.targets[name][`${generation === "pre" ? "preimage" : "result"}_sha256`]) fail();
    return contents;
  };
  await readPayload("config", "pre");
  const configResult = await readPayload("config", "result");
  await readPayload("registry", "pre");
  const registryResult = await readPayload("registry", "result");
  return { configResult, registryResult };
}

async function writeJournal(
  transaction: PreparedTransaction,
  phase: ControlPlaneTransactionPhase,
  targets: TrustedTargets,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<PreparedTransaction> {
  const next = { ...transaction.journal, phase };
  await writeJson(transaction.journalPath, next, transaction.directory, targets.ownerUid, hooks);
  return { ...transaction, journal: next };
}

async function loadTransaction(
  directory: string,
  targets: TrustedTargets,
  published = true
): Promise<PreparedTransaction> {
  await requireCanonicalDirectory(directory, targets.ownerUid, DIRECTORY_MODE);
  const journalPath = join(directory, JOURNAL_NAME);
  const source = await readBoundedSecureFile(journalPath, targets.ownerUid, MAX_JOURNAL_BYTES);
  let value: unknown;
  try { value = JSON.parse(source.toString("utf8")); } catch { fail(); }
  const journal = parseJournal(value, targets);
  if (dirname(journalPath) !== directory ||
      (published && directory !== join(targets.transactionRoot, journal.proposal_id))) fail();
  const transaction = { directory, journalPath, journal };
  await validatePayloads(transaction, targets.ownerUid);
  return transaction;
}

async function loadStagedTransaction(
  directory: string,
  targets: TrustedTargets
): Promise<PreparedTransaction | undefined> {
  try {
    await requireCanonicalDirectory(directory, targets.ownerUid, DIRECTORY_MODE);
  } catch (error) {
    if (error instanceof CoreError) return undefined;
    throw error;
  }
  const journalPath = join(directory, JOURNAL_NAME);
  let source: Buffer;
  try {
    source = await readBoundedSecureFile(journalPath, targets.ownerUid, MAX_JOURNAL_BYTES);
  } catch (error) {
    if (error instanceof CoreError) return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(source.toString("utf8")); } catch { return undefined; }
  let journal: TransactionJournal;
  try {
    journal = parseJournal(value, targets);
  } catch (error) {
    if (error instanceof CoreError) return undefined;
    throw error;
  }
  const transaction = { directory, journalPath, journal };
  await validatePayloads(transaction, targets.ownerUid);
  return transaction;
}

async function findStagedTransactionByToken(
  targets: TrustedTargets,
  token: string
): Promise<{ readonly stagingRoot: string; readonly transaction: PreparedTransaction } | undefined> {
  const stagingRoot = join(targets.stateDirectory, STAGING_ROOT_NAME);
  try {
    await requireCanonicalDirectory(stagingRoot, targets.ownerUid, DIRECTORY_MODE);
  } catch (error) {
    if (error instanceof CoreError) {
      try { await lstat(stagingRoot); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      }
      return undefined;
    }
    throw error;
  }
  const entries = await readdir(stagingRoot, { withFileTypes: true }).catch(() => fail());
  let found: PreparedTransaction | undefined;
  for (const entry of entries) {
    if (!entry.name.startsWith(STAGING_DIRECTORY_PREFIX) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const transaction = await loadStagedTransaction(join(stagingRoot, entry.name), targets);
    if (transaction?.journal.token !== token) continue;
    if (found !== undefined) fail();
    found = transaction;
  }
  return found === undefined ? undefined : { stagingRoot, transaction: found };
}

async function hasStagingEntries(targets: TrustedTargets): Promise<boolean> {
  const stagingRoot = join(targets.stateDirectory, STAGING_ROOT_NAME);
  try {
    await requireCanonicalDirectory(stagingRoot, targets.ownerUid, DIRECTORY_MODE);
  } catch (error) {
    if (error instanceof CoreError) {
      try { await lstat(stagingRoot); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return false;
      }
      return true;
    }
    throw error;
  }
  const entries = await readdir(stagingRoot, { withFileTypes: true }).catch(() => fail());
  return entries.length !== 0;
}

async function hasControlPlaneHistory(stateDirectory: string, ownerUid: number): Promise<boolean> {
  const transactionRoot = join(stateDirectory, TRANSACTION_ROOT_NAME);
  try {
    await requireCanonicalDirectory(transactionRoot, ownerUid, DIRECTORY_MODE);
  } catch (error) {
    if (error instanceof CoreError) {
      try { await lstat(transactionRoot); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") {
          const stagingRoot = join(stateDirectory, STAGING_ROOT_NAME);
          try {
            await requireCanonicalDirectory(stagingRoot, ownerUid, DIRECTORY_MODE);
          } catch (stagingError) {
            if (stagingError instanceof CoreError) {
              try { await lstat(stagingRoot); } catch (stagingMissing) {
                if ((stagingMissing as NodeJS.ErrnoException).code === "ENOENT") return false;
              }
              return true;
            }
            throw stagingError;
          }
          return (await readdir(stagingRoot, { withFileTypes: true }).catch(() => fail())).length !== 0;
        }
      }
      return true;
    }
    throw error;
  }
  const entries = await readdir(transactionRoot, { withFileTypes: true }).catch(() => fail());
  if (entries.some((entry) => entry.name !== LOCK_NAME && entry.name !== RUNTIME_LEASE_NAME)) return true;
  return hasStagingEntries({
    stackRoot: resolve(stateDirectory, ".."),
    configDirectory: join(resolve(stateDirectory, ".."), "config"),
    stateDirectory,
    transactionRoot,
    configPath: join(resolve(stateDirectory, ".."), "config", "workspaces.json"),
    registryPath: join(stateDirectory, "workspace-registry.json"),
    ownerUid
  });
}

async function createTransaction(
  targets: TrustedTargets,
  input: ControlPlaneTransactionInput,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<PreparedTransaction> {
  if (!PROPOSAL_PATTERN.test(input.proposalId) || !HASH_PATTERN.test(input.configPreimageSha256) ||
      !HASH_PATTERN.test(input.configResultSha256) || !HASH_PATTERN.test(input.registryPreimageSha256) ||
      !HASH_PATTERN.test(input.registryResultSha256) || sha256(input.configResult) !== input.configResultSha256 ||
      sha256(input.registryResult) !== input.registryResultSha256 || input.configResult.length > MAX_PAYLOAD_BYTES ||
      input.registryResult.length > MAX_PAYLOAD_BYTES) fail();
  if (!isPreGeneration(await targetGeneration(targets.configPath, {
    path: targets.configPath,
    preimage_sha256: input.configPreimageSha256,
    result_sha256: input.configResultSha256,
    mode: FILE_MODE,
    owner_uid: targets.ownerUid
  }, targets.ownerUid)) || !isPreGeneration(await targetGeneration(targets.registryPath, {
    path: targets.registryPath,
    preimage_sha256: input.registryPreimageSha256,
    result_sha256: input.registryResultSha256,
    mode: FILE_MODE,
    owner_uid: targets.ownerUid
  }, targets.ownerUid))) fail();
  await checkpoint(hooks, "before_journal");
  await ensureTransactionRoot(targets, hooks);
  const stagingRoot = await ensureStagingRoot(targets, hooks);
  const stagingDirectory = join(stagingRoot, `${STAGING_DIRECTORY_PREFIX}${input.proposalId}-${randomUUID()}`);
  const publicationDirectory = join(targets.transactionRoot, input.proposalId);
  await mkdir(stagingDirectory, { mode: DIRECTORY_MODE }).catch(() => fail());
  await requireCanonicalDirectory(stagingDirectory, targets.ownerUid, DIRECTORY_MODE);
  await syncDirectory(stagingRoot, hooks);
  const configPreimage = await readBoundedSecureFile(targets.configPath, targets.ownerUid, MAX_PAYLOAD_BYTES);
  const registryPreimage = await readBoundedSecureFile(targets.registryPath, targets.ownerUid, MAX_PAYLOAD_BYTES);
  if (sha256(configPreimage) !== input.configPreimageSha256 || sha256(registryPreimage) !== input.registryPreimageSha256) fail();
  const token = randomUUID();
  const journal: TransactionJournal = {
    version: TRANSACTION_VERSION,
    proposal_id: input.proposalId,
    token,
    phase: "PREPARED",
    trusted_stack_root: targets.stackRoot,
    targets: {
      config: {
        path: targets.configPath,
        preimage_sha256: input.configPreimageSha256,
        result_sha256: input.configResultSha256,
        mode: FILE_MODE,
        owner_uid: targets.ownerUid
      },
      registry: {
        path: targets.registryPath,
        preimage_sha256: input.registryPreimageSha256,
        result_sha256: input.registryResultSha256,
        mode: FILE_MODE,
        owner_uid: targets.ownerUid
      }
    }
  };
  const stagedTransaction = {
    directory: stagingDirectory,
    journalPath: join(stagingDirectory, JOURNAL_NAME),
    journal
  };
  await durableReplace(payloadPath(stagedTransaction, "config", "pre"), configPreimage,
    stagingDirectory, targets.ownerUid, hooks);
  await durableReplace(payloadPath(stagedTransaction, "config", "result"), input.configResult,
    stagingDirectory, targets.ownerUid, hooks);
  await durableReplace(payloadPath(stagedTransaction, "registry", "pre"), registryPreimage,
    stagingDirectory, targets.ownerUid, hooks);
  await durableReplace(payloadPath(stagedTransaction, "registry", "result"), input.registryResult,
    stagingDirectory, targets.ownerUid, hooks);
  await writeJson(stagedTransaction.journalPath, journal, stagingDirectory, targets.ownerUid, hooks);
  await checkpoint(hooks, "after_staged_journal");
  await publishStagedTransaction(
    stagingDirectory, publicationDirectory, stagingRoot, targets, hooks
  );
  await checkpoint(hooks, "after_prepared");
  return {
    directory: publicationDirectory,
    journalPath: join(publicationDirectory, JOURNAL_NAME),
    journal
  };
}

async function stageCommittedHistoryTransaction(
  targets: TrustedTargets,
  proposalId: string,
  configPreimage: Buffer,
  configResult: Buffer,
  registryPreimage: Buffer,
  registryResult: Buffer,
  hooks?: ControlPlaneTransactionTestHooks,
  journalToken?: string
): Promise<StagedTransaction> {
  if (!PROPOSAL_PATTERN.test(proposalId) ||
      configPreimage.length > MAX_PAYLOAD_BYTES || configResult.length > MAX_PAYLOAD_BYTES ||
      registryPreimage.length > MAX_PAYLOAD_BYTES || registryResult.length > MAX_PAYLOAD_BYTES) fail();
  await ensureTransactionRoot(targets, hooks);
  const stagingRoot = await ensureStagingRoot(targets, hooks);
  const stagingDirectory = join(stagingRoot, `${STAGING_DIRECTORY_PREFIX}${proposalId}-${randomUUID()}`);
  const publicationDirectory = join(targets.transactionRoot, proposalId);
  await mkdir(stagingDirectory, { mode: DIRECTORY_MODE }).catch(() => fail());
  await requireCanonicalDirectory(stagingDirectory, targets.ownerUid, DIRECTORY_MODE);
  await syncDirectory(stagingRoot, hooks);
  const configHash = sha256(configPreimage);
  const configResultSha256 = sha256(configResult);
  const registryPreimageSha256 = sha256(registryPreimage);
  const registryResultSha256 = sha256(registryResult);
  const token = journalToken ?? randomUUID();
  const journal: TransactionJournal = {
    version: TRANSACTION_VERSION,
    proposal_id: proposalId,
    token,
    phase: "COMMITTED",
    trusted_stack_root: targets.stackRoot,
    targets: {
      config: {
        path: targets.configPath,
        preimage_sha256: configHash,
        result_sha256: configResultSha256,
        mode: FILE_MODE,
        owner_uid: targets.ownerUid
      },
      registry: {
        path: targets.registryPath,
        preimage_sha256: registryPreimageSha256,
        result_sha256: registryResultSha256,
        mode: FILE_MODE,
        owner_uid: targets.ownerUid
      }
    }
  };
  const stagedTransaction = {
    directory: stagingDirectory,
    journalPath: join(stagingDirectory, JOURNAL_NAME),
    journal
  };
  await durableReplace(payloadPath(stagedTransaction, "config", "pre"), configPreimage,
    stagingDirectory, targets.ownerUid, hooks);
  await durableReplace(payloadPath(stagedTransaction, "config", "result"), configResult,
    stagingDirectory, targets.ownerUid, hooks);
  await durableReplace(payloadPath(stagedTransaction, "registry", "pre"), registryPreimage,
    stagingDirectory, targets.ownerUid, hooks);
  await durableReplace(payloadPath(stagedTransaction, "registry", "result"), registryResult,
    stagingDirectory, targets.ownerUid, hooks);
  await writeJson(stagedTransaction.journalPath, journal, stagingDirectory, targets.ownerUid, hooks);
  await checkpoint(hooks, "after_staged_journal");
  return {
    stagingRoot,
    stagingDirectory,
    publicationDirectory,
    transaction: stagedTransaction
  };
}

async function recoverTransaction(
  transaction: PreparedTransaction,
  targets: TrustedTargets,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<PreparedTransaction> {
  const payloads = await validatePayloads(transaction, targets.ownerUid);
  const config = await targetGeneration(targets.configPath, transaction.journal.targets.config, targets.ownerUid);
  const registry = await targetGeneration(targets.registryPath, transaction.journal.targets.registry, targets.ownerUid);
  if (transaction.journal.phase === "PREPARED") {
    if (!isPreGeneration(config) || !isPreGeneration(registry)) fail();
    return writeJournal(transaction, "ABORTED", targets, hooks);
  }
  if (transaction.journal.phase === "ABORTED") {
    if (!isPreGeneration(config) || !isPreGeneration(registry)) fail();
    return transaction;
  }
  if (transaction.journal.phase === "COMMITTED") {
    if (!isResultGeneration(config) || !isResultGeneration(registry)) fail();
    return transaction;
  }
  if (isPreGeneration(config)) {
    await durableReplace(targets.configPath, payloads.configResult,
      targets.configDirectory, targets.ownerUid, hooks);
  }
  await checkpoint(hooks, "after_recovery_config");
  if (isPreGeneration(registry)) {
    await durableReplace(targets.registryPath, payloads.registryResult,
      targets.stateDirectory, targets.ownerUid, hooks);
  }
  await checkpoint(hooks, "after_recovery_registry");
  if (!isResultGeneration(await targetGeneration(
    targets.configPath, transaction.journal.targets.config, targets.ownerUid
  )) || !isResultGeneration(await targetGeneration(
    targets.registryPath, transaction.journal.targets.registry, targets.ownerUid
  ))) fail();
  return writeJournal(transaction, "COMMITTED", targets, hooks);
}

function isDirectSuccessor(
  predecessor: PreparedTransaction,
  candidate: PreparedTransaction
): boolean {
  if (predecessor === candidate || candidate.journal.phase !== "COMMITTED") return false;
  const predecessorGeneration = predecessor.journal.phase === "COMMITTED" ? "result"
    : predecessor.journal.phase === "ABORTED" ? "preimage" : undefined;
  if (predecessorGeneration === undefined) return false;
  const configHash = predecessorGeneration === "result"
    ? predecessor.journal.targets.config.result_sha256
    : predecessor.journal.targets.config.preimage_sha256;
  const registryHash = predecessorGeneration === "result"
    ? predecessor.journal.targets.registry.result_sha256
    : predecessor.journal.targets.registry.preimage_sha256;
  return candidate.journal.targets.config.preimage_sha256 === configHash &&
    candidate.journal.targets.registry.preimage_sha256 === registryHash;
}

async function currentMatchesCommittedResult(
  transaction: PreparedTransaction,
  targets: TrustedTargets
): Promise<boolean> {
  try {
    return isResultGeneration(await targetGeneration(
      targets.configPath, transaction.journal.targets.config, targets.ownerUid
    )) && isResultGeneration(await targetGeneration(
      targets.registryPath, transaction.journal.targets.registry, targets.ownerUid
    ));
  } catch (error) {
    if (error instanceof CoreError) return false;
    throw error;
  }
}

async function hasCommittedSuccessor(
  predecessor: PreparedTransaction,
  transactions: readonly PreparedTransaction[],
  targets: TrustedTargets,
  visited = new Set<string>()
): Promise<boolean> {
  const proposalId = predecessor.journal.proposal_id;
  if (visited.has(proposalId)) return false;
  const nextVisited = new Set(visited);
  nextVisited.add(proposalId);
  for (const candidate of transactions) {
    if (!isDirectSuccessor(predecessor, candidate) || nextVisited.has(candidate.journal.proposal_id)) continue;
    if (await currentMatchesCommittedResult(candidate, targets)) return true;
    if (await hasCommittedSuccessor(candidate, transactions, targets, nextVisited)) return true;
  }
  return false;
}

async function discoverTransactions(targets: TrustedTargets): Promise<PreparedTransaction[]> {
  try {
    await requireCanonicalDirectory(targets.transactionRoot, targets.ownerUid, DIRECTORY_MODE);
  } catch (error) {
    if (error instanceof CoreError) {
      try {
        await lstat(targets.transactionRoot);
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return [];
      }
    }
    throw error;
  }
  const entries = await readdir(targets.transactionRoot, { withFileTypes: true }).catch(() => fail());
  const transactions: PreparedTransaction[] = [];
  for (const entry of entries) {
    if (entry.name === LOCK_NAME || entry.name === RUNTIME_LEASE_NAME) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !PROPOSAL_PATTERN.test(entry.name)) fail();
    transactions.push(await loadTransaction(join(targets.transactionRoot, entry.name), targets));
  }
  return transactions;
}

async function recoverSafeBootstrapState(targets: TrustedTargets): Promise<boolean> {
  if (await hasStagingEntries(targets)) fail();
  const transactionRoot = targets.transactionRoot;
  let rootExists = true;
  try {
    await requireCanonicalDirectory(transactionRoot, targets.ownerUid, DIRECTORY_MODE);
  } catch (error) {
    if (error instanceof CoreError) {
      try { await lstat(transactionRoot); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") rootExists = false;
      }
      if (rootExists) fail();
    } else {
      throw error;
    }
  }
  if (!rootExists) return true;
  const entries = await readdir(transactionRoot, { withFileTypes: true }).catch(() => fail());
  if (entries.some((entry) => entry.name !== LOCK_NAME && entry.name !== RUNTIME_LEASE_NAME)) fail();
  if (entries.some((entry) => entry.name === RUNTIME_LEASE_NAME)) {
    const runtimeOwner = parseLockOwner(JSON.parse((await readBoundedSecureFile(
      join(transactionRoot, RUNTIME_LEASE_NAME), targets.ownerUid, MAX_JOURNAL_BYTES
    )).toString("utf8")));
    if (runtimeOwner.kind !== "runtime" || runtimeOwner.pid !== process.pid) fail();
  }
  const lockPath = join(transactionRoot, LOCK_NAME);
  const lockExists = await lstat(lockPath).then(() => true, (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail();
  });
  if (!lockExists) return true;
  await requireCanonicalDirectory(lockPath, targets.ownerUid, DIRECTORY_MODE);
  const owner = parseLockOwner(JSON.parse((await readBoundedSecureFile(
    join(lockPath, OWNER_NAME), targets.ownerUid, MAX_JOURNAL_BYTES
  )).toString("utf8")));
  if (owner.kind !== "registry-writer" || processIsAlive(owner.pid)) fail();
  const release = await acquireLock(targets, {
    version: 1,
    kind: "recovery",
    token: owner.token,
    pid: process.pid
  }, owner.token);
  await release();
  return true;
}

export async function applyControlPlaneTransaction(
  input: ControlPlaneTransactionInput,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<void> {
  const targets = await resolveTrustedTargets(input.configPath);
  let transaction = await createTransaction(targets, input, hooks);
  const release = await acquireLock(targets, {
    version: 1,
    kind: "transaction",
    token: transaction.journal.token,
    proposal_id: transaction.journal.proposal_id,
    pid: process.pid
  }, undefined, hooks);
  try {
    if (!isPreGeneration(await targetGeneration(
      targets.configPath, transaction.journal.targets.config, targets.ownerUid
    )) || !isPreGeneration(await targetGeneration(
      targets.registryPath, transaction.journal.targets.registry, targets.ownerUid
    ))) fail();
    transaction = await writeJournal(transaction, "COMMIT_INTENT", targets, hooks);
    await checkpoint(hooks, "after_commit_intent");
    const payloads = await validatePayloads(transaction, targets.ownerUid);
    await durableReplace(targets.configPath, payloads.configResult,
      targets.configDirectory, targets.ownerUid, hooks);
    await checkpoint(hooks, "after_config_replace");
    await durableReplace(targets.registryPath, payloads.registryResult,
      targets.stateDirectory, targets.ownerUid, hooks);
    await checkpoint(hooks, "after_registry_replace");
    if (!isResultGeneration(await targetGeneration(
      targets.configPath, transaction.journal.targets.config, targets.ownerUid
    )) || !isResultGeneration(await targetGeneration(
      targets.registryPath, transaction.journal.targets.registry, targets.ownerUid
    ))) fail();
    await checkpoint(hooks, "before_committed");
    transaction = await writeJournal(transaction, "COMMITTED", targets, hooks);
    await checkpoint(hooks, "after_committed");
  } finally {
    await release();
  }
}

export async function recoverControlPlaneTransactions(
  configPath: string,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<void> {
  let targets: TrustedTargets;
  try {
    targets = await resolveTrustedTargets(configPath);
  } catch (error) {
    try {
      targets = await resolveRecoveryTargets(configPath);
      await recoverSafeBootstrapState(targets);
      return;
    } catch {
      throw error;
    }
  }
  let transactions = await discoverTransactions(targets);
  const lockPath = join(targets.transactionRoot, LOCK_NAME);
  let staleToken: string | undefined;
  const lockExists = await lstat(lockPath).then(() => true, (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail();
  });
  if (lockExists) {
    await requireCanonicalDirectory(lockPath, targets.ownerUid, DIRECTORY_MODE);
    const owner = parseLockOwner(JSON.parse((await readBoundedSecureFile(
      join(lockPath, OWNER_NAME), targets.ownerUid, MAX_JOURNAL_BYTES)).toString("utf8")));
    let matching = transactions.filter(({ journal }) => journal.token === owner.token);
    if (matching.length === 0) {
      const staged = await findStagedTransactionByToken(targets, owner.token);
      if (staged !== undefined) {
        const publicationDirectory = join(targets.transactionRoot, staged.transaction.journal.proposal_id);
        await publishStagedTransaction(
          staged.transaction.directory,
          publicationDirectory,
          staged.stagingRoot,
          targets,
          hooks
        );
        const published = await loadTransaction(publicationDirectory, targets);
        transactions = [...transactions, published];
        matching = [published];
      }
    }
    if (matching.length === 0 && owner.kind === "registry-writer" && transactions.length === 0) {
      await recoverSafeBootstrapState(targets);
      return;
    }
    if (matching.length !== 1) fail();
    staleToken = owner.token;
  }
  const incomplete = transactions.filter(({ journal }) =>
    journal.phase === "PREPARED" || journal.phase === "COMMIT_INTENT");
  if (incomplete.length > 1) fail();
  if (staleToken !== undefined && incomplete.length === 1 && incomplete[0]!.journal.token !== staleToken) fail();
  const selected = staleToken === undefined
    ? incomplete[0]
    : transactions.find(({ journal }) => journal.token === staleToken);
  let recoveredSelected: PreparedTransaction | undefined;
  if (selected !== undefined) {
    const token = selected.journal.token;
    const release = await acquireLock(targets, {
      version: 1,
      kind: "recovery",
      token,
      proposal_id: selected.journal.proposal_id,
      pid: process.pid
    }, staleToken, hooks);
    try {
      recoveredSelected = await recoverTransaction(selected, targets, hooks);
    } finally {
      await release();
    }
  }
  const recoveredTransactions = recoveredSelected === undefined
    ? transactions
    : transactions.map((transaction) => transaction === selected ? recoveredSelected! : transaction);
  for (const transaction of recoveredTransactions) {
    if (selected !== undefined && transaction.journal.proposal_id === selected.journal.proposal_id) continue;
    if ((transaction.journal.phase === "COMMITTED" || transaction.journal.phase === "ABORTED") &&
        !(await currentMatchesCommittedResult(transaction, targets)) &&
        await hasCommittedSuccessor(transaction, recoveredTransactions, targets)) {
      continue;
    }
    await recoverTransaction(transaction, targets, hooks);
  }
}

export interface ControlPlaneRegistryCatchUpInput {
  readonly configPath: string;
  readonly proposalId: string;
  readonly predecessorProposalId: string;
  readonly registryPreimageSha256: string;
  readonly registryResultSha256: string;
  readonly registryResult: Buffer;
}

/**
 * Record a previously authorized registry change that happened outside the
 * two-file transaction protocol. This never changes config or registry bytes;
 * it only creates a durable successor journal after the caller has supplied
 * the exact current registry bytes and identified the committed predecessor.
 */
export async function recordControlPlaneRegistryCatchUp(
  input: ControlPlaneRegistryCatchUpInput,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<void> {
  if (!PROPOSAL_PATTERN.test(input.proposalId) ||
      !PROPOSAL_PATTERN.test(input.predecessorProposalId) ||
      !HASH_PATTERN.test(input.registryPreimageSha256) ||
      !HASH_PATTERN.test(input.registryResultSha256) ||
      !Buffer.isBuffer(input.registryResult) ||
      sha256(input.registryResult) !== input.registryResultSha256 ||
      input.registryResult.length > MAX_PAYLOAD_BYTES) fail();
  const targets = await resolveTrustedTargets(input.configPath);
  async function reviewedBytes() {
    const transactions = await discoverTransactions(targets);
    if (transactions.some(({ journal }) => journal.phase === "PREPARED" || journal.phase === "COMMIT_INTENT")) fail();
    const predecessor = transactions.find(({ journal }) =>
      journal.proposal_id === input.predecessorProposalId && journal.phase === "COMMITTED");
    if (predecessor === undefined || transactions.some(({ journal }) => journal.proposal_id === input.proposalId)) fail();
    const configCurrent = await readBoundedSecureFile(targets.configPath, targets.ownerUid, MAX_PAYLOAD_BYTES);
    const registryCurrent = await readBoundedSecureFile(targets.registryPath, targets.ownerUid, MAX_PAYLOAD_BYTES);
    if (sha256(configCurrent) !== predecessor.journal.targets.config.result_sha256 ||
        sha256(registryCurrent) !== input.registryResultSha256) fail();
    const registryPreimage = await readBoundedSecureFile(
      payloadPath(predecessor, "registry", "result"), targets.ownerUid, MAX_PAYLOAD_BYTES
    );
    if (sha256(registryPreimage) !== input.registryPreimageSha256 ||
        input.registryPreimageSha256 !== predecessor.journal.targets.registry.result_sha256) fail();
    return { configCurrent, registryPreimage };
  }
  const reviewed = await reviewedBytes();
  // A durable, complete recovery record must exist before the lock references it.
  const staged = await stageCommittedHistoryTransaction(
    targets, input.proposalId, reviewed.configCurrent, reviewed.configCurrent,
    reviewed.registryPreimage, input.registryResult, hooks
  );
  const token = staged.transaction.journal.token;
  const release = await acquireLock(targets, {
    version: 1, kind: "transaction", token, proposal_id: input.proposalId, pid: process.pid
  }, undefined, hooks);
  try {
    const locked = await reviewedBytes();
    if (!locked.configCurrent.equals(reviewed.configCurrent) ||
        !locked.registryPreimage.equals(reviewed.registryPreimage)) fail();
    await checkpoint(hooks, "after_catch_up_lock");
    await publishStagedTransaction(
      staged.stagingDirectory, staged.publicationDirectory, staged.stagingRoot, targets, hooks
    );
  } finally {
    await release();
  }
}

/**
 * Apply a registry-only update through the same durable two-file protocol as
 * a config update. The config bytes are carried through unchanged so the
 * resulting journal can safely supersede an earlier terminal transaction.
 * A registry file may be absent during first-run bootstrap; that case has no
 * prior terminal journal to supersede and uses the ordinary writer lock.
 */
export async function applyControlPlaneRegistryWrite(
  stateDirectory: string,
  contents: Buffer,
  bootstrap: () => Promise<void>
): Promise<void> {
  const stackRoot = resolve(stateDirectory, "..");
  const configPath = join(stackRoot, "config", "workspaces.json");
  const registryPath = join(stateDirectory, "workspace-registry.json");
  const configMissing = await lstat(configPath).then(() => false, (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    fail();
  });
  const registryMissing = await lstat(registryPath).then(() => false, (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    fail();
  });
  if (configMissing || registryMissing) {
    const ownerUid = currentUid();
    await requireCanonicalDirectory(stateDirectory, ownerUid);
    if (await hasControlPlaneHistory(stateDirectory, ownerUid)) fail();
    await withControlPlaneRegistryWriteLock(stateDirectory, bootstrap);
    return;
  }
  const targets = await resolveTrustedTargets(configPath);
  const transactions = await discoverTransactions(targets);
  if (transactions.some(({ journal }) => journal.phase === "PREPARED" || journal.phase === "COMMIT_INTENT")) {
    fail();
  }
  const lockPath = join(targets.transactionRoot, LOCK_NAME);
  if (await lstat(lockPath).then(() => true, (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail();
  })) fail();
  const configPreimage = await readBoundedSecureFile(targets.configPath, targets.ownerUid, MAX_PAYLOAD_BYTES);
  const registryPreimage = await readBoundedSecureFile(targets.registryPath, targets.ownerUid, MAX_PAYLOAD_BYTES);
  if (sha256(registryPreimage) === sha256(contents)) return;
  await applyControlPlaneTransaction({
    configPath: targets.configPath,
    proposalId: `registry-writer-${randomUUID()}`,
    configPreimageSha256: sha256(configPreimage),
    configResultSha256: sha256(configPreimage),
    configResult: configPreimage,
    registryPreimageSha256: sha256(registryPreimage),
    registryResultSha256: sha256(contents),
    registryResult: contents
  });
}

export async function withControlPlaneRegistryWriteLock<T>(
  stateDirectory: string,
  operation: () => Promise<T>,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<T> {
  const ownerUid = currentUid();
  await requireCanonicalDirectory(stateDirectory, ownerUid);
  const targets = {
    stackRoot: resolve(stateDirectory, ".."),
    configDirectory: join(resolve(stateDirectory, ".."), "config"),
    stateDirectory,
    transactionRoot: join(stateDirectory, TRANSACTION_ROOT_NAME),
    configPath: join(resolve(stateDirectory, ".."), "config", "workspaces.json"),
    registryPath: join(stateDirectory, "workspace-registry.json"),
    ownerUid
  } satisfies TrustedTargets;
  const token = randomUUID();
  const release = await acquireLock(targets, {
    version: 1,
    kind: "registry-writer",
    token,
    pid: process.pid
  }, undefined, hooks);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function acquireControlPlaneRuntimeLease(
  configPath: string,
  kind: "runtime" | "migration"
): Promise<() => Promise<void>> {
  const targets = await resolveTrustedTargets(configPath);
  await ensureTransactionRoot(targets);
  const leasePath = join(targets.transactionRoot, RUNTIME_LEASE_NAME);
  const token = randomUUID();
  const owner: LockOwner = { version: 1, kind, token, pid: process.pid };
  const create = async (): Promise<void> => {
    const handle = await open(leasePath, "wx", FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    await syncDirectory(targets.transactionRoot);
  };
  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail();
    const stale = parseLockOwner(JSON.parse((await readBoundedSecureFile(
      leasePath, targets.ownerUid, MAX_JOURNAL_BYTES)).toString("utf8")));
    if ((stale.kind !== "runtime" && stale.kind !== "migration") || processIsAlive(stale.pid)) fail();
    await unlink(leasePath).catch(() => fail());
    await syncDirectory(targets.transactionRoot);
    await create().catch(() => fail());
  }
  return async () => {
    const current = parseLockOwner(JSON.parse((await readBoundedSecureFile(
      leasePath, targets.ownerUid, MAX_JOURNAL_BYTES)).toString("utf8")));
    if (current.token !== token || current.pid !== process.pid || current.kind !== kind) fail();
    await unlink(leasePath).catch(() => fail());
    await syncDirectory(targets.transactionRoot);
  };
}
