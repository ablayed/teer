import { headers } from 'next/headers';

// Intention d'ouverture du menu « ⋯ », reçue AVANT l'hydratation (V4 bis).
//
// Constat mesuré : entre l'apparition de la liste (≈ 0,8 s) et l'attachement des écouteurs de React
// (1,2 à 2,4 s selon la puissance), un appui sur un bouton déjà visible est PERDU. Ce petit script, en
// ligne et sans dépendance, tourne dès l'analyse du HTML. Il garde AU PLUS UNE intention (la dernière)
// et donne un retour immédiat sur le bouton ; l'hydratation la reprend (components/orders/lazy-order-
// actions.tsx), la rejette si la page ou la carte a changé, et la périme après 15 s.
//
// Pas de double traitement avec React : `onActivate` est idempotent (il désigne UNE carte active), que
// l'appui soit rejoué par React, repris par ce script, ou les deux. Le script ne fait ni
// stopPropagation ni preventDefault.
//
// Nonce CSP du régime « app » lu dans `x-nonce` (middleware.ts).
const TIMEOUT_MS = 15_000;

export const EARLY_MENU_SCRIPT = `(function(w,d){
var S=w.__earlyMenu={id:null,at:0,path:'',hydrated:false,timer:0};
function reset(el){if(!el)return;el.removeAttribute('data-early-state');el.removeAttribute('aria-busy');var l=el.getAttribute('data-early-idle-label');if(l)el.setAttribute('aria-label',l);}
function find(id){return d.querySelector('[data-early-menu="'+id+'"]');}
S.reset=reset;
d.addEventListener('click',function(e){
if(S.hydrated)return;
var b=e.target&&e.target.closest&&e.target.closest('[data-early-menu]');
if(!b)return;
if(S.id!==null&&S.id!==b.getAttribute('data-early-menu'))reset(find(S.id));
S.id=b.getAttribute('data-early-menu');S.at=Date.now();S.path=w.location.pathname+w.location.search;
b.setAttribute('data-early-state','pending');b.setAttribute('aria-busy','true');
var wl=b.getAttribute('data-early-loading-label');if(wl)b.setAttribute('aria-label',wl);
w.clearTimeout(S.timer);
S.timer=w.setTimeout(function(){
var x=S.id===null?null:find(S.id);
if(!x||S.hydrated)return;
x.setAttribute('data-early-state','failed');x.removeAttribute('aria-busy');
var f=x.getAttribute('data-early-failed-label');if(f)x.setAttribute('aria-label',f);
S.id=null;
},${TIMEOUT_MS});
},true);
})(window,document);`;

export async function EarlyMenuIntent() {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  // biome-ignore lint/security/noDangerouslySetInnerHtml: script constant, sans donnée utilisateur.
  return <script dangerouslySetInnerHTML={{ __html: EARLY_MENU_SCRIPT }} nonce={nonce} />;
}
