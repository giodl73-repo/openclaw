import { describe, expect, it } from "vitest";
import { createTuiLocalization } from "./i18n/runtime.js";
import { formatTuiHeader, resolveGatewayDisconnectState } from "./tui.js";

describe("TUI localized core rendering", () => {
  const localization = createTuiLocalization({ locale: "zh-CN" });

  it("localizes header labels while preserving title, URL, agent, and session literals", () => {
    expect(
      formatTuiHeader(
        {
          title: "custom title",
          connectionUrl: "wss://gateway.example.com/ws",
          agent: "agent-id (Agent Name)",
          session: "session-id",
        },
        localization,
      ),
    ).toBe(
      "custom title - wss://gateway.example.com/ws - 代理 agent-id (Agent Name) - 会话 session-id",
    );
  });

  it("localizes recovery copy while preserving raw reasons and command literals", () => {
    const state = resolveGatewayDisconnectState(
      "gateway closed (1008): pairing required",
      localization,
    );

    expect(state.connectionStatus).toContain("gateway closed (1008): pairing required");
    expect(state.activityStatus).toBe("device approval needed: preview latest request");
    expect(state.pairingHint).toContain("openclaw devices approve --latest");
    expect(state.pairingHint).toContain("openclaw devices approve <requestId>");
  });

  it("localizes footer mode labels while preserving stable mode tokens", () => {
    expect(localization.t("tui.footer.fastAuto")).toBe("快速:auto");
    expect(localization.t("tui.footer.reasoningStream")).toBe("推理:stream");
  });
});
