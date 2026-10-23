/* eslint-disable @typescript-eslint/no-explicit-any -- Offline Framer renderer; no live data or requests. */
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import ts from "typescript";
import {JSDOM,VirtualConsole} from "jsdom";

const require=createRequire(import.meta.url);
const renderer=(name:string)=>require(process.env.MM_HYDRATION_REACT_ROOT?resolve(process.env.MM_HYDRATION_REACT_ROOT,"node_modules",name):name);
const React=renderer("react"),{renderToString}=renderer("react-dom/server");
const source=readFileSync(new URL("../framer/CMSProductCarousel.tsx",import.meta.url),"utf8");
const sizes="(min-width: 1200px) 276px, (min-width: 768px) calc((100vw - 152px) / 2), (min-width: 388px) 316px, calc(100vw - 72px)";
const images=[{image:{src:"https://images.example.invalid/one.jpg",srcSet:"https://images.example.invalid/one-small.jpg 512w, https://images.example.invalid/one.jpg 1024w",alt:"Original photo"}},{image:{src:"https://images.example.invalid/two.jpg",alt:"Second photo"}}];
function load(win?:any){
 const fixtureModule={exports:{} as any};const tags=new Map();
 const motion=new Proxy({}, {get(_target,tag:string){if(!tags.has(tag))tags.set(tag,React.forwardRef(function MotionFixture(props:any,ref:any){const attributes={...props,ref};for(const k of ["initial","animate","exit","transition"])delete attributes[k];return React.createElement(tag,attributes)}));return tags.get(tag)}});
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function("require","module","exports","window",compiled)((name:string)=>{
  if(name==="framer")return{addPropertyControls(){},ControlType:{},useIsStaticRenderer:()=>false};
  if(name==="framer-motion")return{motion,AnimatePresence:({children}:any)=>children};
  assert.ok(["react","react/jsx-runtime"].includes(name));return renderer(name);
 },fixtureModule,fixtureModule.exports,win);return fixtureModule.exports.default;
}
const Component=load();
function render(props:Record<string,unknown>={}){
 const console=new VirtualConsole();
 return new JSDOM(renderToString(React.createElement(Component,{carouselImages:images,...props})),{virtualConsole:console});
}
test("the first CMS item is eager and high priority directly in server HTML",()=>{
 const dom=render({collectionIndex:1,imageSizes:sizes}),img=dom.window.document.querySelector("img")!;
 assert.equal(img.getAttribute("loading"),"eager");assert.equal(img.getAttribute("fetchpriority"),"high");
 assert.equal(img.getAttribute("sizes"),sizes);assert.equal(img.getAttribute("decoding"),"async");
 assert.equal(img.getAttribute("src"),images[0].image.src);assert.equal(img.getAttribute("srcset"),images[0].image.srcSet);
 assert.equal(img.style.objectFit,"cover");assert.equal(img.style.objectPosition,"center");dom.window.close();
});
test("later CMS products use native lazy loading without competing for high priority",()=>{
 for(const collectionIndex of [2,3,20]){const dom=render({collectionIndex}),img=dom.window.document.querySelector("img")!;
 assert.equal(img.getAttribute("loading"),"lazy");assert.equal(img.getAttribute("fetchpriority"),"auto");
 assert.equal(dom.window.document.querySelectorAll(".mm-product-carousel img").length,1);dom.window.close();}
});
test("unbound carousel instances do not accidentally defer a visible image",()=>{
 const dom=render(),img=dom.window.document.querySelector("img")!;assert.equal(img.getAttribute("loading"),"eager");assert.equal(img.getAttribute("fetchpriority"),"auto");assert.equal(img.sizes,"100vw");dom.window.close();
});
test("index-aware priority hydrates without warnings and carousel navigation stays eager",async()=>{
 const props={carouselImages:images,collectionIndex:2,imageSizes:sizes};
 const dom=new JSDOM(`<div id="root">${renderToString(React.createElement(Component,props))}</div>`,{url:"https://review.example.invalid/",virtualConsole:new VirtualConsole()});
 const win=dom.window as any,originals=new Map();
 for(const [key,value]of Object.entries({window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true});}
 const original=win.document.querySelector(".mm-product-carousel"),warnings:unknown[]=[],recoveries:unknown[]=[];const originalError=console.error;console.error=(...args:unknown[])=>warnings.push(args);let root:any;
 try{
  const Client=load(win);await React.act(async()=>{root=renderer("react-dom/client").hydrateRoot(win.document.getElementById("root"),React.createElement(Client,props),{onRecoverableError:(error:unknown)=>recoveries.push(error)});});
  assert.equal(win.document.querySelector(".mm-product-carousel"),original);assert.deepEqual(recoveries,[]);assert.deepEqual(warnings,[]);
  await React.act(async()=>original.querySelector('[aria-label="Next product image"]').click());
  assert.equal(original.querySelector("img").src,images[1].image.src);assert.equal(original.querySelector("img").getAttribute("loading"),"eager");assert.equal(original.querySelector("img").getAttribute("fetchpriority"),"auto");
 }finally{if(root)await React.act(async()=>root.unmount());console.error=originalError;dom.window.close();for(const[key,descriptor]of originals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
});
test("hero preload is mobile and homepage only, with no layout or analytics changes",()=>{
 const html=readFileSync(new URL("../framer/mobile-image-preload.html",import.meta.url),"utf8");
 for(const path of ["/","/amina","/hawa","/admin","/checkout"]){
  const dom=new JSDOM(`<!doctype html><head>${html}</head><body></body>`,{url:"https://review.example.invalid"+path,runScripts:"dangerously"});
  const links=dom.window.document.querySelectorAll('link[rel="preload"][as="image"]');assert.equal(links.length,path==="/"?1:0);
  if(path==="/"){const link=links[0]as HTMLLinkElement;assert.equal(link.media,"(max-width: 767.98px)");assert.equal(link.getAttribute("imagesizes"),"100vw");assert.match(link.getAttribute("imagesrcset")!,/512w,.*1024w,.*1445w/);assert.equal(link.getAttribute("fetchpriority"),"high");}
  assert.equal(dom.window.document.body.children.length,0);dom.window.close();
 }
});
