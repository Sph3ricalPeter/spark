// Sample data for Spark's board: the fixture's backend commands (src/api.ts)
// answered without a backend. Each app frame picks one in its inspector.
import type { Project } from "./src/api";

const NIGHT_DRIVE: Project = {
  name: "Night Drive",
  tracks: [
    { name: "Drums", color: "var(--track-drums)", level: 0.8 },
    { name: "Bass", color: "var(--track-bass)", level: 0.55 },
    { name: "Keys", color: "var(--track-keys)", level: 0.3 },
  ],
};

const colors = ["var(--track-drums)", "var(--track-bass)", "var(--track-keys)"];
const BIG: Project = {
  name: "Sunday Session, Final Mix (Alternate Take With Extra Percussion)",
  tracks: Array.from({ length: 12 }, (_, i) => ({ name: `Track ${i + 1}`, color: colors[i % 3], level: ((i * 37) % 100) / 100 })),
};

export const samples = {
  "Night Drive": { current_project: () => NIGHT_DRIVE },
  // Nothing open: "Open project" opens Night Drive.
  Empty: () => {
    let open: Project | null = null;
    return {
      current_project: () => open,
      open_project: () => (open = NIGHT_DRIVE),
    };
  },
  "Many tracks": { current_project: () => BIG },
};
