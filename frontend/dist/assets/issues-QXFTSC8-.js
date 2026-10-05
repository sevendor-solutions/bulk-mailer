import{c as n}from"./index-BaH8wE9u.js";/**
 * @license lucide-react v0.447.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const l=n("FileWarning",[["path",{d:"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",key:"1rqfz7"}],["path",{d:"M12 9v4",key:"juzpu7"}],["path",{d:"M12 17h.01",key:"p32p05"}]]);/**
 * @license lucide-react v0.447.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const d=n("History",[["path",{d:"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",key:"1357e3"}],["path",{d:"M3 3v5h5",key:"1xhq8a"}],["path",{d:"M12 7v5l4 2",key:"1fdv2h"}]]);/**
 * @license lucide-react v0.447.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const p=n("ShieldCheck",[["path",{d:"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",key:"oel41y"}],["path",{d:"m9 12 2 2 4-4",key:"dzmm74"}]]),s=[{id:"content",label:"Content",description:"Empty or placeholder content and missing message fields."},{id:"personalization",label:"Personalization",description:"Merge field syntax, mapping and defaults."},{id:"accessibility",label:"Accessibility",description:"Alternative text, heading order, contrast and link clarity."},{id:"compatibility",label:"Compatibility",description:"Markup and CSS support across email clients."},{id:"delivery",label:"Delivery",description:"Message size, external resources and broken references."},{id:"compliance",label:"Compliance",description:"Unsubscribe, organization address and legal content."},{id:"html",label:"HTML",description:"Document structure and markup validity."},{id:"links",label:"Links",description:"URL validity, protocols and tracking."},{id:"security",label:"Security",description:"Scripts, embedded content and unsafe URLs."}],o={blocker:0,error:1,warning:2,info:3},y={blocker:"Blocker",error:"Error",warning:"Warning",info:"Information"};function u(t){return[...t].sort((i,e)=>{const r=o[i.severity]-o[e.severity];if(r!==0)return r;const a=(i.line??0)-(e.line??0);return a!==0?a:i.code.localeCompare(e.code)})}function g(t){const i={};for(const{id:e}of s)i[e]=[];for(const e of t)i[e.category]||(i[e.category]=[]),i[e.category].push(e);return i}export{l as F,d as H,s as I,p as S,y as a,g,u as s};
