import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { LoginScreen } from "./components/LoginScreen";
import { HomePage } from "./pages/HomePage";
import { EditorPage } from "./pages/EditorPage";

export default function App() {
  const { user, ready } = useAuth();

  if (!ready) return null;
  if (!user) return <LoginScreen />;

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/doc/:docId" element={<EditorPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
