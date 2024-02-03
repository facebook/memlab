"use strict";(self.webpackChunkmemlab_website=self.webpackChunkmemlab_website||[]).push([[2540],{5788:(e,a,n)=>{n.d(a,{Iu:()=>m,yg:()=>d});var t=n(1504);function r(e,a,n){return a in e?Object.defineProperty(e,a,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[a]=n,e}function o(e,a){var n=Object.keys(e);if(Object.getOwnPropertySymbols){var t=Object.getOwnPropertySymbols(e);a&&(t=t.filter((function(a){return Object.getOwnPropertyDescriptor(e,a).enumerable}))),n.push.apply(n,t)}return n}function l(e){for(var a=1;a<arguments.length;a++){var n=null!=arguments[a]?arguments[a]:{};a%2?o(Object(n),!0).forEach((function(a){r(e,a,n[a])})):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(n)):o(Object(n)).forEach((function(a){Object.defineProperty(e,a,Object.getOwnPropertyDescriptor(n,a))}))}return e}function p(e,a){if(null==e)return{};var n,t,r=function(e,a){if(null==e)return{};var n,t,r={},o=Object.keys(e);for(t=0;t<o.length;t++)n=o[t],a.indexOf(n)>=0||(r[n]=e[n]);return r}(e,a);if(Object.getOwnPropertySymbols){var o=Object.getOwnPropertySymbols(e);for(t=0;t<o.length;t++)n=o[t],a.indexOf(n)>=0||Object.prototype.propertyIsEnumerable.call(e,n)&&(r[n]=e[n])}return r}var s=t.createContext({}),i=function(e){var a=t.useContext(s),n=a;return e&&(n="function"==typeof e?e(a):l(l({},a),e)),n},m=function(e){var a=i(e.components);return t.createElement(s.Provider,{value:a},e.children)},c="mdxType",g={inlineCode:"code",wrapper:function(e){var a=e.children;return t.createElement(t.Fragment,{},a)}},y=t.forwardRef((function(e,a){var n=e.components,r=e.mdxType,o=e.originalType,s=e.parentName,m=p(e,["components","mdxType","originalType","parentName"]),c=i(n),y=r,d=c["".concat(s,".").concat(y)]||c[y]||g[y]||o;return n?t.createElement(d,l(l({ref:a},m),{},{components:n})):t.createElement(d,l({ref:a},m))}));function d(e,a){var n=arguments,r=a&&a.mdxType;if("string"==typeof e||r){var o=n.length,l=new Array(o);l[0]=y;var p={};for(var s in a)hasOwnProperty.call(a,s)&&(p[s]=a[s]);p.originalType=e,p[c]="string"==typeof e?e:r,l[1]=p;for(var i=2;i<o;i++)l[i]=n[i];return t.createElement.apply(null,l)}return t.createElement.apply(null,n)}y.displayName="MDXCreateElement"},5764:(e,a,n)=>{n.r(a),n.d(a,{assets:()=>s,contentTitle:()=>l,default:()=>g,frontMatter:()=>o,metadata:()=>p,toc:()=>i});var t=n(5072),r=(n(1504),n(5788));const o={id:"core_src.IHeapSnapshot",title:"Interface: IHeapSnapshot",sidebar_label:"IHeapSnapshot",custom_edit_url:null},l=void 0,p={unversionedId:"api/interfaces/core_src.IHeapSnapshot",id:"api/interfaces/core_src.IHeapSnapshot",title:"Interface: IHeapSnapshot",description:"A heap snapshot is generally a graph where graph nodes are JS heap objects",source:"@site/docs/api/interfaces/core_src.IHeapSnapshot.md",sourceDirName:"api/interfaces",slug:"/api/interfaces/core_src.IHeapSnapshot",permalink:"/memlab/docs/api/interfaces/core_src.IHeapSnapshot",draft:!1,editUrl:null,tags:[],version:"current",frontMatter:{id:"core_src.IHeapSnapshot",title:"Interface: IHeapSnapshot",sidebar_label:"IHeapSnapshot",custom_edit_url:null},sidebar:"sidebar",previous:{title:"IHeapNodes",permalink:"/memlab/docs/api/interfaces/core_src.IHeapNodes"},next:{title:"IHeapStringNode",permalink:"/memlab/docs/api/interfaces/core_src.IHeapStringNode"}},s={},i=[{value:"Properties",id:"properties",level:2},{value:'<a id="edges" name="edges"></a> <strong>edges</strong>: <code>IHeapEdges</code>',id:"-edges-iheapedges",level:3},{value:'<a id="nodes" name="nodes"></a> <strong>nodes</strong>: <code>IHeapNodes</code>',id:"-nodes-iheapnodes",level:3},{value:"Methods",id:"methods",level:2},{value:'<a id="getanyobjectwithclassname"></a><strong>getAnyObjectWithClassName</strong>(<code>className</code>)',id:"getanyobjectwithclassnameclassname",level:3},{value:'<a id="getnodebyid"></a><strong>getNodeById</strong>(<code>id</code>)',id:"getnodebyidid",level:3},{value:'<a id="getnodesbyidset"></a><strong>getNodesByIdSet</strong>(<code>ids</code>)',id:"getnodesbyidsetids",level:3},{value:'<a id="getnodesbyids"></a><strong>getNodesByIds</strong>(<code>ids</code>)',id:"getnodesbyidsids",level:3},{value:'<a id="hasobjectwithclassname"></a><strong>hasObjectWithClassName</strong>(<code>className</code>)',id:"hasobjectwithclassnameclassname",level:3},{value:'<a id="hasobjectwithpropertyname"></a><strong>hasObjectWithPropertyName</strong>(<code>nameOrIndex</code>)',id:"hasobjectwithpropertynamenameorindex",level:3},{value:'<a id="hasobjectwithtag"></a><strong>hasObjectWithTag</strong>(<code>tag</code>)',id:"hasobjectwithtagtag",level:3}],m={toc:i},c="wrapper";function g(e){let{components:a,...n}=e;return(0,r.yg)(c,(0,t.c)({},m,n,{components:a,mdxType:"MDXLayout"}),(0,r.yg)("p",null,"A heap snapshot is generally a graph where graph nodes are JS heap objects\nand graph edges are JS references among JS heap objects. For more details\non the structure of nodes and edges in the heap graph, check out\n",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IHeapNode"},"IHeapNode")," and ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IHeapEdge"},"IHeapEdge"),"."),(0,r.yg)("h2",{id:"properties"},"Properties"),(0,r.yg)("h3",{id:"-edges-iheapedges"},(0,r.yg)("a",{id:"edges",name:"edges"})," ",(0,r.yg)("strong",{parentName:"h3"},"edges"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/interfaces/core_src.IHeapEdges"},(0,r.yg)("inlineCode",{parentName:"a"},"IHeapEdges"))),(0,r.yg)("p",null,"A pseudo array containing all heap graph edges (references to heap objects\nin heap). A JS heap could contain millions of references, so memlab uses\na pseudo array as the collection of all the heap edges. The pseudo\narray provides API to query and traverse all heap references."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Examples"),":")),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"import type {IHeapSnapshot, IHeapEdge} from '@memlab/core';\nimport {dumpNodeHeapSnapshot} from '@memlab/core';\nimport {getFullHeapFromFile} from '@memlab/heap-analysis';\n\n(async function () {\n  const heapFile = dumpNodeHeapSnapshot();\n  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);\n\n  // get the total number of heap references\n  heap.edges.length;\n\n  heap.edges.forEach((edge: IHeapEdge) => {\n    // traverse each reference in the heap\n  });\n})();\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/core/src/lib/Types.ts#L1294"},"core/src/lib/Types.ts:1294"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-nodes-iheapnodes"},(0,r.yg)("a",{id:"nodes",name:"nodes"})," ",(0,r.yg)("strong",{parentName:"h3"},"nodes"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/interfaces/core_src.IHeapNodes"},(0,r.yg)("inlineCode",{parentName:"a"},"IHeapNodes"))),(0,r.yg)("p",null,"A pseudo array containing all heap graph nodes (JS objects in heap).\nA JS heap could contain millions of heap objects, so memlab uses\na pseudo array as the collection of all the heap objects. The pseudo\narray provides API to query and traverse all heap objects."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Examples"),":")),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"import type {IHeapSnapshot, IHeapNode} from '@memlab/core';\nimport {dumpNodeHeapSnapshot} from '@memlab/core';\nimport {getFullHeapFromFile} from '@memlab/heap-analysis';\n\n(async function () {\n  const heapFile = dumpNodeHeapSnapshot();\n  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);\n\n  // get the total number of heap objects\n  heap.nodes.length;\n\n  heap.nodes.forEach((node: IHeapNode) => {\n    // traverse each heap object\n  });\n})();\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/core/src/lib/Types.ts#L1268"},"core/src/lib/Types.ts:1268"))))),(0,r.yg)("h2",{id:"methods"},"Methods"),(0,r.yg)("h3",{id:"getanyobjectwithclassnameclassname"},(0,r.yg)("a",{id:"getanyobjectwithclassname"}),(0,r.yg)("strong",{parentName:"h3"},"getAnyObjectWithClassName"),"(",(0,r.yg)("inlineCode",{parentName:"h3"},"className"),")"),(0,r.yg)("p",null,"Search for the heap and get one of the JS object instances with\na specified constructor name (if there is any)."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"className"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"string")," | The constructor name of the object instance"))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/modules/core_src#nullable"},(0,r.yg)("inlineCode",{parentName:"a"},"Nullable")),"<",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IHeapNode"},(0,r.yg)("inlineCode",{parentName:"a"},"IHeapNode")),">"," | a handle pointing to any one of the object instances, returns\n",(0,r.yg)("inlineCode",{parentName:"p"},"null")," if no such object exists in the heap.")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"import type {IHeapSnapshot} from '@memlab/core';\nimport {takeNodeMinimalHeap} from '@memlab/core';\n\nclass TestObject {\n  public arr1 = [1, 2, 3];\n  public arr2 = ['1', '2', '3'];\n}\n\n(async function () {\n  const obj = new TestObject();\n  // get a heap snapshot of the current program state\n  const heap: IHeapSnapshot = await takeNodeMinimalHeap();\n\n  const node = heap.getAnyObjectWithClassName('TestObject');\n  console.log(node?.name); // should be 'TestObject'\n})();\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/core/src/lib/Types.ts#L1435"},"core/src/lib/Types.ts:1435"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"getnodebyidid"},(0,r.yg)("a",{id:"getnodebyid"}),(0,r.yg)("strong",{parentName:"h3"},"getNodeById"),"(",(0,r.yg)("inlineCode",{parentName:"h3"},"id"),")"),(0,r.yg)("p",null,"If you have the id of a heap node (JS object in heap), use this API\nto get an ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IHeapNode"},"IHeapNode")," associated with the id."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"id"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"number")," | id of the heap node (JS object in heap) you would like to query"))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/modules/core_src#nullable"},(0,r.yg)("inlineCode",{parentName:"a"},"Nullable")),"<",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IHeapNode"},(0,r.yg)("inlineCode",{parentName:"a"},"IHeapNode")),">"," | the API returns ",(0,r.yg)("inlineCode",{parentName:"p"},"null")," if no heap object has the specified id.")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"import type {IHeapSnapshot} from '@memlab/core';\nimport {dumpNodeHeapSnapshot} from '@memlab/core';\nimport {getFullHeapFromFile} from '@memlab/heap-analysis';\n\n(async function () {\n  const heapFile = dumpNodeHeapSnapshot();\n  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);\n\n  const node = heap.getNodeById(351);\n  node?.id; // should be 351\n})();\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/core/src/lib/Types.ts#L1316"},"core/src/lib/Types.ts:1316"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"getnodesbyidsetids"},(0,r.yg)("a",{id:"getnodesbyidset"}),(0,r.yg)("strong",{parentName:"h3"},"getNodesByIdSet"),"(",(0,r.yg)("inlineCode",{parentName:"h3"},"ids"),")"),(0,r.yg)("p",null,"Given a set of ids of heap nodes (JS objects in heap), use this API\nto get a set of those heap nodes."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"ids"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"Set"),"<",(0,r.yg)("inlineCode",{parentName:"li"},"number"),">"," | id set of the heap nodes (JS objects in heap) you would like to query"))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": ",(0,r.yg)("inlineCode",{parentName:"p"},"Set"),"<",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IHeapNode"},(0,r.yg)("inlineCode",{parentName:"a"},"IHeapNode")),">"," | a set of those heap nodes. The set will only include\nnodes that are found in the heap. If none of the input ids are found,\nthis API will return an empty set.")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"import type {IHeapSnapshot} from '@memlab/core';\nimport {dumpNodeHeapSnapshot} from '@memlab/core';\nimport {getFullHeapFromFile} from '@memlab/heap-analysis';\n\n(async function () {\n  const heapFile = dumpNodeHeapSnapshot();\n  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);\n\n  // suppose 1000 is not a valid id in the heap\n  const set = heap.getNodesByIdSet(new Set([1, 2, 1000, 3]));\n  set // should be Set([node1, node2, node3])\n})();\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/core/src/lib/Types.ts#L1368"},"core/src/lib/Types.ts:1368"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"getnodesbyidsids"},(0,r.yg)("a",{id:"getnodesbyids"}),(0,r.yg)("strong",{parentName:"h3"},"getNodesByIds"),"(",(0,r.yg)("inlineCode",{parentName:"h3"},"ids"),")"),(0,r.yg)("p",null,"Given an array of ids of heap nodes (JS objects in heap), use this API\nto get an array of those heap nodes."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"ids"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"number"),"[] | id array of the heap nodes (JS objects in heap) you would like to query"))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/modules/core_src#nullable"},(0,r.yg)("inlineCode",{parentName:"a"},"Nullable")),"<",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IHeapNode"},(0,r.yg)("inlineCode",{parentName:"a"},"IHeapNode")),">","[] | an array of those heap nodes. The return array will preserve the\norder of the input array. If an id is not found in the heap, the\ncorresponding element in the return array will be ",(0,r.yg)("inlineCode",{parentName:"p"},"null"),".")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"import type {IHeapSnapshot} from '@memlab/core';\nimport {dumpNodeHeapSnapshot} from '@memlab/core';\nimport {getFullHeapFromFile} from '@memlab/heap-analysis';\n\n(async function () {\n  const heapFile = dumpNodeHeapSnapshot();\n  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);\n\n  // suppose 1000 is not a valid id in the heap\n  const nodes = heap.getNodesByIds([1, 2, 1000, 3]);\n  nodes // should be [node1, node2, null, node3]\n})();\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/core/src/lib/Types.ts#L1342"},"core/src/lib/Types.ts:1342"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"hasobjectwithclassnameclassname"},(0,r.yg)("a",{id:"hasobjectwithclassname"}),(0,r.yg)("strong",{parentName:"h3"},"hasObjectWithClassName"),"(",(0,r.yg)("inlineCode",{parentName:"h3"},"className"),")"),(0,r.yg)("p",null,"Search for the heap and check if there is any JS object instance with\na specified constructor name."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"className"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"string")," | The constructor name of the object instance"))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": ",(0,r.yg)("inlineCode",{parentName:"p"},"boolean")," | ",(0,r.yg)("inlineCode",{parentName:"p"},"true")," if there is at least one such object in the heap")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),": you can write a jest unit test with memory assertions:"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"// save as example.test.ts\nimport type {IHeapSnapshot, Nullable} from '@memlab/core';\nimport {config, takeNodeMinimalHeap} from '@memlab/core';\n\nclass TestObject {\n  public arr1 = [1, 2, 3];\n  public arr2 = ['1', '2', '3'];\n}\n\ntest('memory test with heap assertion', async () => {\n  config.muteConsole = true; // no console output\n\n  let obj: Nullable<TestObject> = new TestObject();\n  // get a heap snapshot of the current program state\n  let heap: IHeapSnapshot = await takeNodeMinimalHeap();\n\n  // call some function that may add references to obj\n  rabbitHole(obj)\n\n  expect(heap.hasObjectWithClassName('TestObject')).toBe(true);\n  obj = null;\n\n  heap = await takeNodeMinimalHeap();\n  // if rabbitHole does not have any side effect that\n  // adds new references to obj, then obj can be GCed\n  expect(heap.hasObjectWithClassName('TestObject')).toBe(false);\n\n}, 30000);\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/core/src/lib/Types.ts#L1407"},"core/src/lib/Types.ts:1407"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"hasobjectwithpropertynamenameorindex"},(0,r.yg)("a",{id:"hasobjectwithpropertyname"}),(0,r.yg)("strong",{parentName:"h3"},"hasObjectWithPropertyName"),"(",(0,r.yg)("inlineCode",{parentName:"h3"},"nameOrIndex"),")"),(0,r.yg)("p",null,"Search for the heap and check if there is any JS object instance with\na specified property name."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"nameOrIndex"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"string")," ","|"," ",(0,r.yg)("inlineCode",{parentName:"li"},"number")," | The property name (string) or element index (number) on the object instance"))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": ",(0,r.yg)("inlineCode",{parentName:"p"},"boolean")," | returns ",(0,r.yg)("inlineCode",{parentName:"p"},"true")," if there is at least one such object in the heap")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"import type {IHeapSnapshot} from '@memlab/core';\nimport {dumpNodeHeapSnapshot} from '@memlab/core';\nimport {getFullHeapFromFile} from '@memlab/heap-analysis';\n\n(async function () {\n  // eslint-disable-next-line @typescript-eslint/no-unused-vars\n  const object = {'memlab-test-heap-property': 'memlab-test-heap-value'};\n\n  const heapFile = dumpNodeHeapSnapshot();\n  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);\n\n  // should be true\n  console.log(heap.hasObjectWithPropertyName('memlab-test-heap-property'));\n})();\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/core/src/lib/Types.ts#L1461"},"core/src/lib/Types.ts:1461"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"hasobjectwithtagtag"},(0,r.yg)("a",{id:"hasobjectwithtag"}),(0,r.yg)("strong",{parentName:"h3"},"hasObjectWithTag"),"(",(0,r.yg)("inlineCode",{parentName:"h3"},"tag"),")"),(0,r.yg)("p",null,"Search for the heap and check if there is any JS object instance with\na marker tagged by ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/modules/core_src#tagobject"},"tagObject"),"."),(0,r.yg)("p",null,"The ",(0,r.yg)("inlineCode",{parentName:"p"},"tagObject")," API does not modify the object instance in any way\n(e.g., no additional or hidden properties added to the tagged object)."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Parameters"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"tag"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"string")," | marker name on the object instances tagged by ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#tagobject"},"tagObject")))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Returns"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"boolean")," | returns ",(0,r.yg)("inlineCode",{parentName:"li"},"true")," if there is at least one such object in the heap")),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"import type {IHeapSnapshot, AnyValue} from '@memlab/core';\nimport {config, takeNodeMinimalHeap, tagObject} from '@memlab/core';\n\ntest('memory test', async () => {\n  config.muteConsole = true;\n  const o1: AnyValue = {};\n  let o2: AnyValue = {};\n\n  // tag o1 with marker: \"memlab-mark-1\", does not modify o1 in any way\n  tagObject(o1, 'memlab-mark-1');\n  // tag o2 with marker: \"memlab-mark-2\", does not modify o2 in any way\n  tagObject(o2, 'memlab-mark-2');\n\n  o2 = null;\n\n  const heap: IHeapSnapshot = await takeNodeMinimalHeap();\n\n  // expect object with marker \"memlab-mark-1\" exists\n  expect(heap.hasObjectWithTag('memlab-mark-1')).toBe(true);\n\n  // expect object with marker \"memlab-mark-2\" can be GCed\n  expect(heap.hasObjectWithTag('memlab-mark-2')).toBe(false);\n\n}, 30000);\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/core/src/lib/Types.ts#L1499"},"core/src/lib/Types.ts:1499"))))))}g.isMDXComponent=!0}}]);