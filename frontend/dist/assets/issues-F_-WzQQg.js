import{c as a}from"./index-fHo1jJXF.js";/**
 * @license lucide-react v0.447.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const l=a("FileWarning",[["path",{d:"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",key:"1rqfz7"}],["path",{d:"M12 9v4",key:"juzpu7"}],["path",{d:"M12 17h.01",key:"p32p05"}]]);/**
 * @license lucide-react v0.447.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const d=a("History",[["path",{d:"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",key:"1357e3"}],["path",{d:"M3 3v5h5",key:"1xhq8a"}],["path",{d:"M12 7v5l4 2",key:"1fdv2h"}]]),s=[{id:"content",label:"Content",description:"Empty or placeholder content and missing message fields."},{id:"personalization",label:"Personalization",description:"Merge field syntax, mapping and defaults."},{id:"accessibility",label:"Accessibility",description:"Alternative text, heading order, contrast and link clarity."},{id:"compatibility",label:"Compatibility",description:"Markup and CSS support across email clients."},{id:"delivery",label:"Delivery",description:"Message size, external resources and broken references."},{id:"compliance",label:"Compliance",description:"Unsubscribe, organization address and legal content."},{id:"html",label:"HTML",description:"Document structure and markup validity."},{id:"links",label:"Links",description:"URL validity, protocols and tracking."},{id:"security",label:"Security",description:"Scripts, embedded content and unsafe URLs."}],o={blocker:0,error:1,warning:2,info:3},p={blocker:"Blocker",error:"Error",warning:"Warning",info:"Information"};function y(n){return[...n].sort((i,e)=>{const r=o[i.severity]-o[e.severity];if(r!==0)return r;const t=(i.line??0)-(e.line??0);return t!==0?t:i.code.localeCompare(e.code)})}function u(n){const i={};for(const{id:e}of s)i[e]=[];for(const e of n)i[e.category]||(i[e.category]=[]),i[e.category].push(e);return i}export{l as F,d as H,s as I,p as S,u as g,y as s};
