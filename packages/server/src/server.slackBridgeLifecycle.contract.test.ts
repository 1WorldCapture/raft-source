import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import ts from "typescript";

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile(
  "server.ts",
  serverSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function callsMethod(node: ts.Node, receiver: string, method: string): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  return ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === receiver
    && node.expression.name.text === method;
}

function countCalls(node: ts.Node, receiver: string, method: string): number {
  let count = 0;
  const visit = (child: ts.Node) => {
    if (callsMethod(child, receiver, method)) count += 1;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return count;
}

function findServerListenCallback(): ts.ArrowFunction | ts.FunctionExpression | undefined {
  // server.ts passes the startup callback by reference (const onListening =
  // () => {...}; server.listen(PORT, onListening)), so an Identifier argument
  // must be resolved back to its variable declaration's initializer.
  const listenCallbackName = (): string | undefined => {
    let name: string | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "server"
        && node.expression.name.text === "listen"
      ) {
        // The startup callback is the LAST argument (earlier identifiers are
        // things like the PORT constant — server.listen(PORT, listenHost,
        // onListening) must resolve onListening, not PORT).
        const last = node.arguments[node.arguments.length - 1];
        name = ts.isIdentifier(last) ? last.text : undefined;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return name;
  };

  const callbackName = listenCallbackName();
  if (callbackName === undefined) return undefined;

  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === callbackName
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      callback = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callback;
}

function findShutdownBody(): ts.ConciseBody | undefined {
  let body: ts.ConciseBody | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "shutdown"
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      body = node.initializer.body;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return body;
}

test("production server starts Slack Bridge from the real listen callback", () => {
  const listenCallback = findServerListenCallback();
  assert.ok(listenCallback, "server.listen must keep an explicit startup callback");
  assert.equal(
    countCalls(listenCallback, "slackBridge", "start"),
    1,
    "the production listen callback must start the configured Slack Bridge exactly once",
  );
  assert.equal(countCalls(sourceFile, "slackBridge", "start"), 1);
});

test("production server stops Slack Bridge from the real shutdown path", () => {
  const shutdownBody = findShutdownBody();
  assert.ok(shutdownBody, "server.ts must keep an explicit shutdown path");
  assert.equal(
    countCalls(shutdownBody, "slackBridge", "stop"),
    1,
    "the production shutdown path must stop the configured Slack Bridge exactly once",
  );
  assert.equal(countCalls(sourceFile, "slackBridge", "stop"), 1);
});
