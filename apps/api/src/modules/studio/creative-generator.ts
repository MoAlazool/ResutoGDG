import type { GenerateCreative } from '@resuto/contracts';
import { GeminiLlm, geminiJson, ProviderError, type LlmUsage } from '@resuto/integrations';
import { z } from 'zod';

export interface CreativeContext {
  restaurant: { name: string; nameAr: string | null; city: string | null };
  product: { name: string; nameAr: string | null; description: string | null; priceLabel: string | null; dietary: string[] } | null;
}

export interface CreativeResult {
  provider: 'gemini' | 'template_rules';
  model: string | null;
  isFallback: boolean;
  variants: Array<{ title?: string; text: string; hashtags?: string[] }>;
  fallbackReason?: string;
  /** Why the template was used: no model key at all, or the model call failed. */
  fallbackCode?: 'not_configured' | 'model_failed';
  /** Tokens Google reported for the call (INT-30), for metering. */
  usage?: LlmUsage | null;
}

const geminiOutput = z.object({
  variants: z.array(z.object({
    title: z.string().max(140).optional(),
    text: z.string().min(1).max(2200),
    hashtags: z.array(z.string().max(40)).max(8).optional(),
  })).min(1).max(3),
});

const KIND_BRIEF: Record<GenerateCreative['kind'], string> = {
  caption: 'a short social media caption (max 220 characters)',
  post: 'a social media post (2–4 short paragraphs) with a clear call to action',
  menu_description: 'a menu item description (max 180 characters), appetising and factual; never invent ingredients that are not given',
  website_copy: 'website copy: a headline (max 60 characters) as "title" and a supporting paragraph (max 320 characters) as "text"',
};

/**
 * Gemini (generateContent, JSON response mode, through the shared client in packages/integrations/src/ai/gemini.ts) when a model key is available (the
 * restaurant's own BYOK key first, then the operator's GEMINI_API_KEY); otherwise, or if the call fails, a
 * deterministic template generator whose output is labelled as a template (fallbackCode says why).
 */
export async function generateCreativeCopy(input: GenerateCreative, context: CreativeContext,
  opts: { apiKey?: string; model: string; fetch?: typeof fetch }): Promise<CreativeResult> {
  if (!opts.apiKey) return { ...templateCopy(input, context), fallbackReason: 'No language model key is configured', fallbackCode: 'not_configured' };
  try {
    return await gemini(input, context, opts.apiKey, opts.model, opts.fetch ?? fetch);
  } catch (e) {
    // The provider's response body is never echoed; only a short, key-free reason is kept.
    const reason = e instanceof z.ZodError || e instanceof SyntaxError || (e instanceof ProviderError && /JSON|schema/.test(e.message)) ? 'unreadable model output'
      : (e as Error).message.replace(/^gemini: /, '').slice(0, 120);
    return { ...templateCopy(input, context), fallbackReason: `The model request failed (${reason})`, fallbackCode: 'model_failed' };
  }
}

async function gemini(input: GenerateCreative, context: CreativeContext, apiKey: string, model: string, http: typeof fetch): Promise<CreativeResult> {
  const language = input.locale === 'ar' ? 'Arabic (Modern Standard with a warm Egyptian/Gulf-friendly tone, no transliteration)' : 'English';
  const facts = [
    `Restaurant: ${context.restaurant.name}${context.restaurant.nameAr ? ` (${context.restaurant.nameAr})` : ''}${context.restaurant.city ? `, ${context.restaurant.city}` : ''}.`,
    context.product ? `Dish: ${context.product.name}${context.product.nameAr ? ` / ${context.product.nameAr}` : ''}. ${context.product.description ?? ''} ${context.product.priceLabel ? `Price: ${context.product.priceLabel}.` : ''} ${context.product.dietary.length ? `Dietary: ${context.product.dietary.join(', ')}.` : ''}` : '',
  ].join(' ');
  const prompt = `You write marketing copy for a restaurant. Write ${input.variants} alternative versions of ${KIND_BRIEF[input.kind]} in ${language}.
Tone: ${input.tone}. Owner brief: ${input.brief}
Facts you may use (do not invent prices, discounts, awards, reviews or ingredients beyond these): ${facts}
Return JSON: {"variants":[{"title":string optional,"text":string,"hashtags":string[] optional}]}`;
  // INT-30: one shared Gemini client (timeouts, one retry on 429/5xx, no response bodies in errors, usage metadata).
  const llm = new GeminiLlm({ apiKey, model, fetch: http, timeoutMs: 25_000, retries: 1 });
  const { value: parsed, result } = await geminiJson(llm, { contents: [{ role: 'user', parts: [{ text: prompt }] }], temperature: 0.8, maxOutputTokens: 2048 },
    (v) => geminiOutput.parse(v));
  return { provider: 'gemini', model, isFallback: false, variants: parsed.variants.slice(0, input.variants), usage: result.usage };
}

/** Deterministic copy from the owner's brief and real menu facts. Clearly labelled as fallback output. */
export function templateCopy(input: GenerateCreative, context: CreativeContext): CreativeResult {
  const ar = input.locale === 'ar';
  const name = ar ? context.restaurant.nameAr ?? context.restaurant.name : context.restaurant.name;
  const dish = context.product ? (ar ? context.product.nameAr ?? context.product.name : context.product.name) : null;
  const brief = input.brief.replace(/\s+/g, ' ').trim();
  const price = context.product?.priceLabel ? (ar ? ` بسعر ${context.product.priceLabel}` : ` for ${context.product.priceLabel}`) : '';
  const tag = `#${name.replace(/[^\p{L}\p{N}]+/gu, '')}`;
  const city = context.restaurant.city ? `#${context.restaurant.city.replace(/[^\p{L}\p{N}]+/gu, '')}` : null;
  const hashtags = [tag, city].filter((x): x is string => !!x);

  const en = {
    caption: [
      `${dish ? `${dish} is on the table at ${name}` : `Your table is waiting at ${name}`}${price}. ${brief}`,
      `${brief} — ${dish ? `try the ${dish}` : 'come hungry'} at ${name}.`,
      `Tonight at ${name}: ${dish ?? 'something good'}. ${brief}`,
    ],
    post: [
      `${dish ? `Meet the ${dish}.` : `Welcome to ${name}.`}\n\n${brief}\n\nBook a table or order online from our website.`,
      `${brief}\n\n${dish ? `The ${dish}${price} is waiting for you at ${name}.` : `We would love to host you at ${name}.`}\n\nReserve now — it takes a minute.`,
      `At ${name}, ${brief.charAt(0).toLowerCase()}${brief.slice(1)}\n\n${dish ? `Start with the ${dish}.` : 'Bring your favourite people.'} Order online or book your table.`,
    ],
    menu_description: [
      `${dish ?? 'Our signature dish'}: ${context.product?.description ?? brief}`.slice(0, 180),
      `${brief}. ${context.product?.description ?? ''}`.trim().slice(0, 180),
      `${context.product?.description ?? brief} — a ${name} favourite.`.slice(0, 180),
    ],
    website_copy: [
      `${name}. ${brief.split('.')[0]}`.slice(0, 60),
      `Welcome to ${name}`.slice(0, 60),
      `${dish ? `Home of the ${dish}` : `A table for you at ${name}`}`.slice(0, 60),
    ],
  };
  const arCopy = {
    caption: [
      `${dish ? `${dish} في انتظارك في ${name}` : `طاولتك في انتظارك في ${name}`}${price}. ${brief}`,
      `${brief} — ${dish ? `جرّب ${dish}` : 'تعال جائعًا'} في ${name}.`,
      `الليلة في ${name}: ${dish ?? 'شيء لذيذ'}. ${brief}`,
    ],
    post: [
      `${dish ? `تعرّف على ${dish}.` : `أهلًا بك في ${name}.`}\n\n${brief}\n\nاحجز طاولتك أو اطلب أونلاين من موقعنا.`,
      `${brief}\n\n${dish ? `${dish}${price} في انتظارك في ${name}.` : `يسعدنا استقبالك في ${name}.`}\n\nاحجز الآن في دقيقة واحدة.`,
      `في ${name}، ${brief}\n\n${dish ? `ابدأ بـ ${dish}.` : 'أحضر من تحب.'} اطلب أونلاين أو احجز طاولتك.`,
    ],
    menu_description: [
      `${dish ?? 'طبقنا المميز'}: ${context.product?.description ?? brief}`.slice(0, 180),
      `${brief}. ${context.product?.description ?? ''}`.trim().slice(0, 180),
      `${context.product?.description ?? brief} — من المفضلات في ${name}.`.slice(0, 180),
    ],
    website_copy: [
      `${name}. ${brief.split('.')[0]}`.slice(0, 60),
      `أهلًا بك في ${name}`.slice(0, 60),
      `${dish ? `بيت ${dish}` : `طاولة لك في ${name}`}`.slice(0, 60),
    ],
  };
  const texts = (ar ? arCopy : en)[input.kind];
  const variants = texts.slice(0, input.variants).map((text, i) => input.kind === 'website_copy'
    ? { title: text, text: ar ? `${brief}. احجز طاولتك أو اطلب أونلاين.` : `${brief}. Book a table or order online.` }
    : { text, ...(input.kind === 'caption' || input.kind === 'post' ? { hashtags: i === 0 ? hashtags : hashtags.slice(0, 1) } : {}) });
  return { provider: 'template_rules', model: null, isFallback: true, variants };
}
