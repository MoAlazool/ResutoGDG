import { Injectable } from '@nestjs/common';
import { formatMoney, type Currency, type GenerateCopyInput, type GeneratedCopy } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { DomainError, notFound } from '../../common/errors/domain-error';
import { recordUsage } from './ai-client.service';
import { GeminiClient } from './gemini.client';
import { PlanLimitsService } from '../billing/plan-limits.service';

interface Subject { name: string; nameAr: string | null; description: string | null; descriptionAr: string | null; price: string | null; restaurant: string; restaurantAr: string | null }

const LIMITS: Record<GenerateCopyInput['channel'], number> = { instagram: 600, facebook: 600, tiktok: 300, whatsapp: 500, sms: 160, website: 400 };

/** Template generator used when no LLM is configured. Deterministic; labelled `provider: 'template'`. */
export function templateCopy(input: GenerateCopyInput, s: Subject): string {
  const ar = input.locale === 'ar';
  const name = ar ? s.nameAr || s.name : s.name;
  const rest = ar ? s.restaurantAr || s.restaurant : s.restaurant;
  const desc = (ar ? s.descriptionAr || s.description : s.description)?.trim();
  const offer = input.offer?.trim();
  const price = s.price;
  const tag = `#${(s.restaurant || 'resuto').replace(/[^\p{L}\p{N}]+/gu, '')}`;
  const T = {
    en: {
      caption: {
        friendly: `${name} is ready for you at ${rest}! ${desc ? `${desc} ` : ''}${price ? `Only ${price}. ` : ''}${offer ? `${offer}. ` : ''}Order now ${tag}`,
        premium: `${name}. ${desc ? `${desc}. ` : ''}Prepared with care at ${rest}.${price ? ` ${price}.` : ''}${offer ? ` ${offer}.` : ''} ${tag}`,
        playful: `Craving something good? ${name} has entered the chat 😋 ${desc ? `${desc} ` : ''}${offer ? `${offer} ` : ''}${tag}`,
      },
      menu_description: {
        friendly: `${name}${desc ? ` — ${desc}` : ''}. A ${rest} favourite.`,
        premium: `${name}${desc ? `: ${desc}` : ''}. Crafted daily in the ${rest} kitchen.`,
        playful: `${name}${desc ? ` — ${desc}` : ''}. Warning: you may want a second one.`,
      },
      campaign: {
        friendly: `Hi from ${rest}! ${offer ? `${offer} on ` : 'Treat yourself to '}${name}${price ? ` (${price})` : ''}. Order today and enjoy!`,
        premium: `${rest} invites you to enjoy ${name}${price ? ` at ${price}` : ''}.${offer ? ` ${offer}.` : ''} Reserve or order today.`,
        playful: `${name} misses you! ${offer ? `${offer} — ` : ''}come grab it at ${rest} 🎉`,
      },
    },
    ar: {
      caption: {
        friendly: `${name} جاهز لك في ${rest}! ${desc ? `${desc} ` : ''}${price ? `بسعر ${price} فقط. ` : ''}${offer ? `${offer}. ` : ''}اطلب الآن ${tag}`,
        premium: `${name}. ${desc ? `${desc}. ` : ''}محضّر بعناية في ${rest}.${price ? ` ${price}.` : ''}${offer ? ` ${offer}.` : ''} ${tag}`,
        playful: `نفسك في حاجة حلوة؟ ${name} وصل 😋 ${desc ? `${desc} ` : ''}${offer ? `${offer} ` : ''}${tag}`,
      },
      menu_description: {
        friendly: `${name}${desc ? ` — ${desc}` : ''}. من أطباق ${rest} المفضلة.`,
        premium: `${name}${desc ? `: ${desc}` : ''}. يُحضَّر يوميًا في مطبخ ${rest}.`,
        playful: `${name}${desc ? ` — ${desc}` : ''}. تحذير: هتطلب واحد كمان.`,
      },
      campaign: {
        friendly: `أهلًا من ${rest}! ${offer ? `${offer} على ` : 'دلّل نفسك بـ '}${name}${price ? ` (${price})` : ''}. اطلب اليوم واستمتع!`,
        premium: `يدعوك ${rest} لتجربة ${name}${price ? ` بسعر ${price}` : ''}.${offer ? ` ${offer}.` : ''} احجز أو اطلب اليوم.`,
        playful: `${name} وحشك! ${offer ? `${offer} — ` : ''}تعال خده من ${rest} 🎉`,
      },
    },
  } as const;
  const text = T[ar ? 'ar' : 'en'][input.kind][input.tone].replace(/\s+/g, ' ').trim();
  return text.length > LIMITS[input.channel] ? `${text.slice(0, LIMITS[input.channel] - 1)}…` : text;
}

@Injectable()
export class CopyService {
  constructor(private readonly db: DbService, private readonly gemini: GeminiClient, private readonly limits: PlanLimitsService) {}

  async generate(ctx: TenantContext, input: GenerateCopyInput): Promise<GeneratedCopy> {
    const subject = await this.db.scoped(ctx, async (tx): Promise<Subject> => {
      const org = await tx.one<{ name: string; name_ar: string | null; currency: Currency }>('select name, name_ar, currency from organizations where id = $1', [ctx.orgId]);
      if (input.productId) {
        const p = await tx.maybeOne<any>('select name, name_ar, description, description_ar, price_minor, currency from products where id = $1 and org_id = $2', [input.productId, ctx.orgId]);
        if (!p) throw notFound('Product');
        return { name: p.name, nameAr: p.name_ar, description: p.description, descriptionAr: p.description_ar,
          price: formatMoney(p.price_minor, p.currency, input.locale), restaurant: org.name, restaurantAr: org.name_ar };
      }
      return { name: input.subject!.name, nameAr: input.subject!.nameAr ?? null, description: input.subject!.description ?? null, descriptionAr: null,
        price: null, restaurant: org.name, restaurantAr: org.name_ar };
    });
    if (!this.gemini.configured) {
      return { kind: input.kind, locale: input.locale, text: templateCopy(input, subject), provider: 'template', isFallback: true };
    }
    await this.db.scoped(ctx, (tx) => this.limits.assertAiQuota(tx, ctx.orgId));
    const lang = input.locale === 'ar' ? 'Arabic (Egyptian/Gulf-friendly Modern Standard Arabic)' : 'English';
    const brief = {
      kind: input.kind, channel: input.channel, tone: input.tone, language: lang, maxCharacters: LIMITS[input.channel],
      restaurant: input.locale === 'ar' ? subject.restaurantAr || subject.restaurant : subject.restaurant,
      item: input.locale === 'ar' ? subject.nameAr || subject.name : subject.name,
      description: subject.description, price: subject.price, offer: input.offer ?? null,
    };
    const reply = await this.gemini.generate({
      system: 'You write short restaurant marketing copy. Output only the final text, no quotes or options. Use only facts from the brief: never invent prices, discounts, ingredients, health or halal claims. Mention the price or offer only if the brief contains it.',
      contents: [{ role: 'user', parts: [{ text: `Brief (JSON): ${JSON.stringify(brief)}` }] }],
      temperature: 0.7,
    });
    const text = reply.parts.map((p) => p.text ?? '').join('').trim();
    if (!text) throw new DomainError('llm_empty', 'The language model returned no text', 503);
    await this.db.scoped(ctx, (tx) => recordUsage(tx, ctx, { endpoint: 'generate-copy', provider: 'gemini' }));
    return { kind: input.kind, locale: input.locale, text: text.slice(0, LIMITS[input.channel]), provider: 'gemini', isFallback: false };
  }
}
