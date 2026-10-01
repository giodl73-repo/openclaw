import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { MAX_PLUGIN_RELOAD_TARGETS } from "../../packages/gateway-protocol/src/schema/plugins.js";
import {
  PluginInstallRuntimeBatch,
  type PluginInstallBatchReload,
} from "../plugins/install-runtime-batch.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

export type ClawPluginRuntimeOptions = OpenClawStateDatabaseOptions & {
  beforePersistentApply?: () => void;
  reloadPlugins?: PluginInstallBatchReload;
  /** The enclosing requirement phase owns nested package installs and compensation. */
  runtimeBatch?: PluginInstallRuntimeBatch;
  runtime?: RuntimeEnv;
};

export async function runClawPluginBatch<T>(
  options: ClawPluginRuntimeOptions,
  pluginCount: number,
  run: (batch: PluginInstallRuntimeBatch | undefined) => Promise<T>,
  runtimeFailure: (failure: unknown, operation: Result<T, unknown>) => Error,
): Promise<T> {
  options.beforePersistentApply?.();
  if (!options.reloadPlugins || options.runtimeBatch) {
    let completed: Result<T, unknown> | undefined;
    try {
      const value = await withPluginLifecycleLease(options, async () => {
        options.beforePersistentApply?.();
        const value = await run(options.runtimeBatch);
        completed = ok(value);
        options.beforePersistentApply?.();
        return value;
      });
      options.beforePersistentApply?.();
      return value;
    } catch (error) {
      if (completed) {
        throw runtimeFailure(error, completed);
      }
      throw error;
    }
  }
  if (pluginCount > MAX_PLUGIN_RELOAD_TARGETS) {
    throw new Error(
      `A live Claw requirement batch supports at most ${MAX_PLUGIN_RELOAD_TARGETS} plugin packages. Split the requirement batch before installing.`,
    );
  }
  const reloadPlugins = options.reloadPlugins;
  const batch = new PluginInstallRuntimeBatch(options, async (targets) => {
    options.beforePersistentApply?.();
    // finish() settles committed-source cleanup under its independent lease.
    // Recheck caller authority only after that settlement has completed.
    return await reloadPlugins(targets);
  });
  let completed: Result<T, unknown> | undefined;
  const operation = await withPluginLifecycleLease(options, async (lease) => {
    let result: Result<T, unknown>;
    try {
      options.beforePersistentApply?.();
      result = ok(await run(batch));
    } catch (error) {
      result = err(error);
    }
    completed = result;
    // The callback has already completed its compensation. Capture final retained owners
    // before releasing the lease; the Gateway validates those facts again after the gap.
    await batch.prepare(lease);
    return result;
  }).catch((error: unknown) => {
    const committed = batch.hasCommitted;
    batch.close();
    if (!committed && !completed) {
      throw error;
    }
    throw runtimeFailure(error, completed ?? err(error));
  });
  try {
    const runtime = options.runtime ?? defaultRuntime;
    const application = await batch.finish((message) => runtime.log(message));
    if (application) {
      runtime.log(`Plugin requirements applied in Gateway generation ${application.generation}.`);
    }
  } catch (error) {
    throw runtimeFailure(error, operation);
  }
  if (!operation.ok) {
    throw operation.error;
  }
  try {
    options.beforePersistentApply?.();
  } catch (error) {
    throw runtimeFailure(error, operation);
  }
  return operation.value;
}
