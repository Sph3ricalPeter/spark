import { icon, type IconName } from "../../packages/vite-plugin/src/theme.ts";

/** One of Spark's Lucide icons (theme.ts), as the board draws it. */
export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return <span className="icon-box" ref={(el) => void el?.replaceChildren(icon(name, size))} />;
}
