"use strict";(self.webpackChunkmemlab_website=self.webpackChunkmemlab_website||[]).push([[3925],{5680:(e,a,n)=>{n.d(a,{xA:()=>c,yg:()=>y});var t=n(6540);function r(e,a,n){return a in e?Object.defineProperty(e,a,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[a]=n,e}function o(e,a){var n=Object.keys(e);if(Object.getOwnPropertySymbols){var t=Object.getOwnPropertySymbols(e);a&&(t=t.filter((function(a){return Object.getOwnPropertyDescriptor(e,a).enumerable}))),n.push.apply(n,t)}return n}function l(e){for(var a=1;a<arguments.length;a++){var n=null!=arguments[a]?arguments[a]:{};a%2?o(Object(n),!0).forEach((function(a){r(e,a,n[a])})):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(n)):o(Object(n)).forEach((function(a){Object.defineProperty(e,a,Object.getOwnPropertyDescriptor(n,a))}))}return e}function i(e,a){if(null==e)return{};var n,t,r=function(e,a){if(null==e)return{};var n,t,r={},o=Object.keys(e);for(t=0;t<o.length;t++)n=o[t],a.indexOf(n)>=0||(r[n]=e[n]);return r}(e,a);if(Object.getOwnPropertySymbols){var o=Object.getOwnPropertySymbols(e);for(t=0;t<o.length;t++)n=o[t],a.indexOf(n)>=0||Object.prototype.propertyIsEnumerable.call(e,n)&&(r[n]=e[n])}return r}var s=t.createContext({}),p=function(e){var a=t.useContext(s),n=a;return e&&(n="function"==typeof e?e(a):l(l({},a),e)),n},c=function(e){var a=p(e.components);return t.createElement(s.Provider,{value:a},e.children)},g="mdxType",m={inlineCode:"code",wrapper:function(e){var a=e.children;return t.createElement(t.Fragment,{},a)}},u=t.forwardRef((function(e,a){var n=e.components,r=e.mdxType,o=e.originalType,s=e.parentName,c=i(e,["components","mdxType","originalType","parentName"]),g=p(n),u=r,y=g["".concat(s,".").concat(u)]||g[u]||m[u]||o;return n?t.createElement(y,l(l({ref:a},c),{},{components:n})):t.createElement(y,l({ref:a},c))}));function y(e,a){var n=arguments,r=a&&a.mdxType;if("string"==typeof e||r){var o=n.length,l=new Array(o);l[0]=u;var i={};for(var s in a)hasOwnProperty.call(a,s)&&(i[s]=a[s]);i.originalType=e,i[g]="string"==typeof e?e:r,l[1]=i;for(var p=2;p<o;p++)l[p]=n[p];return t.createElement.apply(null,l)}return t.createElement.apply(null,n)}u.displayName="MDXCreateElement"},9760:(e,a,n)=>{n.r(a),n.d(a,{assets:()=>s,contentTitle:()=>l,default:()=>m,frontMatter:()=>o,metadata:()=>i,toc:()=>p});var t=n(8168),r=(n(6540),n(5680));const o={id:"core_src.IHeapLocation",title:"Interface: IHeapLocation",sidebar_label:"IHeapLocation",custom_edit_url:null},l=void 0,i={unversionedId:"api/interfaces/core_src.IHeapLocation",id:"api/interfaces/core_src.IHeapLocation",title:"Interface: IHeapLocation",description:"An IHeapLocation instance contains a source location information",source:"@site/docs/api/interfaces/core_src.IHeapLocation.md",sourceDirName:"api/interfaces",slug:"/api/interfaces/core_src.IHeapLocation",permalink:"/memlab/docs/api/interfaces/core_src.IHeapLocation",draft:!1,editUrl:null,tags:[],version:"current",frontMatter:{id:"core_src.IHeapLocation",title:"Interface: IHeapLocation",sidebar_label:"IHeapLocation",custom_edit_url:null},sidebar:"sidebar",previous:{title:"IHeapEdges",permalink:"/memlab/docs/api/interfaces/core_src.IHeapEdges"},next:{title:"IHeapNode",permalink:"/memlab/docs/api/interfaces/core_src.IHeapNode"}},s={},p=[{value:"Properties",id:"properties",level:2},{value:'<a id="column" name="column"></a> <strong>column</strong>: <code>number</code>',id:"-column-number",level:3},{value:'<a id="line" name="line"></a> <strong>line</strong>: <code>number</code>',id:"-line-number",level:3},{value:'<a id="node" name="node"></a> <strong>node</strong>: <code>Nullable</code>&lt;<code>IHeapNode</code>&gt;',id:"-node-nullableiheapnode",level:3},{value:'<a id="script_id" name="script_id"></a> <strong>script_id</strong>: <code>number</code>',id:"-script_id-number",level:3},{value:'<a id="snapshot" name="snapshot"></a> <strong>snapshot</strong>: <code>IHeapSnapshot</code>',id:"-snapshot-iheapsnapshot",level:3},{value:"Methods",id:"methods",level:2},{value:'<a id="getjsonifyableobject"></a><strong>getJSONifyableObject</strong>()',id:"getjsonifyableobject",level:3},{value:'<a id="tojsonstring"></a><strong>toJSONString</strong>(...<code>args</code>)',id:"tojsonstringargs",level:3}],c={toc:p},g="wrapper";function m(e){let{components:a,...n}=e;return(0,r.yg)(g,(0,t.A)({},c,n,{components:a,mdxType:"MDXLayout"}),(0,r.yg)("p",null,"An ",(0,r.yg)("inlineCode",{parentName:"p"},"IHeapLocation")," instance contains a source location information\nassociated with a JS heap object.\nA heap snapshot is generally a graph where graph nodes are JS heap objects\nand graph edges are JS references among JS heap objects."),(0,r.yg)("p",null,(0,r.yg)("strong",{parentName:"p"},(0,r.yg)("inlineCode",{parentName:"strong"},"readonly"))," it is not recommended to modify any ",(0,r.yg)("inlineCode",{parentName:"p"},"IHeapLocation")," instance"),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Examples"),": V8 or hermes heap snapshot can be parsed by the\n",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/heap_analysis_src#getfullheapfromfile"},"getFullHeapFromFile")," API.")),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"import type {IHeapSnapshot, IHeapNode, IHeapLocation} from '@memlab/core';\nimport {dumpNodeHeapSnapshot} from '@memlab/core';\nimport {getFullHeapFromFile} from '@memlab/heap-analysis';\n\n(async function () {\n  const heapFile = dumpNodeHeapSnapshot();\n  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);\n\n  // iterate over each node (heap object)\n  heap.nodes.forEach((node: IHeapNode, i: number) => {\n    const location: Nullable<IHeapLocation> = node.location;\n    if (location) {\n      // use the location API here\n      location.line;\n      // ...\n    }\n  });\n})();\n")),(0,r.yg)("h2",{id:"properties"},"Properties"),(0,r.yg)("h3",{id:"-column-number"},(0,r.yg)("a",{id:"column",name:"column"})," ",(0,r.yg)("strong",{parentName:"h3"},"column"),": ",(0,r.yg)("inlineCode",{parentName:"h3"},"number")),(0,r.yg)("p",null,"get the column number"),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/e8564bd/packages/core/src/lib/Types.ts#L1594"},"core/src/lib/Types.ts:1594"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-line-number"},(0,r.yg)("a",{id:"line",name:"line"})," ",(0,r.yg)("strong",{parentName:"h3"},"line"),": ",(0,r.yg)("inlineCode",{parentName:"h3"},"number")),(0,r.yg)("p",null,"get the line number"),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/e8564bd/packages/core/src/lib/Types.ts#L1590"},"core/src/lib/Types.ts:1590"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-node-nullableiheapnode"},(0,r.yg)("a",{id:"node",name:"node"})," ",(0,r.yg)("strong",{parentName:"h3"},"node"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/modules/core_src#nullable"},(0,r.yg)("inlineCode",{parentName:"a"},"Nullable")),"<",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/interfaces/core_src.IHeapNode"},(0,r.yg)("inlineCode",{parentName:"a"},"IHeapNode")),">"),(0,r.yg)("p",null,"get the heap object this location this location represents"),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/e8564bd/packages/core/src/lib/Types.ts#L1582"},"core/src/lib/Types.ts:1582"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-script_id-number"},(0,r.yg)("a",{id:"script\\_id",name:"script\\_id"})," ",(0,r.yg)("strong",{parentName:"h3"},"script","_","id"),": ",(0,r.yg)("inlineCode",{parentName:"h3"},"number")),(0,r.yg)("p",null,"get the script ID of the source file"),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/e8564bd/packages/core/src/lib/Types.ts#L1586"},"core/src/lib/Types.ts:1586"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-snapshot-iheapsnapshot"},(0,r.yg)("a",{id:"snapshot",name:"snapshot"})," ",(0,r.yg)("strong",{parentName:"h3"},"snapshot"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/interfaces/core_src.IHeapSnapshot"},(0,r.yg)("inlineCode",{parentName:"a"},"IHeapSnapshot"))),(0,r.yg)("p",null,"get the ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IHeapSnapshot"},"IHeapSnapshot")," containing this location instance"),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/e8564bd/packages/core/src/lib/Types.ts#L1578"},"core/src/lib/Types.ts:1578"))))),(0,r.yg)("h2",{id:"methods"},"Methods"),(0,r.yg)("h3",{id:"getjsonifyableobject"},(0,r.yg)("a",{id:"getjsonifyableobject"}),(0,r.yg)("strong",{parentName:"h3"},"getJSONifyableObject"),"()"),(0,r.yg)("p",null,"convert to a concise readable object that can be used for serialization\n(like calling ",(0,r.yg)("inlineCode",{parentName:"p"},"JSON.stringify(node, ...args)"),")."),(0,r.yg)("p",null,"This API does not contain all the information\ncaptured by the hosting object."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Returns"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"AnyRecord")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/e8564bd/packages/core/src/lib/Types.ts#L1602"},"core/src/lib/Types.ts:1602"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"tojsonstringargs"},(0,r.yg)("a",{id:"tojsonstring"}),(0,r.yg)("strong",{parentName:"h3"},"toJSONString"),"(...",(0,r.yg)("inlineCode",{parentName:"h3"},"args"),")"),(0,r.yg)("p",null,"convert to a concise readable string output\n(like calling ",(0,r.yg)("inlineCode",{parentName:"p"},"JSON.stringify(node, ...args)"),")."),(0,r.yg)("p",null,"Note: Please be aware that using ",(0,r.yg)("inlineCode",{parentName:"p"},"JSON.stringify(node, ...args)")," is\nnot recommended as it will generate a JSON representation of the host\nobject that is too large to be easily readable due to its connections\nto other parts of the data structures within the heap snapshot."),(0,r.yg)("p",null,"This API does not completely serialize all the information\ncaptured by the hosting object."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Parameters"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"...args"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"any"),"[]"))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Returns"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"string")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/e8564bd/packages/core/src/lib/Types.ts#L1615"},"core/src/lib/Types.ts:1615"))))))}m.isMDXComponent=!0}}]);