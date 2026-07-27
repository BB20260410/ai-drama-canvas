import { getStudioCanonicalAsset } from "../src/core/material-studio.ts";
const root = "/Users/hxx/Documents/无限画布/projects/grok-mvp-qingdeng-mrwc97mu-d0aea463";
for (const id of ["prop-qingdeng-lantern", "character-qingdeng-ke", "scene-rainy-inn-porch"]) {
  try {
    const a = await getStudioCanonicalAsset(root, id);
    console.log(JSON.stringify({
      id: a.id,
      rev: a.revision,
      auth: a.primaryAuthority,
      name: a.name,
      pos: a.positiveLocks?.slice?.(0, 3),
    }));
  } catch (e) {
    console.log(id, "MISSING", e.message);
  }
}
