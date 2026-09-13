import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, constants, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../version.js";
const RUNTIME_DIRECTORY_NAME = ".engineering-bridge-runtime";
const OWNER_DIRECTORY_NAME = "owner";
const SOCKET_NAME = "mcp.sock";
const OWNER_FILE_NAME = "owner.json";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_OWNER_BYTES = 16 * 1024;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 12_000;
const IDLE_TIMEOUT_MS = 2_000;
const SOCKET_PROBE_TIMEOUT_MS = 1_000;
const MAX_BUILD_FILES = 512;
const MAX_BUILD_BYTES = 128 * 1024 * 1024;
const MAX_BUILD_FILE_BYTES = 32 * 1024 * 1024;
const MAX_BUILD_DEPTH = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f-]{36}$/u;
function fail(message) {
    throw new Error(message);
}
function currentUid() {
    const uid = process.getuid?.();
    if (uid === undefined)
        fail("The Bridge runtime requires a local user identity.");
    return uid;
}
function sha256(contents) {
    return createHash("sha256").update(contents).digest("hex");
}
export async function inspectBridgeOwner(configPath) {
    if (!configPath.startsWith("/") || normalize(configPath) !== configPath) {
        fail("The Bridge configuration path is not absolute and normalized.");
    }
    const paths = pathsFor(configPath);
    const owner = await ownerMetadataFor(paths, currentUid());
    if (owner === undefined)
        return undefined;
    return {
        pid: owner.pid,
        state: owner.state,
        readOnly: owner.read_only,
        configPath: owner.config_path,
        configIdentity: owner.config_identity,
        alive: processIsAlive(owner.pid)
    };
}
function pathsFor(configPath) {
    const stackRoot = resolve(dirname(configPath), "..");
    const stateRoot = join(stackRoot, "state");
    const runtimeRoot = join(stateRoot, RUNTIME_DIRECTORY_NAME);
    const ownerDirectory = join(runtimeRoot, OWNER_DIRECTORY_NAME);
    const uid = process.getuid?.();
    const socketDirectory = join(process.platform === "darwin" ? "/private/tmp" : "/tmp", `engineering-bridge-${uid ?? "unknown"}`);
    return {
        configPath,
        stateRoot,
        registryPath: join(stateRoot, "workspace-registry.json"),
        runtimeRoot,
        ownerDirectory,
        ownerPath: join(ownerDirectory, OWNER_FILE_NAME),
        socketDirectory,
        socketPath: join(socketDirectory, `.${SOCKET_NAME}-${sha256(configPath).slice(0, 24)}`)
    };
}
async function secureDirectory(path, uid, mode = DIRECTORY_MODE) {
    const metadata = await lstat(path).catch(() => fail(`Missing Bridge runtime directory: ${path}`));
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid ||
        (metadata.mode & 0o777) !== mode || await realpath(path).catch(() => "") !== path) {
        fail("The Bridge runtime directory is not trusted.");
    }
}
async function ensureDirectory(path, uid) {
    try {
        await secureDirectory(path, uid);
        return;
    }
    catch (error) {
        if (!(error instanceof Error))
            throw error;
    }
    await mkdir(path, { mode: DIRECTORY_MODE }).catch((error) => {
        if (error.code !== "EEXIST")
            fail("Could not create the Bridge runtime directory.");
    });
    await secureDirectory(path, uid);
}
async function readSecureFile(path, uid, maximumBytes) {
    if (await realpath(path).catch(() => "") !== path)
        fail("The Bridge runtime metadata path is not trusted.");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        .catch(() => fail("The Bridge runtime metadata is unavailable."));
    try {
        const metadata = await handle.stat().catch(() => fail("The Bridge runtime metadata is unavailable."));
        if (!metadata.isFile() || metadata.uid !== uid || metadata.nlink !== 1 ||
            (metadata.mode & 0o777) !== FILE_MODE || metadata.size > maximumBytes) {
            fail("The Bridge runtime metadata is not trusted.");
        }
        const contents = await handle.readFile().catch(() => fail("The Bridge runtime metadata is unavailable."));
        if (contents.length !== metadata.size)
            fail("The Bridge runtime metadata changed while reading.");
        return contents;
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
async function readBuildFile(path, uid, maximumBytes) {
    const metadata = await lstat(path).catch(() => fail("The Bridge runtime build is unavailable."));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || metadata.nlink !== 1 ||
        metadata.size > maximumBytes || await realpath(path).catch(() => "") !== path) {
        fail("The Bridge runtime build is not trusted.");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        .catch(() => fail("The Bridge runtime build is unavailable."));
    try {
        const opened = await handle.stat().catch(() => fail("The Bridge runtime build is unavailable."));
        if (!opened.isFile() || opened.uid !== uid || opened.nlink !== 1 || opened.size > maximumBytes) {
            fail("The Bridge runtime build changed while reading.");
        }
        const contents = await handle.readFile().catch(() => fail("The Bridge runtime build is unavailable."));
        if (contents.length !== opened.size)
            fail("The Bridge runtime build changed while reading.");
        return contents;
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
async function collectBuildFiles(root, uid, extension) {
    const files = [];
    let totalBytes = 0;
    const visit = async (directory, relativeDirectory, depth) => {
        if (depth > MAX_BUILD_DEPTH)
            fail("The Bridge runtime build directory is too deep.");
        const directoryMetadata = await lstat(directory).catch(() => fail("The Bridge runtime build is unavailable."));
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || directoryMetadata.uid !== uid ||
            await realpath(directory).catch(() => "") !== directory) {
            fail("The Bridge runtime build directory is not trusted.");
        }
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail("The Bridge runtime build is unavailable."));
        entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
            const path = join(directory, entry.name);
            const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
            const metadata = await lstat(path).catch(() => fail("The Bridge runtime build is unavailable."));
            if (metadata.isSymbolicLink())
                fail("The Bridge runtime build contains an untrusted symbolic link.");
            if (metadata.isDirectory()) {
                await visit(path, relativePath, depth + 1);
                continue;
            }
            if (!metadata.isFile())
                continue;
            if (!relativePath.endsWith(extension))
                continue;
            if (files.length >= MAX_BUILD_FILES)
                fail("The Bridge runtime build contains too many files.");
            if (!Number.isSafeInteger(metadata.size) || metadata.size > MAX_BUILD_FILE_BYTES ||
                totalBytes + metadata.size > MAX_BUILD_BYTES) {
                fail("The Bridge runtime build exceeds its size bound.");
            }
            files.push({ path, relativePath });
            totalBytes += metadata.size;
        }
    };
    await visit(root, "", 0);
    files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
    return files;
}
async function buildIdentity(uid) {
    const buildRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    let files = await collectBuildFiles(buildRoot, uid, ".js");
    // `node --experimental-strip-types` runs source tests directly. Production
    // owners always hash the bounded dist/src JavaScript tree above.
    if (files.length === 0)
        files = await collectBuildFiles(buildRoot, uid, ".ts");
    if (files.length === 0)
        fail("The Bridge runtime build contains no source files.");
    const hashes = {};
    for (const file of files) {
        hashes[file.relativePath] = sha256(await readBuildFile(file.path, uid, MAX_BUILD_FILE_BYTES));
    }
    return hashes;
}
/** Return the code-only identity used as the runtime's build component. */
export async function inspectBridgeBuildIdentity() {
    return sha256(JSON.stringify({
        bridge_version: VERSION,
        build_hashes: await buildIdentity(currentUid())
    }));
}
async function writeSecureFile(path, contents, directory, exclusive) {
    const handle = await open(path, exclusive ? "wx" : "w", FILE_MODE)
        .catch(() => fail("Could not write Bridge runtime metadata."));
    try {
        await handle.writeFile(contents).catch(() => fail("Could not write Bridge runtime metadata."));
        await handle.sync().catch(() => fail("Could not persist Bridge runtime metadata."));
    }
    finally {
        await handle.close().catch(() => undefined);
    }
    const parent = await open(directory, "r").catch(() => fail("Could not persist Bridge runtime metadata."));
    try {
        await parent.sync().catch(() => fail("Could not persist Bridge runtime metadata."));
    }
    finally {
        await parent.close().catch(() => undefined);
    }
}
async function syncDirectory(path) {
    const directory = await open(path, "r").catch(() => fail("Could not persist Bridge runtime metadata."));
    try {
        await directory.sync().catch(() => fail("Could not persist Bridge runtime metadata."));
    }
    finally {
        await directory.close().catch(() => undefined);
    }
}
async function replaceSecureFile(path, contents, directory) {
    const temporary = join(directory, `.${OWNER_FILE_NAME}.${randomUUID()}.tmp`);
    await writeSecureFile(temporary, contents, directory, true);
    await rename(temporary, path).catch(() => {
        void unlink(temporary).catch(() => undefined);
        fail("Could not publish Bridge runtime metadata.");
    });
    const parent = await open(directory, "r").catch(() => fail("Could not publish Bridge runtime metadata."));
    try {
        await parent.sync().catch(() => fail("Could not publish Bridge runtime metadata."));
    }
    finally {
        await parent.close().catch(() => undefined);
    }
}
function parseOwner(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        fail("Invalid Bridge runtime owner metadata.");
    const object = value;
    const keys = Object.keys(object).sort();
    const baseKeys = "config_identity,config_path,pid,read_only,state,token,uid,version";
    const socketKeys = "config_identity,config_path,pid,read_only,socket_dev,socket_ino,state,token,uid,version";
    if (keys.join(",") !== baseKeys && keys.join(",") !== socketKeys) {
        fail("Invalid Bridge runtime owner metadata.");
    }
    const hasSocketIdentity = Object.hasOwn(object, "socket_dev") || Object.hasOwn(object, "socket_ino");
    if (object.version !== 1 || typeof object.pid !== "number" || !Number.isSafeInteger(object.pid) || object.pid <= 0 ||
        typeof object.uid !== "number" || !Number.isSafeInteger(object.uid) || object.uid < 0 ||
        typeof object.token !== "string" || !TOKEN_PATTERN.test(object.token) ||
        typeof object.config_path !== "string" || normalize(object.config_path) !== object.config_path ||
        typeof object.config_identity !== "string" || !/^[0-9a-f]{64}$/u.test(object.config_identity) ||
        (object.state !== "starting" && object.state !== "ready") || typeof object.read_only !== "boolean" ||
        (hasSocketIdentity && (typeof object.socket_dev !== "number" || !Number.isSafeInteger(object.socket_dev) || object.socket_dev < 0 ||
            typeof object.socket_ino !== "number" || !Number.isSafeInteger(object.socket_ino) || object.socket_ino < 0))) {
        fail("Invalid Bridge runtime owner metadata.");
    }
    if (hasSocketIdentity && (!Object.hasOwn(object, "socket_dev") || !Object.hasOwn(object, "socket_ino"))) {
        fail("Invalid Bridge runtime owner metadata.");
    }
    const socketIdentity = hasSocketIdentity ? {
        socket_dev: object.socket_dev,
        socket_ino: object.socket_ino
    } : {};
    return {
        version: 1,
        pid: object.pid,
        uid: object.uid,
        token: object.token,
        config_path: object.config_path,
        config_identity: object.config_identity,
        state: object.state,
        read_only: object.read_only,
        ...socketIdentity
    };
}
async function readOwner(paths, uid = currentUid()) {
    const source = await readSecureFile(paths.ownerPath, uid, MAX_OWNER_BYTES);
    try {
        return parseOwner(JSON.parse(source.toString("utf8")));
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith("Invalid Bridge runtime owner"))
            throw error;
        fail("Invalid Bridge runtime owner metadata.");
    }
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== "ESRCH";
    }
}
async function secureSocket(path, uid, requirePrivate = true) {
    const metadata = await lstat(path).catch(() => fail("The Bridge runtime socket is unavailable."));
    if (!metadata.isSocket() || metadata.isSymbolicLink() || metadata.uid !== uid || metadata.nlink !== 1 ||
        (requirePrivate && (metadata.mode & 0o777) !== FILE_MODE) ||
        await realpath(path).catch(() => "") !== path ||
        !Number.isSafeInteger(metadata.dev) || !Number.isSafeInteger(metadata.ino)) {
        fail("The Bridge runtime socket is not trusted.");
    }
    return { dev: metadata.dev, ino: metadata.ino };
}
function sameSocketIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
async function removeOwnedSocket(path, uid, expected, requirePrivate = true) {
    let actual;
    try {
        actual = await secureSocket(path, uid, requirePrivate);
    }
    catch (error) {
        if (error instanceof Error && error.message === "The Bridge runtime socket is unavailable.")
            return false;
        throw error;
    }
    if (expected !== undefined && !sameSocketIdentity(actual, expected))
        return false;
    try {
        await unlink(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        fail("Could not remove the stale Bridge runtime socket.");
    }
}
async function displaceReplacedSocket(paths, uid, expected) {
    if (expected === undefined)
        return undefined;
    let metadata;
    try {
        metadata = await lstat(paths.socketPath);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    const current = metadata.isSocket() && metadata.uid === uid && metadata.nlink === 1 &&
        Number.isSafeInteger(metadata.dev) && Number.isSafeInteger(metadata.ino)
        ? { dev: metadata.dev, ino: metadata.ino }
        : undefined;
    if (current !== undefined && sameSocketIdentity(current, expected))
        return undefined;
    if (metadata.uid !== uid || metadata.nlink !== 1 || metadata.isDirectory() ||
        (metadata.isSymbolicLink() ? false : await realpath(paths.socketPath).catch(() => "") !== paths.socketPath)) {
        fail("The Bridge runtime socket changed to an untrusted path while closing.");
    }
    const displaced = join(paths.socketDirectory, `.${SOCKET_NAME}.preserved-${randomUUID()}`);
    await rename(paths.socketPath, displaced).catch(() => fail("Could not preserve the replaced Bridge runtime socket."));
    return displaced;
}
async function restoreDisplacedSocket(paths, displaced) {
    try {
        await lstat(paths.socketPath);
        return;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            return;
    }
    await rename(displaced, paths.socketPath).catch(() => undefined);
}
async function probeSocket(path) {
    return await new Promise((resolvePromise, reject) => {
        const connection = createConnection(path);
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            connection.destroy();
            reject(new Error("The Bridge runtime socket listener could not be verified."));
        }, SOCKET_PROBE_TIMEOUT_MS);
        timer.unref();
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            connection.destroy();
            resolvePromise(result);
        };
        connection.once("connect", () => finish("active"));
        connection.once("error", (error) => {
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
                finish("stale");
            else {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                connection.destroy();
                reject(new Error("The Bridge runtime socket listener could not be verified."));
            }
        });
    });
}
async function cleanupOrphanSocket(paths, uid, expected) {
    await secureDirectory(paths.socketDirectory, uid);
    let actual;
    try {
        actual = await secureSocket(paths.socketPath, uid, false);
    }
    catch (error) {
        if (error instanceof Error && error.message === "The Bridge runtime socket is unavailable.")
            return;
        throw error;
    }
    if (expected !== undefined && !sameSocketIdentity(actual, expected)) {
        fail("The Bridge runtime socket changed while recovering its owner.");
    }
    if (await probeSocket(paths.socketPath) === "active") {
        fail("A Bridge runtime socket listener is already active.");
    }
    await removeOwnedSocket(paths.socketPath, uid, expected ?? actual, false);
}
async function removeStaleOwner(paths, uid) {
    const owner = await readOwner(paths, uid);
    if (owner.uid !== uid || owner.config_path !== paths.configPath || processIsAlive(owner.pid)) {
        fail("A live Bridge runtime owner is already active.");
    }
    await cleanupOrphanSocket(paths, uid, owner.socket_dev === undefined || owner.socket_ino === undefined
        ? undefined
        : { dev: owner.socket_dev, ino: owner.socket_ino });
    await unlink(paths.ownerPath).catch(() => fail("Could not remove the stale Bridge runtime owner."));
    await rmdir(paths.ownerDirectory).catch(() => fail("Could not remove the stale Bridge runtime owner."));
}
async function configIdentity(paths, uid) {
    const canonicalConfig = await realpath(paths.configPath).catch(() => fail("The workspace configuration is unavailable."));
    if (canonicalConfig !== paths.configPath)
        fail("The workspace configuration path is not canonical.");
    const config = await readSecureFile(paths.configPath, uid, 16 * 1024 * 1024);
    let registrySafety;
    try {
        const metadata = await lstat(paths.registryPath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || metadata.nlink !== 1 ||
            (metadata.mode & 0o777) !== FILE_MODE || await realpath(paths.registryPath).catch(() => "") !== paths.registryPath) {
            fail("The workspace registry is not trusted.");
        }
        registrySafety = {
            exists: true,
            owner_uid: metadata.uid,
            mode: metadata.mode & 0o777,
            nlink: metadata.nlink
        };
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        registrySafety = { exists: false };
    }
    const buildHashes = await buildIdentity(uid);
    const descriptor = JSON.stringify({
        bridge_version: VERSION,
        build_hashes: buildHashes,
        config_path: paths.configPath,
        config_sha256: sha256(config),
        registry_path: paths.registryPath,
        registry_safety: registrySafety
    });
    return { identity: sha256(descriptor), registrySafety };
}
async function waitForOwnerMetadata(paths, uid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const metadataPath = await lstat(paths.ownerPath).catch((error) => {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        });
        if (metadataPath !== undefined)
            return await readOwner(paths, uid);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    return undefined;
}
async function claimOwner(paths, metadata, uid) {
    await ensureDirectory(paths.runtimeRoot, uid);
    await ensureDirectory(paths.socketDirectory, uid);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const stagedDirectory = join(paths.runtimeRoot, `.${OWNER_DIRECTORY_NAME}.${randomUUID()}.tmp`);
        let published = false;
        try {
            await mkdir(stagedDirectory, { mode: DIRECTORY_MODE });
            await secureDirectory(stagedDirectory, uid);
            await writeSecureFile(join(stagedDirectory, OWNER_FILE_NAME), Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`), stagedDirectory, true);
            try {
                await rename(stagedDirectory, paths.ownerDirectory);
                published = true;
                await syncDirectory(paths.runtimeRoot);
                return;
            }
            catch (error) {
                if (error.code !== "EEXIST" &&
                    error.code !== "ENOTEMPTY") {
                    fail("Could not claim the Bridge runtime owner.");
                }
            }
        }
        finally {
            if (!published) {
                await unlink(join(stagedDirectory, OWNER_FILE_NAME)).catch(() => undefined);
                await rmdir(stagedDirectory).catch(() => undefined);
            }
        }
        // A published owner always contains metadata. If another process is in
        // publication, wait for it; never evict an unidentifiable owner.
        const existing = await waitForOwnerMetadata(paths, uid, 1_000);
        if (existing === undefined)
            fail("Bridge runtime owner is still starting; retry shortly.");
        if (existing.uid !== uid || existing.config_path !== paths.configPath || processIsAlive(existing.pid)) {
            fail("A live Bridge runtime owner is already active.");
        }
        await removeStaleOwner(paths, uid);
    }
    fail("Could not claim the Bridge runtime owner.");
}
async function readLine(socket, maximumBytes) {
    return await new Promise((resolvePromise, reject) => {
        let buffer = Buffer.alloc(0);
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Bridge runtime handshake timed out."));
        }, HANDSHAKE_TIMEOUT_MS);
        timeout.unref();
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off("data", onData);
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        const onError = (error) => { cleanup(); reject(error); };
        const onClose = () => { cleanup(); reject(new Error("Bridge runtime socket closed.")); };
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > maximumBytes) {
                cleanup();
                reject(new Error("Bridge runtime handshake exceeded its bound."));
                return;
            }
            const index = buffer.indexOf(10);
            if (index < 0)
                return;
            cleanup();
            socket.pause();
            resolvePromise({ line: buffer.subarray(0, index).toString("utf8").replace(/\r$/u, ""), rest: buffer.subarray(index + 1) });
        };
        socket.on("data", onData);
        socket.once("error", onError);
        socket.once("close", onClose);
    });
}
function writeLine(socket, value) {
    const serialized = `${JSON.stringify(value)}\n`;
    return new Promise((resolvePromise, reject) => {
        socket.write(serialized, (error) => error == null ? resolvePromise() : reject(error));
    });
}
class SocketTransport {
    socket;
    started = false;
    closed = false;
    closeNotified = false;
    buffer;
    onclose;
    onerror;
    onmessage;
    constructor(socket, initial = Buffer.alloc(0)) {
        this.socket = socket;
        this.buffer = initial;
    }
    async start() {
        if (this.started)
            throw new Error("Bridge runtime socket transport already started.");
        this.started = true;
        this.socket.on("data", (chunk) => this.receive(chunk));
        this.socket.once("error", (error) => this.fail(error));
        this.socket.once("close", () => this.closeEvent());
        if (this.buffer.length > 0) {
            const pending = this.buffer;
            this.buffer = Buffer.alloc(0);
            this.receive(pending);
        }
        this.socket.resume();
    }
    async send(message, _options) {
        if (this.closed)
            throw new Error("Bridge runtime socket is closed.");
        await writeLine(this.socket, message);
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.socket.end();
        this.closeEvent();
    }
    receive(chunk) {
        if (this.closed)
            return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > MAX_FRAME_BYTES) {
            this.fail(new Error("Bridge runtime MCP frame exceeded its bound."));
            return;
        }
        while (true) {
            const index = this.buffer.indexOf(10);
            if (index < 0)
                return;
            const line = this.buffer.subarray(0, index).toString("utf8").replace(/\r$/u, "");
            this.buffer = this.buffer.subarray(index + 1);
            try {
                this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
            }
            catch (error) {
                this.fail(error instanceof Error ? error : new Error("Invalid Bridge runtime MCP message."));
                return;
            }
        }
    }
    fail(error) {
        if (this.closed)
            return;
        this.onerror?.(error);
        void this.close();
    }
    closeEvent() {
        if (this.closeNotified)
            return;
        this.closeNotified = true;
        this.onclose?.();
    }
}
async function connectSocket(paths, owner, readOnly) {
    const identity = await configIdentity(paths, owner.uid);
    if (identity.identity !== owner.config_identity)
        fail("Bridge runtime needs restart after configuration changed.");
    const socket = await new Promise((resolvePromise, reject) => {
        const connection = createConnection(paths.socketPath);
        const timer = setTimeout(() => {
            connection.destroy();
            reject(new Error("Bridge runtime owner did not accept a connection."));
        }, HANDSHAKE_TIMEOUT_MS);
        timer.unref();
        connection.once("connect", () => { clearTimeout(timer); resolvePromise(connection); });
        connection.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    socket.setNoDelay(true);
    const hello = {
        type: "engineering-bridge-runtime",
        version: 1,
        config_path: paths.configPath,
        config_identity: identity.identity,
        token: owner.token,
        client_nonce: randomUUID(),
        read_only: readOnly
    };
    await writeLine(socket, hello);
    const responseLine = await readLine(socket, MAX_HANDSHAKE_BYTES);
    if (responseLine.rest.length !== 0) {
        socket.destroy();
        fail("Bridge runtime sent data before authentication completed.");
    }
    let response;
    try {
        response = JSON.parse(responseLine.line);
    }
    catch {
        socket.destroy();
        fail("Bridge runtime returned an invalid handshake.");
    }
    if (response.ok !== true || response.type !== "engineering-bridge-runtime-ack" ||
        response.version !== 1 || response.config_identity !== identity.identity) {
        socket.destroy();
        if (response.error === "NEEDS_RESTART")
            fail("Bridge runtime needs restart after configuration changed.");
        fail("Bridge runtime authentication failed.");
    }
    return socket;
}
async function ownerMetadataFor(paths, uid) {
    try {
        await secureDirectory(paths.ownerDirectory, uid);
    }
    catch (error) {
        if (error instanceof Error && error.message.includes("Missing Bridge runtime directory"))
            return undefined;
        throw error;
    }
    const ownerFile = await lstat(paths.ownerPath).catch((error) => {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    });
    if (ownerFile === undefined)
        throw new Error("Bridge runtime owner metadata is still starting.");
    return readOwner(paths, uid);
}
async function waitForOwner(paths, readOnly) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let spawned = false;
    let spawnFailed = false;
    let lastError;
    while (Date.now() < deadline) {
        const uid = currentUid();
        let owner;
        try {
            owner = await ownerMetadataFor(paths, uid);
        }
        catch (error) {
            if (error instanceof Error && error.message === "Bridge runtime owner metadata is still starting.") {
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
                continue;
            }
            lastError = error;
            break;
        }
        if (owner !== undefined) {
            if (owner.uid !== uid || owner.config_path !== paths.configPath)
                fail("Bridge runtime owner identity mismatch.");
            if (!processIsAlive(owner.pid)) {
                await removeStaleOwner(paths, uid);
                continue;
            }
            if (owner.state !== "ready") {
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
                continue;
            }
            try {
                return await connectSocket(paths, owner, readOnly);
            }
            catch (error) {
                lastError = error;
                if (error instanceof Error && error.message.includes("needs restart"))
                    throw error;
            }
        }
        else if (!spawned) {
            if (spawnFailed)
                fail("Bridge runtime owner failed to start.");
            spawned = true;
            const daemonPath = fileURLToPath(new URL("./bridge-daemon.js", new URL("./", import.meta.url)));
            const args = [daemonPath, paths.configPath, ...(readOnly ? ["--read-only"] : [])];
            const child = spawn(process.execPath, args, {
                cwd: process.cwd(),
                env: { ...process.env },
                detached: true,
                stdio: "ignore"
            });
            child.once("exit", (code) => {
                spawned = false;
                if (code !== 0)
                    spawnFailed = true;
            });
            child.once("error", () => {
                spawned = false;
                spawnFailed = true;
            });
            child.unref();
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (lastError instanceof Error)
        throw lastError;
    fail("Bridge runtime owner startup timed out.");
}
export async function runBridgeStdioFrontdoor(configPath, options) {
    const normalized = normalize(configPath);
    if (normalized !== configPath || !configPath.startsWith("/"))
        fail("The Bridge configuration path is not absolute and normalized.");
    const paths = pathsFor(configPath);
    const socket = await waitForOwner(paths, options.readOnly);
    socket.pipe(process.stdout);
    process.stdin.pipe(socket);
    await new Promise((resolvePromise, reject) => {
        const onClose = () => { process.stdin.unpipe(socket); resolvePromise(); };
        const onError = (error) => { process.stdin.unpipe(socket); reject(error); };
        socket.once("close", onClose);
        socket.once("error", onError);
        process.stdin.once("error", onError);
    });
}
async function handleConnection(socket, owner, paths, application, onSessionClosed) {
    socket.setNoDelay(true);
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
    const first = await readLine(socket, MAX_HANDSHAKE_BYTES);
    socket.setTimeout(0);
    if (first.rest.length !== 0)
        fail("Bridge runtime received MCP data before authentication completed.");
    let hello;
    try {
        hello = JSON.parse(first.line);
    }
    catch {
        fail("Bridge runtime received an invalid handshake.");
    }
    if (hello.type !== "engineering-bridge-runtime" || hello.version !== 1 ||
        hello.config_path !== paths.configPath || hello.config_identity !== owner.config_identity ||
        hello.token !== owner.token || !UUID_PATTERN.test(hello.client_nonce) || typeof hello.read_only !== "boolean") {
        const response = {
            type: "engineering-bridge-runtime-ack", version: 1, ok: false, error: "UNAUTHORIZED"
        };
        await writeLine(socket, response).catch(() => undefined);
        socket.destroy();
        return;
    }
    const response = {
        type: "engineering-bridge-runtime-ack", version: 1, ok: true,
        config_identity: owner.config_identity, server_nonce: randomUUID()
    };
    await writeLine(socket, response);
    const server = await application.createServer(hello.read_only);
    const transport = new SocketTransport(socket);
    let finished = false;
    const finish = () => {
        if (finished)
            return;
        finished = true;
        onSessionClosed();
        void server.close().catch(() => undefined);
    };
    socket.once("close", finish);
    socket.once("error", finish);
    transport.onclose = finish;
    await server.connect(transport);
}
export async function startBridgeOwner(configPath, applicationFactory, ownerReadOnly) {
    const paths = pathsFor(configPath);
    const uid = currentUid();
    const identity = await configIdentity(paths, uid);
    let owner = {
        version: 1,
        pid: process.pid,
        uid,
        token: randomBytes(32).toString("hex"),
        config_path: configPath,
        config_identity: identity.identity,
        state: "starting",
        read_only: ownerReadOnly
    };
    await claimOwner(paths, owner, uid);
    let application;
    let server;
    let ownedSocketIdentity;
    const sessions = new Set();
    let idleTimer;
    let closed = false;
    let closeResolve;
    let closeReject;
    const closedPromise = new Promise((resolvePromise, reject) => {
        closeResolve = resolvePromise;
        closeReject = reject;
    });
    const close = async () => {
        if (closed)
            return;
        closed = true;
        if (idleTimer !== undefined)
            clearTimeout(idleTimer);
        for (const socket of sessions)
            socket.destroy();
        sessions.clear();
        const displacedSocket = await displaceReplacedSocket(paths, owner.uid, ownedSocketIdentity);
        await new Promise((resolvePromise) => {
            if (server === undefined || !server.listening) {
                resolvePromise();
                return;
            }
            server.close(() => resolvePromise());
        });
        if (displacedSocket !== undefined)
            await restoreDisplacedSocket(paths, displacedSocket);
        await application?.close().catch(() => undefined);
        const currentOwner = await readOwner(paths, owner.uid).catch(() => undefined);
        if (currentOwner?.pid === owner.pid && currentOwner.token === owner.token) {
            if (ownedSocketIdentity !== undefined) {
                await removeOwnedSocket(paths.socketPath, owner.uid, ownedSocketIdentity).catch(() => undefined);
            }
            await unlink(paths.ownerPath).catch(() => undefined);
            await rmdir(paths.ownerDirectory).catch(() => undefined);
        }
        closeResolve();
    };
    const scheduleIdleClose = () => {
        if (idleTimer !== undefined)
            clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimer = undefined;
            if (sessions.size !== 0 || application?.isBusy?.()) {
                scheduleIdleClose();
                return;
            }
            void close();
        }, IDLE_TIMEOUT_MS);
        idleTimer.unref();
    };
    const readyPromise = (async () => {
        try {
            // A crashed owner can leave a socket path without owner metadata. Only
            // unlink it after a private-directory check and an explicit refusal
            // probe; an active listener is always preserved.
            await cleanupOrphanSocket(paths, uid);
            application = await applicationFactory(ownerReadOnly);
            server = createServer((socket) => {
                if (idleTimer !== undefined) {
                    clearTimeout(idleTimer);
                    idleTimer = undefined;
                }
                sessions.add(socket);
                void handleConnection(socket, { ...owner, state: "ready" }, paths, application, () => {
                    sessions.delete(socket);
                    if (sessions.size === 0) {
                        scheduleIdleClose();
                    }
                }).catch(() => {
                    sessions.delete(socket);
                    socket.destroy();
                    if (sessions.size === 0)
                        scheduleIdleClose();
                });
            });
            await new Promise((resolvePromise, reject) => {
                server.once("error", reject);
                server.listen(paths.socketPath, () => resolvePromise());
            });
            await chmod(paths.socketPath, FILE_MODE).catch(() => fail("Could not secure the Bridge runtime socket."));
            ownedSocketIdentity = await secureSocket(paths.socketPath, uid);
            const readyIdentity = await configIdentity(paths, uid);
            owner = {
                ...owner,
                config_identity: readyIdentity.identity,
                socket_dev: ownedSocketIdentity.dev,
                socket_ino: ownedSocketIdentity.ino
            };
            const readyOwner = { ...owner, state: "ready" };
            await secureDirectory(paths.ownerDirectory, uid);
            await replaceSecureFile(paths.ownerPath, Buffer.from(`${JSON.stringify(readyOwner, null, 2)}\n`), paths.ownerDirectory);
        }
        catch (error) {
            await close().catch(() => undefined);
            throw error;
        }
    })();
    readyPromise.catch((error) => { closeReject(error); });
    return {
        paths,
        ready: readyPromise,
        closed: closedPromise,
        close
    };
}
