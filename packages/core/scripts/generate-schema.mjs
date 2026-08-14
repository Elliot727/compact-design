import { readFile, writeFile } from "node:fs/promises";

const source = await readFile("../../spec/compact-design.schema.json", "utf8");
JSON.parse(source);
await writeFile("src/generated-schema.ts", `// Generated from ../../spec/compact-design.schema.json. Do not edit.\nexport default ${source.trim()} as const;\n`);
