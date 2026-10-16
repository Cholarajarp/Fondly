// Applies the saved (or system) theme before first paint. Kept as an external file so the
// CSP can stay at script-src 'self' with no inline scripts.
(function () {
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem("theme");
    var dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", dark);
  } catch (e) {
    root.classList.remove("dark");
  }
})();
