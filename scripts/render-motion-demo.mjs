import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MOTIONS } from "../shared/motions.mjs";
import { createFixture } from "../tests/fixture.mjs";
const registration = JSON.parse(
  await readFile(
    "public/characters/deepseek-girl/animations/registration.json",
    "utf8",
  ),
);
const fixture = await createFixture(),
  data = await mkdtemp(join(tmpdir(), "deepseek-girl-demo-"));
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({ endpoint: fixture.endpoint, alwaysOnTop: false }),
);
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await electron.launch({ args: ["."], env });
  let page;
  await expect
    .poll(() => {
      page = desktop.windows().find((p) => p.url().includes("view=pet"));
      return !!page;
    })
    .toBe(true);
  const result = await page.evaluate(
    async ({ motions, registration }) => {
      const ids = ["idle", "working", "learning", "celebrating"],
        labels = ["挥手眨眼", "认真工作", "读书翻页", "一起庆祝"];
      const images = await Promise.all(
        ids.map(async (id) => {
          const image = new Image();
          image.src = new URL(
            `characters/deepseek-girl/animations/${id}.png`,
            location.href,
          ).href;
          await image.decode();
          return image;
        }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 640;
      canvas.style.cssText =
        "position:fixed;inset:0;z-index:99999;width:1280px;height:640px";
      document.body.append(canvas);
      const ctx = canvas.getContext("2d"),
        start = performance.now();
      function draw(time) {
        const background = ctx.createLinearGradient(0, 0, 1280, 640);
        background.addColorStop(0, "#f6f8ff");
        background.addColorStop(1, "#e9effb");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, 1280, 640);
        ctx.fillStyle = "#344761";
        ctx.font = "600 36px 'PingFang SC',sans-serif";
        ctx.fillText("DeepSeek Girl", 42, 66);
        ctx.fillStyle = "#7c90b2";
        ctx.font = "20px 'PingFang SC',sans-serif";
        ctx.fillText("一点陪伴，一起完成。", 43, 108);
        ids.forEach((id, i) => {
          const x = 42 + i * 304;
          ctx.fillStyle = "#ffffffdd";
          ctx.strokeStyle = "#dfe7f5";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(x, 148, 284, 438, 24);
          ctx.fill();
          ctx.stroke();
          const sequence = motions[id].sequence,
            total = sequence.reduce((sum, [, ms]) => sum + ms, 0);
          let t = time % total,
            f = 0;
          for (const [index, ms] of sequence) {
            f = index;
            if (t < ms) break;
            t -= ms;
          }
          const meta = registration[id],
            box = meta.frames[f],
            cw = meta.width / 2,
            ch = meta.height / 2,
            scale = 306 / ch,
            ox = x + (284 - cw * scale) / 2,
            oy = 190;
          ctx.save();
          ctx.beginPath();
          ctx.rect(ox, oy, cw * scale, ch * scale);
          ctx.clip();
          ctx.drawImage(
            images[i],
            (f % 2) * cw + box.left,
            Math.floor(f / 2) * ch + box.top,
            box.right - box.left,
            box.bottom - box.top,
            ox + (box.left + box.dx) * scale,
            oy + (box.top + box.dy) * scale,
            (box.right - box.left) * scale,
            (box.bottom - box.top) * scale,
          );
          ctx.restore();
          ctx.textAlign = "center";
          ctx.fillStyle = "#627caa";
          ctx.font = "500 21px 'PingFang SC',sans-serif";
          ctx.fillText(labels[i], x + 142, 550);
          ctx.textAlign = "left";
        });
      }
      draw(0);
      const poster = canvas.toDataURL("image/png");
      const stream = canvas.captureStream(24),
        recorder = new MediaRecorder(stream, {
          mimeType: "video/webm;codecs=vp9",
          videoBitsPerSecond: 2500000,
        }),
        chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      let running = true;
      const tick = () => {
        if (!running) return;
        draw(performance.now() - start);
        requestAnimationFrame(tick);
      };
      recorder.start();
      tick();
      await new Promise((resolve) => setTimeout(resolve, 8000));
      running = false;
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      const video = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType }));
      });
      return { video, poster };
    },
    { motions: MOTIONS, registration },
  );
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/motion-preview.webm",
    Buffer.from(result.video.split(",")[1], "base64"),
  );
  await writeFile(
    "artifacts/motion-preview.png",
    Buffer.from(result.poster.split(",")[1], "base64"),
  );
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      "artifacts/motion-preview.webm",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "artifacts/motion-preview.mp4",
    ],
    { encoding: "utf8" },
  );
  if (encoded.status !== 0) throw new Error(encoded.stderr);
  console.log("Saved 8-second preview: artifacts/motion-preview.mp4");
} finally {
  await desktop?.close();
  await fixture.close();
  await rm(data, { recursive: true, force: true });
}
