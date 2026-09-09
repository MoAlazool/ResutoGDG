import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const workspaceDir = "/Users/tank/Downloads/Resuto-main";
const SKILL_DIR = "/Users/tank/.codex/plugins/cache/openai-primary-runtime/presentations/26.905.11957/skills/presentations";
const TMP_DIR = path.join(workspaceDir, ".codex-build/resuto-deck");
const FINAL_PPTX = path.join(workspaceDir, "output/presentations/Resuto_IMPACT_X_Arabic_Pitch.pptx");
const RUNTIME_PYTHON = "/Users/tank/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const { resolvePresentationFont, finalizePresentation } = await import(pathToFileURL(path.join(SKILL_DIR, "container_tools/artifact_tool_utils.mjs")).href);

const C = { ink: "#17231F", olive: "#445D45", sage: "#A7B69B", cream: "#F5F1E7", sand: "#E6D8C4", orange: "#E8763C", white: "#FFFFFF", muted: "#66736A", teal: "#2F7667", red: "#B94E4E" };
const font = resolvePresentationFont({ fontFamily: "Cairo" });
const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });

const pos = (left, top, width, height) => ({ left, top, width, height });
function box(slide, text, left, top, width, height, opts = {}) {
  const s = slide.shapes.add({ geometry: "textbox", position: pos(left, top, width, height), fill: "none", line: { fill: "none", width: 0 } });
  s.text = text;
  s.text.style = { typeface: font, fontSize: opts.size ?? 23, bold: opts.bold ?? false, color: opts.color ?? C.ink, alignment: opts.align ?? "right", verticalAlignment: opts.valign ?? "middle", autoFit: "shrink" };
  return s;
}
function rect(slide, left, top, width, height, fill, radius = 0) {
  return slide.shapes.add({ geometry: "rect", position: pos(left, top, width, height), fill, line: { fill: "none", width: 0 }, borderRadius: radius });
}
function img(slide, file, left, top, width, height, alt, fit = "cover") {
  return fs.readFile(path.join(workspaceDir, file)).then(bytes => slide.images.add({ blob: bytes, contentType: file.endsWith(".webp") ? "image/webp" : "image/png", alt, fit, position: pos(left, top, width, height), geometry: "roundRect", borderRadius: 18 }));
}
function base(slide, n, section = "RESUTO") {
  slide.background.fill = C.cream;
  rect(slide, 0, 0, 16, 720, C.orange);
  box(slide, section, 1030, 662, 180, 26, { size: 12, bold: true, color: C.olive, align: "right" });
  box(slide, String(n).padStart(2, "0"), 60, 662, 70, 26, { size: 12, bold: true, color: C.olive, align: "left" });
}
function title(slide, text, sub = "") { box(slide, text, 75, 55, 1130, 62, { size: 35, bold: true }); if (sub) box(slide, sub, 75, 116, 1130, 35, { size: 17, color: C.muted }); }
function note(slide, text) { slide.speakerNotes.textFrame.setText(text); }
function line(slide, x1, y1, x2, y2, color = C.sage, width = 2) { slide.shapes.add({ geometry: "line", position: { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }, line: { fill: color, width } }); }

// 1 Cover
{ const s = ppt.slides.add(); s.background.fill = C.ink; rect(s, 0, 0, 420, 720, C.olive); await img(s, "public/assets/olive-interior.png", 0, 0, 420, 720, "The Olive Room restaurant interior"); rect(s, 0, 0, 420, 720, "#17231F/38"); await img(s, "public/assets/resuto-arabic-logo.png", 865, 55, 260, 95, "Resuto logo", "contain"); box(s, "من الحجز إلى التحصيل\nرحلة مطعم واحدة قابلة للإدارة", 485, 242, 665, 160, { size: 43, bold: true, color: C.white }); box(s, "منصة تشغيل عربية للمطاعم الصغيرة والمتوسطة\nIMPACT X | مسار الأعمال والإنتاجية | SDG 8", 490, 426, 620, 75, { size: 21, color: "#D9E5D0" }); box(s, "عرض تحكيم | 6 دقائق", 490, 570, 300, 30, { size: 17, bold: true, color: C.sand }); note(s, "مصادر: ملفات المشروع وملف التحكيم العربي المرفق. افتتح بالقصة وليس بالخصائص."); }

// 2 problem
{ const s = ppt.slides.add(); base(s, 2, "المشكلة"); title(s, "تشغيل المطعم يتوزع بين أدوات لا تتحدث معًا", "النتيجة: إدخال مكرر، بطء في الخدمة، وأخطاء يصعب قياسها"); const xs=[110,390,670,950]; const labels=["حجز", "طاولة وQR", "طلب ومطبخ", "فاتورة ودفع"]; const details=["تأكيد يدوي\nوتضارب المواعيد", "حالة الضيف\nوالطاولة منفصلة", "الطلب يتغير\nبين الفريق والمطبخ", "تسويات كثيرة\nوغياب الرؤية"]; for(let i=0;i<4;i++){rect(s,xs[i],255,220,205,C.white,18); box(s,labels[i],xs[i]+20,280,180,42,{size:25,bold:true,color:C.olive,align:"center"}); line(s,xs[i]+35,336,xs[i]+185,336,C.orange,3); box(s,details[i],xs[i]+20,355,180,70,{size:17,color:C.muted,align:"center"}); if(i<3) box(s,"←",xs[i]+225,330,35,45,{size:28,bold:true,color:C.orange,align:"center"});} box(s,"العميل المستهدف: مطعم صغير أو متوسط يحتاج تشغيلًا موحدًا دون تعقيد مؤسسي",110,525,1040,48,{size:23,bold:true,color:C.ink,align:"center"}); note(s,"المعيار: تعريف المشكلة. لا ندعي أرقامًا ميدانية غير موثقة؛ سنجمع 3-5 مقابلات موثقة قبل التحكيم."); }

// 3 solution
{ const s = ppt.slides.add(); base(s, 3, "الحل"); title(s, "Resuto يربط رحلة الضيف وعمليات الفريق في نظام واحد", "واجهة عربية/إنجليزية، مع قرار المدير محفوظًا في كل خطوة حساسة"); await img(s,"docs/screenshots/experience-landing-1440.png",75,185,480,330,"Resuto guest landing page"); const items=["الحجز وتوصية الطاولة", "QR للطلب داخل المطعم", "KDS وحالات الطلب", "تقسيم الفاتورة والتحصيل", "إدارة القائمة والمخطط والبيانات"]; items.forEach((t,i)=>{rect(s,620,185+i*70,500,50,i===0?"#445D45":"#FFFFFF",14); box(s,t,645,194+i*70,440,32,{size:20,bold:i===0,color:i===0?C.white:C.ink});}); box(s,"قيمة المنتج: رحلة متصلة يمكن تشغيلها الآن وقياسها في Pilot",620,555,500,54,{size:21,bold:true,color:C.olive}); note(s,"المعيار: جودة الحل وتجربة المستخدم. اعرض رابطًا واحدًا حيًا للحجز ثم QR ثم الطلب ثم المطبخ ثم التقسيم."); }

// 4 journey
{ const s = ppt.slides.add(); base(s, 4, "التجربة"); title(s, "رحلة واحدة من الحجز حتى إغلاق الزيارة", "الـMVP يطبق انتقالات محمية ويمنع الإغلاق قبل تسوية الفاتورة وتنفيذ الطلب"); const xs=[95,285,475,665,855,1045]; const l=["يحجز", "يجلس", "يمسح QR", "يُرسل الطلب", "يسدد", "تُغلق الزيارة"]; const d=["موعد وطاولة", "تفعيل الزيارة", "قائمة وسلة", "المطبخ ينجز", "كامل أو مقسم", "تنظيف الطاولة"]; for(let i=0;i<6;i++){rect(s,xs[i],285,140,140,i===5?C.olive:C.white,70); box(s,String(i+1),xs[i],301,140,35,{size:20,bold:true,color:i===5?C.white:C.orange,align:"center"}); box(s,l[i],xs[i]+5,344,130,34,{size:18,bold:true,color:i===5?C.white:C.ink,align:"center"}); box(s,d[i],xs[i]+10,450,120,44,{size:15,color:C.muted,align:"center"}); if(i<5) line(s,xs[i]+140,355,xs[i]+188,355,C.orange,3);} box(s,"تدفقات مثبتة في الاختبارات: حجوزات، طلبات، حالات مطبخ، دفعات مقسمة، تنظيف، واستمرارية بعد إعادة التشغيل",120,565,1040,45,{size:19,bold:true,color:C.olive,align:"center"}); note(s,"المصدر: PROJECT_DOCUMENTATION.md وMVP_VERIFICATION.md. معيار UX والوظائف."); }

//5 technical
{ const s=ppt.slides.add(); base(s,5,"التقنية"); title(s,"تنفيذ تقني مناسب لمطعم واحد اليوم وقابل للتوسّع لاحقًا","بنية واضحة، معاملات كتابة، وحماية للتدفقات الحساسة"); const cols=[["الواجهة","Static web app\nعربية/إنجليزية\nGuest + Manager + Kitchen"],["الخادم","Node.js\nJSON API\nجلسات HTTP-only"],["البيانات","SQLite محليًا\nFirestore للاستضافة\nإصدار لكل تعديل"],["التكاملات","Stripe / Paymob\nFoodics / Odoo\nFirebase Hosting"]]; cols.forEach((a,i)=>{const x=75+i*290; rect(s,x,215,245,280,C.white,18); box(s,a[0],x+18,245,210,45,{size:24,bold:true,color:C.olive,align:"center"}); line(s,x+35,310,x+210,310,C.orange,3); box(s,a[1],x+25,335,195,105,{size:18,color:C.muted,align:"center"});}); box(s,"ضوابط مثبتة: idempotency للمدفوعات، أسعـار بنود غير قابلة للتغيير، تحقق مخزون، وحماية من التعارض في المخططات والقوائم",120,545,1040,58,{size:20,bold:true,color:C.ink,align:"center"}); note(s,"المصدر: PROJECT_DOCUMENTATION.md وMVP_VERIFICATION.md. لا تدّعِ جاهزية تشغيل متعدد المطاعم حاليًا."); }

//6 Google
{ const s=ppt.slides.add(); base(s,6,"Google Technology"); title(s,"Gemini مساعد داخل سير العمل، وليس chatbot منفصلًا","الذكاء الاصطناعي يسرّع التحضير ويعرض مسودة قابلة للمراجعة"); await img(s,"docs/screenshots/owner-ai/mock-ar-1440-manager-menu.png",75,195,485,320,"Arabic AI menu review screen"); const use=["استخراج قائمة من PDF أو صورة مع مراجعة قبل النشر", "اقتراحات للضيف ضمن المخزون والميزانية والقيود المصرّح بها", "ملخصات تشغيلية للمدير مبنية على حقائق النظام"]; use.forEach((t,i)=>{rect(s,635,205+i*94,490,72,C.white,16); box(s,t,660,215+i*94,440,51,{size:18,bold:true,color:C.ink});}); box(s,"الحوكمة: لا نشر تلقائي، نتائج منظمة ومتحققة، fallback واضح عند تعذر المزود",635,510,480,68,{size:19,bold:true,color:C.olive}); note(s,"Google Technology bonus: Gemini API يدعم استخراج القوائم والتوصيات والرؤى. في العرض الحالي نعرض تحققا مقلدًا وموسوما بوضوح؛ لم تُختبر مفاتيح Gemini الحية."); }

//7 impact
{ const s=ppt.slides.add(); base(s,7,"الأثر"); title(s,"الأثر المقترح يرتبط بـ SDG 8 ويُقاس قبل وبعد التجربة","نقيس الكفاءة التشغيلية بدل تقديم نتائج لم تُثبت بعد"); const metrics=[["وقت الوصول لأول طلب مكتمل","من إنشاء الحساب حتى أول عملية مكتملة"],["دقة الطلب","عدد الطلبات المصححة أو الملغاة"],["زمن دورة الطلب","من الإرسال إلى جاهزية المطبخ"],["اكتمال التحصيل","الزيارات المغلقة بعد تسوية صحيحة"],["رضا الفريق","CSAT أسبوعي ووقت التدريب"]]; metrics.forEach((m,i)=>{const x=90+(i%3)*365,y=205+Math.floor(i/3)*180; rect(s,x,y,330,130,C.white,18); box(s,m[0],x+20,y+22,290,35,{size:20,bold:true,color:C.olive,align:"center"}); box(s,m[1],x+24,y+68,282,42,{size:16,color:C.muted,align:"center"});}); box(s,"هدف Pilot: تحسن 10% على الأقل في مؤشرين لكل مطعم، مع مرور 80% من الطلبات عبر النظام",130,585,1010,48,{size:21,bold:true,color:C.ink,align:"center"}); note(s,"المصدر: ملف التحكيم العربي، قسم Pilot. الأهداف ليست نتائج فعلية."); }

//8 proof
{ const s=ppt.slides.add(); base(s,8,"الدليل"); title(s,"ما الذي أثبتناه حتى الآن؟","وظائف MVP اختبرناها آليًا وفي متصفح Chromium، مع حدود واضحة قبل التشغيل الحي"); const left=["48 اختبارًا آليًا ناجحًا", "رحلة QR مشتركة بلا PIN", "الطلب والمطبخ والتقسيم والتنظيف", "استيراد/تصدير مع مراجعة", "تحرير مخطط وصلاحيات تعارض"]; left.forEach((t,i)=>{box(s,"✓",110,210+i*60,34,34,{size:25,bold:true,color:C.teal,align:"center"}); box(s,t,158,210+i*60,400,34,{size:20,bold:true});}); rect(s,650,190,450,320,"#FBE8DD",20); box(s,"حدود صريحة قبل الإنتاج",690,220,370,40,{size:26,bold:true,color:C.red,align:"center"}); box(s,"لا توجد تجربة ميدانية أو معاملات حية أو اختبار Gemini بمفتاح حقيقي.\n\nلا نعرض المنصة كحل لإطلاق أموال حقيقية أو امتثال ضريبي مكتمل.",690,295,370,135,{size:20,bold:true,color:C.ink,align:"center"}); box(s,"هذه الشفافية تحمي مصداقية العرض وتحدد خطوة الـPilot التالية",680,470,390,52,{size:18,bold:true,color:C.olive,align:"center"}); note(s,"المصدر: MVP_VERIFICATION.md. هذه الشريحة مهمة للجدوى والاستمرارية ولا يجب حذفها."); }

//9 business
{ const s=ppt.slides.add(); base(s,9,"نموذج العمل"); title(s,"اشتراك شهري للفرع مع إضافات اختيارية","تسعير مبدئي يُختبر في Pilot، وليس ادعاء إيراد أو قبول سوق"); const rows=[["الأساس","حجز، طاولات، QR، طلب، KDS، فاتورة وتقسيم"],["إضافات","AI، رسائل، تكاملات، دعم متميز"],["البيع","زيارات ميدانية، محاسبون ومستشارو مطاعم، مورّدو POS، إحالات"],["المعادلة","هامش إجمالي × ARPA ÷ churn ثم مقارنة LTV/CAC عند توفر بيانات"]]; rows.forEach((r,i)=>{const y=190+i*90; rect(s,100,y,1040,66,i===3?"#E5ECDD":C.white,14); box(s,r[0],935,y+14,160,34,{size:21,bold:true,color:C.olive,align:"right"}); box(s,r[1],150,y+12,745,42,{size:18,bold:true,color:C.ink,align:"right"});}); box(s,"نقطة القرار: مطعم واحد مدفوع أو قابل للتحويل بعد التجربة، مع قياس activation والاحتفاظ",125,575,1010,45,{size:20,bold:true,color:C.ink,align:"center"}); note(s,"المصدر: ملف التحكيم العربي، نموذج العمل. لا نضع LTV أو churn مصطنعين قبل وجود بيانات."); }

//10 feasibility
{ const s=ppt.slides.add(); base(s,10,"الجدوى"); title(s,"خارطة 90 يومًا من Demo إلى Pilot ثم جاهزية السوق","كل مرحلة تنتهي بدليل أو قرار واضح"); const phases=[["0-7 أيام","تثبيت Demo","3 مقابلات، فيديو احتياطي، اختبار كامل"],["8-30 يومًا","Pilot مصر","3 مطاعم، baseline، تدريب، لوحة أثر"],["31-60 يومًا","جاهزية تشغيل","RBAC، tenant isolation، مراقبة ونسخ احتياطي"],["61-90 يومًا","بوابة السعودية","VAT، شريك امتثال، ZATCA، الدفع المحلي"]]; phases.forEach((p,i)=>{const x=85+i*285; rect(s,x,220,245,285,i===1?"#445D45":C.white,20); box(s,p[0],x+20,250,205,34,{size:20,bold:true,color:i===1?C.sand:C.orange,align:"center"}); box(s,p[1],x+16,310,212,42,{size:24,bold:true,color:i===1?C.white:C.olive,align:"center"}); line(s,x+40,370,x+205,370,i===1?C.sand:C.orange,3); box(s,p[2],x+25,395,195,70,{size:16,bold:true,color:i===1?C.white:C.muted,align:"center"});}); note(s,"المصدر: ملف التحكيم العربي، الجدوى والتنفيذ. اذكر أن الامتثال والإنتاج بوابتان قبل الإطلاق التجاري."); }

//11 continuity risks
{ const s=ppt.slides.add(); base(s,11,"الاستمرارية"); title(s,"الاستمرارية تبدأ من حدود تشغيل واضحة","نحوّل مخاطر الـMVP إلى ضوابط قابلة للتنفيذ والمراجعة"); const risk=[["تعطل الشبكة","Offline queue وخطة تشغيل يدوية"],["اختلاط بيانات المطاعم","tenant isolation واختبارات authorization"],["مخرجات AI غير دقيقة","مسودة ومراجعة بشرية ولا حفظ تلقائي"],["تكامل ضريبي متأخر","لا Go-live قبل شريك محلي واختبارات قبول"],["تبني الفريق بطيء","تدريب 45 دقيقة وchampion وقياس activation"]]; risk.forEach((r,i)=>{const y=180+i*75; rect(s,115,y,1035,55,i%2?"#EDF0E8":C.white,10); box(s,r[0],835,y+11,270,32,{size:18,bold:true,color:C.olive}); box(s,r[1],170,y+11,620,32,{size:18,bold:true,color:C.ink});}); box(s,"تكلفة تشغيل قابلة للتحكم: مراقبة، نسخ احتياطي، cache للـAI، حد استخدام، وfallback يدوي",115,585,1030,46,{size:20,bold:true,color:C.ink,align:"center"}); note(s,"المصدر: ملف التحكيم العربي، الاستدامة والمخاطر. هذه خطة وليست ادعاء تطبيق كامل اليوم."); }

//12 ask
{ const s=ppt.slides.add(); s.background.fill=C.ink; await img(s,"docs/screenshots/experience-reservation.png",0,0,470,720,"Resuto reservation experience"); rect(s,0,0,470,720,"#17231F/45"); box(s,"نحتاج 3 مطاعم\nلتجربة 30 يومًا",545,155,620,110,{size:43,bold:true,color:C.white}); box(s,"نقيس baseline ثم نشغّل الرحلة كاملة ونقارن الوقت، الدقة، التحصيل، ورضا الفريق.",550,315,570,78,{size:23,color:"#D9E5D0"}); rect(s,550,460,470,70,C.orange,16); box(s,"النتيجة المطلوبة: دليل أثر وقرار شراء",570,476,430,35,{size:21,bold:true,color:C.white,align:"center"}); box(s,"Resuto | نظام تشغيل عربي للمطاعم",550,610,500,30,{size:17,bold:true,color:C.sand}); note(s,"الخاتمة في 20 ثانية. اطلب تحديدًا: دعم لجنة IMPACT X لثلاثة مطاعم لمدة 30 يومًا."); }

//13 appendix
{ const s=ppt.slides.add(); base(s,13,"ملحق"); title(s,"خريطة التغطية أمام لجنة التحكيم","محتوى العرض مرتبط مباشرة بمعايير IMPACT X ذات الوزن الأعلى"); const data=[["المعيار","الأدلة في العرض"],["المشكلة والأثر | 25 نقطة","2، 7، Pilot ومقاييس baseline/after"],["التنفيذ التقني | 15 نقطة","4، 5، 6، تحقق واختبارات"],["ROI ونموذج العمل | 15 نقطة","9، تجربة تقيس قرار الدفع"],["الابتكار وUX | 20 نقطة","3، 4، 6"],["الجدوى والاستمرارية | 20 نقطة","8، 10، 11"],["Google + كفاءة العرض | +10","6، عرض مُخطط تحت 6 دقائق"]]; const t=s.tables.add({rows:data.length,columns:2,left:135,top:175,width:1010,height:370,values:data}); for(let r=0;r<data.length;r++){for(let c=0;c<2;c++){const cell=t.getCell(r,c);cell.fill=r===0?C.olive:(r%2?C.white:"#EDF0E8");cell.text.style={typeface:font,fontSize:r===0?19:17,bold:r===0||c===0,color:r===0?C.white:C.ink,alignment:"right",verticalAlignment:"middle"};}} box(s,"ملاحظة للمتحدث: استخدم هذه الشريحة فقط عند الحاجة، ولا تدخلها في مسار 6 دقائق.",150,585,980,40,{size:17,color:C.muted,align:"center"}); note(s,"المصدر: IMPACT X Judging Criteria.pdf. ملحق، لا يقدّم في الوقت الأساسي."); }

await fs.mkdir(path.dirname(FINAL_PPTX), { recursive: true });
const candidatePath = path.join(workspaceDir, ".codex-finalizer/resuto-candidate.pptx");
await (await PresentationFile.exportPptx(ppt)).save(candidatePath);
const result = await finalizePresentation({
  explicitTotalSlideCount: 13, workspaceDir, candidatePath, finalPath: FINAL_PPTX, pythonExecutable: RUNTIME_PYTHON,
  integrityValidatorPath: path.join(SKILL_DIR,"container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(SKILL_DIR,"container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs:["--expected-slide-size-emu","12192000,6858000","--validate-bullet-geometry","--validate-heading-fit"],
  requiredNativeTableOwnerSlides:[], fontPolicy:{basis:"design",families:[font]}, verifyArtifactToolImport:true,
  receiptPath:path.join(workspaceDir,".codex-finalizer/resuto.validation.json")
});
console.log(JSON.stringify(result, null, 2));
