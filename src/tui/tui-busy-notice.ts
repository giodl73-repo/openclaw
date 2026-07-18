import type { ChatLog } from "./components/chat-log.js";
import { TUI_ENGLISH_LOCALIZATION, type TuiLocalization } from "./i18n/runtime.js";

export function addBlockedChatSubmitNotice(
  chatLog: Pick<ChatLog, "addSystem">,
  localization: TuiLocalization = TUI_ENGLISH_LOCALIZATION,
) {
  chatLog.addSystem(localization.t("tui.notice.agentBusy"), { coalesceConsecutive: true });
}
