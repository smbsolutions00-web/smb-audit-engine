import Anthropic from "@anthropic-ai/sdk";

export type LLMProvider = "openai" | "anthropic";

export type LLMInputPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string };

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-6-astra";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

let anthropicClient: Anthropic | null = null;

export function configuredLLMProvider(): LLMProvider | null {
  const requested = (process.env.LLM_PROVIDER || "").trim().toLowerCase();

  if (requested && requested !== "openai" && requested !== "anthropic") {
    throw new Error(`Unsupported LLM_PROVIDER: ${requested}`);
  }

  if (requested === "openai") {
    return process.env.OPENAI_API_KEY ? "openai" : null;
  }
  if (requested === "anthropic") {
    return process.env.ANTHROPIC_API_KEY ? "anthropic" : null;
  }

  // Prefer OpenAI for new deployments while preserving Anthropic as a
  // zero-configuration fallback for existing environments.
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function isLLMAvailable(): boolean {
  return configuredLLMProvider() !== null;
}

function unavailableError(): Error {
  const requested = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (requested === "openai") {
    return new Error("LLM_UNAVAILABLE: OpenAI API key not configured. Add OPENAI_API_KEY to the server environment.");
  }
  if (requested === "anthropic") {
    return new Error("LLM_UNAVAILABLE: Anthropic API key not configured. Add ANTHROPIC_API_KEY to the server environment.");
  }
  return new Error("LLM_UNAVAILABLE: No LLM API key configured. Add OPENAI_API_KEY or ANTHROPIC_API_KEY to the server environment.");
}

export async function generateLLMText(args: {
  instructions: string;
  content: LLMInputPart[];
  maxOutputTokens?: number;
}): Promise<string> {
  const provider = configuredLLMProvider();
  if (!provider) throw unavailableError();

  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions: args.instructions,
        input: [
          {
            role: "user",
            content: args.content.map((part) =>
              part.type === "text"
                ? { type: "input_text", text: part.text }
                : {
                    type: "input_image",
                    image_url: `data:${part.mediaType};base64,${part.data}`,
                    detail: "auto",
                  },
            ),
          },
        ],
        max_output_tokens: args.maxOutputTokens,
        store: false,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };
    if (!response.ok) {
      throw new Error(
        `OpenAI API request failed (${response.status}): ${body.error?.message || "Unknown error"}`,
      );
    }

    return (body.output || [])
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text || "")
      .join("")
      .trim();
  }

  anthropicClient ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropicClient.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: args.maxOutputTokens || 4096,
    system: args.instructions,
    messages: [
      {
        role: "user",
        content: args.content.map((part) =>
          part.type === "text"
            ? { type: "text" as const, text: part.text }
            : {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: part.mediaType,
                  data: part.data,
                },
              },
        ),
      },
    ],
  });

  return response.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}
