#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { buildCatalogList, renderCatalogListMarkdown } from "../src/cli-catalog-overlay/list.js";

export async function runCatalogList(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--markdown")) {
    console.log(renderCatalogListMarkdown());
    return;
  }
  console.log(JSON.stringify(buildCatalogList(), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCatalogList();
}
