import { nativeImage } from "electron";
import { fileURLToPath } from "node:url";

export function createTrayIcon() {
  const template = process.platform === "darwin";
  const icon = nativeImage.createFromPath(
    fileURLToPath(
      new URL(
        `./assets/${template ? "trayTemplate.png" : "tray.png"}`,
        import.meta.url,
      ),
    ),
  );
  icon.setTemplateImage(template);
  return icon;
}
