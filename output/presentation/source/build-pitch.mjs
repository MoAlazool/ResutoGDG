import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PptxGenJS = require("/Users/tank/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pptxgenjs");
const sharp = require("/Users/tank/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp");
const JSZip = require("/Users/tank/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/jszip");

const root = "/Users/tank/Downloads/Resuto-main";
const outDir = path.join(root, "output/presentation");
const sourceDir = path.join(outDir, "source");
const buildDir = path.join(root, ".codex-build/resuto-impactx-pitch");
const finalizerDir = path.join(root, ".codex-finalizer/resuto-impactx-pitch");
const shots = path.join(outDir, "selected-screenshots");
const skillDir = "/Users/tank/.codex/plugins/cache/openai-primary-runtime/presentations/26.905.11957/skills/presentations";
const python = "/Users/tank/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const draftPath = path.join(buildDir, "Resuto_IMPACTX_Pitch_candidate.pptx");
const finalPath = path.join(outDir, "Resuto_IMPACTX_Pitch.pptx");
const receiptPath = path.join(finalizerDir, "Resuto_IMPACTX_Pitch.validation.json");
process.env.RUNTIME_NODE_MODULES ??= "/Users/tank/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
await Promise.all([fs.mkdir(outDir, { recursive: true }), fs.mkdir(sourceDir, { recursive: true }), fs.mkdir(buildDir, { recursive: true }), fs.mkdir(finalizerDir, { recursive: true })]);

const C = {
  ink: "17231F", forest: "173F35", olive: "445D45", sage: "A7B69B",
  mint: "E6EFE8", cream: "F7F4EC", sand: "E8DDCC", orange: "E8763C",
  amber: "D89A32", white: "FFFFFF", muted: "66736A", line: "D4DCD5",
  teal: "2F7667", red: "B94E4E", blush: "F8E9E2", gold: "BAC879",
  darkCream: "EEE9DE", black: "0D1814"
};
const FONT = "Manrope";
const FONT_AR = "IBM Plex Sans Arabic";

// The small mark is a crop of the original repository logo asset, never redrawn.
const markPath = path.join(buildDir, "resuto-original-mark.png");
await sharp(path.join(root, "public/assets/resuto-arabic-logo.png"))
  .extract({ left: 1470, top: 70, width: 540, height: 510 })
  .resize(320, 300, { fit: "contain" })
  .png().toFile(markPath);

async function crop(name, src, w, h, position = "centre") {
  const target = path.join(buildDir, name);
  await sharp(src).resize(w, h, { fit: "cover", position }).png().toFile(target);
  return target;
}

const A = {};
const cropJobs = [
  ["landing", "01-resuto-landing-desktop.png", 1600, 1000, "north"],
  ["restaurant", "03-olive-room-mobile.png", 650, 1400, "north"],
  ["reserve", "06-reservation-selected-mobile.png", 650, 1400, "north"],
  ["menu", "07-menu-mobile.png", 650, 1400, "north"],
  ["aiGuest", "09-live-gemini-recommendation-mobile.png", 650, 1400, "north"],
  ["manager", "10-manager-overview-desktop.png", 1600, 1000, "north"],
  ["floor", "11-floor-editor-desktop.png", 1600, 1000, "north"],
  ["aiImport", "13-live-gemini-menu-draft-desktop.png", 1600, 1000, "north"],
  ["smash", "15-smash-guest-mobile.png", 650, 1400, "north"],
  ["custom", "16-order-customization-mobile.png", 650, 1400, "north"],
  ["checkout", "17-checkout-test-mode-mobile.png", 650, 1400, "north"],
  ["confirm", "18-order-confirmation-mobile.png", 650, 1400, "north"],
  ["kNew", "19-kitchen-new-order-desktop.png", 1600, 1000, "north"],
  ["kPrep", "20-kitchen-preparing-desktop.png", 1600, 1000, "north"],
  ["kReady", "21-kitchen-ready-desktop.png", 1600, 1000, "north"],
  ["arabic", "22-arabic-menu-rtl-mobile.png", 650, 1400, "north"],
];
for (const [key, file, w, h, pos] of cropJobs) A[key] = await crop(`${key}.png`, path.join(shots, file), w, h, pos);

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "Resuto";
pptx.subject = "IMPACT X hackathon pitch";
pptx.title = "Resuto IMPACT X Pitch";
pptx.company = "Resuto";
pptx.lang = "en-US";
pptx.theme = {
  headFontFace: FONT,
  bodyFontFace: FONT,
  lang: "en-US"
};
const SH = pptx.ShapeType;
const dash = { color: C.line, width: 1 };
const noLine = { color: C.white, transparency: 100 };
function addText(slide, text, x, y, w, h, o = {}) {
  slide.addText(text, {
    x, y, w, h, margin: o.margin ?? 0, fontFace: o.fontFace || FONT,
    fontSize: o.fontSize || 20, color: o.color || C.ink, bold: !!o.bold,
    breakLine: false, fit: "shrink", valign: o.valign || "mid", align: o.align || "left",
    paraSpaceAfterPt: o.paraSpaceAfterPt || 0, isTextBox: true,
    ...o
  });
}
function addRect(slide, x, y, w, h, fill, radius = 0, line = noLine) {
  slide.addShape(radius ? SH.roundRect : SH.rect, { x, y, w, h, rectRadius: radius, fill: { color: fill }, line });
}
function addImage(slide, file, x, y, w, h, radius = 0) {
  if (radius) {
    slide.addShape(SH.roundRect, { x: x - 0.02, y: y - 0.02, w: w + 0.04, h: h + 0.04, rectRadius: radius, fill: { color: C.white }, line: { color: C.line, width: 0.7 } });
  }
  slide.addImage({ path: file, x, y, w, h });
}
function title(slide, text, sub = "", opts = {}) {
  addText(slide, text, 0.72, 0.61, 11.85, 0.58, { fontSize: opts.size || 30, bold: true, color: opts.color || C.ink, valign: "top" });
  if (sub) addText(slide, sub, 0.74, 1.20, 11.45, 0.38, { fontSize: 14.5, color: opts.subColor || C.muted, valign: "top" });
}
function section(slide, text) {
  addText(slide, text.toUpperCase(), 10.75, 0.30, 1.85, 0.16, { fontSize: 8.5, bold: true, color: C.amber, align: "right", charSpacing: 1.4 });
}
function chip(slide, text, x, y, w, fill = C.mint, color = C.forest) {
  addRect(slide, x, y, w, 0.32, fill, 0.16);
  addText(slide, text, x + 0.08, y + 0.01, w - 0.16, 0.28, { fontSize: 10, bold: true, color, align: "center" });
}
function note(slide, script, duration, transition, demo, fallback, sources) {
  const text = `المدة: ${duration}\n\nالنص المقترح:\n${script}\n\nالانتقال:\n${transition}\n\nإجراء العرض:\n${demo || "لا يوجد إجراء حي."}\n\nالخطة الاحتياطية:\n${fallback || "استخدم لقطات الشاشة الموجودة في الشريحة."}\n\n[Sources]\n${sources.join("\n")}\n[/Sources]`;
  slide.addNotes(text);
}
function appendixNote(slide, sources) { slide.addNotes(`[Sources]\n${sources.join("\n")}\n[/Sources]`); }
function frame(slide, file, x, y, w, h, label = "") {
  addRect(slide, x - 0.035, y - 0.035, w + 0.07, h + 0.07, C.white, 0.18, { color: C.line, width: 0.9 });
  addImage(slide, file, x, y, w, h);
  if (label) chip(slide, label, x + 0.12, y + h - 0.44, Math.min(w - 0.24, Math.max(1.15, label.length * 0.075)), C.forest, C.white);
}
function addFooterTag(slide, text) { addText(slide, text, 0.72, 7.18, 5.8, 0.13, { fontSize: 8.5, color: C.muted, valign: "top" }); }
function line(slide, x, y, w, h = 0, color = C.line, width = 1.5, beginArrowType, endArrowType) {
  slide.addShape(SH.line, { x, y, w, h, line: { color, width, beginArrowType, endArrowType } });
}
function addLightSlide() {
  const s = pptx.addSlide();
  s.background = { color: C.cream };
  line(s, 0.42, 7.12, 12.47, 0, C.line, 0.7);
  addImage(s, markPath, 0.42, 0.23, 0.39, 0.37);
  addText(s, "RESUTO", 0.86, 0.31, 1.0, 0.18, { fontSize: 9, bold: true, color: C.forest, valign: "top" });
  return s;
}

// 1. Cover
{
  const s = pptx.addSlide();
  s.background = { color: C.black };
  addImage(s, A.landing, 7.12, 0, 6.22, 7.5);
  addRect(s, 6.70, 0, 1.40, 7.5, C.black);
  addRect(s, 7.0, 0, 0.95, 7.5, C.black);
  addImage(s, markPath, 0.62, 0.48, 0.78, 0.72);
  addText(s, "resuto.", 1.43, 0.62, 2.2, 0.45, { fontSize: 27, bold: true, color: C.white });
  addText(s, "Run the room.\nResuto connects\neverything else.", 0.72, 1.65, 6.45, 2.45, { fontSize: 38, bold: true, color: C.white, valign: "top", breakLine: true });
  addText(s, "Reservations, table identity, ordering, kitchen, payment and management in one operating flow.", 0.74, 4.40, 5.65, 0.88, { fontSize: 18, color: "D8E4D9", valign: "top" });
  chip(s, "WORKING MVP", 0.74, 5.65, 1.45, C.orange, C.white);
  chip(s, "BUSINESS & PRODUCTIVITY", 2.31, 5.65, 2.33, C.forest, C.white);
  chip(s, "SDG 8", 4.76, 5.65, 0.90, C.mint, C.forest);
  addText(s, "IMPACT X · 5:40 main pitch", 0.75, 6.58, 3.4, 0.25, { fontSize: 11.5, bold: true, color: C.sand });
  note(s, "ريزوتو يربط رحلة المطعم من أول حجز حتى إغلاق الزيارة. أمامكم منتج يعمل اليوم، لكننا سنفصل بوضوح بين ما أثبتناه في الـMVP وما يحتاج إلى Pilot قبل البيع التجاري.", "15 ثانية", "نبدأ بالمشكلة التي تجعل هذا الاتصال مهمًا.", "افتح العرض فقط. لا تبدأ Demo في هذه الشريحة.", "اعرض الشريحة ثابتة دون أي اعتماد على الشبكة.", ["Repository: public/landing.js and public/landing.css", "Screenshot: / at 1440×900, verified 2026-09-10", "IMPACT X Judging Criteria.pdf, pp. 1-3"]);
}

// 2. Problem
{
  const s = addLightSlide(); section(s, "Problem");
  title(s, "Restaurant service breaks at the handoffs", "A reservation, table, order, kitchen ticket and payment often live in separate workflows");
  const items = [
    ["Reservation", "Manual confirmation and availability"],
    ["Table", "Guest identity and floor status"],
    ["Order", "Repeated entry and unclear changes"],
    ["Kitchen", "Status updates separated from guests"],
    ["Payment", "Split settlement and closeout"],
  ];
  items.forEach((d, i) => {
    const x = 0.75 + i * 2.43;
    addText(s, String(i + 1).padStart(2, "0"), x, 2.08, 0.42, 0.34, { fontSize: 15, bold: true, color: C.orange });
    addText(s, d[0], x, 2.53, 2.02, 0.42, { fontSize: 20, bold: true, color: C.forest });
    addText(s, d[1], x, 3.08, 1.95, 0.83, { fontSize: 13.3, color: C.muted, valign: "top" });
    if (i < 4) line(s, x + 1.93, 2.72, 0.42, 0, C.orange, 2.2, undefined, "triangle");
  });
  addRect(s, 0.75, 4.55, 11.84, 1.28, C.forest, 0.20);
  addText(s, "First customer", 1.02, 4.82, 1.58, 0.32, { fontSize: 13, bold: true, color: C.gold });
  addText(s, "Independent restaurants and small groups in Egypt that need an Arabic-first operating system without enterprise overhead", 2.45, 4.73, 9.55, 0.60, { fontSize: 21, bold: true, color: C.white, valign: "mid" });
  addText(s, "The problem remains a credible operating hypothesis until interviews and pilot baselines quantify it.", 0.78, 6.35, 8.5, 0.32, { fontSize: 12, color: C.red });
  addFooterTag(s, "No invented interviews or market statistics");
  note(s, "المشكلة ليست شاشة ناقصة، بل انتقال المسؤولية بين خمس نقاط. كل انتقال يضيف إعادة إدخال أو تأخيرًا أو خطأً يصعب قياسه. العميل الأول هو مطعم مستقل أو مجموعة صغيرة في مصر يحتاج واجهة عربية ونظامًا أخف من حلول المؤسسات. لا ندّعي مقابلات لم تحدث، لذلك يبدأ الـPilot بقياس الواقع.", "25 ثانية", "الحل هو جعل كل نقطة تكتب في نفس الحالة التشغيلية.", "أشر بسرعة إلى نقاط التسليم الخمس ثم إلى العميل الأول.", "إذا ضاق الوقت، قل الجملة الأخيرة فقط وانتقل.", ["resuto-impact-x-judging-pack-ar.pdf, pp. 4 and 9", "Repository: README.md, Boundaries", "IMPACT X Judging Criteria.pdf, pp. 2-3"]);
}

// 3. Flow
{
  const s = addLightSlide(); section(s, "Connected flow");
  title(s, "One state follows the guest through service", "Green steps run in the current MVP; outlined gates require production validation");
  const flow = [
    ["Reserve", "table + hold", true], ["Seat", "live visit", true], ["Scan", "stable QR", true],
    ["Order", "server price", true], ["Kitchen", "guarded states", true], ["Split", "exact minor units", true],
    ["Pay", "test mode", true], ["Close", "cleaning state", true]
  ];
  flow.forEach((d, i) => {
    const x = 0.65 + i * 1.55;
    addRect(s, x, 2.05, 1.24, 1.19, d[2] ? C.forest : C.white, 0.20, d[2] ? noLine : { color: C.orange, width: 1.5, dash: "dash" });
    addText(s, String(i + 1), x + 0.08, 2.18, 0.25, 0.23, { fontSize: 10, bold: true, color: d[2] ? C.gold : C.orange });
    addText(s, d[0], x + 0.08, 2.47, 1.08, 0.29, { fontSize: 16, bold: true, color: d[2] ? C.white : C.forest, align: "center" });
    addText(s, d[1], x + 0.08, 2.83, 1.08, 0.22, { fontSize: 9.5, color: d[2] ? "DCE7DE" : C.muted, align: "center" });
    if (i < flow.length - 1) line(s, x + 1.25, 2.64, 0.28, 0, C.orange, 1.8, undefined, "triangle");
  });
  addText(s, "The connection creates the value", 0.78, 3.90, 4.1, 0.43, { fontSize: 25, bold: true, color: C.forest });
  addText(s, "One floor geometry drives reservation choice and table identity. One order state updates the kitchen. One bill state controls payment and closeout.", 0.80, 4.50, 7.25, 1.02, { fontSize: 18, color: C.ink, valign: "top" });
  addRect(s, 8.55, 3.82, 3.62, 1.75, C.mint, 0.20);
  addText(s, "Production gates", 8.86, 4.11, 2.90, 0.34, { fontSize: 19, bold: true, color: C.forest });
  addText(s, "Live merchant acceptance\nFirebase emulator isolation run\nOperational monitoring and recovery", 8.88, 4.55, 2.90, 0.70, { fontSize: 13, color: C.muted, valign: "top", breakLine: true });
  addFooterTag(s, "Implemented flow with explicit launch gates");
  note(s, "نفس الحالة التشغيلية تتبع الضيف من الحجز حتى تنظيف الطاولة. كل المراحل الخضراء تعمل في الـMVP. الدفع هنا Test mode، ومسار Firebase متعدد المطاعم موجود في الكود لكنه ما زال يحتاج اختبار المحاكي وتشغيل الإنتاج. هذه الحدود جزء من الخطة وليست مخفية.", "20 ثانية", "لنرَ أقوى أجزاء رحلة الضيف على الهاتف.", "مرّر المؤشر على المسار فقط؛ لا تفتح المتصفح بعد.", "الشريحة تعرض المسار كاملًا دون حاجة إلى Demo حي.", ["Repository: server.js; platform-domain.js; floor-domain.js", "npm test on 2026-09-10: 76 passed, 0 failed, 1 skipped", "Screenshot verification: /reserve, /menu, /kitchen"]);
}

// 4. Guest experience
{
  const s = addLightSlide(); section(s, "Guest experience");
  title(s, "Guests choose the table, then order in context", "The same live menu supports English, Arabic and a constrained Gemini assistant");
  frame(s, A.reserve, 0.78, 1.70, 3.03, 4.93, "TABLE SELECTION");
  frame(s, A.menu, 4.18, 1.70, 3.03, 4.93, "QR MENU");
  frame(s, A.aiGuest, 7.58, 1.70, 3.03, 4.93, "LIVE GEMINI");
  addRect(s, 10.90, 1.70, 1.67, 4.93, C.forest, 0.18);
  addText(s, "Three proofs", 11.12, 2.05, 1.23, 0.54, { fontSize: 18, bold: true, color: C.white, align: "center" });
  const proofs = ["Exact table", "Readable menu", "Budget held"];
  proofs.forEach((t, i) => { addText(s, `0${i + 1}`, 11.12, 2.96 + i * 0.96, 0.38, 0.26, { fontSize: 10, bold: true, color: C.gold }); addText(s, t, 11.12, 3.23 + i * 0.96, 1.24, 0.43, { fontSize: 14, bold: true, color: C.white, align: "center" }); });
  addFooterTag(s, "Fresh screenshots from the current local build");
  note(s, "الضيف يختار طاولة حقيقية من نفس المخطط الذي يراه المدير. بعد ذلك يفتح القائمة من QR ويطلب بدون إعادة إدخال. مساعد Gemini استقبل طلب عشاء لشخصين تحت 700 جنيه، احترم الميزانية، وعرض 685 جنيه مع تنبيه واضح للحساسية. الإضافة إلى السلة ما زالت تحتاج موافقة الضيف.", "45 ثانية", "بعد التأكيد ينتقل نفس الطلب إلى المطبخ.", "اعرض لقطة Gemini. إذا كان الوقت يسمح، افتح /menu وكرر الطلب التجريبي فقط.", "إذا تعذر Gemini، استخدم لقطة LIVE GEMINI واذكر أن النظام يعرض fallback موسومًا.", ["Screenshots: /reserve and /menu, 390×844, 2026-09-10", "Repository: public/booking.css; public/guest.js; ai-service.js", "Live Gemini response verified in local runtime, 2026-09-10"]);
}

// 5. Order to kitchen
{
  const s = addLightSlide(); section(s, "Operations");
  title(s, "Order #001 moved from guest confirmation to ready", "A synthetic pickup order exercised the real state transition; checkout stayed visibly in test mode");
  frame(s, A.confirm, 0.78, 1.76, 2.58, 4.72, "GUEST CONFIRMED");
  frame(s, A.kNew, 3.78, 1.76, 4.08, 2.55, "KITCHEN RECEIVED");
  frame(s, A.kReady, 8.10, 1.76, 4.08, 2.55, "READY TO SERVE");
  line(s, 3.38, 2.93, 0.33, 0, C.orange, 2.3, undefined, "triangle");
  line(s, 7.87, 2.93, 0.18, 0, C.orange, 2.3, undefined, "triangle");
  addRect(s, 3.78, 4.72, 8.40, 1.33, C.mint, 0.20);
  addText(s, "What the state machine protects", 4.08, 4.99, 2.70, 0.56, { fontSize: 18, bold: true, color: C.forest });
  addText(s, "Stale transitions are rejected. Prices stay fixed on order lines. Payment never marks food fulfilled. Closing waits for settlement and completion.", 6.90, 4.91, 4.90, 0.72, { fontSize: 13.4, color: C.ink, valign: "top" });
  chip(s, "TEST PAYMENT MODE", 0.86, 6.60, 1.78, C.blush, C.red);
  addText(s, "Stripe and Paymob adapters plus signed callback validation exist, but no live merchant acceptance was performed.", 2.86, 6.60, 8.65, 0.32, { fontSize: 11.8, color: C.red });
  addFooterTag(s, "Synthetic demo data: IMPACT X Demo · EGP 135");
  note(s, "أنشأنا طلبًا تجريبيًا باسم IMPACT X Demo. ظهر رقم 001 للضيف، ثم ظهر فورًا في المطبخ، ونقلناه من Received إلى Preparing ثم Ready. هذه انتقالات النظام الحقيقية. الدفع ما زال Test mode. تكاملات Stripe وPaymob موجودة وتتحقق من التوقيع، لكننا لم نستخدم حساب تاجر حي.", "45 ثانية", "الذكاء الاصطناعي يعمل داخل هذه الرحلة، لا كصفحة منفصلة.", "اعرض انتقالًا واحدًا فقط إذا كان المتصفح جاهزًا؛ لا تضف طلبًا جديدًا أثناء العرض.", "استخدم اللقطات الثلاث. هي توثق الحالة الفعلية بتاريخ اليوم.", ["Screenshots: /burger and /kitchen, 2026-09-10", "Repository: server.js, /api/transition; payments.js", "Tests: stale transitions, payment isolation and retry safety passed in npm test"]);
}

// 6. AI workflow
{
  const s = addLightSlide(); section(s, "Google technology");
  title(s, "Gemini drafts decisions; people approve the action", "Two live uses were verified: guest recommendations and manager menu extraction");
  frame(s, A.aiGuest, 0.78, 1.72, 3.42, 4.95, "GUEST RECOMMENDATION");
  frame(s, A.aiImport, 7.48, 1.72, 5.05, 3.18, "MANAGER REVIEW DRAFT");
  const steps = [
    ["1", "Structured input", "Current menu, stock, budget and constraints"],
    ["2", "Validated output", "Known item IDs, quantities and price ceiling"],
    ["3", "Human control", "Review, edit, approve, then publish or order"],
  ];
  steps.forEach((d, i) => {
    const x = 4.52, y = 1.90 + i * 1.37;
    addText(s, d[0], x, y, 0.40, 0.36, { fontSize: 15, bold: true, color: C.orange, align: "center" });
    addText(s, d[1], x + 0.55, y - 0.02, 2.10, 0.34, { fontSize: 16, bold: true, color: C.forest });
    addText(s, d[2], x + 0.55, y + 0.40, 2.10, 0.52, { fontSize: 11.8, color: C.muted, valign: "top" });
  });
  addRect(s, 7.48, 5.24, 5.05, 1.13, C.forest, 0.18);
  addText(s, "Fallback is part of the product", 7.78, 5.39, 2.02, 0.54, { fontSize: 15.5, bold: true, color: C.white });
  addText(s, "Provider failure returns labeled demo rules. No draft publishes automatically.", 9.98, 5.36, 2.13, 0.64, { fontSize: 10.7, color: "D8E4D9", valign: "top" });
  addFooterTag(s, "Google value: faster setup and safer choices inside the workflow");
  note(s, "Gemini يضيف قيمة في نقطتين واضحتين. للضيف، يختار من القائمة الحالية فقط ويخضع للميزانية والمخزون. وللمدير، يحول نصًا أو صورة إلى Draft منظم. اختبرنا الحالتين Live اليوم. لا يوجد نشر تلقائي؛ كل نتيجة تمر بتحقق ثم مراجعة بشرية، وعند تعطل المزود يظهر fallback واضح.", "35 ثانية", "هذا التصميم مدعوم ببنية تقنية بسيطة ويمكن الدفاع عنها.", "استخدم لقطة Draft لإظهار عبارة Nothing has been published.", "إذا تعطلت الشبكة، اعرض اللقطتين واشرح مسار fallback في سطر واحد.", ["Repository: gemini-provider.js; ai-service.js; ai-imports.js", "Screenshots: /menu and /manager import review, verified 2026-09-10", "Tests: AI schema validation and unsafe-suggestion fallback passed"]);
}

// 7. Architecture
{
  const s = addLightSlide(); section(s, "Technical credibility");
  title(s, "One domain model, two verified persistence paths", "Local demo uses SQLite; hosted tenant mode uses Firebase Authentication and Firestore");
  const nodes = [
    [0.72, 2.02, 2.15, 1.05, "Guest · Manager · Kitchen", "Static HTML, CSS and browser modules", C.white],
    [3.52, 2.02, 2.35, 1.05, "Node.js JSON API", "Auth, reservations, orders, bills and transitions", C.forest],
    [6.58, 1.47, 2.42, 1.05, "SQLite", "Default local single-installation state", C.white],
    [6.58, 3.02, 2.42, 1.05, "Firebase", "Auth + Firestore tenant documents", C.mint],
    [10.02, 1.47, 2.38, 1.05, "Gemini API", "Structured text and vision responses", C.white],
    [10.02, 3.02, 2.38, 1.05, "Payment adapters", "Stripe / Paymob hosted checkout", C.white],
  ];
  nodes.forEach((n, i) => {
    addRect(s, n[0], n[1], n[2], n[3], n[6], 0.18, i === 3 ? { color: C.teal, width: 1.4 } : { color: C.line, width: 0.9 });
    addText(s, n[4], n[0] + 0.15, n[1] + 0.16, n[2] - 0.30, 0.30, { fontSize: 16, bold: true, color: n[6] === C.forest ? C.white : C.forest, align: "center" });
    addText(s, n[5], n[0] + 0.17, n[1] + 0.54, n[2] - 0.34, 0.38, { fontSize: 10.5, color: n[6] === C.forest ? "D8E4D9" : C.muted, align: "center", valign: "top" });
  });
  line(s, 2.88, 2.55, 0.57, 0, C.orange, 2.0, undefined, "triangle");
  line(s, 5.90, 2.27, 0.62, -0.25, C.orange, 1.8, undefined, "triangle");
  line(s, 5.90, 2.77, 0.62, 0.72, C.orange, 1.8, undefined, "triangle");
  line(s, 8.98, 2.00, 0.98, 0, C.orange, 1.8, undefined, "triangle");
  line(s, 8.98, 3.55, 0.98, 0, C.orange, 1.8, undefined, "triangle");
  addRect(s, 0.75, 5.06, 11.62, 1.13, C.darkCream, 0.18);
  addText(s, "Defensible controls", 1.03, 5.31, 1.90, 0.32, { fontSize: 18, bold: true, color: C.forest });
  addText(s, "HTTP-only SameSite sessions locally · Firebase ID token verification in tenant mode · server-side price and stock checks · idempotent payments · optimistic revisions", 3.12, 5.22, 8.70, 0.52, { fontSize: 13.0, color: C.ink });
  chip(s, "TENANT CODE IMPLEMENTED", 0.78, 6.55, 2.06, C.mint, C.teal);
  addText(s, "The Firebase emulator isolation test was skipped in today’s full suite and remains a release gate.", 3.04, 6.56, 7.65, 0.30, { fontSize: 11.5, color: C.red });
  addFooterTag(s, "Architecture reflects the current repository, not the dated pack");
  note(s, "محليًا نستخدم SQLite داخل عملية Node واحدة. عند تفعيل Firebase Tenant Mode، يتحقق Firebase Auth من الهوية، ثم يختار العضوية مطعمًا واحدًا، وتُحفظ الحالة في مستند Firestore خاص بكل مطعم. الكود موجود، لكن اختبار العزل على Emulator كان Skipped اليوم، لذلك يبقى Gate قبل الإنتاج. الضوابط المثبتة تشمل السعر والمخزون على الخادم وIdempotency للمدفوعات.", "25 ثانية", "الآن نربط هذه التقنية بأثر قابل للقياس.", "لا تشرح كل ملف؛ ركز على الفرق بين Local وHosted.", "الشريحة مستقلة عن أي اتصال حي.", ["Repository: server.js:32-44 and 235-239", "Repository: firebase-platform.js:103-126", "docs/FIREBASE-SAAS.md", "npm test result, 2026-09-10"]);
}

// 8. Impact
{
  const s = addLightSlide(); section(s, "Impact · SDG 8");
  title(s, "The pilot converts operating hypotheses into evidence", "Targets describe success thresholds, not achieved results");
  const nums = [["3", "restaurants"], ["7", "baseline days"], ["23", "operating days"], ["5", "core KPIs"]];
  nums.forEach((d, i) => {
    const x = 0.78 + i * 2.16;
    addText(s, d[0], x, 1.75, 1.50, 0.69, { fontSize: 38, bold: true, color: C.forest, align: "center" });
    addText(s, d[1], x, 2.45, 1.50, 0.27, { fontSize: 11.5, bold: true, color: C.muted, align: "center" });
  });
  addRect(s, 9.52, 1.75, 2.83, 1.04, C.forest, 0.18);
  addText(s, "SDG 8", 9.80, 1.94, 0.95, 0.31, { fontSize: 17, bold: true, color: C.gold });
  addText(s, "Restaurant productivity and more reliable work", 10.68, 1.90, 1.34, 0.54, { fontSize: 11.3, bold: true, color: C.white, align: "center" });
  const kpis = [
    ["Activation", "Time from setup to first complete order"],
    ["Order accuracy", "Corrections or cancellations caused by error"],
    ["Kitchen cycle", "order_sent to kds_ready"],
    ["Settlement", "bill_requested to payment_closed"],
    ["Team adoption", "Share of orders in system + weekly CSAT"],
  ];
  kpis.forEach((d, i) => {
    const y = 3.35 + i * 0.57;
    addText(s, d[0], 0.85, y, 2.10, 0.28, { fontSize: 14, bold: true, color: C.forest });
    line(s, 3.02, y + 0.16, 0.48, 0, C.orange, 1.5);
    addText(s, d[1], 3.70, y - 0.02, 5.14, 0.32, { fontSize: 12.4, color: C.ink });
  });
  addRect(s, 9.52, 3.35, 2.83, 2.78, C.mint, 0.18);
  addText(s, "Pilot thresholds", 9.86, 3.67, 2.12, 0.36, { fontSize: 19, bold: true, color: C.forest, align: "center" });
  addText(s, "80% of orders routed through Resuto\n\n10% improvement in at least two KPIs\n\nTeam CSAT of 4/5", 9.86, 4.20, 2.12, 1.45, { fontSize: 14, bold: true, color: C.ink, valign: "top", align: "center", breakLine: true });
  addText(s, "The source PDF’s RTL inequality glyph order is ambiguous; thresholds are written here as plain language.", 0.82, 6.60, 8.2, 0.26, { fontSize: 10.5, color: C.red });
  addFooterTag(s, "Target metrics · baseline before activation · post-adoption comparison");
  note(s, "الأثر الذي نعد به الآن هو قابلية القياس. نأخذ سبعة أيام Baseline، ثم 23 يوم تشغيل، ونتابع خمسة مؤشرات من أحداث النظام. هدف التجربة أن تمر 80% من الطلبات عبر Resuto، وأن يتحسن مؤشّران على الأقل بنسبة 10%، مع رضا فريق 4 من 5. هذه أهداف وليست نتائج محققة.", "25 ثانية", "إذا تحقق الأثر، من يدفع وما الذي يشتريه؟", "أشر إلى KPIs ثم عتبات النجاح.", "لا حاجة إلى Demo حي.", ["resuto-impact-x-judging-pack-ar.pdf, p. 18", "IMPACT X Judging Criteria.pdf, p. 2", "Repository event names: server.js and platform-domain.js"]);
}

// 9. Business model
{
  const s = addLightSlide(); section(s, "Business model");
  title(s, "Egypt first, paid per branch", "The price buys the connected operating flow; Saudi Arabia opens only after compliance gates");
  addRect(s, 0.77, 1.72, 5.00, 4.73, C.forest, 0.24);
  addText(s, "Growth", 1.12, 2.08, 1.35, 0.40, { fontSize: 24, bold: true, color: C.gold });
  addText(s, "EGP 1,499", 1.12, 2.68, 3.78, 0.70, { fontSize: 40, bold: true, color: C.white });
  addText(s, "per branch / month · before tax", 1.15, 3.37, 3.62, 0.30, { fontSize: 13, color: "D7E4DA" });
  addText(s, "Includes", 1.15, 4.07, 1.10, 0.27, { fontSize: 12, bold: true, color: C.gold });
  addText(s, "Reservations, tables, QR ordering, kitchen display, split bills, customer data, AI assistant and basic integrations", 1.15, 4.49, 3.92, 1.05, { fontSize: 17, bold: true, color: C.white, valign: "top" });
  chip(s, "30-DAY PILOT · NO SETUP FEE", 1.15, 5.89, 2.72, C.orange, C.white);
  const blocks = [
    ["Who pays", "The restaurant owner or operator"],
    ["Why now", "Replace repeated handoffs with one measurable flow"],
    ["How we sell", "Founder-led pilots, restaurant advisors and referrals"],
    ["Expansion gate", "Saudi pricing follows ZATCA, VAT and local payment acceptance"],
  ];
  blocks.forEach((d, i) => {
    const y = 1.86 + i * 1.13;
    addText(s, d[0], 6.35, y, 1.30, 0.31, { fontSize: 12, bold: true, color: C.orange });
    addText(s, d[1], 7.82, y - 0.05, 4.23, 0.56, { fontSize: 17, bold: true, color: C.ink, valign: "top" });
    if (i < 3) line(s, 6.35, y + 0.72, 5.72, 0, C.line, 0.8);
  });
  addText(s, "Pro and multi-branch features remain gated until implemented and validated.", 6.36, 6.36, 5.72, 0.34, { fontSize: 11.5, color: C.red });
  addFooterTag(s, "Proposed pricing · not current revenue or willingness-to-pay evidence");
  note(s, "في مصر نبدأ بباقـة Growth بسعر مقترح 1499 جنيه للفرع شهريًا قبل الضريبة. المشتري هو المالك أو المشغل، والقيمة هي الرحلة المتصلة وليس عدد الشاشات. نستخدم Pilot بدون رسوم إعداد لاختبار الاستعداد للدفع. السعودية مرحلة تالية مشروطة بالامتثال والدفع المحلي، ولا نبيع Pro قبل اكتمال الفروع والتحليلات المطلوبة.", "30 ثانية", "الآن نختبر هل القيمة الشهرية يمكن أن تتجاوز الاشتراك.", "اعرض السعر والنطاق فقط؛ اترك جدول الأسعار الكامل للملحق.", "استخدم هذه الشريحة دون مصادر خارجية مباشرة.", ["resuto-impact-x-judging-pack-ar.pdf, pp. 10-11 and 14", "Repository: public/pricing.js", "Current UI: /pricing, verified 2026-09-10"]);
}

// 10. ROI
{
  const s = addLightSlide(); section(s, "ROI");
  title(s, "A testable Egypt Growth scenario produces 240% modeled ROI", "Illustrative scenario, not measured results");
  const vals = [
    ["Subscription", "1,499", "EGP / month", C.red],
    ["Measurable benefit", "5,100", "EGP / month", C.teal],
    ["Net benefit", "3,601", "EGP / month", C.forest],
  ];
  vals.forEach((d, i) => {
    const x = 0.82 + i * 3.20;
    addText(s, d[0], x, 2.10, 2.42, 0.28, { fontSize: 13, bold: true, color: C.muted, align: "center" });
    addText(s, d[1], x, 2.53, 2.42, 0.73, { fontSize: 39, bold: true, color: d[3], align: "center" });
    addText(s, d[2], x, 3.25, 2.42, 0.25, { fontSize: 11, color: C.muted, align: "center" });
    if (i < 2) addText(s, i === 0 ? "vs" : "=", x + 2.58, 2.73, 0.48, 0.36, { fontSize: 18, bold: true, color: C.orange, align: "center" });
  });
  addRect(s, 10.44, 1.95, 1.90, 1.70, C.forest, 0.26);
  addText(s, "240%", 10.60, 2.27, 1.57, 0.62, { fontSize: 36, bold: true, color: C.gold, align: "center" });
  addText(s, "MODELED ROI", 10.66, 2.98, 1.45, 0.25, { fontSize: 10, bold: true, color: C.white, align: "center", charSpacing: 1.0 });
  addRect(s, 0.82, 4.16, 11.52, 1.30, C.mint, 0.18);
  addText(s, "Benefit assumptions", 1.08, 4.48, 1.77, 0.28, { fontSize: 17, bold: true, color: C.forest });
  addText(s, "20 admin hours × EGP 75 = 1,500", 3.12, 4.39, 2.35, 0.50, { fontSize: 13.5, bold: true, color: C.ink, align: "center" });
  addText(s, "0.4% × EGP 600k sales = 2,400", 5.78, 4.39, 2.63, 0.50, { fontSize: 13.5, bold: true, color: C.ink, align: "center" });
  addText(s, "8 checks × EGP 500 × 30% = 1,200", 8.70, 4.39, 2.90, 0.50, { fontSize: 13.5, bold: true, color: C.ink, align: "center" });
  addText(s, "ROI = (5,100 − 1,499) ÷ 1,499 × 100 = 240.2%, rounded to 240%", 1.04, 5.90, 8.35, 0.35, { fontSize: 16, bold: true, color: C.forest });
  addText(s, "Excludes hardware, gateway fees, tax and setup fees if any.", 9.42, 5.84, 2.63, 0.51, { fontSize: 10.8, color: C.red, align: "right" });
  addFooterTag(s, "Replace every assumption with pilot data before a purchase decision");
  note(s, "هذا مثال حسابي، وليس توفيرًا محققًا. الاشتراك 1499 جنيه، والمنفعة الشهرية المفترضة 5100، فينتج صافي 3601 وعائد 240%. المنفعة تتكون من وقت إداري وأخطاء أو هدر ومساهمة إضافية. سنقيس كل بند في الـPilot ونستبعد أي منفعة لا ترتبط بتغيير تشغيلي واضح.", "25 ثانية", "المعادلة مفيدة فقط إذا تحولت إلى خطة تنفيذ وقياس.", "أشر إلى عبارة Illustrative scenario ثم المعادلة.", "إذا سُئلت عن التفاصيل، انتقل إلى شريحة الملحق الخاصة بالافتراضات.", ["resuto-impact-x-judging-pack-ar.pdf, pp. 12-13", "Arithmetic recalculated: (5100-1499)/1499 = 240.23%", "No external market claim used"]);
}

// 11. Roadmap
{
  const s = addLightSlide(); section(s, "Execution");
  title(s, "The next 90 days turn working software into a sellable service", "Current progress narrows the plan; production gates remain explicit");
  const phases = [
    ["NOW", "Working MVP", "Build passes\n76 tests pass\nLive Gemini verified", C.forest],
    ["0–30 DAYS", "Egypt pilot", "3 restaurants\n7-day baseline\nMeasured adoption + ROI", C.orange],
    ["31–60 DAYS", "Production hardening", "Firebase emulator isolation\nSubscription billing\nMonitoring + recovery", C.teal],
    ["61–90 DAYS", "Saudi gate", "Local tax review\nZATCA integration\nPayment acceptance", C.olive],
  ];
  phases.forEach((d, i) => {
    const x = 0.75 + i * 3.02;
    addText(s, d[0], x, 1.79, 2.44, 0.28, { fontSize: 10, bold: true, color: d[3], charSpacing: 1.2 });
    addText(s, d[1], x, 2.23, 2.46, 0.62, { fontSize: 23, bold: true, color: C.ink, valign: "top" });
    addRect(s, x, 3.11, 2.46, 2.26, i === 0 ? C.forest : C.white, 0.20, i === 0 ? noLine : { color: C.line, width: 1 });
    addText(s, d[2], x + 0.22, 3.43, 2.02, 1.42, { fontSize: 15, bold: true, color: i === 0 ? C.white : C.ink, align: "center", valign: "mid", breakLine: true });
    if (i < 3) line(s, x + 2.52, 4.20, 0.42, 0, C.orange, 2.0, undefined, "triangle");
  });
  addRect(s, 0.77, 5.90, 11.62, 0.66, C.darkCream, 0.16);
  addText(s, "Sustainability", 1.02, 6.09, 1.35, 0.25, { fontSize: 13, bold: true, color: C.forest });
  addText(s, "Per-branch subscriptions fund maintenance; AI usage limits, caching, monitoring and a manual fallback control operating cost.", 2.55, 6.04, 9.20, 0.33, { fontSize: 13.2, color: C.ink });
  addFooterTag(s, "Roadmap gates: evidence, reliability, compliance, then expansion");
  note(s, "منذ كتابة الملف تقدّم المشروع: البناء ينجح، 76 اختبارًا نجح، وتجربتا Gemini الحيتان عملتا. الخطوة التالية ليست إضافة خصائص عشوائية؛ هي Pilot في مصر ثم اختبار عزل Firebase والفوترة والمراقبة. السعودية تأتي بعد مراجعة ضريبية وتكامل ZATCA وقبول دفع محلي. الاشتراك يمول الصيانة، وحدود استخدام AI وFallback يدوي تضبط التكلفة.", "35 ثانية", "لذلك طلبنا النهائي محدد وقابل للتنفيذ.", "لا تفتح الملحق إلا إذا سأل الحكم عن بوابة بعينها.", "الشريحة تحمل الأدلة والحدود دون اعتماد على الشبكة.", ["Current build and test commands, 2026-09-10", "resuto-impact-x-judging-pack-ar.pdf, pp. 15-17 and 21", "Repository: firebase-platform.js; payments.js; docs/FIREBASE-SAAS.md"]);
}

// 12. Ask
{
  const s = pptx.addSlide(); s.background = { color: C.black };
  addImage(s, A.floor, 7.38, 0, 5.95, 7.5);
  addRect(s, 6.62, 0, 1.80, 7.5, C.black);
  addImage(s, markPath, 0.62, 0.46, 0.78, 0.72);
  addText(s, "The ask", 0.78, 1.52, 1.5, 0.30, { fontSize: 13, bold: true, color: C.gold });
  addText(s, "Three restaurants.\nThirty days.\nMeasured impact.", 0.75, 2.02, 6.42, 2.12, { fontSize: 38, bold: true, color: C.white, valign: "top", breakLine: true });
  addText(s, "Support a 30-day Egypt pilot to turn a connected working product into verified operating improvement and a commercial decision.", 0.78, 4.63, 5.83, 0.92, { fontSize: 18, color: "D8E4D9", valign: "top" });
  addRect(s, 0.78, 5.91, 4.62, 0.67, C.orange, 0.18);
  addText(s, "Baseline → adoption → ROI → purchase decision", 1.02, 6.11, 4.14, 0.26, { fontSize: 14, bold: true, color: C.white, align: "center" });
  addText(s, "Resuto · restaurant operations connected", 0.78, 6.92, 4.50, 0.21, { fontSize: 10.5, bold: true, color: C.sand });
  note(s, "طلبنا من لجنة IMPACT X هو دعم تجربة لمدة 30 يومًا مع ثلاثة مطاعم في مصر. نبدأ بخط أساس، نقيس التبني والأثر والعائد، وننتهي بقرار شراء واضح. ريزوتو يعمل اليوم؛ والـPilot سيحدد إن كان يستحق أن يصبح خدمة مستدامة. شكرًا.", "15 ثانية", "توقف هنا وانتظر الأسئلة.", "لا تفتح أي رابط بعد الخاتمة إلا بطلب الحكم.", "ابقَ على هذه الشريحة؛ كل الأدلة موجودة في الملحق.", ["resuto-impact-x-judging-pack-ar.pdf, pp. 18-19 and 22", "Main-pitch timing total: 340 seconds (5:40)"]);
}

// 13. Appendix feature map
{
  const s = addLightSlide(); section(s, "Appendix");
  title(s, "Verified feature map", "Working, demo/sandbox and gated status are separated explicitly", { size: 28 });
  const rows = [
    [{ text: "Role / area" }, { text: "Working now" }, { text: "Demo or sandbox" }, { text: "Production gate" }],
    ["Guest", "Reservations, exact table choice, QR menu, cart, order tracking, Arabic/English", "Live Gemini recommendation; demo restaurant content", "Real device and accessibility audit"],
    ["Kitchen", "Station routing, guarded order transitions, pickup/delivery and live polling", "Synthetic service data", "Offline queue, printer and drawer integration"],
    ["Manager", "Floor editor, menu, stock, reservations, data import/export, insights", "Live Gemini draft; AI image capability depends on model configuration", "Monitoring, recovery and operational runbook"],
    ["Owner / SaaS", "Firebase account, membership and tenant code; branch and trial records", "Local demo is a single restaurant installation", "Emulator isolation pass, subscription lifecycle and acceptance testing"],
    ["Payments", "Test ledger, splits, receipts, Stripe/Paymob adapters and signed callbacks", "No real charge in the captured flow", "Merchant credentials, settlement and refund acceptance"],
  ];
  s.addTable(rows, { x: 0.73, y: 1.72, w: 11.88, h: 4.70, border: { type: "solid", color: C.line, pt: 0.8 }, fill: C.white, color: C.ink, fontFace: FONT, fontSize: 11.3, margin: 0.11, valign: "middle", rowH: 0.72, colW: [1.48, 3.56, 3.03, 3.81], bold: false, autoFit: false, breakLine: false, paraSpaceAfterPt: 0 });
  addRect(s, 0.73, 1.72, 11.88, 0.61, C.forest, 0);
  addText(s, "Role / area", 0.88, 1.88, 1.17, 0.23, { fontSize: 11, bold: true, color: C.white });
  addText(s, "Working now", 2.23, 1.88, 2.90, 0.23, { fontSize: 11, bold: true, color: C.white });
  addText(s, "Demo or sandbox", 5.80, 1.88, 2.47, 0.23, { fontSize: 11, bold: true, color: C.white });
  addText(s, "Production gate", 8.83, 1.88, 3.00, 0.23, { fontSize: 11, bold: true, color: C.white });
  addFooterTag(s, "Status reflects code, test results and the 2026-09-10 runtime review");
  appendixNote(s, ["Repository: PROJECT_DOCUMENTATION.md and README.md", "Runtime verification screenshots, 2026-09-10", "npm test: 76 passed, 1 skipped"]);
}

// 14. Product variants and RTL
{
  const s = addLightSlide(); section(s, "Appendix · Product");
  title(s, "One platform, restaurant-specific presentation", "The Olive Room and Smash & Co are fictional demo restaurants, not customers", { size: 28 });
  frame(s, A.restaurant, 0.78, 1.66, 3.06, 4.95, "OLIVE ROOM");
  frame(s, A.smash, 4.18, 1.66, 3.06, 4.95, "SMASH & CO");
  frame(s, A.arabic, 7.58, 1.66, 3.06, 4.95, "ARABIC / RTL");
  addRect(s, 10.96, 1.66, 1.53, 4.95, C.forest, 0.18);
  addText(s, "Resuto stays the platform brand", 11.17, 2.12, 1.10, 1.14, { fontSize: 18, bold: true, color: C.white, align: "center", valign: "mid" });
  addText(s, "Themes can reflect service model and restaurant identity without changing the operating core.", 11.17, 4.10, 1.10, 1.20, { fontSize: 12, color: "D8E4D9", align: "center", valign: "mid" });
  addFooterTag(s, "Fresh mobile captures · 390×844");
  appendixNote(s, ["Screenshots: /restaurant, /burger and Arabic /menu", "Repository: public/restaurant-experience.js; public/burger.js; public/i18n.js"]);
}

// 15. Auth and tenancy
{
  const s = addLightSlide(); section(s, "Appendix · Architecture");
  title(s, "Authentication, roles and tenant isolation", "The hosted path is implemented in code; production proof remains gated", { size: 28 });
  const rows = [
    ["Concern", "Local demo", "Firebase tenant mode", "Current evidence"],
    ["Authentication", "Opaque staff cookie", "Firebase ID token", "Code + local role tests"],
    ["Roles", "Manager, kitchen, host", "Owner, manager, kitchen, host memberships", "Role restrictions pass"],
    ["Restaurant selection", "Single installation", "Membership selects exactly one restaurant", "Code review"],
    ["State storage", "SQLite state document", "restaurants/{id}/private/state", "Code review"],
    ["Client data access", "Server API only", "Firestore rules deny operational state", "Rules inspected"],
    ["Isolation test", "Guest and staff scope tests pass", "Emulator test skipped today", "Release gate"],
  ];
  s.addTable(rows, { x: 0.78, y: 1.68, w: 11.78, h: 4.65, border: { color: C.line, pt: 0.8 }, fill: C.white, color: C.ink, fontFace: FONT, fontSize: 12.2, margin: 0.10, valign: "middle", rowH: 0.59, colW: [2.12, 2.55, 4.05, 3.06], autoFit: false });
  addRect(s, 0.78, 1.68, 11.78, 0.58, C.forest, 0);
  ["Concern", "Local demo", "Firebase tenant mode", "Current evidence"].forEach((t, i) => addText(s, t, [0.98, 3.10, 5.67, 9.73][i], 1.84, [1.6, 2.0, 3.3, 2.2][i], 0.22, { fontSize: 11.2, bold: true, color: C.white }));
  addText(s, "Hosted mode must pass emulator isolation, backup/restore and incident-response rehearsal before production launch.", 0.80, 6.54, 10.75, 0.34, { fontSize: 13, bold: true, color: C.red });
  addFooterTag(s, "No claim of completed production certification");
  appendixNote(s, ["firebase-platform.js", "firestore.rules", "docs/FIREBASE-SAAS.md", "tests/firebase-tenancy.test.js (skipped in full suite 2026-09-10)"]);
}

// 16. Gemini evidence
{
  const s = addLightSlide(); section(s, "Appendix · Gemini");
  title(s, "Gemini controls and fallback behavior", "AI output stays bounded by restaurant data and explicit human action", { size: 28 });
  const columns = [
    ["Guest recommendation", "Input", "Menu IDs, price, stock, budget, party and exclusions", "Validation", "Known IDs, available quantity and total under budget", "Action", "Guest adds the meal and confirms the order"],
    ["Manager extraction", "Input", "PDF, image or text treated as untrusted source data", "Validation", "Structured schema, confidence, missing prices and uncertain fields", "Action", "Manager edits, approves and publishes separately"],
    ["Provider failure", "Signal", "Timeout, unavailable provider or invalid structured response", "Fallback", "Labeled demo rules or a clear error; no state change", "Recovery", "Manual menu and ordering paths remain available"],
  ];
  columns.forEach((d, i) => {
    const x = 0.76 + i * 4.08;
    addText(s, d[0], x, 1.72, 3.55, 0.47, { fontSize: 20, bold: true, color: C.forest });
    for (let j = 0; j < 3; j++) {
      const y = 2.47 + j * 1.24;
      addText(s, d[1 + j * 2], x, y, 0.88, 0.24, { fontSize: 10, bold: true, color: C.orange });
      addText(s, d[2 + j * 2], x + 0.98, y - 0.07, 2.57, 0.67, { fontSize: 12.8, color: C.ink, valign: "top" });
      if (j < 2) line(s, x, y + 0.84, 3.55, 0, C.line, 0.8);
    }
  });
  addRect(s, 0.77, 6.27, 11.70, 0.52, C.mint, 0.14);
  addText(s, "Live evidence: EGP 685 recommendation under a EGP 700 limit; a menu review draft created with nothing published.", 1.02, 6.39, 11.18, 0.25, { fontSize: 12.5, bold: true, color: C.forest, align: "center" });
  addFooterTag(s, "Live verification is evidence of the configured workspace, not a guarantee of provider uptime");
  appendixNote(s, ["gemini-provider.js", "ai-service.js", "ai-imports.js", "Screenshots 09 and 13, verified 2026-09-10"]);
}

// 17. Pricing tables
{
  const s = addLightSlide(); section(s, "Appendix · Pricing");
  title(s, "Proposed pricing by market", "All figures come from the dated judging pack and remain commercial hypotheses", { size: 28 });
  const egypt = [
    ["Egypt", "Monthly before tax", "Illustrative with 14%"],
    ["Starter", "EGP 799", "EGP 910.86"],
    ["Growth", "EGP 1,499", "EGP 1,708.86"],
    ["Pro", "EGP 2,999", "EGP 3,418.86"],
    ["Business", "Custom", "By proposal"],
  ];
  const saudi = [
    ["Saudi Arabia", "Target before VAT", "90-day founder", "With 15% VAT"],
    ["Starter", "SAR 199", "SAR 149", "SAR 228.85"],
    ["Growth", "SAR 399", "SAR 299", "SAR 458.85"],
    ["Pro", "SAR 699", "SAR 499", "SAR 803.85"],
  ];
  s.addTable(egypt, { x: 0.78, y: 1.78, w: 5.52, h: 3.33, colW: [1.45, 2.02, 2.05], rowH: 0.62, fontFace: FONT, fontSize: 13, color: C.ink, fill: C.white, border: { color: C.line, pt: 0.8 }, margin: 0.11, valign: "middle", autoFit: false });
  s.addTable(saudi, { x: 6.60, y: 1.78, w: 5.93, h: 2.72, colW: [1.45, 1.58, 1.45, 1.45], rowH: 0.62, fontFace: FONT, fontSize: 12.4, color: C.ink, fill: C.white, border: { color: C.line, pt: 0.8 }, margin: 0.10, valign: "middle", autoFit: false });
  addRect(s, 0.78, 1.78, 5.52, 0.62, C.forest, 0);
  addRect(s, 6.60, 1.78, 5.93, 0.62, C.forest, 0);
  ["Egypt", "Monthly before tax", "Illustrative with 14%"].forEach((t, i) => addText(s, t, [0.94, 2.34, 4.25][i], 1.94, [1.1, 1.7, 1.8][i], 0.23, { fontSize: 10.4, bold: true, color: C.white, align: "center" }));
  ["Saudi Arabia", "Target before VAT", "90-day founder", "With 15% VAT"].forEach((t, i) => addText(s, t, [6.75, 8.10, 9.74, 11.12][i], 1.94, [1.15, 1.35, 1.30, 1.2][i], 0.23, { fontSize: 9.6, bold: true, color: C.white, align: "center" }));
  addRect(s, 6.60, 4.88, 5.93, 1.17, C.blush, 0.17);
  addText(s, "Saudi go-live gate", 6.90, 5.10, 1.72, 0.44, { fontSize: 15.3, bold: true, color: C.red });
  addText(s, "Do not sell Resuto as a compliant Saudi POS until ZATCA, local tax treatment and payment acceptance are complete.", 8.88, 5.00, 3.18, 0.68, { fontSize: 11.2, color: C.ink, valign: "top" });
  addText(s, "Egypt annual offer in pack: pay 10 months. Add-ons proposed after demand proof.", 0.82, 5.57, 5.20, 0.35, { fontSize: 12.2, color: C.muted });
  addFooterTag(s, "Pack prices dated 2026-09-09 · not re-verified as current competitor pricing");
  appendixNote(s, ["resuto-impact-x-judging-pack-ar.pdf, pp. 10-11", "Pack source date: 2026-09-09", "Tax treatment requires professional review"]);
}

// 18. ROI assumptions table
{
  const s = addLightSlide(); section(s, "Appendix · ROI");
  title(s, "Egypt Growth ROI assumptions", "The pilot replaces each model input with measured data", { size: 28 });
  const rows = [
    ["Benefit component", "Illustrative calculation", "Monthly value", "Pilot measurement"],
    ["Admin time", "20 hours × EGP 75", "EGP 1,500", "Timed baseline vs system events"],
    ["Avoided error / waste", "0.4% × EGP 600k sales", "EGP 2,400", "Logged corrections with reason codes"],
    ["Incremental contribution", "8 checks × EGP 500 × 30%", "EGP 1,200", "Contribution margin, not gross sales"],
    ["Total benefit", "Sum of three components", "EGP 5,100", "Exclude unsupported attribution"],
    ["Subscription", "Growth package", "EGP 1,499", "Before tax"],
    ["Net benefit", "5,100 − 1,499", "EGP 3,601", "Reported monthly"],
    ["Modeled ROI", "3,601 ÷ 1,499 × 100", "240.2%", "Rounded to 240%"],
  ];
  s.addTable(rows, { x: 0.78, y: 1.67, w: 11.80, h: 4.95, colW: [2.32, 3.18, 1.82, 4.48], rowH: 0.57, fontFace: FONT, fontSize: 12.1, color: C.ink, fill: C.white, border: { color: C.line, pt: 0.8 }, margin: 0.10, valign: "middle", autoFit: false });
  addRect(s, 0.78, 1.67, 11.80, 0.58, C.forest, 0);
  ["Benefit component", "Illustrative calculation", "Monthly value", "Pilot measurement"].forEach((t, i) => addText(s, t, [0.98, 3.27, 6.51, 8.29][i], 1.83, [1.85, 2.6, 1.4, 3.7][i], 0.22, { fontSize: 10.8, bold: true, color: C.white }));
  addFooterTag(s, "Illustrative model · excludes hardware, gateway fees, tax and any setup fee");
  appendixNote(s, ["resuto-impact-x-judging-pack-ar.pdf, pp. 12-13", "Arithmetic independently recalculated in presentation build"]);
}

// 19. Pilot and GTM
{
  const s = addLightSlide(); section(s, "Appendix · Pilot");
  title(s, "Pilot measurement and go-to-market", "A commercial decision closes the feedback loop", { size: 28 });
  const weeks = [
    ["0", "Recruit", "Three distinct restaurants, consent, owner and success line"],
    ["1", "Baseline", "Time, errors, settlement and current workflow without Resuto"],
    ["2", "Activate", "Menu and floor setup, team training, first complete order"],
    ["3", "Operate", "Full flow, midpoint review and prioritized fixes"],
    ["4", "Decide", "Post measure, ROI review, interviews and purchase decision"],
  ];
  weeks.forEach((d, i) => {
    const x = 0.80 + i * 2.43;
    addText(s, `W${d[0]}`, x, 1.82, 0.60, 0.28, { fontSize: 11, bold: true, color: C.orange });
    addText(s, d[1], x, 2.24, 1.95, 0.40, { fontSize: 20, bold: true, color: C.forest });
    addText(s, d[2], x, 2.82, 1.98, 1.06, { fontSize: 12.3, color: C.muted, valign: "top" });
    if (i < 4) line(s, x + 2.0, 2.44, 0.32, 0, C.orange, 1.8, undefined, "triangle");
  });
  addRect(s, 0.78, 4.47, 5.65, 1.70, C.forest, 0.20);
  addText(s, "Commercial success", 1.07, 4.76, 2.00, 0.34, { fontSize: 18, bold: true, color: C.gold });
  addText(s, "One paid conversion; two letters of intent or extensions; documented pricing objections", 1.08, 5.24, 4.72, 0.60, { fontSize: 16, bold: true, color: C.white, valign: "top" });
  addRect(s, 6.77, 4.47, 5.58, 1.70, C.mint, 0.20);
  addText(s, "Unit economics targets", 7.06, 4.76, 2.17, 0.34, { fontSize: 18, bold: true, color: C.forest });
  addText(s, "Track activation, retention, support time and AI cost first. Calculate LTV/CAC only after real cohorts exist.", 7.06, 5.24, 4.72, 0.60, { fontSize: 15, bold: true, color: C.ink, valign: "top" });
  addFooterTag(s, "Founder-led sales first · advisors and referrals after repeatable activation");
  appendixNote(s, ["resuto-impact-x-judging-pack-ar.pdf, pp. 14-15 and 18", "No invented customer or unit-economics data"]);
}

// 20. Production readiness
{
  const s = addLightSlide(); section(s, "Appendix · Risk");
  title(s, "Production readiness register", "Highest-impact risks come before feature expansion", { size: 28 });
  const risk = [
    ["Firebase tenant isolation", "Critical", "Run emulator suite and authorization matrix", "Before pilot accounts"],
    ["Real payments and refunds", "High", "Merchant sandbox, settlement and refund acceptance", "Before live money"],
    ["Monitoring and recovery", "High", "Logs, alerts, backup/restore and incident runbook", "Before production"],
    ["Offline operations", "High", "Queue, printer/drawer path and manual fallback rehearsal", "After pilot / before scale"],
    ["Egypt / Saudi compliance", "High", "Local specialist review and acceptance testing", "Before commercial launch"],
    ["Accessibility", "Medium", "Keyboard, screen reader, contrast and Arabic testing", "Pilot hardening"],
    ["Team adoption", "Medium", "45-minute training, restaurant champion, activation tracking", "During pilot"],
  ];
  risk.forEach((r, i) => {
    const y = 1.72 + i * 0.65;
    addText(s, r[0], 0.82, y, 2.45, 0.30, { fontSize: 14, bold: true, color: C.forest });
    chip(s, r[1].toUpperCase(), 3.36, y - 0.02, 0.88, r[1] === "Critical" ? C.red : r[1] === "High" ? C.blush : C.mint, r[1] === "Critical" ? C.white : r[1] === "High" ? C.red : C.teal);
    addText(s, r[2], 4.55, y - 0.05, 5.20, 0.39, { fontSize: 12.5, color: C.ink });
    addText(s, r[3], 10.12, y - 0.05, 2.03, 0.39, { fontSize: 11.4, bold: true, color: C.muted, align: "right" });
    line(s, 0.80, y + 0.47, 11.50, 0, C.line, 0.6);
  });
  addFooterTag(s, "This register is a launch plan, not a claim of completed compliance");
  appendixNote(s, ["resuto-impact-x-judging-pack-ar.pdf, pp. 16-17 and 21", "Repository boundaries: README.md", "Current Firebase test status: one skipped emulator test"]);
}

// 21. Q&A
{
  const s = addLightSlide(); section(s, "Appendix · Q&A");
  title(s, "Likely judging questions", "Short answers grounded in current evidence", { size: 28 });
  const qa = [
    ["What is different from a POS?", "Resuto connects the guest journey and operating state, with table geometry and reviewed AI inside the workflow. It does not claim to replace every production POS today."],
    ["Is the ROI proven?", "No. The slide is an illustrative model. The pilot records a baseline, measures post-adoption events and ties continuation to evidence."],
    ["Why this price?", "It sits below the pack’s dated Egypt benchmark and reflects MVP scope. Willingness to pay remains a pilot question."],
    ["Does multi-restaurant isolation work?", "Firebase membership and tenant storage code exists. The emulator isolation test was skipped today, so production launch remains gated."],
    ["What happens when Gemini fails?", "The system validates output and returns labeled demo rules or a clear error. It does not publish or place an order automatically."],
    ["Can you operate in Saudi Arabia?", "Only after local tax review, ZATCA integration and payment acceptance. The proposal treats Saudi Arabia as a gated expansion."],
  ];
  qa.forEach((d, i) => {
    const y = 1.64 + i * 0.86;
    addText(s, d[0], 0.82, y, 3.24, 0.38, { fontSize: 14.2, bold: true, color: C.forest, valign: "top" });
    addText(s, d[1], 4.28, y - 0.04, 8.00, 0.62, { fontSize: 12.2, color: C.ink, valign: "top" });
    line(s, 0.82, y + 0.69, 11.46, 0, C.line, 0.65);
  });
  addFooterTag(s, "Start with the direct answer, give one proof, then stop");
  appendixNote(s, ["resuto-impact-x-judging-pack-ar.pdf, p. 20", "Current repository and runtime verification, 2026-09-10"]);
}

// 22. Judging coverage
{
  const s = addLightSlide(); section(s, "Appendix · Evidence");
  title(s, "Judging coverage and source trail", "Every core criterion maps to a main slide and a verifiable source", { size: 28 });
  const rows = [
    ["Criterion", "Main slide", "Evidence"],
    ["Problem definition", "2", "Pack positioning + explicit research limitation"],
    ["Impact / SDG", "8", "Pilot KPIs, baseline and SDG 8 link"],
    ["Innovation", "3, 6", "Connected state + Gemini inside reviewed workflows"],
    ["Solution / UX", "4, 5", "Fresh mobile and kitchen runtime captures"],
    ["Technical implementation", "5, 7", "Real state transition, architecture and passing tests"],
    ["Feasibility", "11", "90-day gated execution plan"],
    ["ROI / business model", "9, 10", "Per-branch price and transparent calculation"],
    ["Sustainability", "11", "Revenue-funded maintenance and cost controls"],
    ["Presentation", "1–12", "340-second timed main narrative"],
  ];
  s.addTable(rows, { x: 0.78, y: 1.60, w: 7.58, h: 5.32, colW: [2.24, 1.14, 4.20], rowH: 0.48, fontFace: FONT, fontSize: 11.6, color: C.ink, fill: C.white, border: { color: C.line, pt: 0.75 }, margin: 0.09, valign: "middle", autoFit: false });
  addRect(s, 0.78, 1.60, 7.58, 0.51, C.forest, 0);
  ["Criterion", "Main slide", "Evidence"].forEach((t, i) => addText(s, t, [0.95, 3.22, 4.35][i], 1.73, [1.8, 0.9, 3.6][i], 0.23, { fontSize: 10.8, bold: true, color: C.white }));
  addRect(s, 8.75, 1.60, 3.79, 5.32, C.forest, 0.22);
  addText(s, "Primary sources", 9.10, 1.98, 3.10, 0.38, { fontSize: 20, bold: true, color: C.gold });
  addText(s, "IMPACT X Judging Criteria.pdf\n\nresuto-impact-x-judging-pack-ar.pdf\n\nCurrent repository files\n\nFresh browser captures\n\n2026-09-10 build and test results", 9.10, 2.70, 3.00, 2.47, { fontSize: 15, bold: true, color: C.white, valign: "top", breakLine: true });
  addText(s, "Detailed mapping: Evidence_Coverage.md", 9.10, 6.12, 3.05, 0.34, { fontSize: 11.5, color: "D8E4D9" });
  addFooterTag(s, "Main presentation: slides 1–12 · Appendix: slides 13–22");
  appendixNote(s, ["IMPACT X Judging Criteria.pdf, pp. 1-7", "output/presentation/Evidence_Coverage.md", "All slide notes contain [Sources] blocks"]);
}

await pptx.writeFile({ fileName: draftPath });

// PptxGenJS 4 currently emits content-type declarations for one slide master per
// slide even though it writes only slideMaster1.xml. Remove only those dangling
// declarations so the OOXML package remains standards-compliant and editable.
{
  const zip = await JSZip.loadAsync(await fs.readFile(draftPath));
  const contentTypesFile = zip.file("[Content_Types].xml");
  let contentTypes = await contentTypesFile.async("string");
  contentTypes = contentTypes.replace(
    /<Override PartName="\/ppt\/slideMasters\/slideMaster(?!1\.xml)[0-9]+\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.slideMaster\+xml"\/>/g,
    ""
  );
  zip.file("[Content_Types].xml", contentTypes);
  await fs.writeFile(draftPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

const { finalizePresentation } = await import(pathToFileURL(path.join(skillDir, "container_tools/artifact_tool_utils.mjs")).href);
await Promise.all([fs.rm(finalPath, { force: true }), fs.rm(receiptPath, { force: true })]);
const result = await finalizePresentation({
  explicitTotalSlideCount: 22,
  requiredNativeTableOwnerSlides: [13, 15, 17, 18, 22],
  requiredNativeChartOwnerSlides: [],
  workspaceDir: root,
  candidatePath: draftPath,
  finalPath,
  pythonExecutable: python,
  integrityValidatorPath: path.join(skillDir, "container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(skillDir, "container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs: ["--expected-slide-size-emu", "12192000,6858000", "--validate-bullet-geometry", "--validate-heading-fit", "--require-native-table-slide", "13", "--require-native-table-slide", "15", "--require-native-table-slide", "17", "--require-native-table-slide", "18", "--require-native-table-slide", "22"],
  fontPolicy: { basis: "design", families: [FONT], scriptFonts: { cs: FONT_AR } },
  verifyArtifactToolImport: true,
  receiptPath
});
console.log(JSON.stringify({ finalPath, result }, null, 2));
