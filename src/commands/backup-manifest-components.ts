import { sha256Hex } from "../infra/crypto-digest.js";
import type { BackupAssetKind } from "./backup-shared.js";

export type BackupManifestComponent = {
  id: string;
  restoreOrder: number;
  dependsOn: string[];
};

const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const REPEATABLE_COMPONENT_KINDS = new Set<BackupAssetKind>(["workspace"]);
const RESTORE_PRIORITY: Record<BackupAssetKind, number> = {
  config: 0,
  credentials: 1,
  state: 2,
  workspace: 3,
};

/** Assign stable component identities without embedding source paths. */
export function buildBackupManifestComponents(
  assets: readonly { kind: BackupAssetKind; sourcePath: string }[],
): BackupManifestComponent[] {
  const restoreOrderByIndex = new Map(
    assets
      .map((asset, index) => ({ asset, index }))
      .toSorted(
        (left, right) =>
          RESTORE_PRIORITY[left.asset.kind] - RESTORE_PRIORITY[right.asset.kind] ||
          left.index - right.index,
      )
      .map((entry, restoreOrder) => [entry.index, restoreOrder]),
  );
  return assets.map((asset, index) => {
    const id = REPEATABLE_COMPONENT_KINDS.has(asset.kind)
      ? `${asset.kind}-${sha256Hex(asset.sourcePath).slice(0, 16)}`
      : asset.kind;
    const restoreOrder = restoreOrderByIndex.get(index);
    if (restoreOrder === undefined) {
      throw new Error(`Backup manifest restore order is missing for asset index ${index}.`);
    }
    return {
      id,
      restoreOrder,
      dependsOn: [],
    };
  });
}

export function validateBackupManifestComponents(
  assets: readonly {
    component?: BackupManifestComponent;
  }[],
): BackupManifestComponent[] {
  const declared = assets.flatMap((asset) =>
    asset.component === undefined ? [] : [asset.component],
  );
  if (declared.length === 0) {
    return [];
  }
  if (declared.length !== assets.length) {
    throw new Error("Backup manifest must declare component metadata for every asset or none.");
  }

  const components = declared;
  const byId = new Map<string, BackupManifestComponent>();
  const restoreOrders = new Set<number>();
  for (const component of components) {
    if (!COMPONENT_ID_PATTERN.test(component.id)) {
      throw new Error(`Backup manifest component id is invalid: ${component.id}`);
    }
    if (byId.has(component.id)) {
      throw new Error(`Backup manifest contains duplicate component id: ${component.id}`);
    }
    if (!Number.isSafeInteger(component.restoreOrder) || component.restoreOrder < 0) {
      throw new Error(
        `Backup manifest component restoreOrder is invalid: ${component.id} -> ${component.restoreOrder}`,
      );
    }
    if (restoreOrders.has(component.restoreOrder)) {
      throw new Error(
        `Backup manifest contains duplicate component restoreOrder: ${component.restoreOrder}`,
      );
    }
    if (
      !Array.isArray(component.dependsOn) ||
      component.dependsOn.some((dependency) => typeof dependency !== "string")
    ) {
      throw new Error(`Backup manifest component dependencies are invalid: ${component.id}`);
    }
    byId.set(component.id, component);
    restoreOrders.add(component.restoreOrder);
  }

  const ordered = components.toSorted((left, right) => left.restoreOrder - right.restoreOrder);
  for (const [index, component] of ordered.entries()) {
    if (component.restoreOrder !== index) {
      throw new Error(
        `Backup manifest component restoreOrder must be contiguous from zero: ${component.id}`,
      );
    }
    const uniqueDependencies = new Set(component.dependsOn);
    if (uniqueDependencies.size !== component.dependsOn.length) {
      throw new Error(`Backup manifest component has duplicate dependencies: ${component.id}`);
    }
    for (const dependencyId of uniqueDependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(
          `Backup manifest component dependency is missing: ${component.id} -> ${dependencyId}`,
        );
      }
      if (dependency.restoreOrder >= component.restoreOrder) {
        throw new Error(
          `Backup manifest component dependency must restore first: ${component.id} -> ${dependencyId}`,
        );
      }
    }
  }
  return ordered;
}
