import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolSection } from "../src/ui/components/tool-section";

/** The opening tag of the element with this id (attribute order agnostic). */
function bodyTag(markup: string, id: string): string {
  const tag = markup.match(new RegExp(`<[^>]*\\sid="${id}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no element with id ${id}`);
  return tag;
}

/** A boolean `hidden` attribute, not `aria-hidden` or a class name. */
const HIDDEN_ATTRIBUTE = /\shidden(?:=""|(?=[\s/>]))/;

describe("ToolSection", () => {
  test("keeps collapsed panel code out of the React tree", () => {
    let panelRenders = 0;
    const Probe = () => {
      panelRenders += 1;
      return <div>device-backed panel</div>;
    };

    const markup = renderToStaticMarkup(
      <ToolSection id="network-tool" title="Network">
        <Probe />
      </ToolSection>,
    );

    expect(panelRenders).toBe(0);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="network-tool-body"');
    expect(markup).toContain('id="network-tool-body"');
    expect(bodyTag(markup, "network-tool-body")).toMatch(HIDDEN_ATTRIBUTE);
    expect(markup).not.toContain("device-backed panel");
  });

  test("mounts an explicitly expanded panel behind its disclosure control", () => {
    let panelRenders = 0;
    const Probe = () => {
      panelRenders += 1;
      return <div>device-backed panel</div>;
    };

    const markup = renderToStaticMarkup(
      <ToolSection id="location-tool" title="Location" defaultExpanded>
        <Probe />
      </ToolSection>,
    );

    expect(panelRenders).toBe(1);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="location-tool-body"');
    expect(markup).toContain('id="location-tool-body"');
    expect(markup).toContain("device-backed panel");
    expect(bodyTag(markup, "location-tool-body")).not.toMatch(HIDDEN_ATTRIBUTE);
  });
});
