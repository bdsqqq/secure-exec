#!/usr/bin/env -S tsx

import { readFile } from "node:fs/promises";
import path from "node:path";

type ImportReplacement = {
  from: string;
  to: string;
};

type TitledBlocksConfig = {
  kind: "titledBlocks";
  docsPath: string;
  entries: Array<{
    title: string;
    examplePath: string;
  }>;
  importReplacements?: ImportReplacement[];
};

type FirstTsBlockConfig = {
  kind: "firstTsBlock";
  docsPath: string;
  examplePath: string;
  importReplacements?: ImportReplacement[];
};

type MultiFirstTsBlockConfig = {
  kind: "multiFirstTsBlock";
  entries: Array<{
    docsPath: string;
    examplePath: string;
  }>;
  importReplacements?: ImportReplacement[];
};

type NamedTsBlockConfig = {
  kind: "namedTsBlock";
  docsPath: string;
  title: string;
  examplePath: string;
  importReplacements?: ImportReplacement[];
};

type ContainsConfig = {
  kind: "contains";
  docsPath: string;
  required: string[];
};

type VerifyConfig =
  | TitledBlocksConfig
  | FirstTsBlockConfig
  | MultiFirstTsBlockConfig
  | NamedTsBlockConfig
  | ContainsConfig;

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== "verify") {
    throw new Error('Usage: docs-gen verify --config <path>');
  }

  const configIndex = rest.indexOf("--config");
  if (configIndex === -1 || !rest[configIndex + 1]) {
    throw new Error('Missing required flag: --config <path>');
  }

  return {
    configPath: rest[configIndex + 1],
  };
}

function normalizeTitle(title: string) {
  return title.trim().replace(/^"|"$/g, "");
}

function normalizeCode(source: string) {
  const normalized = source.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  const lines = normalized.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const minIndent = nonEmptyLines.reduce((indent, line) => {
    const lineIndent = line.match(/^ */)?.[0].length ?? 0;
    return Math.min(indent, lineIndent);
  }, Number.POSITIVE_INFINITY);

  if (!Number.isFinite(minIndent) || minIndent === 0) {
    return normalized;
  }

  return lines.map((line) => line.slice(minIndent)).join("\n");
}

function normalizeImports(source: string, replacements: ImportReplacement[] = []) {
  return replacements.reduce(
    (result, replacement) => result.replaceAll(replacement.from, replacement.to),
    source,
  );
}

function getFirstTsBlock(source: string) {
  const match = source.match(/^\s*```ts(?: [^\n]+)?\n([\s\S]*?)^\s*```/m);
  if (!match?.[1]) {
    return null;
  }

  return normalizeCode(match[1]);
}

function getNamedTsBlock(source: string, expectedTitle: string) {
  const blockPattern = /^\s*```ts(?:\s+([^\n]+))?\n([\s\S]*?)^\s*```/gm;
  for (const match of source.matchAll(blockPattern)) {
    const rawTitle = match[1];
    if (!rawTitle) continue;
    if (normalizeTitle(rawTitle) !== expectedTitle) continue;
    return normalizeCode(match[2] ?? "");
  }
  return null;
}

async function verifyTitledBlocks(configDir: string, config: TitledBlocksConfig) {
  const docsSource = await readFile(path.resolve(configDir, config.docsPath), "utf8");
  const blockPattern = /^\s*```ts(?:\s+([^\n]+))?\n([\s\S]*?)^\s*```/gm;
  const docBlocks = new Map<string, string>();

  for (const match of docsSource.matchAll(blockPattern)) {
    const rawTitle = match[1];
    if (!rawTitle) continue;

    const title = normalizeTitle(rawTitle);
    if (!config.entries.some((entry) => entry.title === title)) {
      continue;
    }

    docBlocks.set(title, normalizeCode(match[2] ?? ""));
  }

  const mismatches: string[] = [];

  for (const entry of config.entries) {
    const examplePath = path.resolve(configDir, entry.examplePath);
    const exampleSource = await readFile(examplePath, "utf8");
    const normalizedExample = normalizeCode(
      normalizeImports(exampleSource, config.importReplacements),
    );
    const docSource = docBlocks.get(entry.title);

    if (!docSource) {
      mismatches.push(`Missing docs snippet for ${entry.title}`);
      continue;
    }

    if (docSource !== normalizedExample) {
      mismatches.push(`Snippet mismatch for ${entry.title}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(mismatches.join("\n"));
  }
}

async function verifyFirstTsBlock(configDir: string, config: FirstTsBlockConfig) {
  const docsSource = await readFile(path.resolve(configDir, config.docsPath), "utf8");
  const exampleSource = await readFile(path.resolve(configDir, config.examplePath), "utf8");
  const docBlock = getFirstTsBlock(docsSource);
  const normalizedExample = normalizeCode(
    normalizeImports(exampleSource, config.importReplacements),
  );

  if (!docBlock) {
    throw new Error(`Missing TypeScript example in ${config.docsPath}`);
  }

  if (docBlock !== normalizedExample) {
    throw new Error(`Snippet mismatch: ${config.docsPath}`);
  }
}

async function verifyMultiFirstTsBlock(
  configDir: string,
  config: MultiFirstTsBlockConfig,
) {
  const mismatches: string[] = [];

  for (const entry of config.entries) {
    const docsSource = await readFile(path.resolve(configDir, entry.docsPath), "utf8");
    const exampleSource = await readFile(
      path.resolve(configDir, entry.examplePath),
      "utf8",
    );
    const docBlock = getFirstTsBlock(docsSource);
    const normalizedExample = normalizeCode(
      normalizeImports(exampleSource, config.importReplacements),
    );

    if (!docBlock) {
      mismatches.push(`Missing TypeScript example in ${entry.docsPath}`);
      continue;
    }

    if (docBlock !== normalizedExample) {
      mismatches.push(`Snippet mismatch: ${entry.docsPath}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(mismatches.join("\n"));
  }
}

async function verifyNamedTsBlock(configDir: string, config: NamedTsBlockConfig) {
  const docsSource = await readFile(path.resolve(configDir, config.docsPath), "utf8");
  const exampleSource = await readFile(path.resolve(configDir, config.examplePath), "utf8");
  const docBlock = getNamedTsBlock(docsSource, config.title);
  const normalizedExample = normalizeCode(
    normalizeImports(exampleSource, config.importReplacements),
  );

  if (!docBlock) {
    throw new Error(`Missing docs snippet for ${config.title}`);
  }

  if (docBlock !== normalizedExample) {
    throw new Error(`Snippet mismatch for ${config.title}`);
  }
}

async function verifyContains(configDir: string, config: ContainsConfig) {
  const docsSource = await readFile(path.resolve(configDir, config.docsPath), "utf8");
  const missing = config.required.filter((value) => !docsSource.includes(value));
  if (missing.length > 0) {
    throw new Error(
      `${config.docsPath} missing required content:\n${missing.join("\n")}`,
    );
  }
}

async function main() {
  const { configPath } = parseArgs(process.argv.slice(2));
  const resolvedConfigPath = path.resolve(process.cwd(), configPath);
  const configDir = path.dirname(resolvedConfigPath);
  const config = JSON.parse(await readFile(resolvedConfigPath, "utf8")) as VerifyConfig;

  switch (config.kind) {
    case "titledBlocks":
      await verifyTitledBlocks(configDir, config);
      break;
    case "firstTsBlock":
      await verifyFirstTsBlock(configDir, config);
      break;
    case "multiFirstTsBlock":
      await verifyMultiFirstTsBlock(configDir, config);
      break;
    case "namedTsBlock":
      await verifyNamedTsBlock(configDir, config);
      break;
    case "contains":
      await verifyContains(configDir, config);
      break;
    default:
      throw new Error("Unsupported docs-gen config");
  }

  console.log(`Docs verified: ${path.relative(process.cwd(), resolvedConfigPath)}`);
}

await main();
