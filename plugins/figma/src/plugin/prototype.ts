import type { Resources } from "./resources";
import type { JsonObject, JsonPrimitive } from "@compact-design/core";

function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function objects(value: unknown): JsonObject[] { return Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }

export function prototypeRoot(node: SceneNode): SceneNode {
  let current = node;
  while (current.parent && current.parent.type !== "PAGE" && "type" in current.parent) current = current.parent as SceneNode;
  return current;
}

function isDescendantOf(node: SceneNode, ancestor: SceneNode): boolean {
  let current: BaseNode | null = node;
  while (current) {
    if (current.id === ancestor.id) return true;
    current = current.parent;
  }
  return false;
}

function transition(input: unknown): Transition | null {
  const value = object(input);
  if (!value || value.type === "INSTANT") return null;
  const type = typeof value.type === "string" ? value.type : "DISSOLVE";
  const easing = typeof value.easing === "string" ? { type: value.easing } : (value.easing || { type: "EASE_OUT" });
  const base = { type, easing, duration: value.duration ?? 0.3 };
  return (["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"].includes(type)
    ? { ...base, direction: value.direction || "LEFT", matchLayers: value.matchLayers === true }
    : base) as Transition;
}

function trigger(value: unknown): Trigger {
  if (typeof value === "string") return { type: value } as Trigger;
  const source = object(value); const type = typeof source.type === "string" ? source.type : "ON_CLICK";
  if (type === "AFTER_TIMEOUT") return { type, timeout: typeof source.timeout === "number" ? source.timeout : 1 };
  if (["MOUSE_UP", "MOUSE_DOWN"].includes(type)) return { type, delay: typeof source.delay === "number" ? source.delay : 0 } as Trigger;
  if (["MOUSE_ENTER", "MOUSE_LEAVE"].includes(type)) return { type, delay: typeof source.delay === "number" ? source.delay : 0, deprecatedVersion: source.deprecatedVersion === true } as Trigger;
  if (type === "ON_KEY_DOWN") return { type, device: typeof source.device === "string" ? source.device : "KEYBOARD", keyCodes: Array.isArray(source.keyCodes) ? source.keyCodes : [] } as Trigger;
  if (type === "ON_MEDIA_HIT") return { type, mediaHitTime: typeof source.mediaHitTime === "number" ? source.mediaHitTime : 0 };
  return { type } as Trigger;
}

async function variableByReference(reference: unknown, resources: Resources): Promise<Variable | null> {
  const key = String(reference || "");
  return resources.variables.get(key) || await figma.variables.getVariableByIdAsync(key);
}

function primitiveData(value: JsonPrimitive): VariableData {
  const type = typeof value === "boolean" ? "BOOLEAN" : typeof value === "number" ? "FLOAT" : "STRING";
  return { type, resolvedType: type, value } as VariableData;
}

async function variableData(value: unknown, resources: Resources): Promise<VariableData | undefined> {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return primitiveData(value as JsonPrimitive);
  const source = object(value);
  if (source.variable) {
    const variable = await variableByReference(source.variable, resources);
    if (!variable) throw new Error(`Prototype variable '${source.variable}' was not found`);
    return { type: "VARIABLE_ALIAS", resolvedType: variable.resolvedType, value: { type: "VARIABLE_ALIAS", id: variable.id } };
  }
  if (source.function) return {
    type: "EXPRESSION", resolvedType: typeof source.resolvedType === "string" ? source.resolvedType : "BOOLEAN",
    value: { expressionFunction: source.function, expressionArguments: await Promise.all((Array.isArray(source.arguments) ? source.arguments : []).map((argument) => variableData(argument, resources))) }
  } as VariableData;
  if (source.type && source.value !== undefined) return { ...source, value: source.value } as unknown as VariableData;
  return primitiveData((source.value ?? "") as JsonPrimitive);
}

async function action(value: JsonObject, nodes: Map<string, SceneNode>, resources: Resources, source?: SceneNode): Promise<Action> {
  const type = String(value.type || value.action || "NAVIGATE").toUpperCase();
  if (["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"].includes(type)) {
    const destinationKey = typeof value.destination === "string" ? value.destination : "";
    let destination = destinationKey ? nodes.get(destinationKey) : null;
    if (value.destination && !destination) throw new Error(`Prototype destination '${value.destination}' was not found`);
    if (destination && ["NAVIGATE", "SWAP", "OVERLAY"].includes(type)) destination = prototypeRoot(destination);
    if (destination && source && type === "SCROLL_TO" && !isDescendantOf(destination, prototypeRoot(source))) {
      throw new Error(`SCROLL_TO destination '${destinationKey}' must be inside the same top-level canvas as its source`);
    }
    if (destination && type === "CHANGE_TO" && destination.type !== "COMPONENT") {
      throw new Error(`CHANGE_TO destination '${destinationKey}' must be a component variant, received ${destination.type}`);
    }
    return {
      type: "NODE", destinationId: destination?.id || null, navigation: type as unknown as Navigation, transition: transition(value.transition),
      ...(value.overlayRelativePosition && typeof value.overlayRelativePosition === "object" ? { overlayRelativePosition: value.overlayRelativePosition as Vector } : {}),
      resetVideoPosition: value.resetVideoPosition === true, resetScrollPosition: value.resetScrollPosition === true,
      resetInteractiveComponents: value.resetInteractiveComponents === true
    };
  }
  if (type === "BACK" || type === "CLOSE") return { type };
  if (type === "URL") return { type, url: typeof value.url === "string" ? value.url : "", openInNewTab: value.openInNewTab !== false };
  if (type === "UPDATE_MEDIA_RUNTIME") return {
    type, destinationId: typeof value.destination === "string" ? nodes.get(value.destination)?.id || null : null, mediaAction: value.mediaAction,
    ...(value.amountToSkip !== undefined ? { amountToSkip: value.amountToSkip } : {}),
    ...(value.newTimestamp !== undefined ? { newTimestamp: value.newTimestamp } : {})
  } as Action;
  if (type === "SET_VARIABLE") {
    const variable = await variableByReference(value.variable || value.variableId, resources);
    if (!variable) throw new Error(`Prototype variable '${value.variable || value.variableId}' was not found`);
    return { type, variableId: variable.id, variableValue: await variableData(value.value ?? value.variableValue, resources) };
  }
  if (type === "SET_VARIABLE_MODE") {
    const collectionKey = String(value.collection || value.variableCollectionId || "");
    const collection = resources.variableCollections.get(collectionKey) || await figma.variables.getVariableCollectionByIdAsync(collectionKey);
    if (!collection) throw new Error(`Prototype variable collection '${collectionKey}' was not found`);
    const modeKey = String(value.mode || value.variableModeId || "");
    const mode = collection.modes.find((candidate) => candidate.modeId === modeKey || candidate.name === modeKey);
    if (!mode) throw new Error(`Prototype mode '${modeKey}' was not found in '${collection.name}'`);
    return { type, variableCollectionId: collection.id, variableModeId: mode.modeId };
  }
  if (type === "CONDITIONAL") return {
    type, conditionalBlocks: await Promise.all(objects(value.blocks || value.conditionalBlocks).map(async (block) => ({
      ...(block.condition !== undefined ? { condition: await variableData(block.condition, resources) } : {}),
      actions: await Promise.all(objects(block.actions).map((nested) => action(nested, nodes, resources, source)))
    })))
  };
  throw new Error(`Unsupported prototype action '${type}'`);
}

export async function buildReactions(items: JsonObject[], nodes: Map<string, SceneNode>, resources: Resources, source?: SceneNode): Promise<Reaction[]> {
  return Promise.all(items.map(async (item) => {
    const values = Array.isArray(item.actions) ? item.actions : [{ ...item, type: item.action || "NAVIGATE" }];
    if (!values.length) throw new Error("Prototype reaction requires at least one action");
    return { trigger: trigger(item.trigger), actions: await Promise.all(objects(values).map((value) => action(value, nodes, resources, source))) };
  }));
}
