import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { AskLakeLandingPage } from "./pages/landing/AskLakeLandingPage";
import { AskLakeLoginPage } from "./pages/landing/AskLakeLoginPage";
import "./styles.css";

const App = lazy(() => import("./App").then((module) => ({ default: module.App })));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AskLakeLandingPage />} />
        <Route path="/login" element={<AskLakeLoginPage />} />
        <Route
          path="*"
          element={(
            <Suspense fallback={<div className="workspace-route-loading" role="status">AskLake 작업 공간을 불러오는 중...</div>}>
              <App />
            </Suspense>
          )}
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
