// Every model is served through OpenRouter, so ids are
// `openrouter:<vendor>/<model>` and must match `configs.models.Models` in the
// backend. The backend still accepts the pre-switch ids for a while
// (LEGACY_MODEL_IDS there), so an older UI build keeps working, but a value
// stored in localStorage from before the switch fails the includes() guard in
// thread/index.tsx and falls back to the default. Display names come from the
// key via getModelDisplayName ("GPT_5_4" -> "Gpt 5.4").
export enum PlannerModels {
  GPT_5_5 = "openrouter:openai/gpt-5.5",
  GPT_5_4 = "openrouter:openai/gpt-5.4",
  GPT_5_4_MINI = "openrouter:openai/gpt-5.4-mini",
  GPT_5_4_NANO = "openrouter:openai/gpt-5.4-nano",
  GPT_5_2 = "openrouter:openai/gpt-5.2",
  GPT_5_1 = "openrouter:openai/gpt-5.1",
  GPT_5 = "openrouter:openai/gpt-5",
  GEMINI_3_5_FLASH = "openrouter:google/gemini-3.5-flash",
  GEMINI_3_1_PRO = "openrouter:google/gemini-3.1-pro-preview",
  GEMINI_FLASH = "openrouter:google/gemini-3-flash-preview",
  GEMINI_2_5_PRO = "openrouter:google/gemini-2.5-pro",
  GEMINI_2_5_FLASH = "openrouter:google/gemini-2.5-flash",
  OPUS_5 = "openrouter:anthropic/claude-opus-5",
  SONNET_5 = "openrouter:anthropic/claude-sonnet-5",
  SONNET_4_6 = "openrouter:anthropic/claude-sonnet-4.6",
  SONNET_4_5 = "openrouter:anthropic/claude-sonnet-4.5",
  HAIKU_4_5 = "openrouter:anthropic/claude-haiku-4.5",
  DEEPSEEK_V4_PRO = "openrouter:deepseek/deepseek-v4-pro",
  DEEPSEEK_V4_FLASH = "openrouter:deepseek/deepseek-v4-flash",
  DEEPSEEK_V4_1_FLASH = "openrouter:deepseek/deepseek-v4.1-flash",
}
