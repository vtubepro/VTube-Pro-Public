// Vite's import.meta.glob (only the Help viewer uses it). The project does not load vite/client types, so the one
// function is declared here. Vite replaces each call at build time; the patterns must stay literal.
interface ImportMeta {
  glob<M = unknown>(pattern: string | string[], options?: { query?: string; import?: string; eager?: boolean }): Record<string, M>;
}
