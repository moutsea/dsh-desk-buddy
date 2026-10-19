import { app, BrowserWindow } from "electron";
app.setName("DSG Plugin Test");
app.setPath("userData", process.env.DSG_TEST_UI_DIR);
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1100,
    height: 850,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.loadURL(process.argv[2]);
});
app.on("window-all-closed", () => app.quit());
