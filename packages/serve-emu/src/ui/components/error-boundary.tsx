import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { label: string; children: ReactNode };
type State = { error: Error | null };

/**
 * Keeps one failing panel from unmounting the whole app, and the stream with
 * it: the panel shows the error and a retry button instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui] ${this.props.label} failed:`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="panel-error" role="alert">
        <p>
          {this.props.label} stopped working: {error.message}
        </p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}
