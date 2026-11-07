import { useEffect, useState } from "react";
import { getAppInfo, type AppInfo } from "@/lib/app-info";
import { CHECK_INTERVAL_MS, DEV_CHECK_INTERVAL_MS, useUpdaterStore } from "@/stores/updater-store";
import { TitleBar } from "@/components/TitleBar";
import { Launcher } from "@/components/Launcher";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    void getAppInfo().then((info) => {
      setInfo(info);
      const updater = useUpdaterStore.getState();
      updater.init(info.updatesEnabled);
      if (!info.updatesEnabled) return;
      void updater.checkNow();
      // "spark dev" gets a build on every push, so it looks more often.
      const every = info.channel === "dev" ? DEV_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS;
      timer = window.setInterval(() => void useUpdaterStore.getState().checkNow(), every);
    });
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="app">
      <TitleBar info={info} />
      <main className="canvas">
        <Launcher />
      </main>
    </div>
  );
}
