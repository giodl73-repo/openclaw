import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import { ClawsPage } from "./claws-page.ts";
import { clawDoctor, clawMethods, clawStatus } from "./claws.test-support.ts";

afterEach(() => document.body.replaceChildren());

it.each(["initial", "update", "reconnect"])(
  "keeps Plugins keyboard reachable when Claws is unavailable after %s",
  async (transition) => {
    const harness = createApplicationGateway();
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "claws.status") return clawStatus([]);
        if (method === "claws.doctor") return clawDoctor;
        throw new Error(`Unexpected method ${method}`);
      }),
    } as unknown as GatewayBrowserClient;
    harness.publish({
      ...harness.gateway.snapshot,
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(transition === "initial" ? [] : clawMethods),
    });
    const navigate = vi.fn();
    const provider = createApplicationContextProvider({
      gateway: harness.gateway,
      navigate,
    } as unknown as ApplicationContext);
    const page = document.createElement("openclaw-claws-page") as ClawsPage;
    provider.append(page);
    document.body.append(provider);
    await settleLitElement(page);
    const plugins = page.querySelector<HTMLElement>("#plugins-tab-plugins")!;
    if (transition !== "initial") {
      await expect.poll(() => plugins.tabIndex).toBe(-1);
      if (transition === "reconnect") {
        harness.publish({ ...harness.gateway.snapshot, phase: "reconnecting" });
        await settleLitElement(page);
      }
      harness.publish({
        ...harness.gateway.snapshot,
        phase: "connected",
        hello: gatewayHelloForMethods([]),
      });
      await settleLitElement(page);
    }
    expect(page.querySelector("#plugins-tab-claws")).toBeNull();
    page.querySelector<HTMLElement>(".learn-more-link")!.focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(plugins);
    await userEvent.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith("plugins");
  },
);
