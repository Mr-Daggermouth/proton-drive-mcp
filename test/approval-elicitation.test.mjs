// Approval gate: explicit accept+approve is the only path that may mutate.
// No real Proton session, keyring, or Drive. The fake CLI records argv only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestFormParamsSchema, ElicitRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_FORM,
  THROTTLE_SUMMARY,
  approvalPromptPaused,
  approvalRequest,
  classifyElicitationError,
  classifyElicitationResult,
  consumesPromptBudget,
  elicitationTimeoutMs,
  recordApprovalMiss,
  sanitizeDiagnostic,
} from "../dist/utils/approval.js";
import { makeSandbox, fakeEnv, nonVersionCalls, DIST_INDEX } from "./helpers/mcp-client.mjs";

const BULK_ARGS = { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d", confirmed: true };

function treeFile() {
  const p = join(tmpdir(), `approval-tree-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ "/my-files/s": [{ name: "x.txt", type: "file" }], "/my-files/d": [] }));
  return p;
}

function collisionTree() {
  const p = join(tmpdir(), `approval-collision-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    "/my-files/s": [{ name: "x.txt", type: "file" }],
    "/my-files/d": [{ name: "x.txt", type: "file" }],
  }));
  return p;
}

async function withClient(capabilities, handler, fn, extraEnv = {}) {
  const sb = makeSandbox();
  const client = new Client({ name: "approval-test", version: "0" }, { capabilities });
  if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX],
    env: fakeEnv("tree", sb, { FAKE_TREE: treeFile(), ...extraEnv }),
  });
  await client.connect(transport);
  try { await fn(client, sb); } finally { await client.close(); sb.cleanup(); }
}

const text = (r) => r.content[0].text;
const mutations = (sb) => nonVersionCalls(sb.argvLog).filter((a) => a[1] !== "list");

describe("approval decisions (no I/O)", () => {
  it("the form schema is the flat boolean the SDK accepts, defaulting to not approved", () => {
    const parsed = ElicitRequestFormParamsSchema.safeParse(approvalRequest("Move 1 item?"));
    assert.equal(parsed.success, true);
    assert.equal(APPROVAL_FORM.mode, "form");
    assert.equal(APPROVAL_FORM.requestedSchema.properties.approve.default, false);
    assert.deepEqual(APPROVAL_FORM.requestedSchema.required, ["approve"]);
  });

  it("only action accept with content.approve true is approval", () => {
    const cases = [
      [{ action: "accept", content: { approve: true } }, true, "accept"],
      [{ action: "accept", content: { approve: true, extra: "ignored" } }, true, "accept"],
      [{ action: "decline" }, false, "decline"],
      [{ action: "cancel" }, false, "cancel"],
      [{ action: "accept", content: { approve: false } }, false, "malformed"],
      [{ action: "accept", content: {} }, false, "malformed"],
      [{ action: "accept" }, false, "malformed"],
      [{ action: "accept", content: { approve: "true" } }, false, "malformed"],
      [{ action: "accept", content: { approve: 1 } }, false, "malformed"],
      [{ action: "nope" }, false, "malformed"],
      [null, false, "malformed"],
      ["accept", false, "malformed"],
    ];
    for (const [input, approved, code] of cases) {
      const d = classifyElicitationResult(input);
      assert.equal(d.approved, approved, JSON.stringify(input));
      assert.equal(d.code, code, JSON.stringify(input));
      if (!approved) assert.match(d.summary, /Nothing was changed/);
    }
  });

  it("classifies timeout, cancel, unsupported, malformed, and exception without echoing paths", () => {
    const timeout = classifyElicitationError(new McpError(ErrorCode.RequestTimeout, "Request timed out"));
    assert.equal(timeout.code, "timeout");
    assert.equal(timeout.approved, false);
    assert.match(timeout.summary, /timed out/);

    const aborted = classifyElicitationError(new McpError(ErrorCode.RequestTimeout, "AbortError: The operation was aborted"));
    assert.equal(aborted.code, "cancel");

    const missing = classifyElicitationError(new McpError(ErrorCode.MethodNotFound, "Method not found"));
    assert.equal(missing.code, "unsupported");
    assert.match(missing.summary, /stop advertising elicitation\.form/);

    const unsupported = classifyElicitationError(new Error("Client does not support form elicitation."));
    assert.equal(unsupported.code, "unsupported");

    const schema = classifyElicitationError(new McpError(ErrorCode.InvalidParams, "Elicitation response content does not match requested schema: approve"));
    assert.equal(schema.code, "malformed");
    assert.match(schema.summary, /failed protocol checks/);
    assert.doesNotMatch(schema.summary, /approve/);

    const badAction = classifyElicitationError(new McpError(ErrorCode.InvalidParams, "Invalid elicitation result: /tmp/secret/session.json"));
    assert.equal(badAction.code, "malformed");
    assert.match(badAction.summary, /failed protocol checks/);
    assert.doesNotMatch(badAction.summary, /secret/);

    const zod = classifyElicitationError(Object.assign(new Error("huge"), { name: "ZodError", issues: [{}] }));
    assert.equal(zod.code, "malformed");

    const boom = classifyElicitationError(new Error("boom at /tmp/secret/session.json\n    at Object.handler (/tmp/secret/session.json:4:2)"));
    assert.equal(boom.code, "exception");
    assert.equal(boom.approved, false);
    assert.match(boom.summary, /approval request failed \(boom\)/);
    assert.doesNotMatch(boom.summary, /secret|session\.json|Object\.handler/);
    const wrapped = classifyElicitationError(new McpError(ErrorCode.InternalError, "boom at /tmp/secret/session.json"));
    assert.match(wrapped.summary, /approval request failed \(JSON-RPC -32603: boom\)/);
    assert.doesNotMatch(wrapped.summary, /secret/);
    assert.equal(sanitizeDiagnostic("line1\nline2\u0007"), "line1 line2");
  });

  it("counts decline, cancel, and timeout toward the pause, not protocol failures", () => {
    assert.equal(consumesPromptBudget("decline"), true);
    assert.equal(consumesPromptBudget("cancel"), true);
    assert.equal(consumesPromptBudget("timeout"), true);
    for (const code of ["exception", "malformed", "unsupported", "accept", "throttle"]) {
      assert.equal(consumesPromptBudget(code), false, code);
    }
    const times = [];
    for (let i = 0; i < 4; i++) recordApprovalMiss(times, 1_000, "decline");
    recordApprovalMiss(times, 1_000, "exception");
    recordApprovalMiss(times, 1_000, "malformed");
    recordApprovalMiss(times, 1_000, "unsupported");
    assert.equal(times.length, 4);
    assert.equal(approvalPromptPaused(times, 1_000), false);
    recordApprovalMiss(times, 1_000, "timeout");
    assert.equal(approvalPromptPaused(times, 1_000), true);
    assert.match(THROTTLE_SUMMARY, /No further form was sent/);
    assert.equal(approvalPromptPaused(times, 1_000 + 60_001), false);
  });

  it("a timeout override can only shorten the wait and cannot approve", () => {
    assert.equal(elicitationTimeoutMs({}), 120_000);
    assert.equal(elicitationTimeoutMs({ PROTON_DRIVE_ELICIT_TIMEOUT_MS: "80" }), 80);
    assert.equal(elicitationTimeoutMs({ PROTON_DRIVE_ELICIT_TIMEOUT_MS: "0" }), 120_000);
    assert.equal(elicitationTimeoutMs({ PROTON_DRIVE_ELICIT_TIMEOUT_MS: "19" }), 120_000);
    assert.equal(elicitationTimeoutMs({ PROTON_DRIVE_ELICIT_TIMEOUT_MS: "999999" }), 120_000);
    assert.equal(elicitationTimeoutMs({ PROTON_DRIVE_ELICIT_TIMEOUT_MS: "true" }), 120_000);
    assert.equal(elicitationTimeoutMs({ PROTON_DRIVE_ELICIT_TIMEOUT_MS: "" }), 120_000);
  });
});

describe("drive_bulk_move approval gate (fake CLI)", () => {
  it("accept with approve true moves once and asks with mode form", async () => {
    let seen;
    await withClient({ elicitation: { form: {} } }, async (req) => {
      seen = req.params;
      return { action: "accept", content: { approve: true } };
    }, async (client, sb) => {
      const r = await client.callTool({ name: "drive_bulk_move", arguments: BULK_ARGS });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(mutations(sb).length, 1);
      assert.equal(mutations(sb)[0][1], "move");
    });
    assert.equal(seen.mode, "form");
    assert.equal(seen.requestedSchema.properties.approve.type, "boolean");
    assert.equal(seen.requestedSchema.properties.approve.default, false);
    assert.deepEqual(seen.requestedSchema.required, ["approve"]);
    assert.equal(ElicitRequestFormParamsSchema.safeParse(seen).success, true);
  });

  for (const [label, reply, pattern] of [
    ["decline", { action: "decline" }, /client returned decline/],
    ["cancel", { action: "cancel" }, /client returned cancel/],
    ["accept with approve false", { action: "accept", content: { approve: false } }, /content\.approve was not true/],
    ["accept with no content", { action: "accept" }, /without content\.approve true/],
    ["accept with string true", { action: "accept", content: { approve: "true" } }, /failed protocol checks|without content\.approve true/],
    ["malformed action", { action: "nope" }, /failed protocol checks/],
  ]) {
    it(`${label} moves nothing`, async () => {
      await withClient({ elicitation: { form: {} } }, async () => reply, async (client, sb) => {
        const r = await client.callTool({ name: "drive_bulk_move", arguments: BULK_ARGS });
        assert.equal(r.isError, true);
        assert.match(text(r), pattern);
        assert.match(text(r), /nothing moved/);
        if (label === "malformed action") assert.doesNotMatch(text(r), /invalid_value|\/tmp\//);
        assert.deepEqual(mutations(sb), []);
      });
    });
  }

  it("a hung form times out, moves nothing, and does not report a human denial", async () => {
    await withClient({ elicitation: { form: {} } }, () => new Promise(() => {}), async (client, sb) => {
      const r = await client.callTool({ name: "drive_bulk_move", arguments: BULK_ARGS });
      assert.equal(r.isError, true);
      assert.match(text(r), /timed out before an explicit approval/);
      assert.doesNotMatch(text(r), /client returned decline/);
      assert.deepEqual(mutations(sb), []);
    }, { PROTON_DRIVE_ELICIT_TIMEOUT_MS: "80" });
  });

  it("a client that advertises form elicitation but has no handler is unsupported and moves nothing", async () => {
    await withClient({ elicitation: { form: {} } }, null, async (client, sb) => {
      const r = await client.callTool({ name: "drive_bulk_move", arguments: BULK_ARGS });
      assert.equal(r.isError, true);
      assert.match(text(r), /rejected elicitation\/create/);
      assert.match(text(r), /confirmed:true is not a substitute/);
      assert.deepEqual(mutations(sb), []);
    });
  });

  it("an exception is reported as a failure, redacts paths, and moves nothing", async () => {
    await withClient({ elicitation: { form: {} } }, async () => {
      throw new Error("boom at /tmp/secret/session.json");
    }, async (client, sb) => {
      const r = await client.callTool({ name: "drive_bulk_move", arguments: BULK_ARGS });
      assert.equal(r.isError, true);
      assert.match(text(r), /approval request failed \(JSON-RPC -32603: boom\)/);
      assert.match(text(r), /not an approval/);
      assert.doesNotMatch(text(r), /secret|session\.json/);
      assert.deepEqual(mutations(sb), []);
    });
  });

  it("repeated exceptions stay visible and never mutate or turn into a pause", async () => {
    let asked = 0;
    await withClient({ elicitation: { form: {} } }, async () => {
      asked++;
      throw new Error("boom");
    }, async (client, sb) => {
      for (let i = 0; i < 6; i++) {
        const r = await client.callTool({ name: "drive_bulk_move", arguments: BULK_ARGS });
        assert.equal(r.isError, true);
        assert.match(text(r), /approval request failed/);
        assert.doesNotMatch(text(r), /prompting is paused/);
      }
      assert.equal(asked, 6);
      assert.deepEqual(mutations(sb), []);
    });
  });

  it("after 5 declines the next call is paused, sends no form, and moves nothing", async () => {
    let asked = 0;
    await withClient({ elicitation: { form: {} } }, async () => {
      asked++;
      return { action: "decline" };
    }, async (client, sb) => {
      for (let i = 0; i < 6; i++) {
        const r = await client.callTool({ name: "drive_bulk_move", arguments: BULK_ARGS });
        assert.equal(r.isError, true);
        assert.match(text(r), i < 5 ? /client returned decline/ : /prompting is paused/);
        assert.match(text(r), /nothing moved/);
      }
      assert.equal(asked, 5);
      assert.deepEqual(mutations(sb), []);
    });
  });

  it("a conflict is refused before any approval form and moves nothing", async () => {
    let asked = 0;
    const sb = makeSandbox();
    const client = new Client({ name: "approval-test", version: "0" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async () => { asked++; return { action: "accept", content: { approve: true } }; });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_INDEX],
      env: fakeEnv("tree", sb, { FAKE_TREE: collisionTree() }),
    });
    await client.connect(transport);
    try {
      const r = await client.callTool({ name: "drive_bulk_move", arguments: BULK_ARGS });
      assert.equal(r.isError, true);
      assert.match(text(r), /nothing moved/);
      assert.equal(asked, 0);
      assert.deepEqual(mutations(sb), []);
    } finally { await client.close(); sb.cleanup(); }
  });

  it("without the elicitation capability, confirmed true still applies and no form is required", async () => {
    await withClient({}, null, async (client, sb) => {
      const r = await client.callTool({ name: "drive_bulk_move", arguments: BULK_ARGS });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(mutations(sb).length, 1);
    });
  });
});
