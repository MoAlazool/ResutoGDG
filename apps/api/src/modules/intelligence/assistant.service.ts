import { Injectable } from '@nestjs/common';
import { formatMoney, type AssistantMessageInput, type AssistantReply, type AssistantToolCall, type Currency } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { forbidden, notFound } from '../../common/errors/domain-error';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { recordUsage } from './ai-client.service';
import { ASSISTANT_TOOLS, PERIODS, toolByName, type Period, type ToolEnv } from './assistant-tools';
import { GeminiClient, type GeminiContent, type LlmClient } from './gemini.client';
import { IntelligenceService } from './intelligence.service';

type Locale = 'en' | 'ar';
type Base = Omit<ToolEnv, 'tx'>;
interface Draft { mode: 'rules' | 'gemini'; answer: string; grounded: boolean; toolCalls: AssistantToolCall[]; llmCalls: number }

class Replay extends Error {}

const SYSTEM_PROMPT = `You are the Resuto owner assistant for a restaurant in Egypt or Saudi Arabia.
Rules:
- Every number, amount, count, date or name of a menu item in your answer must come from a tool result in this conversation. Never estimate, add up, convert or invent numbers; quote them exactly as returned.
- Money values ending in "Minor" are in minor units (1/100 of the currency): present them as the currency amount (divide by 100) with the currency code.
- Call a tool whenever the question needs data. If no tool can answer, say what you can answer instead.
- Cite each tool you used in square brackets, e.g. [sales_summary].
- Answer in the language of the question (Arabic or English), briefly.`;

const P: Record<Locale, Record<Period, string>> = {
  en: { today: 'today', yesterday: 'yesterday', last_7_days: 'in the last 7 days', last_30_days: 'in the last 30 days', this_month: 'this month', last_month: 'last month' },
  ar: { today: 'اليوم', yesterday: 'أمس', last_7_days: 'خلال آخر 7 أيام', last_30_days: 'خلال آخر 30 يومًا', this_month: 'هذا الشهر', last_month: 'الشهر الماضي' },
};
const AREA: Record<string, Record<Locale, string>> = {
  sales_summary: { en: 'sales', ar: 'المبيعات' }, top_items: { en: 'item sales', ar: 'مبيعات الأصناف' },
  low_stock: { en: 'inventory', ar: 'المخزون' }, reservations_today: { en: 'reservations', ar: 'الحجوزات' },
  insights: { en: 'insights', ar: 'الرؤى' }, demand_forecast: { en: 'forecasts', ar: 'التوقعات' },
};

/** Deterministic intent router (English and Arabic, incl. Egyptian/Gulf phrasing). Order matters. */
export function routeIntent(message: string): { tool: string; args: Record<string, unknown> } | null {
  const m = message.toLowerCase();
  const period = (fallback: Period): Period =>
    /last month|previous month|الشهر الماضي|الشهر اللي فات/.test(m) ? 'last_month'
      : /yesterday|أمس|امبارح|البارحة/.test(m) ? 'yesterday'
        : /30 days|last month's|آخر 30|ثلاثين/.test(m) ? 'last_30_days'
          : /this month|month|الشهر|شهر/.test(m) ? 'this_month'
            : /week|7 days|seven days|أسبوع|اسبوع|7 أيام/.test(m) ? 'last_7_days'
              : /today|اليوم|النهارده|النهاردة/.test(m) ? 'today' : fallback;
  if (/stock|inventory|run(ning)? out|sold out|مخزون|المخزن|نفاد|نفد|خلص/.test(m)) return { tool: 'low_stock', args: {} };
  if (/reservation|booking|booked|covers|حجز|حجوزات/.test(m)) return { tool: 'reservations_today', args: {} };
  if (/forecast|predict|expect|next week|demand|توقع|تنبؤ|الطلب المتوقع|الأسبوع الجاي|الأسبوع القادم/.test(m)) {
    return { tool: 'demand_forecast', args: { days: /14|two weeks|أسبوعين/.test(m) ? 14 : 7 } };
  }
  if (/worst|least|slow(est)? (selling|moving)|bottom|lowest|الأقل|أقل|أضعف/.test(m)) return { tool: 'top_items', args: { period: period('last_7_days'), direction: 'bottom', limit: 5 } };
  if (/best|top|popular|selling|most sold|items|dishes|الأكثر|أكثر|الأصناف|أصناف|الأطباق/.test(m)) return { tool: 'top_items', args: { period: period('last_7_days'), direction: 'top', limit: 5 } };
  if (/insight|alert|anomal|warning|problem|تنبيه|تنبيهات|رؤى|ملاحظات|مشاكل/.test(m)) return { tool: 'insights', args: { limit: 5 } };
  if (/sales|revenue|income|turnover|orders|earn|made|sell|مبيعات|المبيعات|إيراد|ايراد|دخل|طلبات|الطلبات|بعنا/.test(m)) return { tool: 'sales_summary', args: { period: period('today') } };
  return null;
}

/** Numbers in free text (Arabic-Indic digits normalised; list markers ignored). */
export function numbersIn(s: string): number[] {
  const ascii = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/\u066B/g, '.').replace(/\u066C/g, ',').replace(/^\s*\d{1,2}[.)]\s/gm, ' ');
  return (ascii.match(/\d+(?:[.,]\d+)*/g) ?? []).map((t) => Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, '') : t.replace(/,/g, '.')))
    .filter((n) => Number.isFinite(n));
}

/** True when every number in the answer appears in the tool results (or the question). */
export function isGrounded(answer: string, results: unknown[], question: string): boolean {
  const allowed = new Set<string>();
  const add = (n: number) => {
    for (const v of [n, n / 100]) for (const d of [0, 1, 2]) allowed.add(v.toFixed(d));
  };
  const walk = (v: unknown) => {
    if (typeof v === 'number') add(v);
    else if (typeof v === 'string') numbersIn(v).forEach(add);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  results.forEach(walk);
  numbersIn(question).forEach(add);
  return numbersIn(answer).every((n) => [0, 1, 2].some((d) => allowed.has(n.toFixed(d))));
}

@Injectable()
export class AssistantService {
  constructor(
    private readonly db: DbService,
    private readonly intelligence: IntelligenceService,
    private readonly gemini: GeminiClient,
    private readonly idem: IdempotencyService,
  ) {}

  get mode(): 'gemini' | 'rules' {
    return this.gemini.configured ? 'gemini' : 'rules';
  }

  async ask(ctx: TenantContext, input: AssistantMessageInput, idempotencyKey?: string): Promise<AssistantReply> {
    if (!ctx.userId) throw forbidden('The assistant is available to signed-in staff only');
    if (input.branchId) ctx.assertBranch(input.branchId);
    const scope = 'intelligence.assistant';
    if (idempotencyKey) {
      try {
        // Replays a completed request; otherwise rolls back the claim and continues.
        return await this.db.scoped(ctx, (tx) => this.idem.run(tx, ctx.orgId, scope, idempotencyKey, input, async () => { throw new Replay(); }));
      } catch (e) {
        if (!(e instanceof Replay)) throw e;
      }
    }
    const { base, history } = await this.prepare(ctx, input);

    const draft = this.gemini.configured
      ? await this.answerWithLlm(base, input.message, input.locale, this.gemini, history)
      : await this.answerWithRules(base, input.message, input.locale);

    const persist = async (tx: any) => {
      const threadId = input.threadId ?? (await tx.one(
        `insert into assistant_threads(org_id, user_id, title) values ($1, $2, $3) returning id`, [ctx.orgId, ctx.userId, input.message.slice(0, 80)])).id;
      await tx.query(`insert into assistant_messages(org_id, thread_id, role, content, created_at) values ($1, $2, 'user', $3, clock_timestamp())`, [ctx.orgId, threadId, input.message]);
      for (const c of draft.toolCalls) {
        await tx.query(`insert into assistant_messages(org_id, thread_id, role, content, tool_calls, provider, created_at) values ($1, $2, 'tool', $3, $4, 'resuto', clock_timestamp())`,
          [ctx.orgId, threadId, JSON.stringify(c.result ?? { error: c.error }).slice(0, 20_000), JSON.stringify([{ name: c.name, args: c.args }])]);
      }
      const msg = await tx.one(
        `insert into assistant_messages(org_id, thread_id, role, content, tool_calls, provider, created_at) values ($1, $2, 'assistant', $3, $4, $5, clock_timestamp()) returning id`,
        [ctx.orgId, threadId, draft.answer, JSON.stringify(draft.toolCalls.map((c) => ({ name: c.name, args: c.args, ok: !c.error }))), draft.mode]);
      for (let i = 0; i < draft.llmCalls; i++) await recordUsage(tx, ctx, { endpoint: 'assistant', provider: 'gemini' });
      const reply: AssistantReply = {
        threadId, messageId: msg.id, mode: draft.mode, answer: draft.answer, grounded: draft.grounded, toolCalls: draft.toolCalls,
        citations: [...new Set(draft.toolCalls.filter((c) => !c.error).map((c) => c.name))],
      };
      return reply;
    };
    return this.db.scoped(ctx, (tx) => idempotencyKey ? this.idem.run(tx, ctx.orgId, scope, idempotencyKey, input, () => persist(tx)) : persist(tx));
  }

  /** Tool environment (tenant, branch scope, dates) and recent thread history for one question. */
  async prepare(ctx: TenantContext, input: Pick<AssistantMessageInput, 'threadId' | 'branchId'>): Promise<{ base: Base; history: Array<{ role: 'user' | 'assistant'; content: string }> }> {
    return this.db.scoped(ctx, async (tx) => {
      if (input.threadId) {
        const t = await tx.maybeOne('select id from assistant_threads where id = $1 and org_id = $2 and user_id = $3', [input.threadId, ctx.orgId, ctx.userId]);
        if (!t) throw notFound('Conversation');
      }
      const org = await tx.one<{ currency: string; today: string }>(
        `select currency, (now() at time zone timezone)::date::text as today from organizations where id = $1`, [ctx.orgId]);
      const branch = input.branchId ? { id: input.branchId } : await tx.maybeOne<{ id: string }>(
        `select id from branches where org_id = $1 and is_active and ($2::uuid[] is null or id = any($2::uuid[])) order by created_at limit 1`,
        [ctx.orgId, ctx.branchFilter]);
      const history = input.threadId ? await tx.query<{ role: 'user' | 'assistant'; content: string }>(
        `select role, content from (select role, content, created_at from assistant_messages where thread_id = $1 and role in ('user', 'assistant')
           order by created_at desc limit 6) h order by created_at`, [input.threadId]) : [];
      return {
        base: {
          ctx, today: org.today, currency: org.currency, branches: input.branchId ? [input.branchId] : ctx.branchFilter, defaultBranchId: branch?.id ?? null,
          forecast: (branchId: string, productId: string | undefined, horizon: number) =>
            this.intelligence.forecast(ctx, { branchId, productId, horizon, top: 5, historyDays: 365 }, 'assistant'),
        } satisfies Base,
        history,
      };
    });
  }

  /** Executes one tool call with permission and argument validation. */
  async runTool(base: Base, name: string, rawArgs: unknown): Promise<AssistantToolCall> {
    const tool = toolByName(name);
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
    if (!tool) return { name, args, error: 'unknown_tool' };
    if (!base.ctx.can(tool.permission)) return { name, args, error: `not_permitted: requires ${tool.permission}` };
    const parsed = tool.args.safeParse(args);
    if (!parsed.success) return { name, args, error: `invalid_arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
    try {
      const result = tool.external
        ? await tool.run({ ...base, tx: null as any }, parsed.data)
        : await this.db.scoped(base.ctx, (tx) => tool.run({ ...base, tx }, parsed.data));
      return { name, args: parsed.data as Record<string, unknown>, result };
    } catch (error) {
      return { name, args: parsed.data as Record<string, unknown>, error: `${(error as any).code ?? 'tool_failed'}: ${(error as Error).message}` };
    }
  }

  async answerWithRules(base: Base, message: string, locale: Locale): Promise<Draft> {
    const intent = routeIntent(message);
    if (!intent) return { mode: 'rules', answer: this.help(locale), grounded: true, toolCalls: [], llmCalls: 0 };
    const call = await this.runTool(base, intent.tool, intent.args);
    return { mode: 'rules', answer: this.render(call, locale, base.currency), grounded: true, toolCalls: [call], llmCalls: 0 };
  }

  /** Gemini function calling over the same tools. Ungrounded answers are replaced by the deterministic rendering. */
  async answerWithLlm(base: Base, message: string, locale: Locale, llm: LlmClient,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = []): Promise<Draft> {
    const tools = ASSISTANT_TOOLS.filter((t) => base.ctx.can(t.permission))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const contents: GeminiContent[] = [
      ...history.map((h) => ({ role: h.role === 'assistant' ? 'model' as const : 'user' as const, parts: [{ text: h.content }] })),
      { role: 'user', parts: [{ text: `${message}\n\n(Today is ${base.today}; currency ${base.currency}.)` }] },
    ];
    const calls: AssistantToolCall[] = [];
    let text = '';
    let llmCalls = 0;
    for (let round = 0; round < 4; round++) {
      const reply = await llm.generate({ system: SYSTEM_PROMPT, contents, tools });
      llmCalls++;
      const fcs = reply.parts.filter((p) => p.functionCall);
      if (!fcs.length) {
        text = reply.parts.map((p) => p.text ?? '').join('').trim();
        break;
      }
      contents.push(reply);
      const responses = [];
      for (const p of fcs.slice(0, 4)) {
        const c = await this.runTool(base, p.functionCall!.name, p.functionCall!.args ?? {});
        calls.push(c);
        responses.push({ functionResponse: { name: c.name, response: c.error ? { error: c.error } : { result: c.result } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    const ok = calls.filter((c) => !c.error);
    const grounded = !!text && isGrounded(text, ok.map((c) => c.result), message) && (numbersIn(text).length === 0 || ok.length > 0);
    if (grounded) return { mode: 'gemini', answer: text, grounded: true, toolCalls: calls, llmCalls };
    const note = locale === 'ar' ? 'تم عرض الأرقام مباشرة من بيانات ريزوتو.' : 'Figures shown directly from Resuto data.';
    if (ok.length) {
      return { mode: 'gemini', answer: `${ok.map((c) => this.render(c, locale, base.currency)).join('\n\n')}\n\n${note}`, grounded: false, toolCalls: calls, llmCalls };
    }
    const rules = await this.answerWithRules(base, message, locale);
    return { ...rules, mode: 'gemini', grounded: false, toolCalls: [...calls, ...rules.toolCalls], llmCalls };
  }

  help(locale: Locale): string {
    return locale === 'ar'
      ? 'يمكنني الإجابة عن: المبيعات لفترة (اليوم، أمس، آخر 7 أيام، هذا الشهر)، الأصناف الأكثر والأقل مبيعًا، المخزون المنخفض، حجوزات اليوم، الرؤى الجديدة، وتوقع الطلب للأيام القادمة.'
      : 'I can answer: sales for a period (today, yesterday, last 7 days, this month), best and worst sellers, low stock, today\'s reservations, new insights, and the demand forecast for the coming days.';
  }

  render(call: AssistantToolCall, locale: Locale, currency: string): string {
    const ar = locale === 'ar';
    const money = (m: number) => formatMoney(m, currency as Currency, locale);
    if (call.error) {
      if (call.error.startsWith('not_permitted')) {
        return ar ? `دورك لا يسمح بعرض ${AREA[call.name]?.ar ?? call.name}.` : `Your role cannot view ${AREA[call.name]?.en ?? call.name}.`;
      }
      return ar ? `تعذر الحصول على البيانات (${call.error}).` : `I could not get that data (${call.error}).`;
    }
    const r = call.result as any;
    const name = (x: any) => (ar && x.nameAr ? x.nameAr : x.name);
    switch (call.name) {
      case 'sales_summary': {
        const p = P[locale][r.period as Period];
        return ar
          ? `المبيعات ${p} (${r.from} – ${r.to}): ${r.orders} طلب، الإيراد ${money(r.revenueMinor)}، متوسط الطلب ${money(r.averageOrderMinor)}. ملغاة: ${r.cancelledOrders}. [sales_summary]`
          : `Sales ${p} (${r.from} – ${r.to}): ${r.orders} orders, revenue ${money(r.revenueMinor)}, average order ${money(r.averageOrderMinor)}. Cancelled: ${r.cancelledOrders}. [sales_summary]`;
      }
      case 'top_items': {
        const p = P[locale][r.period as Period];
        const head = r.direction === 'top' ? (ar ? `الأكثر مبيعًا ${p}:` : `Best sellers ${p}:`) : (ar ? `الأقل مبيعًا ${p}:` : `Slowest sellers ${p}:`);
        if (!r.items.length) return ar ? `${head} لا توجد مبيعات.` : `${head} no sales.`;
        return `${head}\n${r.items.map((x: any, i: number) => `${i + 1}. ${name(x)} — ${x.quantity} (${money(x.revenueMinor)})`).join('\n')}\n[top_items]`;
      }
      case 'low_stock': {
        const lines = [
          ...r.inventory.map((x: any) => `• ${name(x)}: ${x.quantity} ${x.unit} (${ar ? 'حد الطلب' : 'reorder at'} ${x.reorderLevel}) — ${x.branch}`),
          ...r.menuItems.map((x: any) => `• ${name(x)}: ${x.stock} ${ar ? 'متبقٍ' : 'left'} — ${x.branch}`),
        ];
        if (!lines.length) return ar ? 'لا يوجد صنف تحت حد إعادة الطلب. [low_stock]' : 'Nothing is at or below its reorder level. [low_stock]';
        return `${ar ? 'مخزون منخفض:' : 'Low stock:'}\n${lines.join('\n')}\n[low_stock]`;
      }
      case 'reservations_today': {
        if (!r.reservations) return ar ? 'لا توجد حجوزات اليوم. [reservations_today]' : 'No reservations today. [reservations_today]';
        const slots = r.slots.slice(0, 10).map((s: any) => `${s.time} (${s.partySize})`).join('، ');
        return ar ? `اليوم ${r.reservations} حجز لعدد ${r.covers} ضيف: ${slots}. [reservations_today]`
          : `${r.reservations} reservations today for ${r.covers} guests: ${slots}. [reservations_today]`;
      }
      case 'insights': {
        if (!r.insights.length) return ar ? 'لا توجد رؤى جديدة. [insights]' : 'No open insights. [insights]';
        return `${ar ? 'أحدث الرؤى:' : 'Latest insights:'}\n${r.insights.map((x: any) => `• [${x.severity}] ${x.title}`).join('\n')}\n[insights]`;
      }
      case 'demand_forecast': {
        if (!r.items?.length) return ar ? 'لا توجد بيانات كافية للتوقع بعد. [demand_forecast]' : 'Not enough sales history to forecast yet. [demand_forecast]';
        const head = ar ? `توقع الطلب للأيام الـ${r.days} القادمة (البيانات حتى ${r.asOf}):` : `Demand forecast for the next ${r.days} days (data up to ${r.asOf}):`;
        return `${head}\n${r.items.map((x: any) => `• ${name(x)}: ${x.total} (${ar ? 'نطاق' : 'range'} ${x.lowerTotal}–${x.upperTotal}, ${x.model})`).join('\n')}\n[demand_forecast]`;
      }
      default:
        return JSON.stringify(r);
    }
  }
}

export { PERIODS };
