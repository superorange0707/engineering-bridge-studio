import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";

export const defaultStack = () => join(homedir(), ".local", "share", "engineering-bridge");
export const connectionFile = () => join(homedir(), ".config", "engineering-bridge", "connection.json");

export function absolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) {
    throw new Error("Use an absolute, normalized filesystem path.");
  }
  return value;
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error(`Expected a private directory owned by this user: ${path}`);
  }
}

export async function readPrivateJson(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) {
      throw new Error(`Expected a private JSON file owned by this user: ${path}`);
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

export async function resolveConfigPath(env = process.env, pointer = connectionFile()) {
  if (env.ENGINEERING_BRIDGE_CONFIG) return absolutePath(env.ENGINEERING_BRIDGE_CONFIG);
  try {
    const record = await readPrivateJson(pointer);
    if (record.version !== 1) throw new Error("Unsupported Bridge connection format.");
    return absolutePath(record.config_path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return join(defaultStack(), "config", "workspaces.json");
  }
}

export async function connectConfig(configPath, pointer = connectionFile()) {
  absolutePath(configPath);
  const config = await readPrivateJson(configPath);
  if (config.version !== 3 || !Array.isArray(config.workspaces) || !Array.isArray(config.managed_roots)) {
    throw new Error("Expected a version-3 Bridge workspace configuration.");
  }
  const { WorkspaceConfigSchema } = await import("../dist/src/mcp-stdio.js");
  if (!WorkspaceConfigSchema.safeParse(config).success) throw new Error("Workspace configuration does not match the Bridge schema.");
  configPath = await realpath(configPath);
  absolutePath(pointer);
  await privateDirectory(dirname(pointer));
  try { await readPrivateJson(pointer); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${pointer}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, config_path: configPath }, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, pointer);
  } finally { await unlink(temporary).catch(() => {}); }
  return { config_path: configPath, connection_file: pointer };
}
