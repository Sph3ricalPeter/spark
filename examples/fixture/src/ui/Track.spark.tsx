import { Track } from "./Track";

// Tracks stretch to their lane in the app: give them one here.
const lane = { width: 560 };

export const Drums = () => (
  <div style={lane}>
    <Track name="Drums" color="var(--track-drums)" level={0.8} />
  </div>
);
export const Quiet = () => (
  <div style={lane}>
    <Track name="Keys" color="var(--track-keys)" level={0.1} />
  </div>
);
