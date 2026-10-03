#!/usr/bin/env node
// Structural conventions use the already pinned compiler, never generated text assertions.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../Atlas SDK/node_modules/typescript/lib/typescript.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scopes = ["Atlas SDK/src", "Atlas SDK/checks", "tests/contract"];

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["generated", "node_modules", "dist"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function unparenthesized(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function assertion(node) {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function constAssertion(node) {
  return assertion(node) && ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === "const";
}

function castOnly(node) {
  if (!node.body) return false;
  let value = node.body;
  if (ts.isBlock(value)) {
    if (value.statements.length !== 1 || !ts.isReturnStatement(value.statements[0])) return false;
    value = value.statements[0].expression;
    if (!value) return false;
  }
  value = unparenthesized(value);
  let cast = false;
  while (assertion(value) || ts.isNonNullExpression(value)) {
    if (constAssertion(value)) return false;
    cast = true;
    value = unparenthesized(value.expression);
  }
  return cast && ts.isIdentifier(value) && node.parameters.some((parameter) =>
    ts.isIdentifier(parameter.name) && parameter.name.text === value.text);
}

function lint(path) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const name = relative(root, path).replaceAll("\\", "/");
  const negativeTypeTest = name.endsWith(".type-test.ts") &&
    (name.startsWith("Atlas SDK/checks/") || name.startsWith("tests/contract/"));
  const findings = [];
  const comments = new Map();
  function report(position, rule) {
    const { line, character } = source.getLineAndCharacterOfPosition(position);
    findings.push(`${name}:${line + 1}:${character + 1}: ${rule}`);
  }
  function visit(node) {
    for (const range of [...ts.getLeadingCommentRanges(source.text, node.pos) ?? [],
      ...ts.getTrailingCommentRanges(source.text, node.end) ?? []]) comments.set(range.pos, range);
    if (node.kind === ts.SyntaxKind.AnyKeyword) report(node.getStart(source), "explicit any is prohibited");
    if (assertion(node) && !constAssertion(node)) {
      const inner = unparenthesized(node.expression);
      if (assertion(inner) && !constAssertion(inner)) report(node.getStart(source), "double assertions are prohibited");
    }
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && castOnly(node)) {
      report(node.getStart(source), "cast-only functions are prohibited");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const comment of comments.values()) {
    for (const directive of source.text.slice(comment.pos, comment.end).matchAll(/@ts-(ignore|nocheck|expect-error)\b/g)) {
      if (directive[1] !== "expect-error" || !negativeTypeTest) {
        report(comment.pos + directive.index, "type-error suppression is prohibited outside negative type tests");
      }
    }
  }
  return findings;
}

const files = process.argv.length > 2 ? process.argv.slice(2).map((path) => resolve(path)) :
  scopes.flatMap((scope) => sources(join(root, scope))).sort();
const findings = files.flatMap(lint);
if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`PASS TypeScript structural conventions: ${files.length} handwritten files`);
}
