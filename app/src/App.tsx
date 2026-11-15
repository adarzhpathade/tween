import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function App() {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    invoke<string>("app_version")
      .then((ver) => setVersion(ver))
      .catch((err) => console.error("Failed to fetch app version:", err));
  }, []);

  return (
    <main>
      <h1>Tween</h1>
      <p>{version ? `v${version}` : "Loading..."}</p>
    </main>
  );
}

export default App;
