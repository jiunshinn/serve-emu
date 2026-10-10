import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary } from "../src/ui/components/error-boundary";

describe("ErrorBoundary", () => {
  test("renders its children while nothing has failed", () => {
    const markup = renderToStaticMarkup(
      <ErrorBoundary label="Orientation">
        <div>panel body</div>
      </ErrorBoundary>,
    );
    expect(markup).toBe("<div>panel body</div>");
  });

  test("replaces a failed panel with its error and a retry button", () => {
    const boundary = new ErrorBoundary({ label: "Orientation", children: null });
    boundary.state = ErrorBoundary.getDerivedStateFromError(
      new Error("Objects are not valid as a React child"),
    );
    const markup = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(
      "Orientation stopped working: Objects are not valid as a React child",
    );
    expect(markup).toContain(">Retry</button>");
  });

  test("normalizes thrown non-errors and logs the failure", () => {
    expect(ErrorBoundary.getDerivedStateFromError("boom").error?.message).toBe(
      "boom",
    );
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const boundary = new ErrorBoundary({ label: "Apps", children: null });
      const error = new Error("render failed");
      boundary.componentDidCatch(error, { componentStack: "\n  at AppsPanel" });
      expect(errorLog).toHaveBeenCalledWith(
        "[ui] Apps failed:",
        error,
        "\n  at AppsPanel",
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});
