import { register } from "node:module";
// Test-only module substitution: real SDK service uses synthetic providers and private temporary storage.
register(new URL("./loader.mjs", import.meta.url), import.meta.url);
