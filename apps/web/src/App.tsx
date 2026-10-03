import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { ConnectModal } from './components/ConnectModal';
import { Footer } from './components/Footer';
import { TopNav } from './components/Nav';
import { AdminPage } from './pages/Admin';
import { ApiDocs } from './pages/ApiDocs';
import { AppLayout } from './pages/AppLayout';
import { Chat } from './pages/Chat';
import { Dashboard } from './pages/Dashboard';
import { Docs } from './pages/Docs';
import { DownloadPage } from './pages/Download';
import { Keys } from './pages/Keys';
import { Landing } from './pages/Landing';
import { LandingV2 } from './pages/LandingV2';
import { LandingV3 } from './pages/LandingV3';
import { LeaderboardPage } from './pages/Leaderboard';
import { Privacy, Risk, Terms } from './pages/Legal';
import { NodePage } from './pages/Node';
import { NotFound } from './pages/NotFound';
import { usePointsEnabled, useStats } from './lib/hooks';
import { ReportPage } from './pages/Report';
import { Stake } from './pages/Stake';
import { StatsPage } from './pages/StatsPage';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="empty" role="alert" style={{ margin: '40px 0' }}>
          <span className="t">Something broke</span>
          <span className="mono small">{this.state.error.message}</span>
          <button className="btn secondary sm" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** /leaderboard exists only while the points programme is on (GET /stats pointsEnabled); otherwise it is a 404 like any unknown path. */
function LeaderboardRoute() {
  const { data } = useStats(60_000);
  const pointsEnabled = usePointsEnabled();
  if (pointsEnabled) return <LeaderboardPage />;
  if (!data) return null; // stats still loading: avoid flashing a 404 that may turn into the page
  return <NotFound />;
}

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo({ top: 0 });
  }, [pathname, hash]);
  return null;
}

export function App() {
  return (
    <>
      <ScrollToTop />
      <main className="page">
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', paddingTop: 16 }}>
          <TopNav />
        </div>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/v2" element={<LandingV2 />} />
            <Route path="/v3" element={<LandingV3 />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/download" element={<DownloadPage />} />
            <Route path="/api" element={<ApiDocs />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/risk" element={<Risk />} />
            <Route path="/report" element={<ReportPage />} />
            <Route path="/leaderboard" element={<LeaderboardRoute />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/app" element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="keys" element={<Keys />} />
              <Route path="chat" element={<Chat />} />
              <Route path="stats" element={<StatsPage />} />
              <Route path="node" element={<NodePage />} />
              <Route path="stake" element={<Stake />} />
            </Route>
            <Route path="/404" element={<NotFound />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </ErrorBoundary>
        <div style={{ maxWidth: 1200, margin: '0 auto', paddingBottom: 40 }}>
          <Footer />
        </div>
      </main>
      <ConnectModal />
    </>
  );
}
