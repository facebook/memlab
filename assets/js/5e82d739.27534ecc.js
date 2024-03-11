"use strict";(self.webpackChunkmemlab_website=self.webpackChunkmemlab_website||[]).push([[4612],{2078:(e,a,t)=>{t.r(a),t.d(a,{assets:()=>m,contentTitle:()=>p,default:()=>u,frontMatter:()=>s,metadata:()=>d,toc:()=>c});var n=t(8168),i=(t(6540),t(5680)),o=t(9324);const l="/**\n * Copyright (c) Meta Platforms, Inc. and affiliates.\n *\n * @nolint\n * @oncall web_perf_infra\n */\n\n// memlab/packages/e2e/static/example/scenario/detached-dom.js\n/**\n * The initial `url` of the scenario we would like to run.\n */\nfunction url() {\n  return 'http://localhost:3000/examples/detached-dom';\n}\n\n/**\n * Specify how memlab should perform action that you want\n * to test whether the action is causing memory leak.\n *\n * @param page - Puppeteer's page object:\n * https://pptr.dev/api/puppeteer.page/\n */\nasync function action(page) {\n  const elements = await page.$x(\n    \"//button[contains(., 'Create detached DOMs')]\",\n  );\n  const [button] = elements;\n  if (button) {\n    await button.click();\n  }\n  // clean up external references from memlab\n  await Promise.all(elements.map(e => e.dispose()));\n}\n\n/**\n * Specify how memlab should perform action that would\n * reset the action you performed above.\n *\n * @param page - Puppeteer's page object:\n * https://pptr.dev/api/puppeteer.page/\n */\nasync function back(page) {\n  await page.click('a[href=\"/\"]');\n}\n\nmodule.exports = {action, back, url};\n",r='/**\n * Copyright (c) Meta Platforms, Inc. and affiliates.\n *\n * @nolint\n * @oncall web_perf_infra\n */\n\nimport Link from \'next/link\';\nimport React from \'react\';\n\nexport default function DetachedDom() {\n  const addNewItem = () => {\n    if (!window.leakedObjects) {\n      window.leakedObjects = [];\n    }\n    for (let i = 0; i < 1024; i++) {\n      window.leakedObjects.push(document.createElement(\'div\'));\n    }\n    console.log(\n      \'Detached DOMs are created. Please check Memory tab in devtools\',\n    );\n  };\n\n  return (\n    <div className="container">\n      <div className="row">\n        <Link href="/">Go back</Link>\n      </div>\n      <br />\n      <div className="row">\n        <button type="button" className="btn" onClick={addNewItem}>\n          Create detached DOMs\n        </button>\n      </div>\n    </div>\n  );\n}\n',s={id:"guides-detached-dom"},p="Detect Leaks in a Demo App",d={unversionedId:"guides/guides-detached-dom",id:"guides/guides-detached-dom",title:"Detect Leaks in a Demo App",description:"This is a tutorial demonstrating how to detect detached DOM elements with memlab.",source:"@site/docs/guides/01-detached-dom.mdx",sourceDirName:"guides",slug:"/guides/guides-detached-dom",permalink:"/memlab/docs/guides/guides-detached-dom",draft:!1,editUrl:"https://github.com/facebook/memlab/blob/main/website/docs/guides/01-detached-dom.mdx",tags:[],version:"current",sidebarPosition:1,frontMatter:{id:"guides-detached-dom"},sidebar:"sidebar",previous:{title:"Command Line Interface",permalink:"/memlab/docs/cli/CLI-commands"},next:{title:"Detect Oversized Object",permalink:"/memlab/docs/guides/guides-detect-oversized-object"}},m={},c=[{value:"Set up the Example Web App Under Test",id:"set-up-the-example-web-app-under-test",level:2},{value:"1. Clone Repo",id:"1-clone-repo",level:3},{value:"2. Run the Example App",id:"2-run-the-example-app",level:3},{value:"Find Memory Leaks",id:"find-memory-leaks",level:2},{value:"1. Create a Scenario File",id:"1-create-a-scenario-file",level:3},{value:"2. Run memlab",id:"2-run-memlab",level:3},{value:"3. Debug Leak Trace",id:"3-debug-leak-trace",level:3}],g={toc:c},h="wrapper";function u(e){let{components:a,...s}=e;return(0,i.yg)(h,(0,n.A)({},g,s,{components:a,mdxType:"MDXLayout"}),(0,i.yg)("h1",{id:"detect-leaks-in-a-demo-app"},"Detect Leaks in a Demo App"),(0,i.yg)("p",null,"This is a tutorial demonstrating how to detect detached DOM elements with memlab."),(0,i.yg)("h2",{id:"set-up-the-example-web-app-under-test"},"Set up the Example Web App Under Test"),(0,i.yg)("p",null,'The demo app leaks detached DOM elements when you click the\n"Create detached DOMs" button.\nEach click creates 1024 detached DOM elements, which are referenced\nby the ',(0,i.yg)("inlineCode",{parentName:"p"},"window")," object."),(0,i.yg)("p",null,(0,i.yg)("img",{alt:"memlab run result",src:t(3572).A,width:"1964",height:"974"})),(0,i.yg)(o.A,{showLineNumbers:!0,language:"jsx",mdxType:"CodeBlock"},r),(0,i.yg)("p",null,"Source file: ",(0,i.yg)("a",{target:"_blank",href:t(4227).A},(0,i.yg)("code",null,"packages/e2e/static/example/pages/examples/detached-dom.jsx"))),(0,i.yg)("h3",{id:"1-clone-repo"},"1. Clone Repo"),(0,i.yg)("p",null,"To run the demo web app on you local machine, clone the\n",(0,i.yg)("a",{parentName:"p",href:"https://github.com/facebook/memlab"},(0,i.yg)("inlineCode",{parentName:"a"},"memlab")," github repo"),":"),(0,i.yg)("pre",null,(0,i.yg)("code",{parentName:"pre",className:"language-bash"},"git clone git@github.com:facebook/memlab.git\n")),(0,i.yg)("h3",{id:"2-run-the-example-app"},"2. Run the Example App"),(0,i.yg)("p",null,"Once you have cloned the repo on your local machine, run the following commands\nfrom the root directory of the Memlab project:"),(0,i.yg)("pre",null,(0,i.yg)("code",{parentName:"pre",className:"language-bash"},"npm install && npm run build\ncd packages/e2e/static/example\nnpm install && npm run dev\n")),(0,i.yg)("p",null,"This will spin up an example Nextjs app. Let's make sure it is\nrunning by visiting from your browser\n",(0,i.yg)("a",{parentName:"p",href:"http://localhost:3000"},"http://localhost:3000"),":"),(0,i.yg)("div",{className:"admonition admonition-note alert alert--secondary"},(0,i.yg)("div",{parentName:"div",className:"admonition-heading"},(0,i.yg)("h5",{parentName:"div"},(0,i.yg)("span",{parentName:"h5",className:"admonition-icon"},(0,i.yg)("svg",{parentName:"span",xmlns:"http://www.w3.org/2000/svg",width:"14",height:"16",viewBox:"0 0 14 16"},(0,i.yg)("path",{parentName:"svg",fillRule:"evenodd",d:"M6.3 5.69a.942.942 0 0 1-.28-.7c0-.28.09-.52.28-.7.19-.18.42-.28.7-.28.28 0 .52.09.7.28.18.19.28.42.28.7 0 .28-.09.52-.28.7a1 1 0 0 1-.7.3c-.28 0-.52-.11-.7-.3zM8 7.99c-.02-.25-.11-.48-.31-.69-.2-.19-.42-.3-.69-.31H6c-.27.02-.48.13-.69.31-.2.2-.3.44-.31.69h1v3c.02.27.11.5.31.69.2.2.42.31.69.31h1c.27 0 .48-.11.69-.31.2-.19.3-.42.31-.69H8V7.98v.01zM7 2.3c-3.14 0-5.7 2.54-5.7 5.68 0 3.14 2.56 5.7 5.7 5.7s5.7-2.55 5.7-5.7c0-3.15-2.56-5.69-5.7-5.69v.01zM7 .98c3.86 0 7 3.14 7 7s-3.14 7-7 7-7-3.12-7-7 3.14-7 7-7z"}))),"note")),(0,i.yg)("div",{parentName:"div",className:"admonition-content"},(0,i.yg)("p",{parentName:"div"},"The port number ",(0,i.yg)("inlineCode",{parentName:"p"},":3000")," may be different in your case."))),(0,i.yg)("h2",{id:"find-memory-leaks"},"Find Memory Leaks"),(0,i.yg)("h3",{id:"1-create-a-scenario-file"},"1. Create a Scenario File"),(0,i.yg)(o.A,{language:"jsx",mdxType:"CodeBlock"},l),(0,i.yg)("p",null,"Let's save this file at ",(0,i.yg)("inlineCode",{parentName:"p"},"~/memlab/scenarios/detached-dom.js"),"."),(0,i.yg)("h3",{id:"2-run-memlab"},"2. Run memlab"),(0,i.yg)("p",null,"This may take about a few minutes:"),(0,i.yg)("pre",null,(0,i.yg)("code",{parentName:"pre",className:"language-bash"},"memlab run --scenario ~/memlab/scenarios/detached-dom.js\n")),(0,i.yg)("h3",{id:"3-debug-leak-trace"},"3. Debug Leak Trace"),(0,i.yg)("p",null,"For each leaked object group, memLab prints one representative leak trace."),(0,i.yg)("p",null,(0,i.yg)("img",{alt:"memlab run result",src:t(3893).A,width:"2524",height:"1432"})),(0,i.yg)("p",null,"Let's break down the results from the top to bottom:"),(0,i.yg)("p",null,(0,i.yg)("strong",{parentName:"p"},"Part-1"),": Browser interaction breadcrumb shows the browser\ninteractions (navigations) ",(0,i.yg)("inlineCode",{parentName:"p"},"memlab")," performed as specified in our scenario file."),(0,i.yg)("ul",null,(0,i.yg)("li",{parentName:"ul"},(0,i.yg)("strong",{parentName:"li"},(0,i.yg)("inlineCode",{parentName:"strong"},"page-load[6.5MB](baseline)[s1]"))," - the JavaScript heap size was\n",(0,i.yg)("inlineCode",{parentName:"li"},"6.5MB")," on initial page load. The ",(0,i.yg)("inlineCode",{parentName:"li"},"baseline")," heap snapshot will be saved as\n",(0,i.yg)("inlineCode",{parentName:"li"},"s1.heapsnapshot")," on disk."),(0,i.yg)("li",{parentName:"ul"},(0,i.yg)("strong",{parentName:"li"},(0,i.yg)("inlineCode",{parentName:"strong"},"action-on-page[6.6MB](baseline)[s2]")),' - After clicking the\n"Create detached DOMs" button, the heap size increased to ',(0,i.yg)("inlineCode",{parentName:"li"},"6.6MB"),"."),(0,i.yg)("li",{parentName:"ul"},(0,i.yg)("strong",{parentName:"li"},(0,i.yg)("inlineCode",{parentName:"strong"},"revert[7MB](final)[s3]"))," - The web page finally reached 7MB\nafter navigating away from the page that triggered the memory leak.")),(0,i.yg)("p",null,(0,i.yg)("strong",{parentName:"p"},"Part-2"),": Overall summary of the leak trace"),(0,i.yg)("ul",null,(0,i.yg)("li",{parentName:"ul"},(0,i.yg)("strong",{parentName:"li"},(0,i.yg)("inlineCode",{parentName:"strong"},"1024 leaks"))," - There were 1024 leaked objects.\nLine 12 of the ",(0,i.yg)("a",{parentName:"li",href:"#set-up-the-example-web-app-under-test"},"example app"),"\ncreated ",(0,i.yg)("strong",{parentName:"li"},"1024")," detached DOM objects in the ",(0,i.yg)("inlineCode",{parentName:"li"},"for")," loop."),(0,i.yg)("li",{parentName:"ul"},(0,i.yg)("strong",{parentName:"li"},(0,i.yg)("inlineCode",{parentName:"strong"},"Retained size"))," - the aggregated retained sizes of the leaked objects\ncluster is ",(0,i.yg)("inlineCode",{parentName:"li"},"143.3KB")," (memory leaks are grouped together based on the\nsimilarity of retainer traces).")),(0,i.yg)("p",null,(0,i.yg)("strong",{parentName:"p"},"Part-3"),": Detailed representative ",(0,i.yg)("em",{parentName:"p"},"leak trace")," for each leak cluster"),(0,i.yg)("div",{className:"admonition admonition-note alert alert--secondary"},(0,i.yg)("div",{parentName:"div",className:"admonition-heading"},(0,i.yg)("h5",{parentName:"div"},(0,i.yg)("span",{parentName:"h5",className:"admonition-icon"},(0,i.yg)("svg",{parentName:"span",xmlns:"http://www.w3.org/2000/svg",width:"14",height:"16",viewBox:"0 0 14 16"},(0,i.yg)("path",{parentName:"svg",fillRule:"evenodd",d:"M6.3 5.69a.942.942 0 0 1-.28-.7c0-.28.09-.52.28-.7.19-.18.42-.28.7-.28.28 0 .52.09.7.28.18.19.28.42.28.7 0 .28-.09.52-.28.7a1 1 0 0 1-.7.3c-.28 0-.52-.11-.7-.3zM8 7.99c-.02-.25-.11-.48-.31-.69-.2-.19-.42-.3-.69-.31H6c-.27.02-.48.13-.69.31-.2.2-.3.44-.31.69h1v3c.02.27.11.5.31.69.2.2.42.31.69.31h1c.27 0 .48-.11.69-.31.2-.19.3-.42.31-.69H8V7.98v.01zM7 2.3c-3.14 0-5.7 2.54-5.7 5.68 0 3.14 2.56 5.7 5.7 5.7s5.7-2.55 5.7-5.7c0-3.15-2.56-5.69-5.7-5.69v.01zM7 .98c3.86 0 7 3.14 7 7s-3.14 7-7 7-7-3.12-7-7 3.14-7 7-7z"}))),"note")),(0,i.yg)("div",{parentName:"div",className:"admonition-content"},(0,i.yg)("p",{parentName:"div"},"A ",(0,i.yg)("em",{parentName:"p"},"leak trace")," is an object reference chain from the GC root (the entry objects in a heap graph from which garbage collectors traverse the heap) to a leaked object.\nThe trace shows why and how a leaked object is still kept alive in memory.\nBreaking the reference chain means the leaked object will no longer be reachable\nfrom the GC root, and therefore can be garbage collected."),(0,i.yg)("p",{parentName:"div"},"By following the leak trace one step at a time from the native Window (i.e. the GC root) downward, you will be able to find a\nreference that should be set to ",(0,i.yg)("inlineCode",{parentName:"p"},"null")," (but it wasn't due to a bug)."))),(0,i.yg)("ul",null,(0,i.yg)("li",{parentName:"ul"},(0,i.yg)("p",{parentName:"li"},(0,i.yg)("inlineCode",{parentName:"p"},"map")," - This is the V8 HiddenClass (V8 uses this internally to store meta information about the shape of an object and a reference to its prototype - see more ",(0,i.yg)("a",{parentName:"p",href:"https://v8.dev/blog/fast-properties#hiddenclasses-and-descriptorarrays"},"here"),") of the object being accessed - for the most part this is a V8 implementation detail and can be ignored.")),(0,i.yg)("li",{parentName:"ul"},(0,i.yg)("p",{parentName:"li"},(0,i.yg)("inlineCode",{parentName:"p"},"prototype")," - This is the instance of the ",(0,i.yg)("inlineCode",{parentName:"p"},"Window")," class.")),(0,i.yg)("li",{parentName:"ul"},(0,i.yg)("p",{parentName:"li"},(0,i.yg)("inlineCode",{parentName:"p"},"leakedObjects")," - This shows that ",(0,i.yg)("inlineCode",{parentName:"p"},"leakedObjects")," was a property of the\n",(0,i.yg)("inlineCode",{parentName:"p"},"Window")," object with size ",(0,i.yg)("inlineCode",{parentName:"p"},"148.5KB")," pointing to an ",(0,i.yg)("inlineCode",{parentName:"p"},"Array")," object.")),(0,i.yg)("li",{parentName:"ul"},(0,i.yg)("p",{parentName:"li"},(0,i.yg)("inlineCode",{parentName:"p"},"0")," - This shows that a detached ",(0,i.yg)("inlineCode",{parentName:"p"},"HTMLDIVElement")," (i.e. a DOM element that is not currently connected to the DOM tree) is stored as the first element of the ",(0,i.yg)("inlineCode",{parentName:"p"},"leakedObjects")," array (Since it is overwhelming to show all 1024 leak traces,\nMemlab only prints one representative leak trace. i.e. property 0 instead of properties 0->1023)"),(0,i.yg)("p",{parentName:"li"},"In short, the leak trace path from ",(0,i.yg)("inlineCode",{parentName:"p"},"window")," object to leaked object is:"))),(0,i.yg)("pre",null,(0,i.yg)("code",{parentName:"pre"},"[window](object) -> leakedObjects(property) -> [Array](object)\n  -> 0(element) -> [Detached HTMLDIVElement](native)\n")),(0,i.yg)("p",null,"which matches the leaking code in the example:"),(0,i.yg)("pre",null,(0,i.yg)("code",{parentName:"pre",className:"language-javascript"},"window.leakedObjects = [];\nfor (let i = 0; i < 1024; i++) {\n    window.leakedObjects.push(document.createElement('div'));\n}\n")))}u.isMDXComponent=!0},4227:(e,a,t)=>{t.d(a,{A:()=>n});const n=t.p+"assets/files/detached-dom-40c85aa10e05328f8334efa7c452dee7.jsx"},3572:(e,a,t)=>{t.d(a,{A:()=>n});const n=t.p+"assets/images/example-app-1-bf58237a8a1c1e6b14af7eedfd2e9d6d.png"},3893:(e,a,t)=>{t.d(a,{A:()=>n});const n=t.p+"assets/images/memlab-result-2-b790f31b0db1c07deedc14a75c0f7e86.png"}}]);