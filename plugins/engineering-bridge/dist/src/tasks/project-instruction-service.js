import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { CoreError } from "../core/errors.js";
const MAX_ROOT_ENTRIES = 256;
const MAX_INSTRUCTION_BYTES = 128 * 1024;
const PROJECT_EVIDENCE_VERSION = 1;
const MANAGED_BLOCK_BEGIN = `<!-- BEGIN engineering-bridge-project-evidence:v${PROJECT_EVIDENCE_VERSION} -->`;
const MANAGED_BLOCK_END = `<!-- END engineering-bridge-project-evidence:v${PROJECT_EVIDENCE_VERSION} -->`;
const MANAGED_BLOCK_TOKEN = "engineering-bridge-project-evidence:";
const MANAGED_BLOCK_MARKER = /<!-- (BEGIN|END) engineering-bridge-project-evidence:v([1-9][0-9]*) -->/gu;
const execFileAsync = promisify(execFile);
const MANIFEST_NAMES = [
    "package.json", "pyproject.toml", "Makefile", "makefile", "Cargo.toml", "go.mod",
    "pom.xml", "build.gradle", "build.gradle.kts", "Package.swift"
];
const PORTABILITY_CONFLICT = /(?:\/Users\/|workspace[_ -]?id|gpt-\d|reasoning\s*(?:=|:)|secure mcp tunnel|controlled apply)/iu;
const SECRET_RISK = /(?:(?:api[_ -]?key|token)\s*(?:=|:)\s*["']?[A-Za-z0-9_./+-]{12,}|authorization:\s*bearer\s+\S+|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/iu;
export class ProjectInstructionService {
    registry;
    catalog;
    controlledPatches;
    constructor(registry, catalog, controlledPatches) {
        this.registry = registry;
        this.catalog = catalog;
        this.controlledPatches = controlledPatches;
    }
    async prepare(workspaceId) {
        const root = this.registry.resolve(workspaceId);
        const record = this.catalog.get(workspaceId);
        if (record === undefined)
            throw new CoreError("UNKNOWN_WORKSPACE");
        await requireCanonicalDirectory(root);
        const evidence = await collectEvidence(root);
        let existing;
        try {
            existing = await Promise.all([
                readInstruction(root, "AGENTS.md"),
                readInstruction(root, "PLANS.md")
            ]);
        }
        catch {
            return hold(workspaceId, evidence, "UNSAFE_INSTRUCTION_TARGET");
        }
        if (record.workspaceType === "git_workspace" &&
            (await Promise.all(existing.filter(({ content }) => content !== undefined)
                .map(({ path }) => isGitTracked(root, path)))).some((tracked) => !tracked)) {
            return hold(workspaceId, evidence, "UNSAFE_INSTRUCTION_TARGET");
        }
        const managed = existing.map(({ content }) => content === undefined
            ? { status: "absent" }
            : parseManagedBlock(content));
        if (managed.some(({ status }) => status === "invalid")) {
            return hold(workspaceId, evidence, "AMBIGUOUS_MANAGED_BLOCK");
        }
        const conflict = existing.some(({ content }, index) => content !== undefined &&
            hasInstructionConflict(contentOutsideManagedBlock(content, managed[index])));
        if (conflict)
            return hold(workspaceId, evidence, "EXISTING_INSTRUCTION_CONFLICT");
        const targets = existing.flatMap((instruction, index) => {
            const block = instruction.path === "AGENTS.md"
                ? agentsManagedBlock(evidence)
                : plansManagedBlock(evidence);
            const state = managed[index];
            if (state.status === "valid" && state.content === block)
                return [];
            const content = instruction.content === undefined
                ? newInstructionContent(instruction.path, block)
                : state.status === "valid"
                    ? replaceManagedBlock(instruction.content, state, block)
                    : appendManagedBlock(instruction.content, block);
            return [{
                    path: instruction.path,
                    operation: instruction.content === undefined ? "create" : "modify",
                    ...(instruction.content === undefined ? {} : { before_sha256: sha256(instruction.content) }),
                    content
                }];
        });
        if (targets.length === 0)
            return summary("ALREADY_CURRENT", workspaceId, evidence, []);
        const proposal = await this.controlledPatches.generateProjectInstructions({
            workspace_id: workspaceId,
            evidence_sha256: evidence.digest,
            targets
        });
        return {
            ...summary("READY", workspaceId, evidence, targets.map(({ path }) => path)),
            task_id: proposal.taskId,
            base_head: proposal.baseHead
        };
    }
}
function hold(workspaceId, evidence, reason) {
    return { ...summary("HOLD_NEEDS_PROJECT_DECISION", workspaceId, evidence, []), hold_reason: reason };
}
function summary(status, workspaceId, evidence, targets) {
    return {
        status,
        workspace_id: workspaceId,
        evidence_sha256: evidence.digest,
        audited_files: evidence.auditedFiles,
        evidenced_commands: evidence.commands,
        proposed_targets: targets
    };
}
async function collectEvidence(root) {
    const entries = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => !entry.isSymbolicLink() && entry.name !== ".git" &&
        entry.name !== "AGENTS.md" && entry.name !== "PLANS.md")
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort()
        .slice(0, MAX_ROOT_ENTRIES);
    const auditedFiles = [];
    let packageJson;
    const presentManifests = [];
    for (const name of MANIFEST_NAMES) {
        const source = await readBoundedOrdinaryFile(root, name);
        if (source === undefined)
            continue;
        auditedFiles.push(name);
        presentManifests.push(name);
        if (name === "package.json") {
            try {
                const value = JSON.parse(source);
                if (isObject(value))
                    packageJson = value;
            }
            catch {
                throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
            }
        }
    }
    const commands = evidencedCommands(packageJson, entries, await readBoundedOrdinaryFile(root, "Makefile") ??
        await readBoundedOrdinaryFile(root, "makefile"));
    const purpose = typeof packageJson?.description === "string" && packageJson.description.trim() !== "" &&
        !PORTABILITY_CONFLICT.test(packageJson.description) && !SECRET_RISK.test(packageJson.description)
        ? packageJson.description.trim()
        : "Repository purpose is not established by bounded root-level evidence.";
    const technology = technologySummary(presentManifests, packageJson);
    const digest = sha256(`${JSON.stringify({ purpose, technology, entries, presentManifests, commands })}\n`);
    return { purpose, technology, rootEntries: entries, auditedFiles, commands, digest };
}
function evidencedCommands(packageJson, entries, makefile) {
    const commands = new Set();
    if (packageJson !== undefined && isObject(packageJson.scripts)) {
        const manager = packageManager(packageJson, entries);
        for (const name of Object.keys(packageJson.scripts).sort()) {
            if (/^(?:test|build|lint|typecheck|type-check|check|format(?::check)?)$/u.test(name) &&
                typeof packageJson.scripts[name] === "string") {
                commands.add(manager === "npm" && name !== "test" ? `npm run ${name}` : `${manager} ${name}`);
            }
        }
    }
    if (makefile !== undefined) {
        for (const line of makefile.split(/\r?\n/u)) {
            const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?:\s|$)/u.exec(line);
            if (match !== null && /^(?:test|build|lint|typecheck|check|format)$/u.test(match[1])) {
                commands.add(`make ${match[1]}`);
            }
        }
    }
    return [...commands].sort();
}
function packageManager(packageJson, entries) {
    if (typeof packageJson.packageManager === "string") {
        if (packageJson.packageManager.startsWith("pnpm@"))
            return "pnpm";
        if (packageJson.packageManager.startsWith("yarn@"))
            return "yarn";
    }
    if (entries.includes("pnpm-lock.yaml"))
        return "pnpm";
    if (entries.includes("yarn.lock"))
        return "yarn";
    return "npm";
}
function technologySummary(manifests, packageJson) {
    const facts = [];
    if (manifests.includes("package.json"))
        facts.push("Node.js package metadata (package.json)");
    if (manifests.includes("pyproject.toml"))
        facts.push("Python project metadata (pyproject.toml)");
    if (manifests.includes("Cargo.toml"))
        facts.push("Rust package metadata (Cargo.toml)");
    if (manifests.includes("go.mod"))
        facts.push("Go module metadata (go.mod)");
    if (manifests.some((name) => name === "pom.xml" || name.startsWith("build.gradle")))
        facts.push("JVM build metadata");
    if (manifests.includes("Package.swift"))
        facts.push("Swift package metadata (Package.swift)");
    if (packageJson !== undefined) {
        const dependencies = [packageJson.dependencies, packageJson.devDependencies]
            .filter(isObject).flatMap((value) => Object.keys(value));
        for (const framework of ["next", "react", "vue", "svelte", "vite", "typescript"]) {
            if (dependencies.includes(framework))
                facts.push(`${framework} dependency`);
        }
    }
    return facts.length === 0 ? "Primary language/framework is not established by bounded root-level evidence."
        : [...new Set(facts)].join("; ");
}
function agentsManagedBlock(evidence) {
    const rootEntries = evidence.rootEntries.length === 0
        ? "- No ordinary root entries were observed."
        : evidence.rootEntries.slice(0, 32).map((path) => `- \`${escapeMarkdown(path)}\` — observed root entry; inspect before expanding scope.`).join("\n");
    const commands = evidence.commands.length === 0
        ? "# No reliable build/test/lint/typecheck command is evidenced by the bounded manifests."
        : evidence.commands.join("\n");
    return `${MANAGED_BLOCK_BEGIN}\n<!-- evidence-sha256:${evidence.digest} -->\n\n## Project facts\n\n- Purpose: ${escapeMarkdown(evidence.purpose)}\n- Primary language/framework: ${escapeMarkdown(evidence.technology)}\n\n## Repository map\n\n${rootEntries}\n\n## Required commands\n\n\`\`\`bash\n${commands}\n\`\`\`\n\nUse the narrowest relevant evidenced check first. Treat missing command evidence as a blocker to claiming verification, not permission to invent a command.\n\n## Engineering rules\n\n- Preserve existing public behavior unless the task explicitly changes it.\n- Prefer the smallest coherent change; do not perform unrelated cleanup.\n- Keep one writer for overlapping files.\n- Keep writes inside the active repository/workspace and follow the active execution policy.\n\n## Forbidden or approval-required areas\n\n- Secrets, generated outputs, migrations, production configuration, destructive actions, dependency changes, releases, and remote operations require explicit approval.\n\n## Definition of done\n\n- The requested behavior is complete.\n- Relevant evidenced checks pass, or exact blockers are recorded.\n- The change contains no unrelated edits.\n\n## Escalation\n\nStop and report when evidence conflicts, scope materially expands, or no objective verification is available.\n${MANAGED_BLOCK_END}`;
}
function plansManagedBlock(evidence) {
    return `${MANAGED_BLOCK_BEGIN}\n<!-- evidence-sha256:${evidence.digest} -->\n\n## Objective\n\n## User-visible outcome\n\n## Evidence and current behavior\n\n- Project evidence digest: \`${evidence.digest}\`\n\n## Approved design\n\n## Scope\n\n### Allowed\n\n### Forbidden\n\n## Invariants\n\n## Ordered milestones\n\n1. \n2. \n3. \n\n## Verification\n\n## Checkpoints\n\n## Escalation conditions\n\n## Decisions made\n\n| Date | Decision | Reason | Evidence |\n|---|---|---|---|\n\n## Status\n\n## Remaining risks\n${MANAGED_BLOCK_END}`;
}
function newInstructionContent(path, block) {
    const prefix = path === "AGENTS.md"
        ? "# AGENTS.md\n\n"
        : "# PLANS.md\n\nUse this file for long or multi-stage work. Keep it current; do not paste raw logs.\n\n";
    return `${prefix}${block}\n`;
}
function appendManagedBlock(existing, block) {
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${block}\n`;
}
function replaceManagedBlock(existing, current, replacement) {
    return `${existing.slice(0, current.start)}${replacement}${existing.slice(current.end)}`;
}
function parseManagedBlock(content) {
    if (!content.includes(MANAGED_BLOCK_TOKEN))
        return { status: "absent" };
    const tokenCount = content.split(MANAGED_BLOCK_TOKEN).length - 1;
    const markers = [...content.matchAll(MANAGED_BLOCK_MARKER)];
    if (tokenCount !== 2 || markers.length !== 2)
        return { status: "invalid" };
    const [begin, end] = markers;
    if (begin?.[1] !== "BEGIN" || end?.[1] !== "END" ||
        begin[2] !== String(PROJECT_EVIDENCE_VERSION) || end[2] !== String(PROJECT_EVIDENCE_VERSION) ||
        begin.index === undefined || end.index === undefined || begin.index >= end.index ||
        begin[0] !== MANAGED_BLOCK_BEGIN || end[0] !== MANAGED_BLOCK_END) {
        return { status: "invalid" };
    }
    const blockEnd = end.index + end[0].length;
    return {
        status: "valid",
        start: begin.index,
        end: blockEnd,
        content: content.slice(begin.index, blockEnd)
    };
}
function contentOutsideManagedBlock(content, block) {
    return block.status === "valid"
        ? `${content.slice(0, block.start)}${content.slice(block.end)}`
        : content;
}
function hasInstructionConflict(content) {
    return PORTABILITY_CONFLICT.test(content) || SECRET_RISK.test(content);
}
async function readInstruction(root, path) {
    return { path, content: await readBoundedOrdinaryFile(root, path) };
}
async function readBoundedOrdinaryFile(root, relativePath) {
    const target = resolve(root, relativePath);
    if (target !== join(root, relativePath) || posix.normalize(relativePath) !== relativePath) {
        throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
    try {
        const metadata = await lstat(target);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_INSTRUCTION_BYTES) {
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        }
        const canonical = await realpath(target);
        if (canonical !== target)
            throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
        const content = await readFile(target, "utf8");
        if (content.includes("\uFFFD") || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(content)) {
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        }
        return content;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function requireCanonicalDirectory(root) {
    const [canonical, metadata] = await Promise.all([realpath(root), lstat(root)]);
    if (canonical !== root || !metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function escapeMarkdown(value) {
    return value.replace(/[\r\n`]/gu, " ").trim();
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function isGitTracked(root, path) {
    try {
        await execFileAsync("git", ["ls-files", "--error-unmatch", "--", path], {
            cwd: root,
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" },
            maxBuffer: 64 * 1024
        });
        return true;
    }
    catch {
        return false;
    }
}
