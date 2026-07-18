// BTW inline message component renders compact aside messages in chat.
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { TUI_ENGLISH_LOCALIZATION, type TuiLocalization } from "../i18n/runtime.js";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";

// Inline overlay message for BTW follow-up answers inside the chat log.
type BtwInlineMessageParams = {
  question: string;
  text: string;
  isError?: boolean;
};

/** Renders a dismissible BTW result, with error text or assistant markdown content. */
export class BtwInlineMessage extends Container {
  private readonly localization: TuiLocalization;

  constructor(
    params: BtwInlineMessageParams,
    localization: TuiLocalization = TUI_ENGLISH_LOCALIZATION,
  ) {
    super();
    this.localization = localization;
    this.setResult(params);
  }

  /** Replaces the current BTW content without reallocating the host component. */
  setResult(params: BtwInlineMessageParams) {
    this.clear();
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.header(this.localization.t("tui.btw.question", { question: params.question })),
        1,
        0,
      ),
    );
    if (params.isError) {
      this.addChild(new Text(theme.error(params.text), 1, 0));
    } else {
      this.addChild(new AssistantMessageComponent(params.text));
    }
    this.addChild(new Text(theme.dim(this.localization.t("tui.btw.dismiss")), 1, 0));
  }
}
