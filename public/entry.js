import {switcher,watchLegacy} from './i18n.js';
if(location.pathname==='/')await import('./landing.js');
else if(location.pathname==='/pricing')await import('./pricing.js');
else if(location.pathname==='/account')await import('./account.js');
else if(location.pathname==='/reserve')await import('./reservations.js');
else if(location.pathname.startsWith('/burger'))await import('./burger.js');
else if(!location.pathname.startsWith('/manager')&&location.pathname!=='/kitchen'&&location.pathname!=='/host')await import('./guest.js');
else{await import('./app.js');const el=document.createElement('div');el.className='staff-language';el.innerHTML=switcher();document.body.append(el);watchLegacy();}
