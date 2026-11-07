import type { CSSProperties } from "react";
import { Button } from "./Button";
import { Meter } from "./Meter";

/** One track row: name, clip lane, level meter, mute. */
export function Track({ name, color, level }: { name: string; color: string; level: number }) {
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
