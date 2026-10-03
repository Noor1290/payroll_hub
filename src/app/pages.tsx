import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="glass flex flex-col items-center rounded-2xl px-6 py-16 text-center">
      <p className="tabular text-sm text-subtle">404</p>
      <h1 className="mt-2 text-xl font-semibold">That page doesn't exist</h1>
      <p className="mt-2 text-sm text-muted">The link may be old or mistyped.</p>
      <Link to="/" className="mt-6 text-sm font-medium text-accent underline underline-offset-4">
        Back to Overview
      </Link>
    </section>
  );
}
