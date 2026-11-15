// The fixture's "backend": Tauri commands, as a real app's Rust side would
// have them. Spark runs the frontend only, so on the board they're answered
// by the sample data in spark.setup.tsx (packages/vite-plugin/src/sample.ts).
import { invoke } from "@tauri-apps/api/core";

export type TrackInfo = { name: string; color: string; level: number };
export type Project = { name: string; tracks: TrackInfo[] };

export const api = {
  /** The project the app was opened with, if any. */
  currentProject: () => invoke<Project | null>("current_project"),
  openProject: () => invoke<Project>("open_project"),
};
