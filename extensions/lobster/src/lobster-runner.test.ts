// Lobster tests cover lobster runner plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedLobsterRunner, resolveLobsterCwd } from "./lobster-runner.js";

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireFirstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function expectToolContext(value: unknown, expected: { cwd?: string; mode: "tool" }) {
  const ctx = requireRecord(value, "tool context");
  if (expected.cwd !== undefined) {
    expect(ctx.cwd).toBe(expected.cwd);
  }
  expect(ctx.mode).toBe(expected.mode);
  expect(ctx.signal).toBeInstanceOf(AbortSignal);
}

describe("resolveLobsterCwd", () => {
  it("defaults to the current working directory", () => {
    expect(resolveLobsterCwd(undefined)).toBe(process.cwd());
  });

  it("keeps relative paths inside the repo root", () => {
    expect(resolveLobsterCwd("extensions/lobster")).toBe(
      path.resolve(process.cwd(), "extensions/lobster"),
    );
  });
});

describe("createEmbeddedLobsterRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs inline pipelines through the embedded runtime", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [{ hello: "world" }],
        requiresApproval: null,
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.runToolRequest).toHaveBeenCalledTimes(1);
    const request = requireRecord(
      requireFirstCallParam(runtime.runToolRequest.mock.calls, "run tool request"),
      "run tool request",
    );
    expect(request.pipeline).toBe("exec --json=true echo hi");
    expectToolContext(request.ctx, { cwd: process.cwd(), mode: "tool" });
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [{ hello: "world" }],
      requiresApproval: null,
    });
  });

  it.each([
    "exec --json=true cat data.json",
    "exec --json=true cat config.yaml",
    "exec --json=true cat flow.lobster",
    "exec --json=true cat /tmp/missing.json",
    "http.fetch https://example.test/workflows/flow.lobster",
    "exec --json=true echo nested/path",
  ])("keeps inline pipeline with file-like args as a pipeline: %s", async (pipeline) => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await runner.run({
      action: "run",
      pipeline,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.runToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.runToolRequest.mock.calls, "inline run tool request"),
      "inline run tool request",
    );
    expect(request.pipeline).toBe(pipeline);
    expect(request.filePath).toBeUndefined();
  });

  it("detects workflow files and parses argsJson", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "workflow.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        runToolRequest: vi.fn().mockResolvedValue({
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: [],
          requiresApproval: null,
        }),
        resumeToolRequest: vi.fn(),
      };

      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await runner.run({
        action: "run",
        pipeline: "workflow.lobster",
        argsJson: '{"limit":3}',
        cwd: tempDir,
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      });

      expect(runtime.runToolRequest).toHaveBeenCalledOnce();
      const request = requireRecord(
        requireFirstCallParam(runtime.runToolRequest.mock.calls, "workflow run tool request"),
        "workflow run tool request",
      );
      expect(request.filePath).toBe(workflowPath);
      expect(request.args).toEqual({ limit: 3 });
      expectToolContext(request.ctx, { cwd: tempDir, mode: "tool" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects existing workflow file paths that contain spaces", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "daily inbox.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        runToolRequest: vi.fn().mockResolvedValue({
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: [],
          requiresApproval: null,
        }),
        resumeToolRequest: vi.fn(),
      };

      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await runner.run({
        action: "run",
        pipeline: "daily inbox.lobster",
        cwd: tempDir,
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      });

      expect(runtime.runToolRequest).toHaveBeenCalledOnce();
      const request = requireRecord(
        requireFirstCallParam(runtime.runToolRequest.mock.calls, "workflow file with spaces"),
        "workflow file with spaces",
      );
      expect(request.filePath).toBe(workflowPath);
      expect(request.pipeline).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing.lobster", "missing.lobster"],
    ["nested/missing.yaml", path.join("nested", "missing.yaml")],
  ])("surfaces missing workflow path errors for %s", async (pipeline, expectedRelativePath) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));

    try {
      const runtime = {
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      };
      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await expect(
        runner.run({
          action: "run",
          pipeline,
          cwd: tempDir,
          timeoutMs: 2000,
          maxStdoutBytes: 4096,
        }),
      ).rejects.toMatchObject({
        code: "ENOENT",
        path: path.join(tempDir, expectedRelativePath),
      });
      expect(runtime.runToolRequest).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "workflow.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      };
      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await expect(
        runner.run({
          action: "run",
          pipeline: "workflow.lobster",
          argsJson: "{bad",
          cwd: tempDir,
          timeoutMs: 2000,
          maxStdoutBytes: 4096,
        }),
      ).rejects.toThrow("run --args-json must be valid JSON");
      expect(runtime.runToolRequest).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when the embedded runtime returns an error envelope", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: false,
        protocolVersion: 1,
        error: {
          type: "runtime_error",
          message: "boom",
        },
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: "exec --json=true echo hi",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow("boom");
  });

  it("fails closed when the embedded runtime requests unsupported input", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "needs_input",
        output: [],
        requiresApproval: null,
        requiresInput: {
          prompt: "Need more data",
          schema: { type: "string" },
        },
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: "exec --json=true echo hi",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow("Lobster input requests are not supported by the OpenClaw Lobster tool yet");
  });

  it("routes resume through the embedded runtime", async () => {
    const runtime = {
      runToolRequest: vi.fn(),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "cancelled",
        output: [],
        requiresApproval: null,
      }),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "resume",
      token: "resume-token",
      approve: false,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.resumeToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.resumeToolRequest.mock.calls, "resume tool request"),
      "resume tool request",
    );
    expect(request.token).toBe("resume-token");
    expect(request.approved).toBe(false);
    expectToolContext(request.ctx, { cwd: process.cwd(), mode: "tool" });
    expect(envelope).toEqual({
      ok: true,
      status: "cancelled",
      output: [],
      requiresApproval: null,
    });
  });

  it("forwards approvalId through resume when token is absent", async () => {
    const runtime = {
      runToolRequest: vi.fn(),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await runner.run({
      action: "resume",
      approvalId: "dbc98d05",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.resumeToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.resumeToolRequest.mock.calls, "approval resume tool request"),
      "approval resume tool request",
    );
    expect(request.approvalId).toBe("dbc98d05");
    expect(request.approved).toBe(true);
    expectToolContext(request.ctx, { mode: "tool" });
  });

  it("passes approvalId through the normalized needs_approval envelope", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "ok?",
          items: [],
          resumeToken: "eyJ...",
          approvalId: "dbc98d05",
        },
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(envelope).toEqual({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "ok?",
        items: [],
        resumeToken: "eyJ...",
        approvalId: "dbc98d05",
      },
    });
  });

  it("loads the embedded runtime once per runner", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "cancelled",
        output: [],
        requiresApproval: null,
      }),
    };
    const loadRuntime = vi.fn().mockResolvedValue(runtime);

    const runner = createEmbeddedLobsterRunner({ loadRuntime });

    await runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });
    await runner.run({
      action: "resume",
      token: "resume-token",
      approve: false,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("loads the published package core runtime", async () => {
    await expect(
      createEmbeddedLobsterRunner().run({
        action: "run",
        pipeline: "commands.list",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).resolves.toMatchObject({ ok: true, status: "ok" });
  });

  it("requires approval before resolving a verified customer case", async () => {
    const events: string[] = [];
    const invoke = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push("spawn:verify");
        return {
          status: "accepted",
          runId: "run-verify",
          childSessionKey: "agent:main:subagent:verify",
        };
      })
      .mockImplementationOnce(async () => {
        events.push("spawn:resolve");
        return {
          status: "accepted",
          runId: "run-resolve",
          childSessionKey: "agent:main:subagent:resolve",
        };
      });
    const waitForRun = vi.fn(async ({ runId }: { runId: string }) => {
      events.push(`complete:${runId}`);
      return {
        status: "ok" as const,
        audit: {
          receipts:
            runId === "run-verify"
              ? [{ type: "customer.verified", data: { authorizationCode: "RET-42" } }]
              : [{ type: "case.resolved" }],
        },
      };
    });
    const runner = createEmbeddedLobsterRunner({
      invokeOpenClawTool: invoke,
      waitForOpenClawRun: waitForRun,
    });

    const pending = await runner.run({
      action: "run",
      pipeline: path.resolve("extensions/lobster/examples/support-case.lobster"),
      argsJson: '{"case_id":"CAS-42"}',
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
      taskFlowId: "flow-case-42",
    });

    expect(pending).toMatchObject({
      ok: true,
      status: "needs_approval",
      requiresApproval: {
        type: "approval_request",
        prompt: "Resolve this verified customer case?",
        items: [{ type: "customer.verified" }],
      },
    });
    expect(invoke).toHaveBeenCalledOnce();

    if (!pending.ok || !pending.requiresApproval?.resumeToken) {
      throw new Error("expected approval resume token");
    }
    const completed = await runner.run({
      action: "resume",
      token: pending.requiresApproval.resumeToken,
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
      taskFlowId: "flow-case-42",
    });

    expect(invoke.mock.calls).toEqual([
      [
        {
          tool: "sessions_spawn",
          args: {
            task: "Verify the customer for case CAS-42",
            skill: "verify-customer",
            runtime: "subagent",
            mode: "run",
            taskName: "verify_customer",
          },
          idempotencyKey: "lobster:flow-case-42:verify-customer",
        },
      ],
      [
        {
          tool: "sessions_spawn",
          args: {
            task: "Resolve case CAS-42 using the authorization code in workflow-input.json",
            skill: "resolve-case",
            runtime: "subagent",
            mode: "run",
            taskName: "resolve_case",
            attachments: [
              {
                name: "workflow-input.json",
                content: '{"authorizationCode":"RET-42"}',
                encoding: "utf8",
                mimeType: "application/json",
              },
            ],
          },
          idempotencyKey: "lobster:flow-case-42:resolve-case",
        },
      ],
    ]);
    expect(events).toEqual([
      "spawn:verify",
      "complete:run-verify",
      "spawn:resolve",
      "complete:run-resolve",
    ]);
    expect(completed).toMatchObject({ ok: true, status: "ok" });
  });

  it("does not resolve a verified customer case when approval is rejected", async () => {
    const invoke = vi.fn().mockResolvedValue({
      status: "accepted",
      runId: "run-verify",
      childSessionKey: "agent:main:subagent:verify",
    });
    const runner = createEmbeddedLobsterRunner({
      invokeOpenClawTool: invoke,
      waitForOpenClawRun: vi.fn().mockResolvedValue({
        status: "ok",
        audit: { receipts: [{ type: "customer.verified" }] },
      }),
    });

    const pending = await runner.run({
      action: "run",
      pipeline: path.resolve("extensions/lobster/examples/support-case.lobster"),
      argsJson: '{"case_id":"CAS-42"}',
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
      taskFlowId: "flow-case-42",
    });
    if (!pending.ok || !pending.requiresApproval?.resumeToken) {
      throw new Error("expected approval resume token");
    }

    await expect(
      runner.run({
        action: "resume",
        token: pending.requiresApproval.resumeToken,
        approve: false,
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
        taskFlowId: "flow-case-42",
      }),
    ).resolves.toMatchObject({ ok: true, status: "cancelled" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("stops a managed case workflow when verification fails", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: "accepted", runId: "run-verify" });
    const runner = createEmbeddedLobsterRunner({
      invokeOpenClawTool: invoke,
      waitForOpenClawRun: vi.fn().mockResolvedValue({
        status: "error",
        error: "customer identity did not match",
      }),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: path.resolve("extensions/lobster/examples/support-case.lobster"),
        argsJson: '{"case_id":"CAS-42"}',
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
        taskFlowId: "flow-case-42",
      }),
    ).rejects.toThrow("managed skill run error: customer identity did not match");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("skips case resolution when verification records no matching receipt", async () => {
    const invoke = vi.fn().mockResolvedValue({
      status: "accepted",
      runId: "run-verify",
      childSessionKey: "agent:main:subagent:verify",
    });
    const runner = createEmbeddedLobsterRunner({
      invokeOpenClawTool: invoke,
      waitForOpenClawRun: vi.fn().mockResolvedValue({
        status: "ok",
        audit: { receipts: [{ type: "customer.verification_failed" }] },
      }),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: path.resolve("extensions/lobster/examples/support-case.lobster"),
        argsJson: '{"case_id":"CAS-42"}',
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
        taskFlowId: "flow-case-42",
      }),
    ).resolves.toMatchObject({ ok: true, status: "ok" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("requires a pipeline for run", async () => {
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue({
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      }),
    });

    await expect(
      runner.run({
        action: "run",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/pipeline required/);
  });

  it("requires token and approve for resume", async () => {
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue({
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      }),
    });

    await expect(
      runner.run({
        action: "resume",
        approve: true,
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/token or approvalId required/);

    await expect(
      runner.run({
        action: "resume",
        token: "resume-token",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/approve required/);
  });

  it("aborts long-running embedded work", async () => {
    const runtime = {
      runToolRequest: vi.fn(
        async ({ ctx }: { ctx?: { signal?: AbortSignal } }) =>
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => resolve({ ok: true, status: "ok", output: [], requiresApproval: null }),
              500,
            );
            ctx?.signal?.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(
                toLintErrorObject(
                  ctx.signal?.reason ?? new Error("aborted"),
                  "Non-Error rejection",
                ),
              );
            });
          }),
      ),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: "exec --json=true echo hi",
        cwd: process.cwd(),
        timeoutMs: 200,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/timed out|aborted/);
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
