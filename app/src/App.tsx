import { ScreenProvider, ScreenRouter } from "./shell";

export function App() {
  return (
    <ScreenProvider>
      <ScreenRouter />
    </ScreenProvider>
  );
}

export default App;
