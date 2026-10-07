import { resolve } from "node:path";

/** Open a file or folder with the OS default app (Preview, Finder, xdg-open…). */
export function openPath(path: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  Bun.spawn([cmd, resolve(path)], { stdout: "ignore", stderr: "ignore" });
}
