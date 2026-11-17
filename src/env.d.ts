// Vite's build-time constants this app reads (Vite replaces import.meta.env.* when it bundles). Declared here because
// tsconfig.json only loads the node types (no vite/client).
interface ImportMetaEnv { readonly MODE: string; readonly BASE_URL: string; readonly DEV: boolean; readonly PROD: boolean }
interface ImportMeta { readonly env: ImportMetaEnv }
