-- Public pricing copy (audits VP-22 and VP-02).
--  * plans.description_ar: the /pricing page showed the English plan description on the Arabic page.
--  * The Arabic name of "Build Your Resuto" misspelled the brand (ريزوتو); the brand is ريسوتو.
-- Additive and data-only. Rows a platform admin has already edited are left alone (each update matches the seeded value).
-- Down: alter table public.plans drop column description_ar;
--       update public.plans set name_ar = 'ابنِ ريزوتو الخاص بك' where id = 'custom' and name_ar = 'ابنِ ريسوتو الخاص بك';

alter table public.plans add column if not exists description_ar text;

update public.plans set name_ar = 'ابنِ ريسوتو الخاص بك'
 where id = 'custom' and name_ar = 'ابنِ ريزوتو الخاص بك';

update public.plans p set description_ar = v.ar
  from (values
    ('free',    'Digital QR menu and table ordering for one branch.',    'قائمة رقمية وطلب الطاولات عبر QR لفرع واحد.'),
    ('starter', 'Operations and online payments for a single branch.',   'التشغيل والمدفوعات الإلكترونية لفرع واحد.'),
    ('growth',  'Customer communication, marketing and websites.',       'التواصل مع العملاء والتسويق والمواقع الإلكترونية.'),
    ('pro',     'Every Resuto module for multi-branch operators.',       'كل وحدات ريسوتو للمطاعم متعددة الفروع.'),
    ('custom',  'Pick only the modules you need.',                       'اختر الوحدات التي تحتاجها فقط.')
  ) as v(id, en, ar)
 where p.id = v.id and p.description_ar is null and p.description = v.en;
