import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { LiveProvider } from "./lib/live";
import { MetaProvider } from "./lib/meta";
import { Layout } from "./components/Layout";
import { Empty, Skeleton } from "./components/ui";
import Overview from "./pages/Overview";

const LiveTrends = lazy(() => import("./pages/LiveTrends"));
const Explorer = lazy(() => import("./pages/Explorer"));
const Sentiment = lazy(() => import("./pages/Sentiment"));
const Pipeline = lazy(() => import("./pages/Pipeline"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <LiveProvider>
        <MetaProvider>
          <Layout>
            <Suspense fallback={<Skeleton className="h-64" />}>
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/trends" element={<LiveTrends />} />
                <Route path="/explorer" element={<Explorer />} />
                <Route path="/explorer/:tag" element={<Explorer />} />
                <Route path="/sentiment" element={<Sentiment />} />
                <Route path="/pipeline" element={<Pipeline />} />
                <Route path="/history" element={<HistoryPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Empty title="Page not found" />} />
              </Routes>
            </Suspense>
          </Layout>
        </MetaProvider>
      </LiveProvider>
    </BrowserRouter>
  </StrictMode>,
);
