import { describe, expect, test } from "bun:test";
import { parseAccessibilityXml, type AccessibilityNode, type AccessibilitySnapshot } from "../src/accessibility.ts";
import { displaySizeFromPng } from "../src/display-size.ts";
import { assertElementViewport, describeMatchedElement, identifySourceElement, matchTargetElement } from "../src/element-matching.ts";

const size = { width: 100, height: 100 };
const snapshot = (nodes: AccessibilityNode[]): AccessibilitySnapshot => ({ ok: true, capturedAt: new Date().toISOString(), nodes });
function node(id: string, overrides: Partial<AccessibilityNode> = {}): AccessibilityNode {
  return {
    id, text: "", contentDescription: "Home", resourceId: "", className: "android.widget.Button",
    packageName: "com.google.android.youtube", clickable: true, enabled: true,
    bounds: { left: 0, top: 60, right: 40, bottom: 100 }, ...overrides,
  };
}

describe("semantic element matching", () => {
  test("matches YouTube Home across phone and centered unfolded-fold navigation", () => {
    const phone = snapshot([node("phone-3", { bounds: { left: 0, top: 2211, right: 270, bottom: 2337 } })]);
    const fold = snapshot([node("fold-52", { bounds: { left: 600, top: 1630, right: 852, bottom: 1756 } })]);
    const identity = identifySourceElement(phone, { width: 1080, height: 2400 }, { x: 0.125, y: 0.9475 });
    expect(matchTargetElement(identity, fold, { width: 2208, height: 1840 })).toEqual({ x: 726 / 2208, y: 1693 / 1840 });
  });

  test("resource IDs disambiguate duplicate Search labels without falling back to content actions", () => {
    const nav = node("nav", { contentDescription: "Search", resourceId: "com.qa:id/nav_search" });
    const content = node("content", { contentDescription: "Search", resourceId: "com.qa:id/search_content", bounds: { left: 60, top: 0, right: 100, bottom: 40 } });
    const identity = identifySourceElement(snapshot([nav, content]), size, { x: 0.2, y: 0.8 });
    const movedNav = { ...nav, id: "different-index", bounds: { left: 60, top: 0, right: 100, bottom: 40 } };
    const movedContent = { ...content, bounds: { left: 0, top: 60, right: 40, bottom: 100 } };
    expect(matchTargetElement(identity, snapshot([movedNav, movedContent]), size)).toEqual({ x: 0.8, y: 0.2 });
    expect(() => matchTargetElement(identity, snapshot([movedContent]), size)).toThrow("No enabled control");
    expect(() => matchTargetElement(identity, snapshot([movedNav, { ...nav, id: "duplicate" }]), size)).toThrow("More than one");
  });

  test("never matches local node IDs, other packages, disabled controls, or different labels", () => {
    const identity = identifySourceElement(snapshot([node("same-index")]), size, { x: 0.2, y: 0.8 });
    for (const target of [
      node("same-index", { contentDescription: "Subscriptions" }),
      node("same-index", { packageName: "com.other.app" }),
      node("same-index", { enabled: false }),
    ]) expect(() => matchTargetElement(identity, snapshot([target]), size)).toThrow("No enabled control");
  });

  test("refuses duplicate source labels before using the clicked control as an identity", () => {
    const first = node("first");
    const second = node("second", { bounds: { left: 60, top: 0, right: 100, bottom: 40 } });
    expect(() => identifySourceElement(snapshot([first, second]), size, { x: 0.2, y: 0.8 }))
      .toThrow("not unique on the source");
  });

  test("normalizes accessible labels without exposing internal label sets", () => {
    const source = node("source", { text: "  ＨＯＭＥ  ", contentDescription: "Open\n Home" });
    const identity = identifySourceElement(snapshot([source]), size, { x: 0.2, y: 0.8 });
    const target = node("target", { text: "home", contentDescription: "open home" });
    expect(matchTargetElement(identity, snapshot([target]), size)).toEqual({ x: 0.2, y: 0.8 });
    expect(describeMatchedElement(identity)).toEqual({
      text: "  ＨＯＭＥ  ", contentDescription: "Open\n Home", resourceId: "", packageName: source.packageName,
    });
    expect(() => matchTargetElement(identity, snapshot([{ ...target, contentDescription: "Open settings" }]), size))
      .toThrow("No enabled control");
  });

  test("a unique resource ID can identify an otherwise unnamed control", () => {
    const source = node("source", { contentDescription: "", resourceId: "com.qa:id/home" });
    const identity = identifySourceElement(snapshot([source]), size, { x: 0.2, y: 0.8 });
    expect(matchTargetElement(identity, snapshot([node("target", { resourceId: source.resourceId })]), size))
      .toEqual({ x: 0.2, y: 0.8 });
    expect(() => matchTargetElement(identity, snapshot([node("same-index")]), size)).toThrow("No enabled control");
  });

  test("uses descendant names only for unnamed parents and requires all distinguishing labels", () => {
    const card = node("card", { contentDescription: "", resourceId: "com.qa:id/card" });
    const title = node("title", { parentId: "card", clickable: false, contentDescription: "", text: "Unique video title" });
    const action = node("action", { parentId: "card", clickable: false, contentDescription: "", text: "Subscribe" });
    const identity = identifySourceElement(snapshot([card, title, action]), size, { x: 0.2, y: 0.8 });
    const otherTitle = { ...title, text: "A completely different video" };
    expect(() => matchTargetElement(identity, snapshot([card, otherTitle, action]), size)).toThrow("No enabled control");
    expect(matchTargetElement(identity, snapshot([card, title, action]), size)).toEqual({ x: 0.2, y: 0.8 });
    const ownName = identifySourceElement(snapshot([{ ...card, contentDescription: "Home" }, title]), size, { x: 0.2, y: 0.8 });
    expect(matchTargetElement(ownName, snapshot([{ ...card, contentDescription: "Home" }, otherTitle]), size)).toEqual({ x: 0.2, y: 0.8 });
  });

  test("does not borrow identity from nested buttons, disabled children, or another package", () => {
    const parent = node("parent", { contentDescription: "" });
    for (const child of [
      node("child", { parentId: "parent", contentDescription: "Subscribe", bounds: { left: 10, top: 80, right: 30, bottom: 95 } }),
      node("child", { parentId: "parent", clickable: false, enabled: false }),
      node("child", { parentId: "parent", clickable: false, packageName: "com.other.app" }),
    ]) {
      expect(() => identifySourceElement(snapshot([parent, child]), size, { x: 0.05, y: 0.65 }))
        .toThrow("no reliable label");
    }
  });

  test("rejects unrelated overlays and permits verified clickable ancestor chains", () => {
    const home = node("home");
    const overlay = node("overlay", { contentDescription: "Dialog", bounds: { left: 0, top: 0, right: 100, bottom: 100 } });
    expect(() => identifySourceElement(snapshot([home, overlay]), size, { x: 0.2, y: 0.8 })).toThrow("Overlapping");
    const identity = identifySourceElement(snapshot([home]), size, { x: 0.2, y: 0.8 });
    expect(() => matchTargetElement(identity, snapshot([home, overlay]), size)).toThrow("Overlapping");
    const nested = snapshot([{ ...home, parentId: "overlay" }, overlay]);
    expect(matchTargetElement(identifySourceElement(nested, size, { x: 0.2, y: 0.8 }), nested, size)).toEqual({ x: 0.2, y: 0.8 });
    const reversed = snapshot([...nested.nodes].reverse());
    expect(matchTargetElement(identifySourceElement(reversed, size, { x: 0.2, y: 0.8 }), reversed, size)).toEqual({ x: 0.2, y: 0.8 });
  });

  test("refuses a matched parent whose target center belongs to a nested button", () => {
    const parent = node("parent", { contentDescription: "Open card", bounds: { left: 0, top: 0, right: 100, bottom: 100 } });
    const identity = identifySourceElement(snapshot([parent]), size, { x: 0.1, y: 0.1 });
    const child = node("child", {
      parentId: "parent", contentDescription: "Delete card", bounds: { left: 40, top: 40, right: 60, bottom: 60 },
    });
    expect(() => matchTargetElement(identity, snapshot([parent, child]), size)).toThrow("covers the matched element's center");
  });

  test("excludes partially offscreen and non-clickable target nodes", () => {
    const identity = identifySourceElement(snapshot([node("source")]), size, { x: 0.2, y: 0.8 });
    for (const target of [
      node("target", { clickable: false }),
      node("target", { bounds: { left: -1, top: 60, right: 40, bottom: 100 } }),
      node("target", { bounds: { left: 0, top: 60, right: 101, bottom: 100 } }),
      node("target", { bounds: { left: 0, top: 60, right: 0, bottom: 100 } }),
    ]) expect(() => matchTargetElement(identity, snapshot([target]), size)).toThrow("No enabled control");
  });

  test("bounds ancestor traversal before collecting fallback labels", () => {
    const hierarchy = Array.from({ length: 130 }, (_, index) => node(String(index), {
      clickable: false, contentDescription: "", ...(index ? { parentId: String(index - 1) } : {}),
    }));
    hierarchy.push(node("label", { parentId: "129", clickable: false, contentDescription: "Home" }));
    expect(() => identifySourceElement(snapshot(hierarchy), size, { x: 0.2, y: 0.8 })).toThrow("too deep");
  });

  test("bounds hierarchy work and rejects unlabelled, offscreen, and empty source points", () => {
    expect(() => identifySourceElement(snapshot([node("0", { contentDescription: "" })]), size, { x: 0.2, y: 0.8 })).toThrow("no reliable label");
    expect(() => identifySourceElement(snapshot([node("0")]), size, { x: 0.9, y: 0.1 })).toThrow("No enabled accessibility");
    expect(() => identifySourceElement(snapshot(Array.from({ length: 20_001 }, (_, i) => node(String(i)))), size, { x: 0.2, y: 0.8 })).toThrow("too large");
    expect(() => identifySourceElement(snapshot([node("0"), node("0")]), size, { x: 0.2, y: 0.8 })).toThrow("duplicate local IDs");
  });
});

test("parses real parent relationships without treating local IDs as portable selectors", () => {
  const nodes = parseAccessibilityXml('<hierarchy><node bounds="[0,0][100,100]"><node clickable="true" bounds="[0,60][40,100]"><node text="Home" enabled="true" bounds="[10,70][30,90]" /></node><node text="Other" bounds="[50,50][70,70]" /></node></hierarchy>');
  expect(nodes.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
    { id: "0", parentId: undefined }, { id: "1", parentId: "0" }, { id: "2", parentId: "1" }, { id: "3", parentId: "0" },
  ]);
});

test("uses verified PNG viewport dimensions and permits encoder scale rounding only", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12); png.writeUInt32BE(2208, 16); png.writeUInt32BE(1840, 20);
  expect(displaySizeFromPng(png)).toEqual({ width: 2208, height: 1840 });
  expect(() => displaySizeFromPng(Buffer.from("bad"))).toThrow("PNG");
  expect(() => assertElementViewport({ width: 2208, height: 1840 }, { width: 1280, height: 1066 })).not.toThrow();
  expect(() => assertElementViewport({ width: 1080, height: 2400 }, { width: 1280, height: 576 })).toThrow("orientation or fold");
  expect(() => assertElementViewport({ width: 1280, height: 2856 }, { width: 572, height: 1280 })).not.toThrow();
  expect(() => assertElementViewport({ width: 2208, height: 1840 }, { width: 1228, height: 1024 })).not.toThrow();
  for (const width of [0, -1, 65_536, 1080.5, NaN, Infinity]) {
    expect(() => assertElementViewport({ width, height: 2400 }, { width: 576, height: 1280 })).toThrow("could not be verified");
  }
});
