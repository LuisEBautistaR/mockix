import { app, BrowserWindow, nativeTheme } from "electron";
import { APP_ENTRY_URL } from "./app-path";

/** Matches the rail and ink tokens of the design so the native window controls blend in. */
const THEME = {
  light: { background: "#eeecea", overlay: "#e4e1dd", symbols: "#333231" },
  dark: { background: "#242322", overlay: "#1d1c1b", symbols: "#e9e6e2" },
} as const;
const TITLE_BAR_HEIGHT = 38;

const palette = () => THEME[nativeTheme.shouldUseDarkColors ? "dark" : "light"];

export function createMainWindow(preloadPath: string, devUrl: string | null): BrowserWindow {
  const colors = palette();
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    title: "Mockix",
    backgroundColor: colors.background,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: colors.overlay, symbolColor: colors.symbols, height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  const syncTheme = () => {
    if (window.isDestroyed()) return;
    const next = palette();
    window.setBackgroundColor(next.background);
    window.setTitleBarOverlay({ color: next.overlay, symbolColor: next.symbols, height: TITLE_BAR_HEIGHT });
  };
  nativeTheme.on("updated", syncTheme);
  window.on("closed", () => nativeTheme.off("updated", syncTheme));

  window.once("ready-to-show", () => window.show());
  void window.loadURL(devUrl ?? APP_ENTRY_URL);
  return window;
}
