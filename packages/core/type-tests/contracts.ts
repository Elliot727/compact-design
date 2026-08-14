import type { DesignProperties, InternalDocument } from "../src/types";

declare const properties: DesignProperties;
declare const document: InternalDocument;

properties.opacity = 0.5;
document.styles[0]?.name;
document.variables[0]?.items[0]?.type;

// @ts-expect-error Unknown node properties must be rejected by the internal model.
properties.opactiy = 0.5;
// @ts-expect-error Normalized styles are typed resources, not arbitrary objects.
document.styles.push({ surprise: true });
// @ts-expect-error Normalized variable collections require a name and typed items.
document.variables.push({ name: "Theme" });
