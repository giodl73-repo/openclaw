import { describe, expect, it, vi } from "vitest";
import { activatedConversation, createHarness, flush } from "./conversation.test-support.js";
import { createControlModel } from "./index.js";

const sessionKey = "agent:main:one";
const sourceSessionKey = "agent:main:child";
const approval = {
  id: "child-approval",
  status: "pending",
  sourceSessionKey,
  presentation: { kind: "exec", allowedDecisions: ["allow-once", "deny"] },
};

describe("conversation approval replay audiences", () => {
  it("retains child provenance and resolves an approval replayed to its parent", async () => {
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      { approvalReplay: { sessionKey, approvals: [approval], truncated: false } },
    );
    const { model, conversation } = await activatedConversation(harness);
    try {
      expect(conversation.getSnapshot().approvals).toEqual([expect.objectContaining(approval)]);
      await conversation.resolveApproval(approval.id, "deny");
      expect(harness.callsFor("approval.resolve")[0]?.params).toEqual({
        id: approval.id,
        kind: "exec",
        decision: "deny",
      });
      expect(conversation.getSnapshot().approvals).toEqual([
        expect.objectContaining({ ...approval, status: "denied", decision: "deny" }),
      ]);
    } finally {
      model.dispose();
    }
  });

  it.each(["agent:main:other", undefined, "", 42])(
    "ignores replay with invalid audience %s without clearing existing approvals",
    async (audience) => {
      const { harness, model, conversation } = await activatedConversation();
      try {
        harness.emit({
          event: "session.approval",
          payload: {
            sessionKey,
            approval: { ...approval, sourceSessionKey: undefined },
          },
        });
        const existing = conversation.getSnapshot().approvals;
        harness.queue("sessions.messages.subscribe", { key: sessionKey });
        harness.queue("sessions.messages.subscribe", {
          key: sessionKey,
          approvalReplay: {
            sessionKey: audience,
            approvals: [
              {
                ...approval,
                id: "wrong-audience",
                sourceSessionKey: sessionKey,
              },
            ],
            truncated: false,
          },
        });
        harness.setConnection({ status: "connected", epoch: 2 });
        await vi.waitFor(() => expect(harness.callsFor("question.list")).toHaveLength(2));
        expect(conversation.getSnapshot().approvals).toEqual(existing);
      } finally {
        model.dispose();
      }
    },
  );

  it("reconciles complete and truncated parent replay without dropping terminal approvals", async () => {
    const { harness, model, conversation } = await activatedConversation();
    try {
      for (const status of ["pending", "denied"]) {
        harness.emit({
          event: "session.approval",
          payload: {
            sessionKey,
            approval: { ...approval, id: status, status, sourceSessionKey: undefined },
          },
        });
      }
      const reconnect = async (epoch: number, truncated: boolean) => {
        harness.queue("sessions.messages.subscribe", { key: sessionKey });
        harness.queue("sessions.messages.subscribe", {
          key: sessionKey,
          approvalReplay: { sessionKey, approvals: [approval], truncated },
        });
        harness.setConnection({ status: "connected", epoch });
        await vi.waitFor(() => expect(harness.callsFor("question.list")).toHaveLength(epoch));
      };
      await reconnect(2, true);
      expect(conversation.getSnapshot().approvals.map((item) => item.id)).toEqual([
        "pending",
        "denied",
        approval.id,
      ]);
      expect(conversation.getSnapshot().partialReasons).toContain("approval-replay-truncated");
      await reconnect(3, false);
      expect(conversation.getSnapshot().approvals.map((item) => item.id)).toEqual([
        "denied",
        approval.id,
      ]);
      expect(conversation.getSnapshot().partialReasons).not.toContain("approval-replay-truncated");
      harness.emit({
        event: "session.approval",
        payload: {
          sessionKey,
          sourceSessionKey,
          approval: { ...approval, sourceSessionKey: undefined, status: "expired" },
        },
      });
      expect(
        conversation.getSnapshot().approvals.find((item) => item.id === approval.id)?.status,
      ).toBe("expired");
      harness.emit({
        event: "session.approval",
        payload: {
          sessionKey: "agent:main:other",
          approval: { ...approval, id: "foreign-live" },
        },
      });
      expect(conversation.getSnapshot().approvals).toHaveLength(2);
    } finally {
      model.dispose();
    }
  });

  it("uses the coordinator's canonical audience for aliases and retains bounds", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    harness.queue("sessions.messages.subscribe", { key: sessionKey });
    harness.queue("sessions.messages.subscribe", {
      key: sessionKey,
      approvalReplay: {
        sessionKey,
        approvals: [approval, { ...approval, id: "second" }],
        truncated: false,
      },
    });
    const model = createControlModel({
      gateway: harness.gateway,
      bounds: { maxConversationApprovals: 1 },
    });
    model.start();
    const conversation = model.conversation("one");
    try {
      await vi.waitFor(() => expect(harness.callsFor("question.list")).toHaveLength(1));
      expect(conversation.getSnapshot().approvals).toEqual([
        expect.objectContaining({ ...approval, id: "second" }),
      ]);
      expect(conversation.getSnapshot().bounds.approvalsTruncated).toBe(true);
    } finally {
      model.dispose();
    }
  });

  it("ignores late replay from a retired connection", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    harness.queue("sessions.messages.subscribe", { key: sessionKey });
    const retired = harness.defer("sessions.messages.subscribe");
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    const conversation = model.conversation(sessionKey);
    try {
      await vi.waitFor(() =>
        expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2),
      );
      harness.setConnection({ status: "connected", epoch: 2 });
      await vi.waitFor(() => expect(harness.callsFor("question.list")).toHaveLength(1));
      retired.resolve({
        key: sessionKey,
        approvalReplay: { sessionKey, approvals: [approval], truncated: false },
      });
      await flush();
      expect(conversation.getSnapshot().approvals).toEqual([]);
    } finally {
      model.dispose();
    }
  });
});
