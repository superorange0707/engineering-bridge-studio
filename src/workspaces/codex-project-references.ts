import { readFile, realpath } from "node:fs/promises";
import { basename } from "node:path";

import { CoreError } from "../core/errors.js";

export interface CodexProjectReference {
  readonly path: string;
  readonly trustLevel?: string | undefined;
}

export async function readCodexProjectReferences(configPath: string): Promise<readonly CodexProjectReference[]> {
  if (basename(configPath) !== "config.toml") throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  const canonical = await realpath(configPath);
  if (basename(canonical) !== "config.toml") throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  return parseCodexProjectReferences(await readFile(canonical, "utf8"));
}

export function parseCodexProjectReferences(source: string): readonly CodexProjectReference[] {
  const references: CodexProjectReference[] = [];
  let current: { path: string; trustLevel?: string } | undefined;
  const flush = (): void => {
    if (current !== undefined) references.push(current);
    current = undefined;
  };

  for (const line of source.split(/\r?\n/)) {
    const section = /^\s*\[projects\.("(?:[^"\\]|\\.)*"|'[^']*')\]\s*(?:#.*)?$/.exec(line);
    if (section !== null) {
      flush();
      try {
        const literal = section[1]!;
        current = { path: literal.startsWith('"') ? JSON.parse(literal) as string : literal.slice(1, -1) };
      } catch {
        current = undefined;
      }
      continue;
    }
    if (/^\s*\[/.test(line)) {
      flush();
      continue;
    }
    if (current !== undefined) {
      const trust = /^\s*trust_level\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(line);
      if (trust !== null) current.trustLevel = trust[1]!;
    }
  }
  flush();
  return references;
}
