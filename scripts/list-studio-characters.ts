import { listStudioCanonicalAssets } from "../src/core/material-studio.js";
import { listVoiceIdentities } from "../src/core/asset-registry.js";

const root = "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const chars = [];
let cursor: string | undefined;
do {
  const page = await listStudioCanonicalAssets(root, { category: "character", limit: 50, cursor });
  chars.push(...page.items);
  cursor = page.nextCursor;
} while (cursor);
const voices = await listVoiceIdentities(root);
process.stdout.write(`${JSON.stringify({
  characterCount: chars.length,
  characters: chars.map((item) => ({
    id: item.id,
    name: item.name,
    revision: item.revision,
    primary: item.primaryMediaSha256?.slice(0, 16),
    versions: item.versionCount,
    aliases: item.aliases,
  })),
  voiceCount: voices.length,
  voices: voices.map((voice) => ({
    id: voice.id,
    name: voice.name,
    characterAssetIds: voice.characterAssetIds,
    samples: voice.sampleMediaSha256s.length,
  })),
}, null, 2)}\n`);
