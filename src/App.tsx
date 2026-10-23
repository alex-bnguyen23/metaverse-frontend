import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { loadAppearance, STORAGE_KEY } from "./utils/appearance";
import DressPage from "./pages/DressPage";
import WorldPage from "./pages/WorldPage";
import { LandingPage } from "./pages/LandingPage";
import "./App.css";
// Own appearance above both routes so navigation preserves the selected look.
export default function App() {
  // A function initializer reads storage when state is created, rather than on every render.
  const [appearance, setAppearance] = useState(loadAppearance);
  // Persist after each selection; navigation keeps the same in-memory state.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    } catch {
      // Blocked or full storage should not prevent changing the look in this session.
      console.warn("Appearance could not be saved on this device.");
    }
  }, [appearance]);
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/dress"
          element={<DressPage appearance={appearance} onChange={setAppearance} />}
        />
        <Route path="/world" element={<WorldPage appearance={appearance} />} />
        <Route path="*" element={<Navigate to="/dress" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
