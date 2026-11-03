import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { devBuild, type AppInfo } from "@/lib/app-info";
import { UpdateIndicator } from "./UpdateIndicator";

function windowAction(action: "minimize" | "toggleMaximize" | "close") {
  if (!isTauri()) return;
  void getCurrentWindow()[action]();
}

const Win = ({ d }: { d: string }) => (
  <svg viewBox="0 0 10 10" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** The spark mark: a lightning bolt. */
export const SparkMark = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M9.2 1 3.5 9.2h4l-.8 5.8L12.5 6.8h-4z" />
  </svg>
);

/** Custom title bar: the window has no native frame (Windows 11 still rounds it). */
export function TitleBar({ info }: { info: AppInfo | null }) {
  const dev = info && info.channel === "dev";
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tleft" data-tauri-drag-region>
        <div className="logo" data-tauri-drag-region title={info ? `spark ${info.version}` : "spark"}>
          <SparkMark />
          spark
          {dev && <span className="badge">dev {devBuild(info)}</span>}
        </div>
      </div>
      <div className="tright" data-tauri-drag-region>
        <UpdateIndicator />
        <div className="winctl">
          <button aria-label="Minimize" onClick={() => windowAction("minimize")}>
            <Win d="M0 5h10" />
          </button>
          <button aria-label="Maximize" onClick={() => windowAction("toggleMaximize")}>
            <Win d="M.5.5h9v9h-9z" />
          </button>
          <button className="close" aria-label="Close" onClick={() => windowAction("close")}>
            <Win d="M0 0l10 10M10 0 0 10" />
          </button>
        </div>
      </div>
    </header>
  );
}
