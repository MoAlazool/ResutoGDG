/* ResutoDriver service worker (FT-22): shows Web Push notifications for offers, assignments and cancellations and
 * opens the job when tapped. The payload (decrypted by the browser) carries only { v, kind, jobId, orgId, url }; the
 * text is chosen here in the device language, so no customer data ever travels through the push service. */
const TEXT = {
  en: {
    offer: ['New delivery offer', 'Open ResutoDriver to accept it before it expires.'],
    assigned: ['New delivery assigned', 'Open ResutoDriver to see the pickup.'],
    cancelled: ['Delivery cancelled', 'This delivery was cancelled. You do not need to go.'],
    unassigned: ['Delivery handed back', 'This delivery is no longer assigned to you.'],
    test: ['Notifications are on', 'You will be notified of new offers and changes.'],
  },
  ar: {
    offer: ['عرض توصيل جديد', 'افتح ResutoDriver لقبوله قبل انتهاء صلاحيته.'],
    assigned: ['تم إسناد توصيلة جديدة', 'افتح ResutoDriver لمعرفة مكان الاستلام.'],
    cancelled: ['أُلغيت التوصيلة', 'أُلغيت هذه التوصيلة ولا داعي للذهاب.'],
    unassigned: ['أُعيدت التوصيلة', 'لم تعد هذه التوصيلة مسندة إليك.'],
    test: ['الإشعارات مفعّلة', 'ستصلك إشعارات بالعروض الجديدة والتغييرات.'],
  },
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const lang = (self.navigator && self.navigator.language || 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const kind = TEXT[lang][data.kind] ? data.kind : 'assigned';
  const [title, body] = TEXT[lang][kind];
  const url = typeof data.url === 'string' && data.url.startsWith('/driver') ? data.url : '/driver';
  event.waitUntil(self.registration.showNotification(title, {
    body, lang, dir: lang === 'ar' ? 'rtl' : 'ltr', icon: '/brand/resuto-icon.png', badge: '/brand/resuto-icon.png',
    tag: data.jobId ? `job-${data.jobId}` : `resuto-${kind}`, renotify: kind === 'offer' || kind === 'cancelled',
    requireInteraction: kind === 'offer', data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/driver';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).pathname.startsWith('/driver')) { await c.focus(); if ('navigate' in c) await c.navigate(url); return; }
    }
    await self.clients.openWindow(url);
  })());
});
