import { useEffect, useState } from "react";
import type { Health } from "../api";
import { useTheme } from "../theme";

export type HealthState =
  | { state: "loading" }
  | { state: "ready"; health: Health }
  | { state: "error"; message: string };

function missingPieces(h: Health): string[] {
  const missing: string[] = [];
  if (!h.qloo) missing.push("Qloo API key");
  if (!h.llm) missing.push("LLM API key");
  return missing;
}

export function isHealthy(h: HealthState): boolean {
  return h.state === "ready" && h.health.ok && h.health.qloo && h.health.llm;
}

function StatusPill({ health }: { health: HealthState }) {
  if (health.state === "loading") return <span className="pill pill-muted">Checking server…</span>;
  if (health.state === "error")
    return (
      <span className="pill pill-bad" title={health.message}>
        <span className="dot" aria-hidden="true" />
        Server offline
      </span>
    );
  const missing = missingPieces(health.health);
  if (missing.length || !health.health.ok) {
    const detail = missing.length ? `Missing ${missing.join(" and ")}` : undefined;
    return (
      <span className="pill pill-warn" title={detail}>
        <span className="pill-text">
          Setup incomplete
          {detail && <span className="sr-only">: {detail}</span>}
        </span>
      </span>
    );
  }
  return (
    <span className="pill pill-ok" title={health.health.model ?? undefined}>
      <span className="dot" aria-hidden="true" />
      <span className="pill-text">
        Live
        {health.health.model && <span className="pill-label-long"> · {health.health.model}</span>}
      </span>
    </span>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

export function Header({ health, onHome }: { health: HealthState; onHome: () => void }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`site-header${scrolled ? " scrolled" : ""}`}>
      <nav className="nav" aria-label="Site">
        <a
          href="#/"
          className="logo"
          onClick={(e) => {
            e.preventDefault();
            onHome();
          }}
        >
          <img src="/favicon.svg" alt="" width={30} height={30} />
          <span className="logo-word">Fondly</span>
        </a>
        <div className="nav-meta">
          <span className="powered">Powered by Qloo</span>
          <span role="status" aria-live="polite">
            <StatusPill health={health} />
          </span>
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
