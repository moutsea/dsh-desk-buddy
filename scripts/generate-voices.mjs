import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { SOUND_VOICES, SOUND_PHRASES } from "../shared/voices.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const model = "qwen-audio-3.1-tts-flash";
const endpoint =
  "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
const sourceRoot = join(root, "artifacts/tts-source");

// Save only audio and reproducible, non-secret synthesis settings. Credentials
// remain in memory and never become part of the voice pack or its manifest.
async function synthesize(apiKey, input) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(45000),
    redirect: "error",
  });
  const reply = await response.json();
  if (!response.ok || !reply.output?.audio?.url)
    throw new Error(
      `TTS request failed (${response.status}, ${reply.code || "no audio"})`,
    );
  const url = new URL(reply.output.audio.url);
  if (url.protocol === "http:" && url.hostname.endsWith(".aliyuncs.com"))
    url.protocol = "https:";
  if (url.protocol !== "https:") throw new Error("Expected HTTPS audio URL");
  const audio = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!audio.ok) throw new Error(`Audio download failed (${audio.status})`);
  return {
    data: Buffer.from(await audio.arrayBuffer()),
    metadata: { model, input, requestId: reply.request_id, usage: reply.usage },
  };
}

function normalizeWav(data, kind) {
  if (
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Expected WAV audio");
  let format;
  let pcm;
  for (let at = 12; at + 8 <= data.length;) {
    const size = data.readUInt32LE(at + 4);
    const chunkId = data.toString("ascii", at, at + 4);
    // DashScope emits streaming WAV headers with a placeholder data size.
    // The downloaded response body is complete; rebuild its header below.
    if (chunkId !== "data" && at + 8 + size > data.length)
      throw new Error("Incomplete WAV audio");
    const chunk = data.subarray(at + 8, at + 8 + size);
    if (chunkId === "fmt ") format = chunk;
    if (chunkId === "data") pcm = chunk;
    at += 8 + size + (size % 2);
  }
  if (
    !format ||
    format.length < 16 ||
    !pcm ||
    pcm.length < 2 ||
    pcm.length % 2 ||
    format.readUInt16LE(0) !== 1 ||
    format.readUInt16LE(2) !== 1 ||
    format.readUInt16LE(14) !== 16 ||
    format.readUInt32LE(4) !== 24000
  )
    throw new Error("Expected 24 kHz mono PCM16");

  const count = pcm.length / 2;
  let peak = 0;
  let power = 0;
  for (let i = 0; i < count; i++) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    peak = Math.max(peak, Math.abs(value));
    power += value * value;
  }
  const rms = Math.sqrt(power / count);
  if (rms < 0.001 || count < 6000 || count > 144000)
    throw new Error("Silent or unexpectedly long/short voice clip");
  const scale = Math.min(
    0.75 / peak,
    (kind.startsWith("idle") || kind === "sleep" ? 0.075 : 0.11) / rms,
  );
  const output = Buffer.alloc(44 + pcm.length);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  format.copy(output, 20, 0, 16);
  output.write("data", 36);
  output.writeUInt32LE(pcm.length, 40);
  for (let i = 0; i < count; i++) {
    const fade = Math.min(1, i / 120, (count - 1 - i) / 120);
    output.writeInt16LE(
      Math.round(pcm.readInt16LE(i * 2) * scale * fade),
      44 + i * 2,
    );
  }
  return { data: output, duration: count / 24000 };
}

export async function generateVoicePack({
  apiKey,
  outputDir = join(root, "public/voices"),
  onProgress = console.log,
} = {}) {
  if (!apiKey)
    throw new Error("Set DASHSCOPE_API_KEY before generating voices");
  const clips = [];
  // Reuse the three already auditioned previews, preserving their performances.
  const previews = await readFile(
    join(root, "artifacts/tts-preview/manifest.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch(() => ({ samples: [] }));
  for (const voice of SOUND_VOICES) {
    for (const [kind, text] of Object.entries(SOUND_PHRASES)) {
      const input = {
        text,
        voice: voice.id,
        format: "wav",
        sample_rate: 24000,
        instruction: `为桌面陪伴角色配音。声线${voice.style}，用普通话轻声说话，带自然微笑和亲近感。起声轻柔，尾音微微上扬，语速自然，短句干净利落。${kind === "idle" ? "像轻轻招呼朋友，声音更轻一些。" : kind === "completion" ? "带一点做完事情的小开心。" : "俏皮自然，不要刻意夹嗓。"}不要播音腔，不要大喊。`,
      };
      if (["started", "attention", "failure", "angry"].includes(kind))
        input.instruction =
          `为桌面陪伴角色配音。声线${voice.style}，用普通话轻声说话，带自然微笑和亲近感。起声轻柔，语速自然，短句干净利落。` +
          {
            started: "像轻快地接过朋友交代的小任务，可靠又有一点小开心。",
            attention: "像轻轻提醒朋友需要确认一件事，亲切清楚，不催促。",
            failure: "温柔地说明遇到小问题，语气平静安慰，不惊慌、不卖惨。",
            angry:
              "被朋友连续戳了几下，鼓着脸轻轻闹别扭。用可爱娇嗔的小抱怨说「慢一点啦」，最后短短地哼一下。略有不满但亲近柔和，不凶、不尖叫。",
          }[kind] +
          "俏皮自然，不要刻意夹嗓。不要播音腔，不要大喊。";
      const extraStyle = {
        shy: "被朋友一直看着，有一点害羞，像微微脸红的小声询问，尾音轻软含蓄。",
        wake: "刚被轻轻叫醒，先迷迷糊糊地唔一声，再柔和地回应，慵懒但吐字清楚。",
        sleep:
          "有一点困了，温柔地道声小别，越说越轻，像准备眯一小会儿，不夸张打哈欠。",
        welcome: "朋友回来时开心地轻声欢迎，温暖自然，有一点小惊喜。",
        moved: "被搬到新位置后好奇地看看周围，轻快满意，尾音柔和。",
        reconnected: "连接恢复后轻轻松一口气，简短清楚，开心但不兴奋大喊。",
        pet_2: "朋友轻轻点了点你，温柔亲近地回应，像轻轻答应一声。",
        pet_3: "被朋友轻轻点了一下，先自然轻笑，再俏皮地问怎么啦。",
        idle_2: "像轻轻招呼朋友休息，语气关心而不催促，声音更轻一些。",
        idle_3: "安静温柔地陪着朋友，语速舒缓，声音更轻一些。",
        started_2: "轻快地接过朋友的小任务，温柔爽快，像微笑着答应马上开始。",
        started_3:
          "先轻轻答应一声，再亲切地表示接下这件事，可靠又有一点小开心。",
        completion_2:
          "事情完成后开心地招呼朋友来看结果，轻柔俏皮，不夸张庆祝。",
        completion_3: "做完事情后带一点小满足，温柔自然地告诉朋友已经办好了。",
        attention_2: "有一处需要朋友确认，轻声提醒，吐字清楚，亲近而不催促。",
        attention_3: "轻轻招呼朋友来回应，耐心柔和，尾音轻软，不催促不着急。",
        failure_2:
          "温柔地说明这次没有完成，请朋友一起查看原因，平静清楚，不惊慌不卖惨。",
        failure_3:
          "遇到问题后温柔地邀请朋友一起看看，语气平静，不夸大也不承诺已经解决。",
      }[kind];
      if (extraStyle)
        input.instruction = `为桌面陪伴角色配音。声线${voice.style}，用普通话轻声说话，起声轻柔，短句干净利落。${extraStyle}自然亲切，不要刻意夹嗓，不要播音腔，不要大喊。`;
      const source = join(sourceRoot, voice.id, kind);
      let raw;
      let metadata;
      try {
        metadata = JSON.parse(await readFile(`${source}.json`, "utf8"));
        if (
          metadata.model !== model ||
          JSON.stringify(metadata.input) !== JSON.stringify(input)
        )
          throw new Error("Recipe changed");
        raw = await readFile(`${source}.wav`);
      } catch {
        const preview =
          kind === "preview" &&
          previews.model === model &&
          previews.text === text &&
          previews.samples.find((item) => item.voice === voice.id);
        if (preview) {
          raw = await readFile(
            join(root, "artifacts/tts-preview", `${voice.id}.wav`),
          );
          metadata = {
            model,
            input,
            originalInstruction: previews.instruction,
            requestId: preview.requestId,
            usage: preview.usage,
          };
        } else {
          const result = await synthesize(apiKey, input);
          raw = result.data;
          metadata = result.metadata;
        }
        await mkdir(dirname(source), { recursive: true });
        await writeFile(`${source}.wav`, raw);
        await writeFile(
          `${source}.json`,
          JSON.stringify(metadata, null, 2) + "\n",
        );
      }
      const normalized = normalizeWav(raw, kind);
      const relativePath = `${voice.id}/${kind}.wav`;
      await mkdir(join(outputDir, voice.id), { recursive: true });
      await writeFile(join(outputDir, relativePath), normalized.data);
      clips.push({
        voice: voice.id,
        kind,
        text,
        file: relativePath,
        duration: normalized.duration,
        sha256: createHash("sha256").update(normalized.data).digest("hex"),
        instruction: metadata.originalInstruction || input.instruction,
        requestId: metadata.requestId,
      });
      onProgress(`${voice.name} / ${kind}: ${normalized.duration.toFixed(2)}s`);
    }
  }
  await writeFile(
    join(outputDir, "manifest.json"),
    JSON.stringify(
      {
        model,
        source:
          "https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list",
        processing:
          "24 kHz mono PCM16; matched RMS with a 0.75 peak ceiling; quieter idle cues; 5 ms edge fades",
        clips,
      },
      null,
      2,
    ) + "\n",
  );
  return { voices: SOUND_VOICES.length, clips: clips.length };
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await generateVoicePack({ apiKey: process.env.DASHSCOPE_API_KEY });
