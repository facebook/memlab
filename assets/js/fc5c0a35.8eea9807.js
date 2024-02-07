"use strict";(self.webpackChunkmemlab_website=self.webpackChunkmemlab_website||[]).push([[6920],{5788:(e,a,n)=>{n.d(a,{Iu:()=>s,yg:()=>d});var t=n(1504);function r(e,a,n){return a in e?Object.defineProperty(e,a,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[a]=n,e}function l(e,a){var n=Object.keys(e);if(Object.getOwnPropertySymbols){var t=Object.getOwnPropertySymbols(e);a&&(t=t.filter((function(a){return Object.getOwnPropertyDescriptor(e,a).enumerable}))),n.push.apply(n,t)}return n}function i(e){for(var a=1;a<arguments.length;a++){var n=null!=arguments[a]?arguments[a]:{};a%2?l(Object(n),!0).forEach((function(a){r(e,a,n[a])})):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(n)):l(Object(n)).forEach((function(a){Object.defineProperty(e,a,Object.getOwnPropertyDescriptor(n,a))}))}return e}function o(e,a){if(null==e)return{};var n,t,r=function(e,a){if(null==e)return{};var n,t,r={},l=Object.keys(e);for(t=0;t<l.length;t++)n=l[t],a.indexOf(n)>=0||(r[n]=e[n]);return r}(e,a);if(Object.getOwnPropertySymbols){var l=Object.getOwnPropertySymbols(e);for(t=0;t<l.length;t++)n=l[t],a.indexOf(n)>=0||Object.prototype.propertyIsEnumerable.call(e,n)&&(r[n]=e[n])}return r}var c=t.createContext({}),p=function(e){var a=t.useContext(c),n=a;return e&&(n="function"==typeof e?e(a):i(i({},a),e)),n},s=function(e){var a=p(e.components);return t.createElement(c.Provider,{value:a},e.children)},g="mdxType",m={inlineCode:"code",wrapper:function(e){var a=e.children;return t.createElement(t.Fragment,{},a)}},y=t.forwardRef((function(e,a){var n=e.components,r=e.mdxType,l=e.originalType,c=e.parentName,s=o(e,["components","mdxType","originalType","parentName"]),g=p(n),y=r,d=g["".concat(c,".").concat(y)]||g[y]||m[y]||l;return n?t.createElement(d,i(i({ref:a},s),{},{components:n})):t.createElement(d,i({ref:a},s))}));function d(e,a){var n=arguments,r=a&&a.mdxType;if("string"==typeof e||r){var l=n.length,i=new Array(l);i[0]=y;var o={};for(var c in a)hasOwnProperty.call(a,c)&&(o[c]=a[c]);o.originalType=e,o[g]="string"==typeof e?e:r,i[1]=o;for(var p=2;p<l;p++)i[p]=n[p];return t.createElement.apply(null,i)}return t.createElement.apply(null,n)}y.displayName="MDXCreateElement"},488:(e,a,n)=>{n.r(a),n.d(a,{assets:()=>c,contentTitle:()=>i,default:()=>m,frontMatter:()=>l,metadata:()=>o,toc:()=>p});var t=n(5072),r=(n(1504),n(5788));const l={id:"core_src.IScenario",title:"Interface: IScenario",sidebar_label:"IScenario",custom_edit_url:null},i=void 0,o={unversionedId:"api/interfaces/core_src.IScenario",id:"api/interfaces/core_src.IScenario",title:"Interface: IScenario",description:"Test scenario specifies how you want a E2E test to interact with a web browser.",source:"@site/docs/api/interfaces/core_src.IScenario.md",sourceDirName:"api/interfaces",slug:"/api/interfaces/core_src.IScenario",permalink:"/memlab/docs/api/interfaces/core_src.IScenario",draft:!1,editUrl:null,tags:[],version:"current",frontMatter:{id:"core_src.IScenario",title:"Interface: IScenario",sidebar_label:"IScenario",custom_edit_url:null},sidebar:"sidebar",previous:{title:"ILeakFilter",permalink:"/memlab/docs/api/interfaces/core_src.ILeakFilter"}},c={},p=[{value:"Properties",id:"properties",level:2},{value:'<a id="action" name="action"></a> <code>Optional</code> <strong>action</strong>: <code>InteractionsCallback</code>',id:"-optional-action-interactionscallback",level:3},{value:'<a id="back" name="back"></a> <code>Optional</code> <strong>back</strong>: <code>InteractionsCallback</code>',id:"-optional-back-interactionscallback",level:3},{value:'<a id="beforeinitialpageload" name="beforeinitialpageload"></a> <code>Optional</code> <strong>beforeInitialPageLoad</strong>: <code>InteractionsCallback</code>',id:"-optional-beforeinitialpageload-interactionscallback",level:3},{value:'<a id="beforeleakfilter" name="beforeleakfilter"></a> <code>Optional</code> <strong>beforeLeakFilter</strong>: <code>InitLeakFilterCallback</code>',id:"-optional-beforeleakfilter-initleakfiltercallback",level:3},{value:'<a id="ispageloaded" name="ispageloaded"></a> <code>Optional</code> <strong>isPageLoaded</strong>: <code>CheckPageLoadCallback</code>',id:"-optional-ispageloaded-checkpageloadcallback",level:3},{value:'<a id="leakfilter" name="leakfilter"></a> <code>Optional</code> <strong>leakFilter</strong>: <code>LeakFilterCallback</code>',id:"-optional-leakfilter-leakfiltercallback",level:3},{value:'<a id="retainerreferencefilter" name="retainerreferencefilter"></a> <code>Optional</code> <strong>retainerReferenceFilter</strong>: <code>ReferenceFilterCallback</code>',id:"-optional-retainerreferencefilter-referencefiltercallback",level:3},{value:'<a id="setup" name="setup"></a> <code>Optional</code> <strong>setup</strong>: <code>InteractionsCallback</code>',id:"-optional-setup-interactionscallback",level:3},{value:"Methods",id:"methods",level:2},{value:'<a id="cookies"></a><code>Optional</code> <strong>cookies</strong>()',id:"optional-cookies",level:3},{value:'<a id="repeat"></a><code>Optional</code> <strong>repeat</strong>()',id:"optional-repeat",level:3},{value:'<a id="url"></a><strong>url</strong>()',id:"url",level:3}],s={toc:p},g="wrapper";function m(e){let{components:a,...n}=e;return(0,r.yg)(g,(0,t.c)({},s,n,{components:a,mdxType:"MDXLayout"}),(0,r.yg)("p",null,"Test scenario specifies how you want a E2E test to interact with a web browser.\nThe test scenario can be saved as a ",(0,r.yg)("inlineCode",{parentName:"p"},".js")," file and passed to the ",(0,r.yg)("inlineCode",{parentName:"p"},"memlab\nrun --scenario")," command:"),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-javascript"},"// save as test.js and use in terminal:\n// $ memlab run --scenario test.js\n\nmodule.exports = {\n  url: () => 'https://www.npmjs.com/',\n  action: async () => ... ,\n  back: async () => ... ,\n  cookies: () => ... , // optional\n  repeat: () => ... , // optional\n  ...\n};\n")),(0,r.yg)("p",null,"The test scenario instance can also be passed to the\n",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/modules/api_src#run"},"run")," API exported by ",(0,r.yg)("inlineCode",{parentName:"p"},"@memlab/api"),"."),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"const {run} = require('@memlab/api');\n\n(async function () {\n  const scenario = {\n    url: () => 'https://www.facebook.com',\n    action: async () => ... ,\n    back: async () => ... ,\n    cookies: () => ... , // optional\n    repeat: () => ... , // optional\n    ...\n  };\n  const leaks = await run({scenario});\n})();\n")),(0,r.yg)("h2",{id:"properties"},"Properties"),(0,r.yg)("h3",{id:"-optional-action-interactionscallback"},(0,r.yg)("a",{id:"action",name:"action"})," ",(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"action"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/modules/core_src#interactionscallback"},(0,r.yg)("inlineCode",{parentName:"a"},"InteractionsCallback"))),(0,r.yg)("p",null,(0,r.yg)("inlineCode",{parentName:"p"},"action")," is the callback function that defines the interaction\nwhere you want to trigger memory leaks after the initial page load.\nAll JS objects in browser allocated by the browser interactions triggered\nfrom the ",(0,r.yg)("inlineCode",{parentName:"p"},"action")," callback will be candidates for memory leak filtering."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"page"),": ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"))," | the puppeteer\n",(0,r.yg)("a",{parentName:"li",href:"https://pptr.dev/api/puppeteer.page"},(0,r.yg)("inlineCode",{parentName:"a"},"Page")),"\nobject, which provides APIs to interact with the web browser. To import\nthis type, check out ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"),"."))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"const scenario = {\n  url: () => 'https://www.npmjs.com/',\n  action: async (page) => {\n    await page.click('a[href=\"/link\"]');\n  },\n  back: async (page) => {\n    await page.click('a[href=\"/back\"]');\n  },\n}\n\nmodule.exports = scenario;\n")),(0,r.yg)("p",null,"Note: always clean up external puppeteer references to JS objects\nin the browser context."),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"const scenario = {\n  url: () => 'https://www.npmjs.com/',\n  action: async (page) => {\n    const elements = await page.$x(\"//button[contains(., 'Text in Button')]\");\n    const [button] = elements;\n    if (button) {\n      await button.click();\n    }\n    // dispose external references to JS objects in browser context\n    await promise.all(elements.map(e => e.dispose()));\n  },\n  back: async (page) => ... ,\n}\n\nmodule.exports = scenario;\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L829"},"core/src/lib/Types.ts:829"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-optional-back-interactionscallback"},(0,r.yg)("a",{id:"back",name:"back"})," ",(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"back"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/modules/core_src#interactionscallback"},(0,r.yg)("inlineCode",{parentName:"a"},"InteractionsCallback"))),(0,r.yg)("p",null,(0,r.yg)("inlineCode",{parentName:"p"},"back")," is the callback function that specifies how memlab should\nback/revert the ",(0,r.yg)("inlineCode",{parentName:"p"},"action")," callback. Think of it as an undo action."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"page"),": ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"))," | the puppeteer\n",(0,r.yg)("a",{parentName:"li",href:"https://pptr.dev/api/puppeteer.page"},(0,r.yg)("inlineCode",{parentName:"a"},"Page")),"\nobject, which provides APIs to interact with the web browser. To import\nthis type, check out ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"),"."))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"const scenario = {\n  url: () => 'https://www.npmjs.com/',\n  action: async (page) => {\n    await page.click('a[href=\"/link\"]');\n  },\n  back: async (page) => {\n    await page.click('a[href=\"/back\"]');\n  },\n}\n")),(0,r.yg)("p",null,"Check out ",(0,r.yg)("a",{parentName:"p",href:"/docs/how-memlab-works"},"this page")," on why\nmemlab needs to undo/revert the ",(0,r.yg)("inlineCode",{parentName:"p"},"action")," callback."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L855"},"core/src/lib/Types.ts:855"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-optional-beforeinitialpageload-interactionscallback"},(0,r.yg)("a",{id:"beforeinitialpageload",name:"beforeinitialpageload"})," ",(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"beforeInitialPageLoad"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/modules/core_src#interactionscallback"},(0,r.yg)("inlineCode",{parentName:"a"},"InteractionsCallback"))),(0,r.yg)("p",null,(0,r.yg)("inlineCode",{parentName:"p"},"beforeInitialPageLoad")," is the callback function that will be called only\nonce before the initial page load. This callback can be used to set up\nthe HTTP headers or to prepare data before loading the web page."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"page"),": ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"))," | the puppeteer\n",(0,r.yg)("a",{parentName:"li",href:"https://pptr.dev/api/puppeteer.page"},(0,r.yg)("inlineCode",{parentName:"a"},"Page")),"\nobject, which provides APIs to interact with the web browser. To import\nthis type, check out ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"),"."))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"const scenario = {\n  url: () => 'https://www.npmjs.com/',\n  beforeInitialPageLoad: async (page) => {\n    // before the initial page load\n  },\n  action: async (page) => {\n    await page.click('a[href=\"/link\"]');\n  },\n  back: async (page) => {\n    await page.click('a[href=\"/back\"]');\n  },\n}\n\nmodule.exports = scenario;\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L733"},"core/src/lib/Types.ts:733"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-optional-beforeleakfilter-initleakfiltercallback"},(0,r.yg)("a",{id:"beforeleakfilter",name:"beforeleakfilter"})," ",(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"beforeLeakFilter"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/modules/core_src#initleakfiltercallback"},(0,r.yg)("inlineCode",{parentName:"a"},"InitLeakFilterCallback"))),(0,r.yg)("p",null,"Lifecycle function callback that is invoked initially once before\nthe subsequent ",(0,r.yg)("inlineCode",{parentName:"p"},"leakFilter")," function calls. This callback could\nbe used to initialize some data stores or to any one-off\npreprocessings."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"snapshot"),": ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/interfaces/core_src.IHeapSnapshot"},"IHeapSnapshot"))," | the final heap\nsnapshot taken after all browser interactions are done.\nCheck out ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/interfaces/core_src.IHeapSnapshot"},"IHeapSnapshot")," for more APIs that queries the\nheap snapshot."),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"leakedNodeIds"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"Set<number>")," | the set of ids of all JS heap objects\nallocated by the ",(0,r.yg)("inlineCode",{parentName:"li"},"action")," call but not released after the ",(0,r.yg)("inlineCode",{parentName:"li"},"back")," call\nin browser."))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"module.exports = {\n  url: () => ... ,\n  action: async (page) => ... ,\n  back: async (page) => ... ,\n  beforeLeakFilter: (snapshot, leakedNodeIds) {\n    // initialize some data stores\n  },\n};\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L941"},"core/src/lib/Types.ts:941"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-optional-ispageloaded-checkpageloadcallback"},(0,r.yg)("a",{id:"ispageloaded",name:"ispageloaded"})," ",(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"isPageLoaded"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/modules/core_src#checkpageloadcallback"},(0,r.yg)("inlineCode",{parentName:"a"},"CheckPageLoadCallback"))),(0,r.yg)("p",null,"Optional callback function that checks if the web page is loaded\nfor the initial page load and subsequent browser interactions."),(0,r.yg)("p",null,"If this callback is not provided, memlab by default\nconsiders a navigation to be finished when there are no network\nconnections for at least 500ms."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"page"),": ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"))," | the puppeteer\n",(0,r.yg)("a",{parentName:"li",href:"https://pptr.dev/api/puppeteer.page"},(0,r.yg)("inlineCode",{parentName:"a"},"Page")),"\nobject, which provides APIs to interact with the web browser. To import\nthis type, check out ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"),"."))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": a boolean value, if it returns ",(0,r.yg)("inlineCode",{parentName:"p"},"true"),", memlab will consider\nthe navigation completes, if it returns ",(0,r.yg)("inlineCode",{parentName:"p"},"false"),", memlab will keep calling\nthis callback until it returns ",(0,r.yg)("inlineCode",{parentName:"p"},"true"),". This is an async callback, you can\nalso ",(0,r.yg)("inlineCode",{parentName:"p"},"await")," and returns ",(0,r.yg)("inlineCode",{parentName:"p"},"true")," until some async logic is resolved.")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"module.exports = {\n  url: () => ... ,\n  action: async (page) => ... ,\n  back: async (page) => ... ,\n  isPageLoaded: async (page) => {\n    await page.waitForNavigation({\n      // consider navigation to be finished when there are\n      // no more than 2 network connections for at least 500 ms.\n      waitUntil: 'networkidle2',\n      // Maximum navigation time in milliseconds\n      timeout: 5000,\n    });\n    return true;\n  },\n};\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L913"},"core/src/lib/Types.ts:913"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-optional-leakfilter-leakfiltercallback"},(0,r.yg)("a",{id:"leakfilter",name:"leakfilter"})," ",(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"leakFilter"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/modules/core_src#leakfiltercallback"},(0,r.yg)("inlineCode",{parentName:"a"},"LeakFilterCallback"))),(0,r.yg)("p",null,"This callback defines how you want to filter out the\nleaked objects. The callback is called for every node (JS heap\nobject in browser) allocated by the ",(0,r.yg)("inlineCode",{parentName:"p"},"action")," callback, but not\nreleased after the ",(0,r.yg)("inlineCode",{parentName:"p"},"back")," callback. Those objects could be caches\nthat are retained in memory on purpose, or they are memory leaks."),(0,r.yg)("p",null,"This optional callback allows you to define your own algorithm\nto cherry pick memory leaks for specific JS program under test."),(0,r.yg)("p",null,"If this optional callback is not defined, memlab will use its\nbuilt-in leak filter, which considers detached DOM elements\nand unmounted Fiber nodes (detached from React Fiber tree) as\nmemory leaks."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"node"),": ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/interfaces/core_src.IHeapNode"},"IHeapNode"))," | the heap object\nallocated but not released. This filter callback will be applied\nto each node allocated but not released in the heap snapshot."),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"snapshot"),": ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/interfaces/core_src.IHeapSnapshot"},"IHeapSnapshot"))," | the final heap\nsnapshot taken after all browser interactions are done.\nCheck out ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/interfaces/core_src.IHeapSnapshot"},"IHeapSnapshot")," for more APIs that queries the\nheap snapshot."),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"leakedNodeIds"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"Set<number>")," | the set of ids of all JS heap objects\nallocated by the ",(0,r.yg)("inlineCode",{parentName:"li"},"action")," call but not released after the ",(0,r.yg)("inlineCode",{parentName:"li"},"back")," call\nin browser."))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": the boolean value indicating whether the given node in\nthe snapshot should be considered as leaked.")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"module.exports = {\n  url: () => ... ,\n  action: async (page) => ... ,\n  back: async (page) => ... ,\n  leakFilter(node, snapshot, leakedNodeIds) {\n    // any unreleased node (JS heap object) with 1MB+\n    // retained size is considered a memory leak\n    return node.retainedSize > 1000000;\n  },\n};\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L986"},"core/src/lib/Types.ts:986"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-optional-retainerreferencefilter-referencefiltercallback"},(0,r.yg)("a",{id:"retainerreferencefilter",name:"retainerreferencefilter"})," ",(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"retainerReferenceFilter"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/modules/core_src#referencefiltercallback"},(0,r.yg)("inlineCode",{parentName:"a"},"ReferenceFilterCallback"))),(0,r.yg)("p",null,"Callback that can be used to define a logic to decide whether\na reference should be considered as part of the retainer trace.\nThe callback is called for every reference (edge) in the heap snapshot."),(0,r.yg)("p",null,"For concrete examples, check out ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IScenario#leakfilter"},"leakFilter"),"."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"edge")," : ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/interfaces/core_src.IHeapEdge"},"IHeapEdge"))," | the reference (edge)\nthat is considered for calcualting the retainer trace"),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"snapshot"),": ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/interfaces/core_src.IHeapSnapshot"},"IHeapSnapshot"))," | the heap snapshot\ntaken after all browser interactions are done.\nCheck out ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/interfaces/core_src.IHeapSnapshot"},"IHeapSnapshot")," for more APIs that queries the\nheap snapshot."),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"isReferenceUsedByDefault"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"boolean")," | MemLab has its own default\nlogic for whether a reference should be considered as part of the\nretainer trace, if this parameter is true, it means MemLab will\nconsider this reference when calculating the retainer trace."))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": the value indicating whether the given reference should be\nconsidered when calculating the retainer trace. Note that when this\ncallback returns true, the reference will only be considered as a candidate\nfor retainer trace, so it may or may not be included in the retainer trace;\nhowever, if this callback returns false, the reference will be excluded."))),(0,r.yg)("p",null,"Note that by excluding a dominator reference of an object (i.e., an edge\nthat must be traveled through to reach the heap object from GC roots),\nthe object will be considered as unreachable in the heap graph; and\ntherefore, the reference and heap object will not be included in the\nretainer trace detection and retainer size calculation."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Examples"),":")),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-javascript"},"// save as leak-filter.js\nmodule.exports = {\n  retainerReferenceFilter(edge, _snapshot, _leakedNodeIds) {\n    // exclude react fiber references\n    if (edge.name_or_index.toString().startsWith('__reactFiber$')) {\n      return false;\n    }\n    return true;\n  }\n};\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L1032"},"core/src/lib/Types.ts:1032"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"-optional-setup-interactionscallback"},(0,r.yg)("a",{id:"setup",name:"setup"})," ",(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"setup"),": ",(0,r.yg)("a",{parentName:"h3",href:"/memlab/docs/api/modules/core_src#interactionscallback"},(0,r.yg)("inlineCode",{parentName:"a"},"InteractionsCallback"))),(0,r.yg)("p",null,(0,r.yg)("inlineCode",{parentName:"p"},"setup")," is the callback function that will be called only once\nafter the initial page load. This callback can be used to log in\nif you have to (we recommend using ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IScenario#cookies"},"cookies"),")\nor to prepare data before the ",(0,r.yg)("a",{parentName:"p",href:"/memlab/docs/api/interfaces/core_src.IScenario#action"},"action")," call."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Parameters"),":"),(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("inlineCode",{parentName:"li"},"page"),": ",(0,r.yg)("code",null,(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"))," | the puppeteer\n",(0,r.yg)("a",{parentName:"li",href:"https://pptr.dev/api/puppeteer.page"},(0,r.yg)("inlineCode",{parentName:"a"},"Page")),"\nobject, which provides APIs to interact with the web browser. To import\nthis type, check out ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#page"},"Page"),"."))),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"const scenario = {\n  url: () => 'https://www.npmjs.com/',\n  setup: async (page) => {\n    // log in or prepare data for the interaction\n  },\n  action: async (page) => {\n    await page.click('a[href=\"/link\"]');\n  },\n  back: async (page) => {\n    await page.click('a[href=\"/back\"]');\n  },\n}\n\nmodule.exports = scenario;\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L782"},"core/src/lib/Types.ts:782"))))),(0,r.yg)("h2",{id:"methods"},"Methods"),(0,r.yg)("h3",{id:"optional-cookies"},(0,r.yg)("a",{id:"cookies"}),(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"cookies"),"()"),(0,r.yg)("p",null,"If the page you are running memlab against requires authentication or\nspecific cookie(s) to be set, you can pass them as\na list of ",(0,r.yg)("inlineCode",{parentName:"p"},"<name, value, domain>")," tuples."),(0,r.yg)("p",null,(0,r.yg)("strong",{parentName:"p"},"Note"),": please make sure that you provide the correct ",(0,r.yg)("inlineCode",{parentName:"p"},"domain")," field for\nthe cookies tuples. If no ",(0,r.yg)("inlineCode",{parentName:"p"},"domain")," field is specified, memlab will try\nto fill in a domain based on the ",(0,r.yg)("inlineCode",{parentName:"p"},"url")," callback.\nFor example, when the ",(0,r.yg)("inlineCode",{parentName:"p"},"domain")," field is absent,\nmemlab will auto fill in ",(0,r.yg)("inlineCode",{parentName:"p"},".facebook.com")," as domain base\non the initial page load's url: ",(0,r.yg)("inlineCode",{parentName:"p"},"https://www.facebook.com/"),"."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Returns"),": ",(0,r.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/core_src#cookies"},(0,r.yg)("inlineCode",{parentName:"a"},"Cookies"))," | cookie list"),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Examples"),":")),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"const scenario = {\n  url: () => 'https://www.facebook.com/',\n  cookies: () => [\n    {name:'cm_j', value: 'none', domain: '.facebook.com'},\n    {name:'datr', value: 'yJvIY...', domain: '.facebook.com'},\n    {name:'c_user', value: '8917...', domain: '.facebook.com'},\n    {name:'xs', value: '95:9WQ...', domain: '.facebook.com'},\n    // ...\n  ],\n};\n\nmodule.exports = scenario;\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L703"},"core/src/lib/Types.ts:703"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"optional-repeat"},(0,r.yg)("a",{id:"repeat"}),(0,r.yg)("inlineCode",{parentName:"h3"},"Optional")," ",(0,r.yg)("strong",{parentName:"h3"},"repeat"),"()"),(0,r.yg)("p",null,"Specifies how many ",(0,r.yg)("strong",{parentName:"p"},"extra")," ",(0,r.yg)("inlineCode",{parentName:"p"},"action")," and ",(0,r.yg)("inlineCode",{parentName:"p"},"back")," actions performed\nby memlab."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Returns"),": a number value specifies the number of extra actions.")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("p",{parentName:"li"},(0,r.yg)("strong",{parentName:"p"},"Examples"),":"))),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"module.exports = {\n  url: () => ... ,\n  action: async (page) => ... ,\n  back: async (page) => ... ,\n  // browser interaction: two additional [ action -> back ]\n  // init-load -> action -> back -> action -> back -> action -> back\n  repeat: () => 2,\n};\n")),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Returns"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"number")),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L874"},"core/src/lib/Types.ts:874"))))),(0,r.yg)("hr",null),(0,r.yg)("h3",{id:"url"},(0,r.yg)("a",{id:"url"}),(0,r.yg)("strong",{parentName:"h3"},"url"),"()"),(0,r.yg)("p",null,"String value of the initial url of the page."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Returns"),": ",(0,r.yg)("inlineCode",{parentName:"li"},"string")," | the string value of the initial url"),(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Examples"),":")),(0,r.yg)("pre",null,(0,r.yg)("code",{parentName:"pre",className:"language-typescript"},"const scenario = {\n  url: () => 'https://www.npmjs.com/',\n};\n\nmodule.exports = scenario;\n")),(0,r.yg)("p",null,"If a test scenario only specifies the ",(0,r.yg)("inlineCode",{parentName:"p"},"url")," callback (without the ",(0,r.yg)("inlineCode",{parentName:"p"},"action"),"\ncallback), memlab will try to detect memory leaks from the initial page\nload. All objects allocated by the initial page load will be candidates\nfor memory leak filtering."),(0,r.yg)("ul",null,(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("strong",{parentName:"li"},"Source"),":",(0,r.yg)("ul",{parentName:"li"},(0,r.yg)("li",{parentName:"ul"},(0,r.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/bb1a3b6/packages/core/src/lib/Types.ts#L751"},"core/src/lib/Types.ts:751"))))))}m.isMDXComponent=!0}}]);