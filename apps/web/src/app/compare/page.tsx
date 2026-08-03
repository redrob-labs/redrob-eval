import { ComparePanel } from '@/components/ComparePanel';

export default function ComparePage() {
  return (
    <div className="app">
      <header className="app-titlebar">
        <div className="app-titlebar-left">
          <a href="/" className="app-name">
            redrob-eval
          </a>
          <span className="app-sep" />
          <span className="app-muted">Compare</span>
        </div>
        <div className="app-titlebar-right">
          <a href="/" className="app-ghost-btn">
            ← Modes
          </a>
        </div>
      </header>
      <ComparePanel />
    </div>
  );
}
