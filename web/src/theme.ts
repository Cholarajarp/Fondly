import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const read = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light");

function subscribe(onChange: () => void): () => void {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => obs.disconnect();
}

/** Current theme (class on <html>, set before paint by /theme-init.js) and a setter that persists it. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, read, () => "light" as Theme);
  const set = useCallback((t: Theme) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    try {
      localStorage.setItem("theme", t);
    } catch {
      // Private mode: the choice just won't persist.
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#1b1714" : "#faf7f2");
  }, []);
  return [theme, set];
}
