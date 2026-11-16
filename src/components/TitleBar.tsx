import { launcherTitleBar } from "../../packages/vite-plugin/src/titlebar.ts";

/** The board's own title bar (titlebar.ts), made once: the spark mark, the
 * update button and the window buttons, exactly as with a project open. */
const bar = launcherTitleBar();

export function TitleBar() {
  return <div className="titlebar" ref={(el) => void el?.append(bar)} />;
}
