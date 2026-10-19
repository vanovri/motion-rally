// Optional server-side Gemini TTS adapter.
// It never pretends to be enabled: without an API key it reports why and makes no
// network call. With a key it performs one bounded request per commentary event.

const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const VOICE = "Puck";

export function createCommentary({
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = globalThis.fetch,
  model = DEFAULT_MODEL,
  timeoutMs = 4000,
} = {}) {
  if (!apiKey) {
    return {
      enabled: false,
      reason: "GEMINI_API_KEY not set",
      model: null,
      async speak() {
        return { audio: null, mime: null, reason: "disabled" };
      },
    };
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  return {
    enabled: true,
    reason: null,
    model,
    async speak(text) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
            },
          }),
        });
        if (!response.ok) {
          return { audio: null, mime: null, error: `tts_http_${response.status}` };
        }
        const payload = await response.json();
        const part = payload?.candidates?.[0]?.content?.parts?.find((item) => item.inlineData);
        if (!part?.inlineData?.data) return { audio: null, mime: null, error: "tts_no_audio" };
        return { audio: part.inlineData.data, mime: part.inlineData.mimeType ?? "audio/L16" };
      } catch (error) {
        return { audio: null, mime: null, error: error.name === "AbortError" ? "tts_timeout" : "tts_failed" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
