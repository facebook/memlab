"use strict";(self.webpackChunkmemlab_website=self.webpackChunkmemlab_website||[]).push([[8807],{540:(e,a,n)=>{n.r(a),n.d(a,{assets:()=>o,contentTitle:()=>i,default:()=>m,frontMatter:()=>l,metadata:()=>r,toc:()=>p});var t=n(8168),s=(n(6540),n(5680));const l={id:"heap_analysis_src.ObjectSizeAnalysis",title:"Class: ObjectSizeAnalysis",sidebar_label:"ObjectSizeAnalysis",custom_edit_url:null},i=void 0,r={unversionedId:"api/classes/heap_analysis_src.ObjectSizeAnalysis",id:"api/classes/heap_analysis_src.ObjectSizeAnalysis",title:"Class: ObjectSizeAnalysis",description:"Hierarchy",source:"@site/docs/api/classes/heap_analysis_src.ObjectSizeAnalysis.md",sourceDirName:"api/classes",slug:"/api/classes/heap_analysis_src.ObjectSizeAnalysis",permalink:"/memlab/docs/api/classes/heap_analysis_src.ObjectSizeAnalysis",draft:!1,editUrl:null,tags:[],version:"current",frontMatter:{id:"heap_analysis_src.ObjectSizeAnalysis",title:"Class: ObjectSizeAnalysis",sidebar_label:"ObjectSizeAnalysis",custom_edit_url:null},sidebar:"sidebar",previous:{title:"ObjectShapeAnalysis",permalink:"/memlab/docs/api/classes/heap_analysis_src.ObjectShapeAnalysis"},next:{title:"ObjectUnboundGrowthAnalysis",permalink:"/memlab/docs/api/classes/heap_analysis_src.ObjectUnboundGrowthAnalysis"}},o={},p=[{value:"Hierarchy",id:"hierarchy",level:2},{value:"Constructors",id:"constructors",level:2},{value:'<a id="new objectsizeanalysis"></a><strong>new ObjectSizeAnalysis</strong>()',id:"new-objectsizeanalysis",level:3},{value:"Methods",id:"methods",level:2},{value:'<a id="analyzesnapshotfromfile"></a><strong>analyzeSnapshotFromFile</strong>(<code>file</code>, <code>options?</code>)',id:"analyzesnapshotfromfilefile-options",level:3},{value:'<a id="getcommandname"></a><strong>getCommandName</strong>()',id:"getcommandname",level:3}],y={toc:p},c="wrapper";function m(e){let{components:a,...n}=e;return(0,s.yg)(c,(0,t.A)({},y,n,{components:a,mdxType:"MDXLayout"}),(0,s.yg)("h2",{id:"hierarchy"},"Hierarchy"),(0,s.yg)("ul",null,(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("p",{parentName:"li"},(0,s.yg)("a",{parentName:"p",href:"/memlab/docs/api/classes/heap_analysis_src.BaseAnalysis"},(0,s.yg)("inlineCode",{parentName:"a"},"BaseAnalysis"))),(0,s.yg)("p",{parentName:"li"},"\u21b3 ",(0,s.yg)("strong",{parentName:"p"},(0,s.yg)("inlineCode",{parentName:"strong"},"ObjectSizeAnalysis"))))),(0,s.yg)("h2",{id:"constructors"},"Constructors"),(0,s.yg)("h3",{id:"new-objectsizeanalysis"},(0,s.yg)("a",{id:"new objectsizeanalysis"}),(0,s.yg)("strong",{parentName:"h3"},"new ObjectSizeAnalysis"),"()"),(0,s.yg)("h2",{id:"methods"},"Methods"),(0,s.yg)("h3",{id:"analyzesnapshotfromfilefile-options"},(0,s.yg)("a",{id:"analyzesnapshotfromfile"}),(0,s.yg)("strong",{parentName:"h3"},"analyzeSnapshotFromFile"),"(",(0,s.yg)("inlineCode",{parentName:"h3"},"file"),", ",(0,s.yg)("inlineCode",{parentName:"h3"},"options?"),")"),(0,s.yg)("p",null,"Run heap analysis for a single heap snapshot file"),(0,s.yg)("ul",null,(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("strong",{parentName:"li"},"Parameters"),":",(0,s.yg)("ul",{parentName:"li"},(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("inlineCode",{parentName:"li"},"file"),": ",(0,s.yg)("inlineCode",{parentName:"li"},"string")," | the absolute path of a ",(0,s.yg)("inlineCode",{parentName:"li"},".heapsnapshot")," file."),(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("inlineCode",{parentName:"li"},"options"),": ",(0,s.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/heap_analysis_src#runheapanalysisoptions"},(0,s.yg)("inlineCode",{parentName:"a"},"RunHeapAnalysisOptions"))," | optional configuration for the heap analysis run"))),(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("strong",{parentName:"li"},"Returns"),": ",(0,s.yg)("inlineCode",{parentName:"li"},"Promise"),"<",(0,s.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/heap_analysis_src#analyzesnapshotresult"},(0,s.yg)("inlineCode",{parentName:"a"},"AnalyzeSnapshotResult")),">"," | this API returns ",(0,s.yg)("a",{parentName:"li",href:"/memlab/docs/api/modules/heap_analysis_src#analyzesnapshotresult"},"AnalyzeSnapshotResult"),", which contains\nthe logging file of analysis console output. Alternatively, to get more\nstructured analysis results, check out the documentation of the hosting\nheap analysis class and call the analysis-specific API to get results\nafter calling this method."),(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("strong",{parentName:"li"},"Example"),":")),(0,s.yg)("pre",null,(0,s.yg)("code",{parentName:"pre",className:"language-typescript"},"const analysis = new StringAnalysis();\n// analysis console output is saved in result.analysisOutputFile\nconst result = await analysis.analyzeSnapshotFromFile(snapshotFile);\n// query analysis-specific and structured results\nconst stringPatterns = analysis.getTopDuplicatedStringsInCount();\n")),(0,s.yg)("p",null,"Additionally, you can specify a working directory to where\nthe intermediate, logging, and final output files will be dumped:"),(0,s.yg)("pre",null,(0,s.yg)("code",{parentName:"pre",className:"language-typescript"},"const analysis = new StringAnalysis();\n// analysis console output is saved in result.analysisOutputFile\n// which is inside the specified working directory\nconst result = await analysis.analyzeSnapshotFromFile(snapshotFile, {\n  // if the specified directory doesn't exist, memlab will create it\n  workDir: '/tmp/your/work/dir',\n});\n")),(0,s.yg)("ul",null,(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("strong",{parentName:"li"},"Source"),":",(0,s.yg)("ul",{parentName:"li"},(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/4ab6546/packages/heap-analysis/src/BaseAnalysis.ts#L95"},"heap-analysis/src/BaseAnalysis.ts:95"))))),(0,s.yg)("hr",null),(0,s.yg)("h3",{id:"getcommandname"},(0,s.yg)("a",{id:"getcommandname"}),(0,s.yg)("strong",{parentName:"h3"},"getCommandName"),"()"),(0,s.yg)("p",null,"Get the name of the heap analysis, which is also used to reference\nthe analysis in memlab command-line tool."),(0,s.yg)("p",null,"The following terminal command will initiate with this analysis:\n",(0,s.yg)("inlineCode",{parentName:"p"},"memlab analyze <ANALYSIS_NAME>")),(0,s.yg)("ul",null,(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("strong",{parentName:"li"},"Returns"),": ",(0,s.yg)("inlineCode",{parentName:"li"},"string")," | the name of the analysis"),(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("strong",{parentName:"li"},"Examples"),":")),(0,s.yg)("pre",null,(0,s.yg)("code",{parentName:"pre",className:"language-typescript"},"const analysis = new YourAnalysis();\nconst name = analysis.getCommandName();\n")),(0,s.yg)("ul",null,(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("strong",{parentName:"li"},"Source"),":",(0,s.yg)("ul",{parentName:"li"},(0,s.yg)("li",{parentName:"ul"},(0,s.yg)("a",{parentName:"li",href:"https://github.com/facebook/memlab/blob/4ab6546/packages/heap-analysis/src/plugins/ObjectSizeAnalysis.ts#L20"},"heap-analysis/src/plugins/ObjectSizeAnalysis.ts:20"))))))}m.isMDXComponent=!0},5680:(e,a,n)=>{n.d(a,{xA:()=>y,yg:()=>g});var t=n(6540);function s(e,a,n){return a in e?Object.defineProperty(e,a,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[a]=n,e}function l(e,a){var n=Object.keys(e);if(Object.getOwnPropertySymbols){var t=Object.getOwnPropertySymbols(e);a&&(t=t.filter((function(a){return Object.getOwnPropertyDescriptor(e,a).enumerable}))),n.push.apply(n,t)}return n}function i(e){for(var a=1;a<arguments.length;a++){var n=null!=arguments[a]?arguments[a]:{};a%2?l(Object(n),!0).forEach((function(a){s(e,a,n[a])})):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(n)):l(Object(n)).forEach((function(a){Object.defineProperty(e,a,Object.getOwnPropertyDescriptor(n,a))}))}return e}function r(e,a){if(null==e)return{};var n,t,s=function(e,a){if(null==e)return{};var n,t,s={},l=Object.keys(e);for(t=0;t<l.length;t++)n=l[t],a.indexOf(n)>=0||(s[n]=e[n]);return s}(e,a);if(Object.getOwnPropertySymbols){var l=Object.getOwnPropertySymbols(e);for(t=0;t<l.length;t++)n=l[t],a.indexOf(n)>=0||Object.prototype.propertyIsEnumerable.call(e,n)&&(s[n]=e[n])}return s}var o=t.createContext({}),p=function(e){var a=t.useContext(o),n=a;return e&&(n="function"==typeof e?e(a):i(i({},a),e)),n},y=function(e){var a=p(e.components);return t.createElement(o.Provider,{value:a},e.children)},c="mdxType",m={inlineCode:"code",wrapper:function(e){var a=e.children;return t.createElement(t.Fragment,{},a)}},u=t.forwardRef((function(e,a){var n=e.components,s=e.mdxType,l=e.originalType,o=e.parentName,y=r(e,["components","mdxType","originalType","parentName"]),c=p(n),u=s,g=c["".concat(o,".").concat(u)]||c[u]||m[u]||l;return n?t.createElement(g,i(i({ref:a},y),{},{components:n})):t.createElement(g,i({ref:a},y))}));function g(e,a){var n=arguments,s=a&&a.mdxType;if("string"==typeof e||s){var l=n.length,i=new Array(l);i[0]=u;var r={};for(var o in a)hasOwnProperty.call(a,o)&&(r[o]=a[o]);r.originalType=e,r[c]="string"==typeof e?e:s,i[1]=r;for(var p=2;p<l;p++)i[p]=n[p];return t.createElement.apply(null,i)}return t.createElement.apply(null,n)}u.displayName="MDXCreateElement"}}]);