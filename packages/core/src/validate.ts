import { SUPPORTED_NODE_TYPES, SUPPORTED_PAINT_TYPES } from "./constants";
import type { DesignPaint, InternalDocument, InternalNode, JsonObject } from "./types";

export function validateDocument(document: InternalDocument): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const components = new Set<string>();
  const add = (path: string, message: string) => { if (errors.length < 30) errors.push(`${path}: ${message}`); };
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const triggers = new Set(["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG", "AFTER_TIMEOUT", "MOUSE_UP", "MOUSE_DOWN", "MOUSE_ENTER", "MOUSE_LEAVE", "ON_KEY_DOWN", "ON_MEDIA_HIT", "ON_MEDIA_END"]);
  const actions = new Set(["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO", "BACK", "CLOSE", "URL", "UPDATE_MEDIA_RUNTIME", "SET_VARIABLE", "SET_VARIABLE_MODE", "CONDITIONAL"]);

  function validateAction(value: unknown, path: string): void {
    if (!value || typeof value !== "object") return add(path, "action must be an object");
    const action = value as JsonObject;
    const type = String(action.type || "");
    if (!actions.has(type)) add(`${path}.type`, `unsupported prototype action '${type}'`);
    if (["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"].includes(type) && typeof action.destination !== "string") add(`${path}.destination`, `${type} requires a destination ID`);
    if (type === "URL" && typeof action.url !== "string") add(`${path}.url`, "URL action requires url");
    if (type === "SET_VARIABLE" && typeof (action.variable || action.variableId) !== "string") add(`${path}.variable`, "SET_VARIABLE requires a variable reference");
    if (type === "SET_VARIABLE_MODE" && (typeof (action.collection || action.variableCollectionId) !== "string" || typeof (action.mode || action.variableModeId) !== "string")) add(path, "SET_VARIABLE_MODE requires collection and mode references");
    if (type === "UPDATE_MEDIA_RUNTIME" && typeof action.mediaAction !== "string") add(`${path}.mediaAction`, "UPDATE_MEDIA_RUNTIME requires mediaAction");
    if (type === "CONDITIONAL") {
      const blocks = action.blocks || action.conditionalBlocks;
      if (!Array.isArray(blocks) || !blocks.length) add(`${path}.blocks`, "CONDITIONAL requires at least one block");
      else blocks.forEach((block, index) => { if (block && typeof block === "object" && !Array.isArray(block)) { const nested = (block as JsonObject).actions; if (Array.isArray(nested)) nested.forEach((item, actionIndex) => validateAction(item, `${path}.blocks[${index}].actions[${actionIndex}]`)); } });
    }
  }

  function validatePrototype(values: JsonObject[], path: string): void {
    values.forEach((reaction, index) => {
      const reactionPath = `${path}[${index}]`;
      const triggerValue = reaction.trigger;
      const trigger = typeof triggerValue === "string" ? triggerValue : triggerValue && typeof triggerValue === "object" && !Array.isArray(triggerValue) && typeof (triggerValue as JsonObject).type === "string" ? (triggerValue as JsonObject).type as string : "";
      if (!triggers.has(trigger)) add(`${reactionPath}.trigger`, `unsupported trigger '${trigger}'`);
      const reactionActions: unknown[] = Array.isArray(reaction.actions) ? reaction.actions : reaction.action ? [{ ...reaction, type: reaction.action }] : [];
      if (!reactionActions.length) add(`${reactionPath}.actions`, "reaction requires at least one action");
      reactionActions.forEach((action, actionIndex) => validateAction(action, `${reactionPath}.actions[${actionIndex}]`));
    });
  }

  function validatePaint(value: DesignPaint, path: string): void {
    if (!value || typeof value !== "object") return add(path, "paint must be an object or valid hex color");
    if (!SUPPORTED_PAINT_TYPES.has(value.type)) add(`${path}.type`, `unsupported paint type '${value.type}'`);
    if (value.type === "IMAGE") {
      if (typeof value.src !== "string" || (!/^https:\/\//i.test(value.src) && !/^file:[^/].+/i.test(value.src) && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(value.src))) add(`${path}.src`, "IMAGE requires HTTPS, file:filename, or an embedded image data URL");
      if (!value.scaleMode || !["FILL", "FIT", "CROP", "TILE"].includes(value.scaleMode)) add(`${path}.scaleMode`, "must be COVER/FILL, CONTAIN/FIT, CROP, or TILE");
      if (value.imageTransform !== undefined && (!Array.isArray(value.imageTransform) || value.imageTransform.length !== 2)) add(`${path}.imageTransform`, "must be a 2×3 transform matrix");
    }
    if (value.type?.startsWith("GRADIENT_") && (!Array.isArray(value.gradientStops) || value.gradientStops.length < 2)) add(`${path}.gradientStops`, "gradient requires at least two stops");
    if (value.opacity !== undefined && (!finite(value.opacity) || value.opacity < 0 || value.opacity > 1)) add(`${path}.opacity`, "must be 0–1");
  }

  function walk(node: InternalNode, path: string): void {
    if (ids.has(node.id)) add(`${path}.id`, `duplicate ID '${node.id}'`); else ids.add(node.id);
    if (!SUPPORTED_NODE_TYPES.has(node.type)) add(`${path}.type`, `unsupported node type '${node.type}'`);
    if (node.type === "COMPONENT") components.add(node.id);
    const props = node.properties;
    if (!finite(props.position?.x) || !finite(props.position?.y)) add(`${path}.position`, "x and y must be finite numbers");
    if (!finite(props.size?.width) || props.size.width <= 0 || !finite(props.size?.height) || props.size.height <= 0) add(`${path}.size`, "w and h must be positive finite numbers");
    if (props.cornerRadius !== undefined && (!finite(props.cornerRadius) || props.cornerRadius < 0)) add(`${path}.cornerRadius`, "must be non-negative");
    if (props.cornerRadii !== undefined && (!Array.isArray(props.cornerRadii) || props.cornerRadii.length !== 4 || props.cornerRadii.some((n: unknown) => !finite(n) || n < 0))) add(`${path}.cornerRadii`, "must contain four non-negative numbers");
    if (props.layout) {
      if (!props.layout.direction || !["HORIZONTAL", "VERTICAL", "GRID"].includes(props.layout.direction)) add(`${path}.layout.direction`, "must be HORIZONTAL, VERTICAL, or GRID");
      for (const key of ["primaryAxisSizingMode", "counterAxisSizingMode"] as const) { const value = props.layout[key]; if (value !== undefined && !["FIXED", "HUG", "AUTO"].includes(value)) add(`${path}.layout.${key}`, "must be FIXED or HUG"); }
      if (props.layout.primaryAxisAlignItems !== undefined && !["MIN", "MAX", "CENTER", "SPACE_BETWEEN"].includes(props.layout.primaryAxisAlignItems)) add(`${path}.layout.primaryAxisAlignItems`, "must be MIN, MAX, CENTER, or SPACE_BETWEEN");
      if (props.layout.counterAxisAlignItems !== undefined && !["MIN", "MAX", "CENTER", "BASELINE", "STRETCH"].includes(props.layout.counterAxisAlignItems)) add(`${path}.layout.counterAxisAlignItems`, "must be MIN, MAX, CENTER, BASELINE, or STRETCH");
    }
    for (const key of ["fills", "strokes"] as const) props.styles[key].forEach((item, index) => validatePaint(item, `${path}.${key}[${index}]`));
    if (node.type === "TEXT" && typeof props.text !== "string") add(`${path}.text`, "TEXT requires text or runs");
    if (node.type === "SVG" && typeof props.svg !== "string") add(`${path}.svg`, "SVG requires markup");
    if (node.type === "VECTOR" && !Array.isArray(props.vectorPaths)) add(`${path}.vectorPaths`, "VECTOR requires vectorPaths");
    if (node.type === "INSTANCE" && typeof props.componentId !== "string") add(`${path}.componentId`, "INSTANCE requires componentId");
    if (node.type === "COMPONENT_SET" && (!node.children.length || node.children.some((child) => child.type !== "COMPONENT"))) add(`${path}.children`, "COMPONENT_SET requires COMPONENT children");
    if (node.type === "COMPONENT_SET" && props.variantAxes) {
      for (const [axis, options] of Object.entries(props.variantAxes)) if (!axis || !Array.isArray(options) || !options.length || options.some((option) => typeof option !== "string")) add(`${path}.variantAxes.${axis}`, "must be a non-empty string array");
      const variantAxes = props.variantAxes;
      node.children.forEach((child, index) => Object.entries(child.properties.variant || {}).forEach(([axis, value]) => { if (!variantAxes[axis]?.includes(value)) add(`${path}.children[${index}].variant.${axis}`, `value '${value}' is not declared in variantAxes`); }));
    }
    if (props.prototype !== undefined) Array.isArray(props.prototype) ? validatePrototype(props.prototype, `${path}.prototype`) : add(`${path}.prototype`, "must be an array of reactions");
    if (["GROUP", "BOOLEAN_OPERATION"].includes(node.type) && !node.children.length) add(`${path}.children`, `${node.type} requires children`);
    node.children.forEach((child, index) => walk(child, `${path}.children[${index}]`));
  }

  document.nodes.forEach((node, index) => walk(node, `nodes[${index}]`));
  function references(node: InternalNode, path: string): void {
    if (node.type === "INSTANCE" && (!node.properties.componentId || !components.has(node.properties.componentId))) add(`${path}.componentId`, `component '${node.properties.componentId || ""}' is not defined in this import`);
    node.children.forEach((child, index) => references(child, `${path}.children[${index}]`));
  }
  document.nodes.forEach((node, index) => references(node, `nodes[${index}]`));
  const variableKeys = new Set<string>();
  const collectionNames = new Set<string>();
  const modesByCollection = new Map<string, string[]>();
  for (const [collectionIndex, collection] of (document.variables || []).entries()) {
    const modes = Array.isArray(collection.modes) && collection.modes.length ? collection.modes : [];
    if (collection.modes !== undefined && (!modes.length || modes.some((mode: unknown) => typeof mode !== "string"))) add(`variables[${collectionIndex}].modes`, "must be a non-empty array of mode names");
    if (typeof collection.name === "string" && collection.name) {
      collectionNames.add(collection.name);
      if (collection.modes !== undefined && modes.length && modes.every((mode: unknown) => typeof mode === "string")) {
        modesByCollection.set(collection.name, modes as string[]);
      }
    }
    for (const [variableIndex, variable] of (collection.items || []).entries()) {
      const path = `variables[${collectionIndex}].items[${variableIndex}]`;
      if (!variable.name || typeof variable.name !== "string") add(`${path}.name`, "must be a non-empty string");
      if (!['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'].includes(variable.type)) add(`${path}.type`, "must be COLOR, FLOAT, STRING, or BOOLEAN");
      if (typeof variable.id === "string" && variable.id) variableKeys.add(variable.id);
      if (typeof variable.name === "string" && variable.name) variableKeys.add(variable.name);
      const values = variable.values || (variable.value !== undefined ? { default: variable.value } : {});
      if (!Object.keys(values).length) add(`${path}`, "requires value or values");
      if (variable.values && modes.length) for (const mode of modes) if (!(mode in variable.values)) add(`${path}.values.${mode}`, "missing value for declared mode");
      for (const [mode, value] of Object.entries(values)) {
        if (variable.type === "FLOAT" && !finite(value)) add(`${path}.${mode}`, "FLOAT value must be a finite number");
        if (variable.type === "STRING" && typeof value !== "string") add(`${path}.${mode}`, "STRING value must be a string");
        if (variable.type === "BOOLEAN" && typeof value !== "boolean") add(`${path}.${mode}`, "BOOLEAN value must be true or false");
        const color = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
        if (variable.type === "COLOR" && (!color || !finite(color.r) || !finite(color.g) || !finite(color.b))) add(`${path}.${mode}`, "COLOR value requires numeric r, g, and b channels");
      }
    }
  }
  function tokenReferences(node: InternalNode, path: string): void {
    const bindings = node.properties.bindings;
    if (bindings) {
      for (const [field, key] of Object.entries(bindings)) {
        if (typeof key !== "string" || !key) {
          add(`${path}.bindings.${field}`, "must be a non-empty variable id or name");
          continue;
        }
        if (!variableKeys.has(key)) add(`${path}.bindings.${field}`, `variable '${key}' is not defined in this document`);
      }
    }
    const variableModes = node.properties.variableModes;
    if (variableModes) {
      for (const [collectionName, modeName] of Object.entries(variableModes)) {
        if (!collectionNames.has(collectionName)) {
          add(`${path}.variableModes.${collectionName}`, `variable collection '${collectionName}' is not defined in this document`);
          continue;
        }
        if (typeof modeName !== "string" || !modeName) {
          add(`${path}.variableModes.${collectionName}`, "must be a non-empty mode name");
          continue;
        }
        const declared = modesByCollection.get(collectionName);
        if (declared && !declared.includes(modeName)) add(`${path}.variableModes.${collectionName}`, `mode '${modeName}' is not declared on collection '${collectionName}'`);
      }
    }
    node.children.forEach((child, index) => tokenReferences(child, `${path}.children[${index}]`));
  }
  document.nodes.forEach((node, index) => tokenReferences(node, `nodes[${index}]`));
  return errors;
}
