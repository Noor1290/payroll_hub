import { Component, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logger } from "@/lib/logger";

interface Props {
  children: ReactNode;
  /** When this changes (e.g. the route), the boundary clears its error. */
  resetKey?: string;
}

interface State {
  failed: boolean;
}

/** Keeps one broken screen from taking the whole dashboard down. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    // Only the error's name: messages and stacks could carry data from the screen.
    logger.error("A screen crashed.", { name: error instanceof Error ? error.name : "unknown" });
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto max-w-md px-6 py-20 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full border border-danger/30 bg-danger/10">
          <TriangleAlert className="size-5 text-danger" aria-hidden="true" />
        </div>
        <h2 className="mt-5 text-lg font-semibold">This screen hit a problem</h2>
        <p className="mt-2 text-sm text-muted">
          The rest of the dashboard is still running. Try again, or pick another page from the
          sidebar.
        </p>
        <Button className="mt-6" onClick={() => this.setState({ failed: false })}>
          Try again
        </Button>
      </div>
    );
  }
}
