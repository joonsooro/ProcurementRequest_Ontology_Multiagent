/**
 * Compile-time declaration for the demo-date value injected by vite.config.ts.
 * This describes the browser environment; it does not read the server .env at runtime.
 */
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEMO_NOW: string;
}
