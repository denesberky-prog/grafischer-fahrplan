# Grafischer Fahrplan / Graphical Timetable

A standalone tool for building graphical (line-diagram) train/transit
timetables.

- **Use it:** open `grafischer-fahrplan.html` directly in a browser. No
  server or build step needed.
- **Edit it:** the source is `src/App.jsx` (a single React component). After
  changing it, rebuild the standalone HTML file:

  ```sh
  npm install
  npm run build
  ```

  This regenerates `grafischer-fahrplan.html` (React + ReactDOM bundled
  inline via esbuild, minified). Commit both the source change and the
  regenerated HTML together.
