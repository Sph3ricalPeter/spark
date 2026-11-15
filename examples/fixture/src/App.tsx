import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Project } from "./api";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Track } from "./ui/Track";

function Toolbar({ title }: { title: string }) {
  return (
    <header className="toolbar">
      <span className="title">{title}</span>
      <Button small disabled title="Nothing to undo">
        <svg className="glyph" viewBox="0 0 16 16">
          <path d="M6 3 2.5 6.5 6 10M3 6.5h6.5a3.5 3.5 0 0 1 0 7H8" />
        </svg>
        Undo
      </Button>
      <Button small>
        <svg className="glyph" viewBox="0 0 16 16" style={{ transform: "scaleX(-1)" }}>
          <path d="M6 3 2.5 6.5 6 10M3 6.5h6.5a3.5 3.5 0 0 1 0 7H8" />
        </svg>
        Redo
      </Button>
      <Button variant="primary">
        <Download size={14} />
        Export
      </Button>
    </header>
  );
}

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.currentProject().then(setProject, (e) => setError(String(e)));
  }, []);
  const open = () => api.openProject().then(setProject, (e) => setError(String(e)));
  return (
    <div className="app">
      <Toolbar title={project?.name ?? "No project"} />
      <main className="tracks">
        {project ? (
          project.tracks.map((t) => <Track key={t.name} {...t} />)
        ) : (
          <div className="empty">
            <p>{error || "No project open."}</p>
            <Button variant="primary" onClick={open}>
              Open project
            </Button>
          </div>
        )}
      </main>
      <footer className="footer">
        <Card title="Export mixdown">
          <div>WAV · 48 kHz · 24-bit</div>
          <div className="actions">
            <Button variant="ghost">Cancel</Button>
            <Button variant="primary">Export</Button>
          </div>
        </Card>
      </footer>
    </div>
  );
}
