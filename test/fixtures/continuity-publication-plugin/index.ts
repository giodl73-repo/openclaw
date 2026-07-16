import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
  type ContinuityPublicationProviderV1,
  type OpenClawPluginApi,
} from "../../../src/plugin-sdk/index.js";

type FixtureConfig = {
  publicationRoot: string;
  generation: string;
};

function readConfig(api: OpenClawPluginApi): FixtureConfig {
  const publicationRoot = api.pluginConfig?.publicationRoot;
  const generation = api.pluginConfig?.generation;
  if (typeof publicationRoot !== "string" || typeof generation !== "string") {
    throw new Error("continuity publication fixture config is invalid");
  }
  return { publicationRoot, generation };
}

export default function register(api: OpenClawPluginApi): void {
  const config = readConfig(api);
  const provider: ContinuityPublicationProviderV1 = {
    id: "fixture/continuity",
    version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
    generation: config.generation,
    async publish({ identity, content }) {
      await fs.mkdir(config.publicationRoot, { recursive: true });
      const archivePath = path.join(config.publicationRoot, `${identity.archiveSha256}.tar.gz`);
      const temporaryPath = `${archivePath}.${process.pid}.${Date.now()}.tmp`;
      const handle = await fs.open(temporaryPath, "wx", 0o600);
      try {
        for await (const chunk of content) {
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(temporaryPath, archivePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }
      return {
        version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
        publicationId: `publication/${identity.handoffId}`,
        identity,
        durabilityClass: "immutable",
        acceptedAt: "2026-07-15T00:00:00.000Z",
      };
    },
    async retrieve({ receipt }) {
      const archivePath = path.join(
        config.publicationRoot,
        `${receipt.identity.archiveSha256}.tar.gz`,
      );
      return {
        version: CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
        publicationId: receipt.publicationId,
        identity: receipt.identity,
        content: createReadStream(archivePath),
      };
    },
  };
  api.registerContinuityPublicationProvider(provider);
}
