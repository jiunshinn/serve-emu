import type { AccessibilityNode, AccessibilitySnapshot } from "./accessibility.ts";
import type { DeviceSize, MatchedElement } from "./shared/api-contracts.ts";

export class ElementMatchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ElementMatchError";
  }
}

type Identity = MatchedElement & { labels: Set<string> };
type IndexedSnapshot = { nodes: AccessibilityNode[]; byId: Map<string, AccessibilityNode>; labels: Map<string, Set<string>> };

const label = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

function insideViewport(node: AccessibilityNode, size: DeviceSize): boolean {
  const { left, top, right, bottom } = node.bounds;
  return [left, top, right, bottom].every(Number.isFinite) &&
    left >= 0 && top >= 0 && right > left && bottom > top &&
    right <= size.width && bottom <= size.height;
}

function indexSnapshot({ nodes }: AccessibilitySnapshot): IndexedSnapshot {
  if (nodes.length > 20_000) throw new ElementMatchError("hierarchy-too-large", "The accessibility hierarchy is too large to match safely.");
  const byId = new Map(nodes.map((item) => [item.id, item]));
  if (byId.size !== nodes.length) throw new ElementMatchError("hierarchy-invalid", "The accessibility hierarchy contains duplicate local IDs.");
  const ownLabels = new Map(nodes.map((node) => [node.id,
    new Set([label(node.text), label(node.contentDescription)].filter(Boolean)),
  ]));
  const labels = new Map(Array.from(ownLabels, ([id, values]) => [id, new Set(values)]));
  for (const child of nodes) {
    if (child.clickable || !child.enabled || !ownLabels.get(child.id)!.size) continue;
    let parentId = child.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      if (seen.size >= 128) throw new ElementMatchError("hierarchy-too-deep", "The accessibility hierarchy is too deep to match safely.");
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.clickable) {
        // Prefer the control's own accessible name. Descendant labels are a
        // fallback only for otherwise unnamed controls, never another button.
        if (parent.packageName === child.packageName && !ownLabels.get(parent.id)!.size) {
          for (const value of ownLabels.get(child.id)!) labels.get(parent.id)!.add(value);
        }
        break;
      }
      parentId = parent.parentId;
    }
  }
  return { nodes, byId, labels };
}

function isAncestor(ancestor: AccessibilityNode, node: AccessibilityNode, index: IndexedSnapshot): boolean {
  let parentId = node.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId) && seen.size < 128) {
    if (parentId === ancestor.id) return true;
    seen.add(parentId);
    parentId = index.byId.get(parentId)?.parentId;
  }
  return false;
}

function controlAtPoint(index: IndexedSnapshot, viewport: DeviceSize, x: number, y: number): AccessibilityNode {
  const hit = index.nodes.filter((node) => node.clickable && node.enabled && insideViewport(node, viewport) &&
    x >= node.bounds.left && x < node.bounds.right && y >= node.bounds.top && y < node.bounds.bottom);
  if (!hit.length) throw new ElementMatchError("element-not-found", "No enabled accessibility control was found at that point.");
  // A smaller rectangle is not evidence that it sits above an unrelated
  // dialog or overlay. Only a verified ancestor chain can disambiguate hits.
  let deepest = hit[0]!;
  for (const node of hit.slice(1)) {
    if (isAncestor(deepest, node, index)) deepest = node;
    else if (!isAncestor(node, deepest, index)) {
      throw new ElementMatchError("element-ambiguous", "Overlapping accessibility controls make this tap ambiguous.");
    }
  }
  return deepest;
}

function identityFor(node: AccessibilityNode, index: IndexedSnapshot): Identity {
  const labels = index.labels.get(node.id)!;
  if (!node.packageName || (!labels.size && !node.resourceId)) {
    throw new ElementMatchError("element-unidentified", "The clicked control has no reliable label or resource ID.");
  }
  return {
    text: node.text || (labels.values().next().value ?? ""),
    contentDescription: node.contentDescription,
    resourceId: node.resourceId,
    packageName: node.packageName,
    labels,
  };
}

function candidates(identity: Identity, index: IndexedSnapshot, viewport: DeviceSize) {
  return index.nodes.filter((node) => {
    if (!node.clickable || !node.enabled || !insideViewport(node, viewport)) return false;
    if (node.packageName !== identity.packageName) return false;
    // A label must never jump from a navigation control to an unrelated
    // content action carrying the same text when a resource ID is available.
    if (identity.resourceId && node.resourceId !== identity.resourceId) return false;
    if (!identity.labels.size) return true;
    const labels = index.labels.get(node.id)!;
    return Array.from(identity.labels).every((value) => labels.has(value));
  });
}

export function assertElementViewport(viewport: DeviceSize, stream: DeviceSize): void {
  if (![viewport.width, viewport.height, stream.width, stream.height].every(
    (value) => Number.isSafeInteger(value) && value > 0 && value <= 65_535,
  )) throw new ElementMatchError("display-unavailable", "The current display size could not be verified.");
  const ratio = (viewport.width / viewport.height) / (stream.width / stream.height);
  if (Math.abs(ratio - 1) > 0.01) {
    throw new ElementMatchError("display-changed", "The display orientation or fold state changed; wait for the live screen and retry.");
  }
}

export function identifySourceElement(
  snapshot: AccessibilitySnapshot,
  viewport: DeviceSize,
  point: { x: number; y: number },
): Identity {
  const x = point.x * viewport.width;
  const y = point.y * viewport.height;
  const index = indexSnapshot(snapshot);
  const hit = controlAtPoint(index, viewport, x, y);
  const identity = identityFor(hit, index);
  if (candidates(identity, index, viewport).length !== 1) {
    throw new ElementMatchError("element-ambiguous", "The clicked control's label and resource ID are not unique on the source device.");
  }
  return identity;
}

export function matchTargetElement(
  identity: Identity,
  snapshot: AccessibilitySnapshot,
  viewport: DeviceSize,
): { x: number; y: number } {
  const index = indexSnapshot(snapshot);
  const matches = candidates(identity, index, viewport);
  if (matches.length !== 1) {
    throw new ElementMatchError(
      matches.length ? "element-ambiguous" : "element-not-found",
      matches.length ? "More than one control matches this element; nothing was tapped." : "No enabled control matches this element; nothing was tapped.",
    );
  }
  const { bounds } = matches[0]!;
  if (controlAtPoint(index, viewport, (bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2) !== matches[0]) {
    throw new ElementMatchError("element-obscured", "Another clickable control covers the matched element's center.");
  }
  return {
    x: (bounds.left + bounds.right) / 2 / viewport.width,
    y: (bounds.top + bounds.bottom) / 2 / viewport.height,
  };
}

export function describeMatchedElement(identity: Identity): MatchedElement {
  const { labels: _labels, ...description } = identity;
  return description;
}
