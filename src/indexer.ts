import { getConfiguredDomain, getConfiguredSiteName } from "./config";
import { buildRagIndex } from "./rag";

const domain = getConfiguredDomain();
const siteName = getConfiguredSiteName();

const out = await buildRagIndex(domain, siteName);
console.log(`[indexer] domain=${out.domain} pages=${out.pageCount} chunks=${out.chunkCount}`);
