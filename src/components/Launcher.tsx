import { folderName, useProjectsStore } from "@/stores/projects-store";

/** The main window: open a project folder, or one of the recent ones. */
export function Launcher() {
  const { recent, opening, error, pick, open, forget, dismissError } = useProjectsStore();
  const busy = opening !== null;

  return (
    <div className="launcher">
      <div className="launcher-head">
        <h1>Open a project</h1>
        <p className="faint">
          A folder with a Vite + React app. Spark runs its dev server and opens it in its own window, ready to edit.
        </p>
        <button className="btn primary" disabled={busy} onClick={() => void pick()}>
          Open folder…
        </button>
      </div>

      {opening && (
        <div className="launcher-status">
          <span className="spinner" />
          <span>
            <b>{folderName(opening.folder)}</b> · {opening.step}
          </span>
        </div>
      )}

      {error && (
        <div className="launcher-error">
          <div className="launcher-error-head">
            <b>Couldn't open {folderName(error.folder)}</b>
            <button className="tb" aria-label="Dismiss" onClick={dismissError}>
              ×
            </button>
          </div>
          <pre>{error.message}</pre>
        </div>
      )}

      {recent.length > 0 && (
        <div className="recent">
          <h2>Recent</h2>
          <ul>
            {recent.map((r) => (
              <li key={r.folder}>
                <button className="recent-open" disabled={busy} onClick={() => void open(r.folder)} title={`Open ${r.folder}`}>
                  <span className="recent-name">{r.name}</span>
                  <span className="recent-path faint">{r.folder}</span>
                </button>
                <button className="tb" aria-label={`Remove ${r.name} from recent`} title="Remove from recent" onClick={() => forget(r.folder)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
