// Runs in a browser for alpha analysis; keeps all generated PNGs unchanged.
export async function analyzeCharacters(ids) {
  const output = {};
  const load = async (path) => {
    const image = new Image();
    image.src = new URL(`characters/deepseek-girl/${path}`, location.href).href;
    await image.decode();
    return image;
  };
  const inspect = (image, index, grid) => {
    const cellWidth = image.width / grid,
      cellHeight = image.height / grid;
    // Draw a little beyond the nominal grid: generated tails can cross a cell edge.
    // Connected-component analysis still selects the intended figure, avoiding its neighbor.
    const cellX = (index % grid) * cellWidth,
      cellY = Math.floor(index / grid) * cellHeight;
    const margin = grid === 2 ? cellWidth * 0.16 : 0;
    const cropX = Math.max(0, cellX - margin),
      cropY = Math.max(0, cellY - margin);
    const cropWidth = Math.min(image.width, cellX + cellWidth + margin) - cropX;
    const cropHeight =
      Math.min(image.height, cellY + cellHeight + margin) - cropY;
    const canvas = document.createElement("canvas"),
      w = 288,
      h = Math.round((w * cropHeight) / cropWidth);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data,
      seen = new Uint8Array(w * h);
    let largest = [];
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || pixels[i * 4 + 3] < 40) continue;
      const group = [i];
      seen[i] = 1;
      for (let head = 0; head < group.length; head++) {
        const p = group[head],
          x = p % w,
          y = Math.floor(p / w);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy,
              q = ny * w + nx;
            if (
              nx < 0 ||
              nx >= w ||
              ny < 0 ||
              ny >= h ||
              seen[q] ||
              pixels[q * 4 + 3] < 40
            )
              continue;
            seen[q] = 1;
            group.push(q);
          }
      }
      if (group.length > largest.length) largest = group;
    }
    let left = w,
      right = 0,
      top = h,
      bottom = 0;
    for (const p of largest) {
      const x = p % w,
        y = Math.floor(p / w);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    let footSum = 0,
      footCount = 0;
    for (const p of largest)
      if (Math.floor(p / w) > bottom - (bottom - top) * 0.12) {
        footSum += p % w;
        footCount++;
      }
    // A padded convex outline retains the complete figure and excludes tiny neighbor fragments
    // that a rectangular crop can catch near the corners of an expanded cell.
    const rows = new Map();
    for (const p of largest) {
      const x = p % w,
        y = Math.floor(p / w);
      const row = rows.get(y) || [w, 0];
      row[0] = Math.min(row[0], x);
      row[1] = Math.max(row[1], x);
      rows.set(y, row);
    }
    const points = [...rows]
      .flatMap(([y, [lo, hi]]) => [
        [Math.max(0, lo - 2), Math.max(0, y - 2)],
        [Math.min(w, hi + 3), Math.max(0, y - 2)],
        [Math.min(w, hi + 3), Math.min(h, y + 3)],
        [Math.max(0, lo - 2), Math.min(h, y + 3)],
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (a, b, c) =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const chain = (list) => {
      const result = [];
      for (const point of list) {
        while (
          result.length > 1 &&
          cross(result.at(-2), result.at(-1), point) <= 0
        )
          result.pop();
        result.push(point);
      }
      return result.slice(0, -1);
    };
    const hull = [...chain(points), ...chain([...points].reverse())];
    const sx = cropWidth / w,
      sy = cropHeight / h;
    const offsetX = cropX - cellX,
      offsetY = cropY - cellY;
    return {
      left: Math.max(cropX, cropX + (left - 2) * sx) - cellX,
      right: Math.min(cropX + cropWidth, cropX + (right + 3) * sx) - cellX,
      top: Math.max(cropY, cropY + (top - 2) * sy) - cellY,
      bottom: Math.min(cropY + cropHeight, cropY + (bottom + 3) * sy) - cellY,
      bodyTop: offsetY + top * sy,
      footX: offsetX + (footSum / footCount) * sx,
      footY: offsetY + (bottom + 1) * sy,
      outline: hull.map(([x, y]) => [offsetX + x * sx, offsetY + y * sy]),
    };
  };
  const rounded = (box) =>
    Object.fromEntries(
      Object.entries(box).map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value.map((point) => point.map((v) => Math.round(v * 100) / 100))
          : Math.round(value * 100) / 100,
      ]),
    );
  for (const id of ids) {
    const still = await load(`${id}.png`),
      image = await load(`animations/${id}.png`);
    const frames = Array.from({ length: 4 }, (_, index) =>
      inspect(image, index, 2),
    );
    output[id] = {
      width: image.width,
      height: image.height,
      frames: frames.map((frame) =>
        rounded({
          ...frame,
          dx: frames[0].footX - frame.footX,
          dy: frames[0].footY - frame.footY,
        }),
      ),
      static: {
        width: still.width,
        height: still.height,
        ...rounded(inspect(still, 0, 1)),
      },
    };
  }
  return output;
}
