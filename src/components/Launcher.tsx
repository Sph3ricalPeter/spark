import { folderName, useProjectsStore } from "@/stores/projects-store";
import { Icon } from "./Icon";

/** "now", "5m ago", "3h ago", "2d ago", then the date: as the Chats list says it. */
function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Spark's home: open a project folder, or one of the recent ones. A project replaces it in the window.
 * A panel on the board's canvas, built like the board's panels (theme.ts). */
export function Launcher() {
  const { recent, opening, error, pick, open, forget, dismissError } = useProjectsStore();
  const busy = opening !== null;

  return (
    <div className="picker">
      <div className="picker-head">
        <div className="picker-title">
          <Icon name="folder-open" size={14} />
          Open a project
        </div>
        <p>A folder with a Vite + React app. Spark runs its dev server and opens it here, ready to edit; the spark button in its title bar comes back to this list.</p>
        <button className="sp-btn primary wide" disabled={busy} onClick={() => void pick()}>
          <Icon name="folder-open" size={13} />
          <span>Open folder…</span>
        </button>
      </div>

      {opening && (
        <div className="picker-status">
          <span className="spin" />
          <span className="picker-status-text">
            <b>{folderName(opening.folder)}</b> · {opening.step}
          </span>
        </div>
      )}

      {error && (
        <div className="picker-error">
          <div className="picker-error-head">
            <b>Couldn't open {folderName(error.folder)}</b>
            <button className="sp-btn ghost small" aria-label="Dismiss" title="Dismiss" onClick={dismissError}>
              <Icon name="x" size={12} />
            </button>
          </div>
          <pre>{error.message}</pre>
        </div>
      )}

      {recent.length > 0 && (
        <div className="recent">
          <div className="recent-label">Recent</div>
          <ul>
            {recent.map((r) => (
              <li key={r.folder}>
                <button className="recent-row" disabled={busy} onClick={() => void open(r.folder)} title={`Open ${r.folder}`}>
                  <span className="recent-ic">
                    <Icon name="folder" size={14} />
                  </span>
                  <span className="recent-main">
                    <span className="recent-top">
                      <span className="recent-name">{r.name}</span>
                      <span className="recent-when">{ago(r.openedAt)}</span>
                    </span>
                    <span className="recent-path">{r.folder}</span>
                  </span>
                </button>
                <button className="recent-forget" aria-label={`Remove ${r.name} from recent`} title="Remove from recent" onClick={() => forget(r.folder)}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
