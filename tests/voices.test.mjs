import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SOUND_VOICES, SOUND_PHRASES } from "../shared/voices.mjs";

test("every selectable voice ships all four distinct, decodable PCM clips and their provenance", async () => {
  const root = new URL("../public/voices/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", root), "utf8"),
  );
  assert.equal(manifest.clips.length, SOUND_VOICES.length * 4);
  const hashes = new Set();
  for (const voice of SOUND_VOICES) {
    for (const [kind, text] of Object.entries(SOUND_PHRASES)) {
      const entry = manifest.clips.find(
        (clip) => clip.voice === voice.id && clip.kind === kind,
      );
      assert.ok(entry, `${voice.id}/${kind} has metadata`);
      assert.equal(entry.text, text);
      assert.equal(entry.file, `${voice.id}/${kind}.wav`);
      const data = await readFile(new URL(entry.file, root));
      assert.equal(data.toString("ascii", 0, 4), "RIFF");
      assert.equal(
        data.readUInt32LE(4),
        data.length - 8,
        "WAV length is repaired",
      );
      assert.equal(data.toString("ascii", 8, 16), "WAVEfmt ");
      assert.equal(data.readUInt16LE(20), 1, "PCM encoding");
      assert.equal(data.readUInt16LE(22), 1, "mono");
      assert.equal(data.readUInt32LE(24), 24000);
      assert.equal(data.readUInt16LE(34), 16);
      assert.equal(data.toString("ascii", 36, 40), "data");
      assert.equal(data.readUInt32LE(40), data.length - 44);
      assert.equal((data.length - 44) / 48000, entry.duration);
      assert.ok(entry.duration >= 0.25 && entry.duration <= 6);
      let power = 0;
      let peak = 0;
      for (let at = 44; at < data.length; at += 2) {
        const sample = data.readInt16LE(at) / 32768;
        power += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      const rms = Math.sqrt(power / ((data.length - 44) / 2));
      assert.ok(
        rms > 0.02 && rms < 0.12,
        `${entry.file} has audible, even volume`,
      );
      assert.ok(peak <= 0.751, `${entry.file} has no clipping`);
      assert.equal(data.readInt16LE(44), 0);
      assert.equal(data.readInt16LE(data.length - 2), 0);
      const hash = createHash("sha256").update(data).digest("hex");
      assert.equal(hash, entry.sha256);
      assert.ok(
        !hashes.has(hash),
        "voices and event performances must not be duplicated",
      );
      hashes.add(hash);
    }
  }
});
