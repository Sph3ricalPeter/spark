import { TitleBar } from "@/components/TitleBar";
import { Launcher } from "@/components/Launcher";

export function App() {
  return (
    <div className="app">
      <TitleBar />
      <main className="home">
        <Launcher />
      </main>
    </div>
  );
}
