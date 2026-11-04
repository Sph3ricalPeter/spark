import type { CSSProperties } from "react";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Meter } from "./ui/Meter";

const TRACKS = [
  { name: "Drums", color: "var(--track-drums)", level: 0.8 },
  { name: "Bass", color: "var(--track-bass)", level: 0.55 },
  { name: "Keys", color: "var(--track-keys)", level: 0.3 },
];

function Toolbar() {
  return (
    <header className="toolbar">
      <span className="title">Night Drive</span>
      <Button small>Undo</Button>
      <Button small>Redo</Button>
      <Button variant="primary">Export</Button>
    </header>
  );
}

function Track({ name, color, level }: { name: string; color: string; level: number }) {
  return (
    <div className="track" style={{ "--track-color": color } as CSSProperties}>
      <span className="name">{name}</span>
      <div className="clip" />
      <Meter level={level} />
      <Button variant="ghost" small>
        Mute
      </Button>
    </div>
  );
}

export function App() {
  return (
    <div className="app">
      <Toolbar />
      <main className="tracks">
        {TRACKS.map((t) => (
          <Track key={t.name} {...t} />
        ))}
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
