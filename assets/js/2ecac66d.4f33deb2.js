"use strict";(self.webpackChunkmemlab_website=self.webpackChunkmemlab_website||[]).push([[8656],{5788:(e,a,n)=>{n.d(a,{Iu:()=>y,yg:()=>u});var t=n(1504);function l(e,a,n){return a in e?Object.defineProperty(e,a,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[a]=n,e}function s(e,a){var n=Object.keys(e);if(Object.getOwnPropertySymbols){var t=Object.getOwnPropertySymbols(e);a&&(t=t.filter((function(a){return Object.getOwnPropertyDescriptor(e,a).enumerable}))),n.push.apply(n,t)}return n}function i(e){for(var a=1;a<arguments.length;a++){var n=null!=arguments[a]?arguments[a]:{};a%2?s(Object(n),!0).forEach((function(a){l(e,a,n[a])})):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(n)):s(Object(n)).forEach((function(a){Object.defineProperty(e,a,Object.getOwnPropertyDescriptor(n,a))}))}return e}function r(e,a){if(null==e)return{};var n,t,l=function(e,a){if(null==e)return{};var n,t,l={},s=Object.keys(e);for(t=0;t<s.length;t++)n=s[t],a.indexOf(n)>=0||(l[n]=e[n]);return l}(e,a);if(Object.getOwnPropertySymbols){var s=Object.getOwnPropertySymbols(e);for(t=0;t<s.length;t++)n=s[t],a.indexOf(n)>=0||Object.prototype.propertyIsEnumerable.call(e,n)&&(l[n]=e[n])}return l}var o=t.createContext({}),p=function(e){var a=t.useContext(o),n=a;return e&&(n="function"==typeof e?e(a):i(i({},a),e)),n},y=function(e){var a=p(e.components);return t.createElement(o.Provider,{value:a},e.children)},c="mdxType",m={inlineCode:"code",wrapper:function(e){var a=e.children;return t.createElement(t.Fragment,{},a)}},g=t.forwardRef((function(e,a){var n=e.components,l=e.mdxType,s=e.originalType,o=e.parentName,y=r(e,["components","mdxType","originalType","parentName"]),c=p(n),g=l,u=c["".concat(o,".").concat(g)]||c[g]||m[g]||s;return n?t.createElement(u,i(i({ref:a},y),{},{components:n})):t.createElement(u,i({ref:a},y))}));function u(e,a){var n=arguments,l=a&&a.mdxType;if("string"==typeof e||l){var s=n.length,i=new Array(s);i[0]=g;var r={};for(var o in a)hasOwnProperty.call(a,o)&&(r[o]=a[o]);r.originalType=e,r[c]="string"==typeof e?e:l,i[1]=r;for(var p=2;p<s;p++)i[p]=n[p];return t.createElement.apply(null,i)}return t.createElement.apply(null,n)}g.displayName="MDXCreateElement"},7940:(e,a,n)=>{n.r(a),n.d(a,{assets:()=>o,contentTitle:()=>i,default:()=>m,frontMatter:()=>s,metadata:()=>r,toc:()=>p});var t=n(5072),l=(n(1504),n(5788));const s={id:"heap_analysis_src.DetachedDOMElementAnalysis",title:"Class: DetachedDOMElementAnalysis",sidebar_label:"DetachedDOMElementAnalysis",custom_edit_url:null},i=void 0,r={unversionedId:"api/classes/heap_analysis_src.DetachedDOMElementAnalysis",id:"api/classes/heap_analysis_src.DetachedDOMElementAnalysis",title:"Class: DetachedDOMElementAnalysis",description:"Hierarchy",source:"@site/docs/api/classes/heap_analysis_src.DetachedDOMElementAnalysis.md",sourceDirName:"api/classes",slug:"/api/classes/heap_analysis_src.DetachedDOMElementAnalysis",permalink:"/memlab/docs/api/classes/heap_analysis_src.DetachedDOMElementAnalysis",draft:!1,editUrl:null,tags:[],version:"current",frontMatter:{id:"heap_analysis_src.DetachedDOMElementAnalysis",title:"Class: DetachedDOMElementAnalysis",sidebar_label:"DetachedDOMElementAnalysis",custom_edit_url:null},sidebar:"sidebar",previous:{title:"CollectionsHoldingStaleAnalysis",permalink:"/memlab/docs/api/classes/heap_analysis_src.CollectionsHoldingStaleAnalysis"},next:{title:"GlobalVariableAnalysis",permalink:"/memlab/docs/api/classes/heap_analysis_src.GlobalVariableAnalysis"}},o={},p=[{value:"Hierarchy",id:"hierarchy",level:2},{value:"Constructors",id:"constructors",level:2},{value:'<a id="new detacheddomelementanalysis"></a><strong>new DetachedDOMElementAnalysis</strong>()',id:"new-detacheddomelementanalysis",level:3},{value:"Methods",id:"methods",level:2},{value:'<a id="analyzesnapshotfromfile"></a><strong>analyzeSnapshotFromFile</strong>(<code>file</code>, <code>options?</code>)',id:"analyzesnapshotfromfilefile-options",level:3},{value:'<a id="getcommandname"></a><strong>getCommandName</strong>()',id:"getcommandname",level:3},{value:'<a id="getdetachedelements"></a><strong>getDetachedElements</strong>()',id:"getdetachedelements",level:3}],y={toc:p},c="wrapper";function m(e){let{components:a,...n}=e;return(0,l.yg)(c,(0,t.c)({},y,n,{components:a,mdxType:"MDXLayout"}),(0,l.yg)("h2",{id:"hierarchy"},"Hierarchy"),(0,l.yg)("ul",null,(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("p",{parentName:"li"},(0,l.yg)("a",{parentName:"p",href:"/memlab/docs/api/classes/heap_analysis_src.BaseAnalysis"},(0,l.yg)("inlineCode",{parentName:"a"},"BaseAnalysis"))),(0,l.yg)("p",{parentName:"li"},"\u21b3 ",(0,l.yg)("strong",{parentName:"p"},(0,l.yg)("inlineCode",{parentName:"strong"},"DetachedDOMElementAnalysis"))))),(0,l.yg)("h2",{id:"constructors"},"Constructors"),(0,l.yg)("h3",{id:"new-detacheddomelementanalysis"},(0,l.yg)("a",{id:"new detacheddomelementanalysis"}),(0,l.yg)("strong",{parentName:"h3"},"new DetachedDOMElementAnalysis"),"()"),(0,l.yg)("h2",{id:"methods"},"Methods"),(0,l.yg)("h3",{id:"analyzesnapshotfromfilefile-options"},(0,l.yg)("a",{id:"analyzesnapshotfromfile"}),(0,l.yg)("strong",{parentName:"h3"},"analyzeSnapshotFromFile"),"(",(0,l.yg)("inlineCode",{parentName:"h3"},"file"),", ",(0,l.yg)("inlineCode",{parentName:"h3"},"options?"),")"),(0,l.yg)("p",null,"Run heap analysis for a single heap snapshot file"),(0,l.yg)("ul",null,(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("strong",{parentName:"li"},"Parameters"),":",(0,l.yg)("ul",{parentName:"li"},(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("inlineCode",{parentName:"li"},"file"),": ",(0,l.yg)("inlineCode",{parentName:"li"},"string")," | the absolute path of a ",(0,l.yg)("inlineCode",{parentName:"li"},".heapsnapshot")," file."),(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("inlineCode",{parentName:"li"},"options"),": ",(0,l.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/heap_analysis_src#runheapanalysisoptions"},(0,l.yg)("inlineCode",{parentName:"a"},"RunHeapAnalysisOptions"))," | optional configuration for the heap analysis run"))),(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("strong",{parentName:"li"},"Returns"),": ",(0,l.yg)("inlineCode",{parentName:"li"},"Promise"),"<",(0,l.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/heap_analysis_src#analyzesnapshotresult"},(0,l.yg)("inlineCode",{parentName:"a"},"AnalyzeSnapshotResult")),">"," | this API returns ",(0,l.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/heap_analysis_src#analyzesnapshotresult"},"AnalyzeSnapshotResult"),", which contains\nthe logging file of analysis console output. Alternatively, to get more\nstructured analysis results, check out the documentation of the hosting\nheap analysis class and call the analysis-specific API to get results\nafter calling this method."),(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("strong",{parentName:"li"},"Example"),":")),(0,l.yg)("pre",null,(0,l.yg)("code",{parentName:"pre",className:"language-typescript"},"const analysis = new StringAnalysis();\n// analysis console output is saved in result.analysisOutputFile\nconst result = await analysis.analyzeSnapshotFromFile(snapshotFile);\n// query analysis-specific and structured results\nconst stringPatterns = analysis.getTopDuplicatedStringsInCount();\n")),(0,l.yg)("p",null,"Additionally, you can specify a working directory to where\nthe intermediate, logging, and final output files will be dumped:"),(0,l.yg)("pre",null,(0,l.yg)("code",{parentName:"pre",className:"language-typescript"},"const analysis = new StringAnalysis();\n// analysis console output is saved in result.analysisOutputFile\n// which is inside the specified working directory\nconst result = await analysis.analyzeSnapshotFromFile(snapshotFile, {\n  // if the specified directory doesn't exist, memlab will create it\n  workDir: '/tmp/your/work/dir',\n});\n")),(0,l.yg)("ul",null,(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("strong",{parentName:"li"},"Source"),":",(0,l.yg)("ul",{parentName:"li"},(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/heap-analysis/src/BaseAnalysis.ts#L95"},"heap-analysis/src/BaseAnalysis.ts:95"))))),(0,l.yg)("hr",null),(0,l.yg)("h3",{id:"getcommandname"},(0,l.yg)("a",{id:"getcommandname"}),(0,l.yg)("strong",{parentName:"h3"},"getCommandName"),"()"),(0,l.yg)("p",null,"Get the name of the heap analysis, which is also used to reference\nthe analysis in memlab command-line tool."),(0,l.yg)("p",null,"The following terminal command will initiate with this analysis:\n",(0,l.yg)("inlineCode",{parentName:"p"},"memlab analyze <ANALYSIS_NAME>")),(0,l.yg)("ul",null,(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("strong",{parentName:"li"},"Returns"),": ",(0,l.yg)("inlineCode",{parentName:"li"},"string")," | the name of the analysis"),(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("strong",{parentName:"li"},"Examples"),":")),(0,l.yg)("pre",null,(0,l.yg)("code",{parentName:"pre",className:"language-typescript"},"const analysis = new YourAnalysis();\nconst name = analysis.getCommandName();\n")),(0,l.yg)("ul",null,(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("strong",{parentName:"li"},"Source"),":",(0,l.yg)("ul",{parentName:"li"},(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts#L20"},"heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:20"))))),(0,l.yg)("hr",null),(0,l.yg)("h3",{id:"getdetachedelements"},(0,l.yg)("a",{id:"getdetachedelements"}),(0,l.yg)("strong",{parentName:"h3"},"getDetachedElements"),"()"),(0,l.yg)("ul",null,(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("strong",{parentName:"li"},"Returns"),": ",(0,l.yg)("inlineCode",{parentName:"li"},"IHeapNode"),"[]"),(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("strong",{parentName:"li"},"Source"),":",(0,l.yg)("ul",{parentName:"li"},(0,l.yg)("li",{parentName:"ul"},(0,l.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/f5ab171/packages/heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts#L47"},"heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:47"))))))}m.isMDXComponent=!0}}]);