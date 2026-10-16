export function ErrorPanel({
  title,
  message,
  onRetry,
  onDismiss,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <section className="card error-panel" role="alert">
      <p className="eyebrow">Error</p>
      <h2 className="display-sub">{title}</h2>
      <p className="error-msg">{message}</p>
      <div className="form-actions">
        {onRetry && (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Retry
          </button>
        )}
        {onDismiss && (
          <button type="button" className="btn btn-ghost" onClick={onDismiss}>
            Back to planner
          </button>
        )}
      </div>
    </section>
  );
}
