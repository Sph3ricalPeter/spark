/** A level meter, 0 to 1. */
export function Meter({ level }: { level: number }) {
  return (
    <div className="meter">
      <div style={{ height: `${Math.round(level * 100)}%` }} />
    </div>
  );
}
