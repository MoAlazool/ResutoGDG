// Styles for the components added in this package. They build on the tokens in
// apps/web/app/globals.css and are injected once per document through React 19
// stylesheet hoisting (<style href precedence>), so consumers need no extra import.
const css = /* css */ `
.rui-drawer{margin:0;padding:0;border:0;max-width:none;max-height:none;height:100dvh;width:min(440px,100vw);inset-block:0;inset-inline-start:auto;inset-inline-end:0;background:var(--card,#fff);box-shadow:var(--shadow-sheet,0 20px 100px #123a3340);display:flex;flex-direction:column}
.rui-drawer:not([open]){display:none}
.rui-drawer[data-side=start]{inset-inline-start:0;inset-inline-end:auto}
.rui-drawer::backdrop{background:#0c262066}
.rui-drawer[open]{animation:rui-slide-in .28s var(--ease,cubic-bezier(.22,1,.36,1)) both}
[dir=rtl] .rui-drawer[open]{animation-name:rui-slide-in-rtl}
.rui-drawer[data-side=start][open]{animation-name:rui-slide-in-rtl}
[dir=rtl] .rui-drawer[data-side=start][open]{animation-name:rui-slide-in}
@keyframes rui-slide-in{from{transform:translateX(100%)}to{transform:none}}
@keyframes rui-slide-in-rtl{from{transform:translateX(-100%)}to{transform:none}}
.rui-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px;border-block-end:1px solid var(--line-soft,#eef0ea)}
.rui-drawer-head h2{margin:0;font-size:18px}
.rui-drawer-body{flex:1;overflow:auto;padding:20px 22px}
.rui-drawer-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-block-start:1px solid var(--line-soft,#eef0ea);flex-wrap:wrap}
.rui-confirm{width:min(440px,calc(100% - 24px));border:0;border-radius:var(--radius-md,16px);padding:24px;box-shadow:var(--shadow-sheet,0 20px 100px #123a3340)}
.rui-confirm::backdrop{background:#0c262066}
.rui-confirm h2{margin:0 0 8px;font-size:19px}
.rui-confirm p{color:var(--muted,#747c74);margin:0}
.rui-confirm .rui-actions{display:flex;justify-content:flex-end;gap:10px;margin-block-start:20px;flex-wrap:wrap}
.rui-toasts{position:fixed;inset-block-end:18px;inset-inline-end:18px;z-index:1000;display:grid;gap:10px;width:min(380px,calc(100vw - 36px));pointer-events:none}
.rui-toast{pointer-events:auto;display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-radius:12px;background:var(--ink,#163d34);color:#fff;box-shadow:var(--shadow-float,0 8px 45px #132d322b);font-size:14px;animation:rise .3s var(--ease,cubic-bezier(.22,1,.36,1)) both}
.rui-toast[data-tone=danger]{background:var(--danger,#a33a22)}
.rui-toast[data-tone=warn]{background:#7d5a12}
.rui-toast[data-tone=ok]{background:#2f6238}
.rui-toast p{margin:0;flex:1}
.rui-toast button{background:transparent;border:1px solid #ffffff55;color:#fff;border-radius:8px;padding:3px 9px;font-size:12px;cursor:pointer}
.rui-toast button:focus-visible{outline:2px solid #fff;outline-offset:2px}
.rui-search{position:relative;display:flex;align-items:center}
.rui-search input{padding-inline-start:36px;padding-inline-end:36px}
.rui-search .rui-search-icon{position:absolute;inset-inline-start:12px;color:var(--muted,#747c74);pointer-events:none;font-size:14px}
.rui-search .rui-search-clear{position:absolute;inset-inline-end:6px;border:0;background:transparent;color:var(--muted,#747c74);min-width:30px;min-height:30px;border-radius:8px;cursor:pointer}
.rui-search .rui-search-clear:hover{background:var(--line-soft,#eef0ea)}
.rui-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-block-start:14px;flex-wrap:wrap}
.rui-pagination span{font-size:13px;color:var(--muted,#747c74)}
.rui-daterange{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.rui-daterange .field{margin:0;min-width:140px}
.rui-daterange .rui-presets{display:flex;gap:6px;flex-wrap:wrap}
.rui-timeline{list-style:none;margin:0;padding:0;display:grid;gap:0}
.rui-timeline li{position:relative;display:grid;grid-template-columns:18px 1fr;gap:12px;padding-block-end:16px}
.rui-timeline li::before{content:'';position:absolute;inset-inline-start:8px;inset-block:18px 0;width:2px;background:var(--line,#e1e5dd)}
.rui-timeline li:last-child::before{display:none}
.rui-timeline .rui-dot{width:18px;height:18px;border-radius:50%;border:3px solid var(--card,#fff);background:var(--line,#e1e5dd);box-shadow:0 0 0 1px var(--line,#e1e5dd);margin-block-start:2px}
.rui-timeline .rui-dot[data-tone=ok]{background:var(--ok,#2f6238)}.rui-timeline .rui-dot[data-tone=warn]{background:#b88831}
.rui-timeline .rui-dot[data-tone=info]{background:var(--info,#2f4a76)}.rui-timeline .rui-dot[data-tone=danger]{background:var(--danger,#a33a22)}
.rui-timeline .rui-dot[data-tone=pay]{background:var(--pay,#76528f)}
.rui-timeline strong{display:block;color:var(--ink,#163d34);font-size:14px}
.rui-timeline time,.rui-timeline small{font-size:12px;color:var(--muted,#747c74)}
.rui-kv{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:8px 18px;margin:0}
.rui-kv dt{color:var(--muted,#747c74);font-size:13px}
.rui-kv dd{margin:0;color:var(--text,#25382f);font-weight:600;font-size:14px;overflow-wrap:anywhere}
@media (max-width:430px){.rui-kv{grid-template-columns:1fr}.rui-kv dd{margin-block-end:6px}}
@media (prefers-reduced-motion:reduce){.rui-drawer[open],.rui-toast{animation:none}}
`;

export function UiStyles() {
  return <style href="resuto-ui-v1" precedence="default">{css}</style>;
}
