import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/Users/tank/Downloads/Resuto-main";
const SKILL_DIR = "/Users/tank/.codex/plugins/cache/openai-primary-runtime/presentations/26.905.11957/skills/presentations";
const TEMPLATE = "/Users/tank/.codex/plugins/cache/openai-curated-remote/openai-templates/0.1.1/skills/artifact-template-project-kickoff/assets/reference.pptx";
const RUNTIME_NODE_MODULES = "/Users/tank/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const RUNTIME_PYTHON = "/Users/tank/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const BUILD = path.join(ROOT, ".codex-build/resuto-impactx-kickoff-special");
const FINALIZER = path.join(ROOT, ".codex-finalizer/resuto-impactx-kickoff-special");
const OUTPUT = path.join(ROOT, "output/presentation/Resuto_IMPACTX_Special_Kickoff.pptx");
const RECEIPT = path.join(FINALIZER, "Resuto_IMPACTX_Special_Kickoff.validation.json");
const SHOTS = path.join(ROOT, "output/presentation/selected-screenshots");
const DRAFT = path.join(BUILD, "candidate.pptx");

process.env.RUNTIME_NODE_MODULES ??= RUNTIME_NODE_MODULES;
await Promise.all([
  fs.mkdir(BUILD, { recursive: true }),
  fs.mkdir(FINALIZER, { recursive: true }),
  fs.mkdir(path.dirname(OUTPUT), { recursive: true }),
]);

const { importRuntimeModule } = await import(pathToFileURL(path.join(SKILL_DIR, "container_tools/runtime_helpers.mjs")).href);
const { PresentationFile, FileBlob } = await importRuntimeModule("@oai/artifact-tool");
const presentation = await PresentationFile.importPptx(await FileBlob.load(TEMPLATE));

const INTER = "Inter";
const BG = "#002615";
const LIME = "#BCEF59";
const WHITE = "#FFFFFF";
const MUTED = "#284638";
const SOFT = "#DDE9E2";
const RED = "#FF8C7A";

function byName(slide, name, occurrence = 0) {
  const matches = slide.shapes.items.filter((shape) => shape.name === name);
  if (!matches[occurrence]) throw new Error(`Missing shape ${name}[${occurrence}]`);
  return matches[occurrence];
}

function setText(shape, value, style = {}) {
  shape.text = value;
  shape.text.style = {
    typeface: INTER,
    autoFit: "shrinkText",
    ...style,
  };
}

function setTitle(slide, value) {
  const title = slide.shapes.items.find((shape) => shape.placeholder?.type === "title")
    ?? slide.shapes.items.find((shape) => /Title|533/.test(shape.name));
  if (!title) throw new Error("Missing slide title");
  setText(title, value, { color: WHITE, fontSize: 38, bold: false, verticalAlignment: "top" });
}

function setRich(shape, title, body, { titlePt = 20, bodyPt = 13, titleColor = LIME, bodyColor = WHITE } = {}) {
  shape.text.set([
    [{ run: title, textStyle: { typeface: INTER, bold: true, fontSize: `${titlePt}pt`, color: titleColor } }],
    [{ run: body, textStyle: { typeface: INTER, fontSize: `${bodyPt}pt`, color: bodyColor } }],
  ]);
  shape.text.style = {
    typeface: INTER,
    autoFit: "shrinkText",
    verticalAlignment: "top",
    insets: { top: 2, right: 3, bottom: 2, left: 0 },
  };
}

async function addImage(slide, filename, position, alt, options = {}) {
  const blob = await fs.readFile(path.join(SHOTS, filename));
  return slide.images.add({
    blob,
    contentType: "image/png",
    alt,
    fit: options.fit ?? "cover",
    position,
    geometry: "roundRect",
    borderRadius: "rounded-xl",
    ...(options.crop ? { crop: options.crop } : {}),
  });
}

function setTable(table, values) {
  values.forEach((row, r) => row.forEach((value, c) => table.cells.set(r, c, value)));
}

function mainNote(slide, duration, arabic, transition, demo, fallback, sources) {
  slide.speakerNotes.textFrame.setText([
    arabic,
    `المدة: ${duration}`,
    `الانتقال: ${transition}`,
    `العرض: ${demo}`,
    `الخطة البديلة: ${fallback}`,
    "[Sources]",
    ...sources,
  ].join("\n\n"));
}

function appendixNote(slide, sources) {
  slide.speakerNotes.textFrame.setText(["ملحق للأسئلة والتفاصيل.", "[Sources]", ...sources].join("\n\n"));
}

const base = presentation.slides.items.slice(0, 12);
const appendix = [
  base[1].duplicate(),
  base[2].duplicate(),
  base[6].duplicate(),
  base[5].duplicate(),
  base[1].duplicate(),
  base[1].duplicate(),
  base[7].duplicate(),
  base[4].duplicate(),
  base[3].duplicate(),
  base[2].duplicate(),
];
// duplicate() inserts beside its source. Move each clone to the end so the
// original 12-slide pitch stays intact and the appendix follows in order.
appendix.forEach((slide) => slide.moveTo(presentation.slides.items.length - 1));

// 1 — cover
{
  const s = base[0];
  setText(byName(s, "Title 3"), "Resuto\nIMPACT X Pitch", { color: LIME, fontSize: 70, alignment: "center", verticalAlignment: "middle" });
  setText(byName(s, "Subtitle 4"), "A connected operating system for independent restaurants", { color: WHITE, fontSize: 26, alignment: "center" });
  setText(byName(s, "Rounded Rectangle 2"), "5:40 MAIN PITCH · EGYPT PILOT", { color: WHITE, fontSize: 15, bold: true, alignment: "center", verticalAlignment: "middle" });
  mainNote(s, "15 ثانية", "ريزوتو يربط رحلة المطعم من أول حجز حتى إغلاق الزيارة. أمامكم منتج يعمل اليوم، وسنفصل بوضوح بين ما أثبتناه في الـMVP وما يحتاج إلى Pilot قبل البيع التجاري.", "نبدأ بنقطة الانقطاع داخل الخدمة.", "ابدأ من العرض فقط.", "هذه الشريحة لا تعتمد على الشبكة.", ["Repository landing page", "IMPACT X Judging Criteria.pdf, pp. 1-3"]);
}

// 2 — problem table
{
  const s = base[1];
  setTitle(s, "Where restaurant service breaks");
  setTable(s.tables.items[0], [
    ["01", "Reservation", "Manual confirmation"],
    ["02", "Table", "Identity and floor status"],
    ["03", "Order", "Repeated entry"],
    ["04", "Kitchen", "Status separated from guests"],
    ["05", "Payment", "Settlement and closeout"],
    ["06", "Result", "No single operating record"],
  ]);
  mainNote(s, "25 ثانية", "المشكلة تظهر عند انتقال المسؤولية بين الحجز والطاولة والطلب والمطبخ والدفع. كل انتقال يضيف إعادة إدخال أو تأخيرًا أو خطأً يصعب قياسه. لا ندّعي مقابلات لم تحدث، لذلك يبدأ الـPilot بقياس الواقع.", "الحل يبدأ بملف تشغيلي واحد.", "أشر إلى الصفوف بسرعة.", "اقرأ صف النتيجة فقط إذا ضاق الوقت.", ["resuto-impact-x-judging-pack-ar.pdf, pp. 4 and 9", "Repository boundaries"]);
}

// 3 — first customer and live product
{
  const s = base[2];
  setTitle(s, "First customer: independent restaurants in Egypt");
  setRich(byName(s, "Google Shape;534;p58", 0), "Who we serve", "Independent restaurants and small groups that need Arabic support without enterprise overhead.", { titlePt: 20, bodyPt: 13 });
  setRich(byName(s, "Google Shape;534;p58", 1), "What they buy", "One operating record across reservations, tables, orders, kitchen status and settlement.", { titlePt: 20, bodyPt: 13 });
  const image = s.images.items[0];
  image.replace({ blob: await fs.readFile(path.join(SHOTS, "01-resuto-landing-desktop.png")), contentType: "image/png", alt: "Current Resuto landing and floor workspace" });
  image.fit = "cover";
  image.crop = { left: 0.20, top: 0.02, right: 0.02, bottom: 0.02 };
  mainNote(s, "20 ثانية", "العميل الأول هو مطعم مستقل أو مجموعة صغيرة في مصر. القيمة ليست عدد الشاشات، بل أن كل شاشة تقرأ من نفس الحالة التشغيلية. الصورة من النسخة الحالية وليست Mockup.", "الآن نتبع الحالة نفسها خلال الخدمة.", "أشر إلى مساحة التشغيل في الصورة.", "الصورة محفوظة داخل العرض.", ["Current local landing capture, 2026-09-10", "README.md"]);
}

// 4 — connected state
{
  const s = base[3];
  setTitle(s, "One operating state follows the guest through service");
  const bodies = s.shapes.items.filter((shape) => ["Google Shape;534;p58", "Content Placeholder 1", "Content Placeholder 2"].includes(shape.name));
  const supers = s.shapes.items.filter((shape) => shape.name === "Content Placeholder 15");
  ["01", "02", "03"].forEach((value, i) => setText(supers[i], value, { color: LIME, fontSize: 13, bold: true }));
  setRich(bodies[0], "Reserve and seat", "A table chosen in the floor plan becomes the guest’s service identity.", { titlePt: 18, bodyPt: 13, titleColor: WHITE });
  setRich(bodies[2], "Order and prepare", "Server prices and guarded order states keep the guest and kitchen aligned.", { titlePt: 18, bodyPt: 13, titleColor: WHITE });
  setRich(bodies[1], "Settle and close", "Split settlement stays separate from food fulfillment. The visit closes only after both complete.", { titlePt: 18, bodyPt: 13, titleColor: WHITE });
  mainNote(s, "20 ثانية", "نفس الحالة التشغيلية تتبع الضيف من اختيار الطاولة حتى إغلاق الزيارة. السعر والمخزون يتحققان على الخادم. انتقالات المطبخ محكومة، والدفع لا يغيّر حالة الطعام تلقائيًا.", "نثبت ذلك من أربع واجهات حقيقية.", "اتبع الأرقام الثلاثة.", "المسار كامل على الشريحة.", ["server.js", "platform-domain.js", "floor-domain.js"]);
}

// 5 — product proof with four fresh captures
{
  const s = base[4];
  setTitle(s, "Working product proof");
  const cells = [
    byName(s, "Content Placeholder 9", 0),
    byName(s, "Content Placeholder 10", 0),
    byName(s, "Content Placeholder 9", 1),
    byName(s, "Content Placeholder 10", 1),
  ];
  const frames = [
    { left: 225, top: 213, width: 397, height: 172 },
    { left: 840, top: 213, width: 398, height: 172 },
    { left: 225, top: 422, width: 397, height: 172 },
    { left: 840, top: 422, width: 398, height: 172 },
  ];
  cells.forEach((shape, i) => { shape.position = frames[i]; });
  setRich(cells[0], "Exact table", "Reservation choice writes the table identity used by service.", { titlePt: 18, bodyPt: 12 });
  setRich(cells[1], "Readable menu", "English and Arabic share the same live catalog and prices.", { titlePt: 18, bodyPt: 12 });
  setRich(cells[2], "Confirmed order", "Synthetic order #001 reached the kitchen at EGP 135.", { titlePt: 18, bodyPt: 12 });
  setRich(cells[3], "Guarded kitchen", "The order moved from received to preparing and ready.", { titlePt: 18, bodyPt: 12 });
  await addImage(s, "06-reservation-selected-mobile.png", { left: 41, top: 213, width: 160, height: 150 }, "Selected reservation table", { crop: { left: 0, top: 0.12, right: 0, bottom: 0.38 } });
  await addImage(s, "07-menu-mobile.png", { left: 656, top: 213, width: 160, height: 150 }, "Guest menu", { crop: { left: 0, top: 0.04, right: 0, bottom: 0.52 } });
  await addImage(s, "18-order-confirmation-mobile.png", { left: 41, top: 422, width: 160, height: 150 }, "Order confirmation number 001", { crop: { left: 0, top: 0.20, right: 0, bottom: 0.30 } });
  await addImage(s, "21-kitchen-ready-desktop.png", { left: 656, top: 422, width: 160, height: 150 }, "Kitchen order ready", { crop: { left: 0.15, top: 0.14, right: 0.37, bottom: 0.35 } });
  mainNote(s, "45 ثانية", "هذه أربع لقطات من نفس المنتج. الضيف اختار طاولة حقيقية، فتح القائمة، ثم أنشأنا طلبًا تجريبيًا رقم 001 بقيمة 135 جنيهًا. ظهر الطلب في شاشة المطبخ وانتقل حتى Ready. الدفع بقي Test mode ولم ننفذ شحنة حقيقية.", "Gemini يعمل داخل هذه الرحلة.", "اعرض لقطة الطلب وشاشة Ready فقط.", "كل اللقطات محفوظة داخل العرض.", ["Fresh browser captures dated 2026-09-10", "npm tests for transitions and payment isolation"]);
}

// 6 — Gemini with large embedded proof
{
  const s = base[5];
  setTitle(s, "Gemini inside reviewed workflows");
  setText(byName(s, "Google Shape;534;p58"), "Drafts decisions.\nPeople approve the action.", { color: WHITE, fontSize: 31, verticalAlignment: "top" });
  setText(byName(s, "TextBox 11"), "Guest recommendations use current menu IDs, stock, budget and exclusions. Manager extraction treats uploaded text or images as untrusted source data. Neither path publishes automatically.", { color: WHITE, fontSize: 20, verticalAlignment: "top" });
  setText(byName(s, "Content Placeholder 10", 0), "");
  setText(byName(s, "Content Placeholder 10", 1), "");
  await addImage(s, "09-live-gemini-recommendation-mobile.png", { left: 670, top: 190, width: 555, height: 150 }, "Live Gemini guest recommendation under EGP 700", { crop: { left: 0, top: 0.20, right: 0, bottom: 0.46 } });
  await addImage(s, "13-live-gemini-menu-draft-desktop.png", { left: 670, top: 402, width: 555, height: 150 }, "Live Gemini manager menu draft", { crop: { left: 0.10, top: 0.15, right: 0.06, bottom: 0.18 } });
  mainNote(s, "35 ثانية", "Gemini يضيف قيمة في نقطتين. للضيف، يختار من القائمة الحالية ويلتزم بالميزانية والمخزون. وللمدير، يحول النص أو الصورة إلى Draft منظم. اختبرنا الحالتين Live اليوم. كل نتيجة تمر بتحقق ثم مراجعة بشرية، وعند تعطل المزود يظهر fallback واضح.", "البنية التقنية تفصل الذكاء عن القرار التشغيلي.", "أشر إلى 685 جنيه وعبارة Nothing has been published.", "اعرض اللقطتين فقط إذا تعطل المزود.", ["gemini-provider.js", "ai-service.js", "ai-imports.js", "Live runtime check, 2026-09-10"]);
}

// 7 — architecture
{
  const s = base[6];
  setTitle(s, "Technical architecture and launch boundaries");
  setText(byName(s, "Google Shape;534;p58"), "One domain model\nTwo storage paths", { color: WHITE, fontSize: 29, verticalAlignment: "top" });
  const labels = s.shapes.items.filter((shape) => shape.name === "Content Placeholder 10");
  const limeLabels = [labels[1], labels[3], labels[5], labels[7]];
  const whiteBodies = [labels[0], labels[2], labels[4], labels[6]];
  const items = [
    ["Local runtime", "Node.js and SQLite support the current single-installation demo."],
    ["Hosted tenant mode", "Firebase Authentication selects a membership. Firestore stores one private state document per restaurant."],
    ["AI boundary", "Gemini output must match a structured schema and known restaurant records."],
    ["Payment boundary", "Stripe and Paymob adapters exist. Live merchant acceptance remains gated."],
  ];
  items.forEach((item, i) => {
    setText(limeLabels[i], item[0], { color: LIME, fontSize: 17, bold: true });
    setText(whiteBodies[i], item[1], { color: WHITE, fontSize: 15, verticalAlignment: "top" });
  });
  mainNote(s, "25 ثانية", "محليًا نستخدم SQLite داخل عملية Node واحدة. في Firebase Tenant Mode تتحقق الهوية ثم تختار العضوية مطعمًا واحدًا. الكود موجود، لكن اختبار العزل على Emulator كان Skipped اليوم، لذلك يبقى Gate قبل الإنتاج. الدفع الحي أيضًا يحتاج قبول تاجر.", "التقنية الآن تتحول إلى تجربة أثر.", "ركز على Local مقابل Hosted.", "لا حاجة إلى اتصال حي.", ["server.js", "firebase-platform.js", "docs/FIREBASE-SAAS.md", "npm test, 2026-09-10"]);
}

// 8 — impact timeline
{
  const s = base[7];
  setTitle(s, "Pilot design converts claims into evidence");
  const dates = s.shapes.items.filter((shape) => shape.name === "Content Placeholder 15");
  ["DAYS 1–7", "DAYS 8–23", "DAY 30"].forEach((value, i) => setText(dates[i], value, { color: LIME, fontSize: 14, bold: true }));
  const textBlocks = s.shapes.items.filter((shape) => shape.name === "Text Placeholder 16");
  setRich(textBlocks[1], "Baseline", "Record time, corrections, kitchen cycle, settlement and team adoption.", { titlePt: 19, bodyPt: 13, titleColor: WHITE });
  setRich(textBlocks[0], "Operate", "Route at least 80% of orders through Resuto and compare events with baseline.", { titlePt: 19, bodyPt: 13, titleColor: WHITE });
  setRich(textBlocks[2], "Decide", "Seek 10% improvement in two KPIs, team CSAT 4/5 and a purchase decision.", { titlePt: 19, bodyPt: 13, titleColor: WHITE });
  mainNote(s, "25 ثانية", "نأخذ سبعة أيام Baseline ثم 23 يوم تشغيل. نتابع خمسة مؤشرات من أحداث النظام. هدف التجربة أن تمر 80% من الطلبات عبر Resuto، وأن يتحسن مؤشّران على الأقل بنسبة 10%، مع رضا فريق 4 من 5. هذه أهداف وليست نتائج محققة.", "إذا تحقق الأثر، من يدفع؟", "اتبع الخط الزمني.", "الشريحة مستقلة عن الشبكة.", ["resuto-impact-x-judging-pack-ar.pdf, p. 18", "IMPACT X Judging Criteria.pdf, p. 2"]);
}

// 9 — business model
{
  const s = base[8];
  setTitle(s, "Egypt-first business model");
  setRich(byName(s, "Content Placeholder 15"), "Commercial entry", "The restaurant owner pays per branch. A 30-day pilot tests operational value and willingness to pay before expansion.", { titlePt: 18, bodyPt: 14, titleColor: WHITE });
  const stats = s.shapes.items.filter((shape) => shape.name === "Content Placeholder 9");
  const desc = [byName(s, "Content Placeholder 9", 0), byName(s, "Content Placeholder 10"), byName(s, "Content Placeholder 11")];
  setText(stats[1], "EGP 1,499", { color: LIME, fontSize: 54 });
  setText(stats[2], "30 days", { color: LIME, fontSize: 54 });
  setText(stats[3], "1 branch", { color: LIME, fontSize: 54 });
  setText(desc[0], "Growth package before tax", { color: WHITE, fontSize: 18 });
  setText(desc[1], "Pilot with no setup fee", { color: WHITE, fontSize: 18 });
  setText(desc[2], "Subscription unit of sale", { color: WHITE, fontSize: 18 });
  mainNote(s, "30 ثانية", "في مصر نبدأ بباقة Growth بسعر مقترح 1499 جنيه للفرع شهريًا قبل الضريبة. المشتري هو المالك أو المشغل. نستخدم Pilot بدون رسوم إعداد لاختبار الاستعداد للدفع. السعودية مرحلة تالية مشروطة بالامتثال والدفع المحلي.", "نختبر قيمة الاشتراك بمعادلة واضحة.", "اعرض السعر والوحدة فقط.", "جدول الأسعار الكامل في الملحق.", ["resuto-impact-x-judging-pack-ar.pdf, pp. 10-11 and 14", "Current pricing page"]);
}

// 10 — ROI horizontal evidence bars
{
  const s = base[9];
  setTitle(s, "What drives the modeled 240% ROI");
  setTable(s.tables.items[0], [["EGP 0", "1,500", "3,000", "4,500", "6,000"]]);
  const bars = [
    byName(s, "Google Shape;969;p80"),
    byName(s, "Google Shape;966;p80"),
    byName(s, "Google Shape;963;p80"),
    byName(s, "Google Shape;955;p80"),
    byName(s, "Google Shape;960;p80"),
    byName(s, "Google Shape;957;p80"),
  ];
  const values = [
    ["Admin time  EGP 1,500", 275],
    ["Avoided error or waste  EGP 2,400", 440],
    ["Incremental contribution  EGP 1,200", 220],
    ["Total benefit  EGP 5,100", 935],
    ["Subscription  EGP 1,499", 275],
    ["Net benefit  EGP 3,601", 660],
  ];
  const ys = [207, 283, 357, 431, 499, 575];
  bars.forEach((shape, i) => {
    shape.position = { left: 61, top: ys[i], width: values[i][1], height: 54 };
    setText(shape, values[i][0], { fontSize: 16, bold: true, verticalAlignment: "middle" });
  });
  mainNote(s, "25 ثانية", "هذا مثال حسابي وليس توفيرًا محققًا. الاشتراك 1499 جنيه، والمنفعة الشهرية المفترضة 5100، فينتج صافي 3601 وعائد 240%. سنقيس كل بند في الـPilot ونستبعد أي منفعة لا ترتبط بتغيير تشغيلي واضح.", "المعادلة تصبح خطة تنفيذ.", "اقرأ Total benefit ثم Subscription ثم Net benefit.", "الافتراضات التفصيلية في الملحق.", ["resuto-impact-x-judging-pack-ar.pdf, pp. 12-13", "Recalculated ROI: 240.23%"]);
}

// 11 — 90 day plan
{
  const s = base[10];
  setTitle(s, "90-day path to a sellable service");
  const table = s.tables.items[0];
  setTable(table, [
    ["NOW", "0–30 DAYS", "31–60 DAYS", "61–90 DAYS", "GATE"],
    ["Working MVP", "Egypt pilot", "Firebase", "Hardening", "Saudi"],
    ["", "", "", "", ""],
    ["", "", "", "", ""],
    ["", "", "", "", ""],
  ]);
  const pills = s.shapes.items.filter((shape) => shape.name === "Google Shape;969;p80");
  const plan = [
    ["Build passes", { left: 56, top: 171, width: 210, height: 36 }],
    ["76 tests pass", { left: 56, top: 214, width: 210, height: 36 }],
    ["3 restaurants", { left: 296, top: 300, width: 210, height: 36 }],
    ["Measured ROI", { left: 296, top: 346, width: 210, height: 36 }],
    ["Tenant isolation", { left: 535, top: 445, width: 210, height: 36 }],
    ["Billing + monitoring", { left: 775, top: 525, width: 210, height: 36 }],
  ];
  pills.forEach((shape, i) => { shape.position = plan[i][1]; setText(shape, plan[i][0], { fontSize: 13, bold: true, alignment: "center", verticalAlignment: "middle" }); });
  mainNote(s, "35 ثانية", "منذ كتابة الملف تقدّم المشروع: البناء ينجح، 76 اختبارًا نجح، وتجربتا Gemini الحيتان عملتا. الخطوة التالية Pilot في مصر ثم اختبار عزل Firebase والفوترة والمراقبة. السعودية تأتي بعد مراجعة ضريبية وتكامل ZATCA وقبول دفع محلي.", "الطلب النهائي محدد وقابل للتنفيذ.", "اتبع الأعمدة من اليسار إلى اليمين.", "لا تفتح الملحق إلا عند سؤال محدد.", ["Current build and tests, 2026-09-10", "judging pack, pp. 15-17 and 21"]);
}

// 12 — ask
{
  const s = base[11];
  setText(byName(s, "Title 3"), "Three restaurants\nThirty days", { color: LIME, fontSize: 70, alignment: "center", verticalAlignment: "middle" });
  setText(byName(s, "Subtitle 4"), "Baseline, adoption, ROI, purchase decision", { color: WHITE, fontSize: 27, alignment: "center" });
  setText(byName(s, "Rounded Rectangle 2"), "THE ASK", { color: WHITE, fontSize: 15, bold: true, alignment: "center", verticalAlignment: "middle" });
  mainNote(s, "15 ثانية", "طلبنا من لجنة IMPACT X هو دعم تجربة لمدة 30 يومًا مع ثلاثة مطاعم في مصر. نبدأ بخط أساس، نقيس التبني والأثر والعائد، وننتهي بقرار شراء واضح. ريزوتو يعمل اليوم، والـPilot سيحدد إن كان يستحق أن يصبح خدمة مستدامة. شكرًا.", "توقف وانتظر الأسئلة.", "لا تفتح أي رابط بعد الخاتمة إلا بطلب الحكم.", "كل الأدلة في الملحق.", ["resuto-impact-x-judging-pack-ar.pdf, pp. 18-19 and 22", "Main timing: 340 seconds"]);
}

// 13 — feature truth table
{
  const s = appendix[0];
  setTitle(s, "APPENDIX / Feature truth table");
  setTable(s.tables.items[0], [
    ["AREA", "WORKING NOW", "PRODUCTION GATE"],
    ["Guest", "Reserve, seat, QR menu, Arabic", "Device and accessibility audit"],
    ["Kitchen", "Guarded transitions, live polling", "Offline queue and printing"],
    ["Manager", "Floor, menu, stock, exports", "Monitoring and recovery"],
    ["Payments", "Test ledger and adapters", "Merchant acceptance and refunds"],
    ["Tenant", "Firebase membership and state code", "Emulator isolation pass"],
  ]);
  appendixNote(s, ["Repository review", "Fresh browser captures", "npm test, 2026-09-10"]);
}

// 14 — Arabic and themes
{
  const s = appendix[1];
  setTitle(s, "APPENDIX / Arabic and restaurant themes");
  setRich(byName(s, "Google Shape;534;p58", 0), "Platform", "Resuto stays the product brand across every restaurant workspace.", { titlePt: 20, bodyPt: 13 });
  setRich(byName(s, "Google Shape;534;p58", 1), "Presentation", "Each restaurant can express its own service model while the operating core stays shared.", { titlePt: 20, bodyPt: 13 });
  const image = s.images.items[0];
  image.replace({ blob: await fs.readFile(path.join(SHOTS, "22-arabic-menu-rtl-mobile.png")), contentType: "image/png", alt: "Arabic right-to-left Resuto menu" });
  image.fit = "contain";
  appendixNote(s, ["Arabic RTL capture, 2026-09-10", "The Olive Room and Smash & Co are fictional demo restaurants"]);
}

// 15 — tenant isolation detail
{
  const s = appendix[2];
  setTitle(s, "APPENDIX / Authentication and tenant isolation");
  setText(byName(s, "Google Shape;534;p58"), "Hosted path\nImplemented in code", { color: WHITE, fontSize: 29 });
  const labels = s.shapes.items.filter((shape) => shape.name === "Content Placeholder 10");
  const limeLabels = [labels[1], labels[3], labels[5], labels[7]];
  const whiteBodies = [labels[0], labels[2], labels[4], labels[6]];
  const items = [
    ["Authentication", "Opaque staff cookie locally. Firebase ID token in hosted mode."],
    ["Restaurant selection", "Membership selects exactly one restaurant before state access."],
    ["Operational state", "Firestore rules deny direct client access to private state."],
    ["Release gate", "Run emulator isolation, backup and incident-response rehearsals."],
  ];
  items.forEach((item, i) => { setText(limeLabels[i], item[0], { color: LIME, fontSize: 17, bold: true }); setText(whiteBodies[i], item[1], { color: WHITE, fontSize: 15 }); });
  appendixNote(s, ["firebase-platform.js", "firestore.rules", "docs/FIREBASE-SAAS.md"]);
}

// 16 — Gemini controls
{
  const s = appendix[3];
  setTitle(s, "APPENDIX / Gemini controls and fallback");
  setText(byName(s, "Google Shape;534;p58"), "Bounded output.\nHuman action.", { color: WHITE, fontSize: 31 });
  setText(byName(s, "TextBox 11"), "The guest path validates known menu IDs, stock, quantity and total. The manager path validates schema, confidence and missing fields. Provider failure returns labeled demo rules or a clear error.", { color: WHITE, fontSize: 19 });
  setText(byName(s, "Content Placeholder 10", 0), "");
  setText(byName(s, "Content Placeholder 10", 1), "");
  await addImage(s, "08-ai-assistant-mobile.png", { left: 670, top: 190, width: 555, height: 150 }, "Guest AI assistant before response", { crop: { left: 0, top: 0.15, right: 0, bottom: 0.48 } });
  await addImage(s, "12-ai-import-ready-desktop.png", { left: 670, top: 402, width: 555, height: 150 }, "Manager AI import ready state", { crop: { left: 0.08, top: 0.10, right: 0.05, bottom: 0.25 } });
  appendixNote(s, ["gemini-provider.js", "ai-service.js", "ai-imports.js"]);
}

// 17 — pricing
{
  const s = appendix[4];
  setTitle(s, "APPENDIX / Proposed pricing by market");
  setTable(s.tables.items[0], [
    ["PACKAGE", "EGYPT BEFORE TAX", "SAUDI TARGET"],
    ["Starter", "EGP 799", "SAR 199"],
    ["Growth", "EGP 1,499", "SAR 399"],
    ["Pro", "EGP 2,999", "SAR 699"],
    ["Founder offer", "30-day pilot, no setup fee", "SAR 149 / 299 / 499"],
    ["Gate", "Validate willingness to pay", "Tax, ZATCA, local payments"],
  ]);
  appendixNote(s, ["resuto-impact-x-judging-pack-ar.pdf, pp. 10-11", "Pack dated 2026-09-09"]);
}

// 18 — ROI assumptions
{
  const s = appendix[5];
  setTitle(s, "APPENDIX / Egypt Growth ROI assumptions");
  setTable(s.tables.items[0], [
    ["COMPONENT", "ILLUSTRATIVE CALCULATION", "MONTHLY VALUE"],
    ["Admin time", "20 hours × EGP 75", "EGP 1,500"],
    ["Avoided error or waste", "0.4% × EGP 600k sales", "EGP 2,400"],
    ["Contribution", "8 checks × EGP 500 × 30%", "EGP 1,200"],
    ["Total benefit", "Sum of components", "EGP 5,100"],
    ["Net benefit and ROI", "5,100 − 1,499", "EGP 3,601 / 240.2%"],
  ]);
  appendixNote(s, ["resuto-impact-x-judging-pack-ar.pdf, pp. 12-13", "ROI recalculated as 240.23%"]);
}

// 19 — pilot metrics
{
  const s = appendix[6];
  setTitle(s, "APPENDIX / Pilot measurement");
  const dates = s.shapes.items.filter((shape) => shape.name === "Content Placeholder 15");
  ["BASELINE", "OPERATE", "DECIDE"].forEach((value, i) => setText(dates[i], value, { color: LIME, fontSize: 14, bold: true }));
  const blocks = s.shapes.items.filter((shape) => shape.name === "Text Placeholder 16");
  setRich(blocks[1], "Five KPIs", "Activation, order accuracy, kitchen cycle, settlement and team adoption.", { titlePt: 18, bodyPt: 13, titleColor: WHITE });
  setRich(blocks[0], "Thresholds", "80% adoption, 10% improvement in two KPIs and team CSAT 4/5.", { titlePt: 18, bodyPt: 13, titleColor: WHITE });
  setRich(blocks[2], "Commercial outcome", "One paid conversion, two extensions or letters of intent, and documented pricing objections.", { titlePt: 18, bodyPt: 13, titleColor: WHITE });
  appendixNote(s, ["resuto-impact-x-judging-pack-ar.pdf, p. 18", "Repository event names"]);
}

// 20 — risk register
{
  const s = appendix[7];
  setTitle(s, "APPENDIX / Production readiness register");
  const cells = [
    byName(s, "Content Placeholder 9", 0),
    byName(s, "Content Placeholder 10", 0),
    byName(s, "Content Placeholder 9", 1),
    byName(s, "Content Placeholder 10", 1),
  ];
  setRich(cells[0], "CRITICAL / Tenant isolation", "Run Firebase emulator suite and authorization matrix before pilot accounts.", { titlePt: 18, bodyPt: 13, titleColor: RED });
  setRich(cells[1], "HIGH / Live payments", "Complete merchant sandbox, settlement and refund acceptance before live money.", { titlePt: 18, bodyPt: 13, titleColor: RED });
  setRich(cells[2], "HIGH / Recovery", "Add logs, alerts, backup and incident runbook before production.", { titlePt: 18, bodyPt: 13, titleColor: RED });
  setRich(cells[3], "HIGH / Saudi launch", "Complete tax review, ZATCA integration and local payment acceptance.", { titlePt: 18, bodyPt: 13, titleColor: RED });
  appendixNote(s, ["Repository review", "docs/FIREBASE-SAAS.md", "Judging pack roadmap"]);
}

// 21 — Q&A
{
  const s = appendix[8];
  setTitle(s, "APPENDIX / Likely judging questions");
  const bodies = s.shapes.items.filter((shape) => ["Google Shape;534;p58", "Content Placeholder 1", "Content Placeholder 2"].includes(shape.name));
  const supers = s.shapes.items.filter((shape) => shape.name === "Content Placeholder 15");
  ["POS", "ROI", "SAUDI"].forEach((value, i) => setText(supers[i], value, { color: LIME, fontSize: 13, bold: true }));
  setRich(bodies[0], "What is different?", "Resuto connects the guest journey and operating state. It does not claim to replace every production POS today.", { titlePt: 17, bodyPt: 12, titleColor: WHITE });
  setRich(bodies[2], "Is ROI proven?", "No. The model provides measurable assumptions. The pilot replaces them with observed data.", { titlePt: 17, bodyPt: 12, titleColor: WHITE });
  setRich(bodies[1], "Can you operate in Saudi Arabia?", "Only after local tax review, ZATCA integration and payment acceptance.", { titlePt: 17, bodyPt: 12, titleColor: WHITE });
  appendixNote(s, ["Evidence_Coverage.md", "Judging pack", "Current repository boundaries"]);
}

// 22 — evidence trail
{
  const s = appendix[9];
  setTitle(s, "APPENDIX / Evidence trail");
  setRich(byName(s, "Google Shape;534;p58", 0), "Primary sources", "Two supplied judging PDFs define scoring, pricing, ROI assumptions and pilot thresholds.", { titlePt: 20, bodyPt: 13 });
  setRich(byName(s, "Google Shape;534;p58", 1), "Current verification", "Repository files, 76 passing tests and fresh browser captures define what works and what remains gated.", { titlePt: 20, bodyPt: 13 });
  const image = s.images.items[0];
  image.replace({ blob: await fs.readFile(path.join(SHOTS, "10-manager-overview-desktop.png")), contentType: "image/png", alt: "Current Resuto manager overview" });
  image.fit = "cover";
  image.crop = { left: 0.02, top: 0.03, right: 0.02, bottom: 0.03 };
  appendixNote(s, ["IMPACT X Judging Criteria.pdf", "resuto-impact-x-judging-pack-ar.pdf", "Current repository", "Fresh browser captures, 2026-09-10"]);
}

await fs.rm(OUTPUT, { force: true });
await fs.rm(RECEIPT, { force: true });
await (await PresentationFile.exportPptx(presentation)).save(DRAFT);

const { finalizePresentation } = await import(pathToFileURL(path.join(SKILL_DIR, "container_tools/artifact_tool_utils.mjs")).href);
const result = await finalizePresentation({
  explicitTotalSlideCount: 22,
  requiredNativeTableOwnerSlides: [2, 10, 11, 13, 17, 18],
  requiredNativeChartOwnerSlides: [],
  workspaceDir: ROOT,
  candidatePath: DRAFT,
  finalPath: OUTPUT,
  pythonExecutable: RUNTIME_PYTHON,
  integrityValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs: [
    "--expected-slide-size-emu", "12192000,6858000",
    "--validate-bullet-geometry",
    "--validate-heading-fit",
    "--require-native-table-slide", "2",
    "--require-native-table-slide", "10",
    "--require-native-table-slide", "11",
    "--require-native-table-slide", "13",
    "--require-native-table-slide", "17",
    "--require-native-table-slide", "18",
  ],
  fontPolicy: {
    basis: "reference",
    families: [INTER, "Helvetica Neue"],
    referencePath: TEMPLATE,
    referenceSha256: "b1b15cb0c23ad524f9832749ec31b775719bae2bdba897de9c9d8556ca00a44c",
  },
  verifyArtifactToolImport: true,
  receiptPath: RECEIPT,
});

console.log(JSON.stringify({ output: OUTPUT, slides: presentation.slides.items.length, result }, null, 2));
