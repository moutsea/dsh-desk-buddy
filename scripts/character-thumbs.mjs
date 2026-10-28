import { execFileSync } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

// Preview sprites render at ~116 CSS px (≈232 physical px at 2x). Serving the
// 1145x1374 originals to every grid cell costs ~6.3 MB of decoded bitmap each;
// 30% copies keep previews crisp while cutting that to ~0.57 MB.
const ROOT = "public/characters/deepseek-girl";
const SCALE_LONG_EDGE = 412; // 1374 * 0.3
if (process.platform !== "darwin") {
  console.error("Character thumbnails are generated with macOS sips.");
  process.exit(1);
}

async function resize(sourceDirectory, targetDirectory) {
  await mkdir(targetDirectory, { recursive: true });
  const files = (await readdir(sourceDirectory)).filter((file) =>
    file.endsWith(".png"),
  );
  for (const file of files)
    execFileSync("/usr/bin/sips", [
      "-Z",
      String(SCALE_LONG_EDGE),
      join(sourceDirectory, file),
      "--out",
      join(targetDirectory, file),
    ]);
  console.log(`${targetDirectory}: ${files.length} thumbnails`);
}

await resize(ROOT, join(ROOT, "thumbs"));
await resize(join(ROOT, "animations"), join(ROOT, "animations/thumbs"));
