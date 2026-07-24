#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const excludedDirectories = new Set([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "output",
]);

const errors = [];
const stats = {
  anchorsChecked: 0,
  files: 0,
  linksChecked: 0,
  mermaidBlocks: 0,
};

function relative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function addError(filePath, lineNumber, category, message) {
  const location = lineNumber ? `${relative(filePath)}:${lineNumber}` : relative(filePath);
  errors.push(`${location} [${category}] ${message}`);
}

function findMarkdownFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(entryPath);
    }
  }

  return files;
}

function githubSlugBase(rawHeading) {
  const withoutMarkdown = rawHeading
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, "")
    .trim()
    .toLowerCase();

  return withoutMarkdown
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function collectAnchors(lines) {
  const anchors = new Set();
  const duplicateCounts = new Map();

  function addHeading(rawHeading) {
    const base = githubSlugBase(rawHeading);
    const duplicateCount = duplicateCounts.get(base) ?? 0;
    duplicateCounts.set(base, duplicateCount + 1);
    anchors.add(duplicateCount === 0 ? base : `${base}-${duplicateCount}`);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const atx = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (atx) {
      addHeading(atx[1]);
    } else if (
      line.trim() &&
      index + 1 < lines.length &&
      /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1])
    ) {
      addHeading(line.trim());
    }

    for (const match of line.matchAll(/\b(?:id|name)=["']([^"']+)["']/gi)) {
      anchors.add(match[1].toLowerCase());
    }
  }

  return anchors;
}

function validateMermaid(filePath, startLine, lines) {
  stats.mermaidBlocks += 1;
  const firstDirective = lines
    .map((line) => line.replace(/%%.*$/, "").trim())
    .find(Boolean);
  if (!/^(?:flowchart|graph)\b/i.test(firstDirective ?? "")) {
    return;
  }

  let balance = 0;
  let subgraphCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const statement = lines[index].replace(/%%.*$/, "").trim();
    if (/^subgraph(?:\s|$)/i.test(statement)) {
      balance += 1;
      subgraphCount += 1;
    } else if (/^end\s*;?$/i.test(statement)) {
      balance -= 1;
      if (balance < 0) {
        addError(
          filePath,
          startLine + index,
          "mermaid",
          "subgraph보다 먼저 닫히는 end가 있습니다.",
        );
        balance = 0;
      }
    }
  }

  if (subgraphCount > 0 && balance !== 0) {
    addError(
      filePath,
      startLine,
      "mermaid",
      `subgraph/end가 ${balance > 0 ? `${balance}개 덜 닫혔습니다` : `${-balance}개 더 닫혔습니다`}.`,
    );
  }
}

function parseFences(filePath, text) {
  const lines = text.split(/\r?\n/);
  const visibleLines = Array(lines.length).fill("");
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);

    if (!fence) {
      if (!marker) {
        visibleLines[index] = line;
        continue;
      }

      const info = marker[2].trim().split(/\s+/, 1)[0].toLowerCase();
      fence = {
        character: marker[1][0],
        content: [],
        info,
        length: marker[1].length,
        startLine: index + 1,
      };
      continue;
    }

    const closesFence =
      marker &&
      marker[1][0] === fence.character &&
      marker[1].length >= fence.length &&
      marker[2].trim() === "";

    if (closesFence) {
      if (fence.info === "mermaid") {
        validateMermaid(filePath, fence.startLine + 1, fence.content);
      }
      fence = null;
    } else {
      fence.content.push(line);
    }
  }

  if (fence) {
    addError(
      filePath,
      fence.startLine,
      "fence",
      `${fence.character.repeat(fence.length)} code fence가 닫히지 않았습니다.`,
    );
  }

  return visibleLines;
}

function stripInlineCode(line) {
  return line.replace(/(`+)(.*?)\1/g, "");
}

function extractInlineLinks(line) {
  const links = [];
  const source = stripInlineCode(line);

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "[" || source[index - 1] === "\\") {
      continue;
    }

    let bracketDepth = 1;
    let closeBracket = index + 1;
    for (; closeBracket < source.length && bracketDepth > 0; closeBracket += 1) {
      if (source[closeBracket] === "\\" && closeBracket + 1 < source.length) {
        closeBracket += 1;
      } else if (source[closeBracket] === "[") {
        bracketDepth += 1;
      } else if (source[closeBracket] === "]") {
        bracketDepth -= 1;
      }
    }

    if (bracketDepth !== 0) {
      continue;
    }

    let openParenthesis = closeBracket;
    while (source[openParenthesis] === " " || source[openParenthesis] === "\t") {
      openParenthesis += 1;
    }
    if (source[openParenthesis] !== "(") {
      continue;
    }

    let parenthesisDepth = 1;
    let closeParenthesis = openParenthesis + 1;
    for (
      ;
      closeParenthesis < source.length && parenthesisDepth > 0;
      closeParenthesis += 1
    ) {
      const character = source[closeParenthesis];
      if (character === "\\" && closeParenthesis + 1 < source.length) {
        closeParenthesis += 1;
      } else if (character === "(") {
        parenthesisDepth += 1;
      } else if (character === ")") {
        parenthesisDepth -= 1;
      }
    }

    if (parenthesisDepth === 0) {
      links.push(source.slice(openParenthesis + 1, closeParenthesis - 1));
      index = closeParenthesis - 1;
    }
  }

  return links;
}

function linkDestination(rawTarget) {
  const target = rawTarget.trim();
  if (!target) {
    return "";
  }
  if (target.startsWith("<")) {
    const end = target.indexOf(">");
    return end === -1 ? target.slice(1) : target.slice(1, end);
  }

  let escaped = false;
  for (let index = 0; index < target.length; index += 1) {
    if (escaped) {
      escaped = false;
    } else if (target[index] === "\\") {
      escaped = true;
    } else if (/\s/.test(target[index])) {
      return target.slice(0, index);
    }
  }
  return target;
}

function decodeLinkPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function targetParts(destination) {
  const hashIndex = destination.indexOf("#");
  const filePart = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const anchorPart = hashIndex === -1 ? "" : destination.slice(hashIndex + 1);
  const queryIndex = filePart.indexOf("?");

  return {
    anchor: decodeLinkPart(anchorPart).toLowerCase(),
    file: decodeLinkPart(queryIndex === -1 ? filePart : filePart.slice(0, queryIndex)),
  };
}

function isExternalLink(destination) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(destination) ||
    destination.startsWith("//")
  );
}

function hasExactPathCase(targetPath) {
  const repositoryRelativePath = path.relative(repoRoot, targetPath);
  if (!repositoryRelativePath) {
    return true;
  }

  let currentPath = repoRoot;
  for (const segment of repositoryRelativePath.split(path.sep)) {
    if (!readdirSync(currentPath).some((entry) => entry === segment)) {
      return false;
    }
    currentPath = path.join(currentPath, segment);
  }
  return true;
}

function validateLink(filePath, lineNumber, rawTarget, anchorIndex) {
  const destination = linkDestination(rawTarget).replace(/\\([() ])/g, "$1");
  if (!destination || isExternalLink(destination)) {
    return;
  }

  const parts = targetParts(destination);
  const targetPath = parts.file
    ? parts.file.startsWith("/")
      ? path.resolve(repoRoot, `.${parts.file}`)
      : path.resolve(path.dirname(filePath), parts.file)
    : filePath;

  stats.linksChecked += 1;
  const repositoryRelativePath = path.relative(repoRoot, targetPath);
  if (
    repositoryRelativePath === ".." ||
    repositoryRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(repositoryRelativePath)
  ) {
    addError(filePath, lineNumber, "link", `저장소 밖을 가리킵니다: ${destination}`);
    return;
  }

  if (!existsSync(targetPath)) {
    addError(filePath, lineNumber, "link", `대상 파일이 없습니다: ${destination}`);
    return;
  }
  if (!hasExactPathCase(targetPath)) {
    addError(filePath, lineNumber, "link", `대상 경로의 대소문자가 다릅니다: ${destination}`);
    return;
  }

  if (!parts.anchor || lstatSync(targetPath).isDirectory()) {
    return;
  }

  if (path.extname(targetPath).toLowerCase() !== ".md") {
    return;
  }

  stats.anchorsChecked += 1;
  const anchors = anchorIndex.get(path.resolve(targetPath));
  if (!anchors?.has(parts.anchor)) {
    addError(filePath, lineNumber, "anchor", `대상 heading이 없습니다: ${destination}`);
  }
}

function scanTextPatterns(filePath, text) {
  const lines = text.split(/\r?\n/);
  const personalPathPatterns = [
    /(?:^|[\s"'`(=])(?:file:\/\/)?\/Users\/(?!<|USER(?:NAME)?\b|your[-_])/,
    /(?:^|[\s"'`(=])(?:file:\/\/)?\/home\/(?!<|USER(?:NAME)?\b|your[-_])[^/\s]+(?:\/|$)/,
    /(?:^|[\s"'`(=])(?:file:\/\/)?\/var\/folders\/[^/\s]+\/[^/\s]+(?:\/|$)/,
    /(?:^|[\s"'`(=])[a-z]:\\Users\\(?!<|USER(?:NAME)?\b|your[-_])/i,
    /(?:^|[\s"'`(=])[a-z]:\\[^<\r\n]*\\AskLake2?\\/i,
  ];
  const hardMojibakePattern =
    /(?:\uFFFD|[\u0080-\u009F]|臾몄|吏|紐⑺|寃利|쒕쾲|댁슜|몄텧|媛쒕)/;
  const latin1MojibakePattern = /(?:Ã.|Â.|â(?:€|€™|€œ|€)|ðŸ)/g;

  for (let index = 0; index < lines.length; index += 1) {
    if (personalPathPatterns.some((pattern) => pattern.test(lines[index]))) {
      addError(filePath, index + 1, "path", "개인 절대 경로가 포함되어 있습니다.");
    }
    const latin1Matches = lines[index].match(latin1MojibakePattern) ?? [];
    if (hardMojibakePattern.test(lines[index]) || latin1Matches.length >= 2) {
      addError(filePath, index + 1, "mojibake", "대표적인 깨진 인코딩 패턴이 있습니다.");
    }
  }
}

const markdownFiles = findMarkdownFiles(repoRoot).sort();
stats.files = markdownFiles.length;

const documents = new Map();
const anchorIndex = new Map();
const duplicateIndex = new Map();

for (const filePath of markdownFiles) {
  const bytes = readFileSync(filePath);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    addError(filePath, 0, "encoding", "유효한 UTF-8 문서가 아닙니다.");
    text = bytes.toString("utf8");
  }
  const visibleLines = parseFences(filePath, text);
  const resolvedPath = path.resolve(filePath);
  documents.set(resolvedPath, { text, visibleLines });
  anchorIndex.set(resolvedPath, collectAnchors(visibleLines));
  scanTextPatterns(filePath, text);

  const duplicateContent = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const digest = createHash("sha256").update(duplicateContent).digest("hex");
  const duplicates = duplicateIndex.get(digest) ?? [];
  duplicates.push(filePath);
  duplicateIndex.set(digest, duplicates);
}

for (const [filePath, document] of documents) {
  for (let index = 0; index < document.visibleLines.length; index += 1) {
    const line = document.visibleLines[index];
    for (const rawTarget of extractInlineLinks(line)) {
      validateLink(filePath, index + 1, rawTarget, anchorIndex);
    }

    const referenceDefinition = line.match(
      /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/,
    );
    if (referenceDefinition) {
      validateLink(
        filePath,
        index + 1,
        referenceDefinition[1] ?? referenceDefinition[2],
        anchorIndex,
      );
    }
  }
}

for (const duplicateFiles of duplicateIndex.values()) {
  if (duplicateFiles.length < 2) {
    continue;
  }
  const names = duplicateFiles.map(relative).sort();
  errors.push(`[duplicate] 완전히 동일한 Markdown: ${names.join(", ")}`);
}

if (errors.length > 0) {
  console.error(`문서 검사 실패: ${errors.length}개 문제`);
  for (const error of errors.sort()) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `문서 검사 통과: Markdown ${stats.files}개, 로컬 링크 ${stats.linksChecked}개, heading anchor ${stats.anchorsChecked}개, Mermaid ${stats.mermaidBlocks}개`,
  );
}
