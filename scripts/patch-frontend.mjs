export function patchSessionBarriers(source) {
  let changes = 0;
  const patched = source.replace(
    /async function (invoke(?:\$\d+)?)\(e,t=\{\},n\)\{return window\.__TAURI_INTERNALS__\.invoke\(e,t,n\)\}/g,
    (_, name) => {
      changes += 1;
      return `async function ${name}(e,t={},n){if(e==="open_login_window"||e==="open_panel_window"||e==="plugin:event|emit"&&(t.event==="cat-auth-login-success"||t.event==="cat-auth-logout"))await window.__WUWATAPPO_SESSION__?.flush();return window.__TAURI_INTERNALS__.invoke(e,t,n)}`;
    },
  );
  // 1.0.3 keeps one invoke wrapper in the entry module; the plugin-dialog copy moved to its own
  // chunk (assets/index-BtAv0o2S.js) and never issues a barrier command, so one wrapper is complete.
  if (changes !== 1) throw new Error(`Expected 1 original Tauri invoke wrapper, found ${changes}. Reconcile the app version before building.`);
  return patched;
}

export function patchLoginReady(source) {
  const original='function N(n){return o(u,t=>{n(t.payload??{})})}';
  const replacement='async function N(n){const unlisten=await o(u,t=>{n(t.payload??{})});await window.__TAURI_INTERNALS__.invoke("login_window_ready");return unlisten}';
  if(source.split(original).length!==2) throw new Error('Original login listener bridge changed; reconcile modal readiness before building.');
  return source.replace(original,replacement);
}

export function patchDomesticSdkUrls(source) {
  if (!source.includes('const APP_REGION="CN"')) {
    throw new Error('Expected the official CN frontend. Extract the CN installer before building.');
  }
  let changes = 0;
  const patched = source.replace(
    /(isdk(?:Src|Css)=")(\/\/pro-cdn-sdk\.kurogame\.com\/pro\/web-sdk\/1\.x\/(?:kr-sdk\.js|style\.css)")/g,
    (_, prefix, url) => {
      changes += 1;
      return `${prefix}https:${url}`;
    },
  );
  if (changes !== 2) throw new Error(`Expected 2 CN SDK URLs, found ${changes}. Reconcile the app version before building.`);
  return patched;
}

export function patchDomesticLoginReload(source) {
  const start = 'async function we(e=!1){if(E)return E;if(!e&&$())';
  const end = 'async function me()';
  const insertion = ',document.head.appendChild(t),r=window.setTimeout(';
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset);
  if (offset < 0 || limit < 0 || source.split(start).length !== 2) {
    throw new Error('Original CN SDK reload function changed; reconcile the login reload patch before building.');
  }
  const loader = source.slice(offset, limit);
  if (!loader.includes('t.dataset.kuroSdkRetry="true"') || loader.split(insertion).length !== 2) {
    throw new Error('Original CN SDK script insertion changed; reconcile the login reload patch before building.');
  }
  const replacement = ',e&&([...document.scripts].filter(s=>s.src===t.src).forEach(s=>s.remove()),document.getElementById("KrSDK")?.remove())' + insertion;
  return source.slice(0, offset) + loader.replace(insertion, replacement) + source.slice(limit);
}

export function patchMacUpdateFeedback(source) {
  // The i18n alias is minified per build (1.0.2 "n", 1.0.3 "t"), so match and re-emit whichever one the bundle carries.
  const pattern = /if\(([$\w]+)\.kind==="error"\)\{([^{}]*?)([$\w]+)\.value=([$\w]+)\("setting_version_check_failed"\);return\}/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('Original update feedback changed; reconcile the Mac update message before building.');
  return source.replace(pattern, (_, error, before, target, i18n) => `if(${error}.kind==="error"){${before}${target}.value=${error}.message||${i18n}("setting_version_check_failed");return}`);
}

export function patchMacUpdater(source) {
  const resolver = 'async function resolveUpdaterLatestJsonUrl(){const e=resolveUpdaterLatestHostJsonUrl();if(!e)return null;';
  const recovery = 'async function resolveUpdaterLatestJsonUrl(){let e=resolveUpdaterLatestHostJsonUrl();if(!e){const config=unwrapApiData(await activityInfo());const host=typeof config?.assets_host==="string"?config.assets_host.trim():"";if(!host||host===LOCAL_ROLE_ASSETS_HOST)throw new Error("官方配置缺少更新资源地址");setUpdaterAssetsHost(host,{triggerSilentCheck:!1});e=resolveUpdaterLatestHostJsonUrl()}';
  const failure = 'if(logDiagnostic("UPDATE","check_failed",{stage:"check",reason_code:diagnosticErrorCode(t),fallback:e?.interactive?"report_error":"treat_as_latest"},"warn"),e?.interactive)return{kind:"error",message:n};try{const s=await getVersion();return console.warn("[updater] check skipped (treat as latest)",t),{kind:"none",currentVersion:s}}catch{return{kind:"error",message:n}}';
  const report = 'return logDiagnostic("UPDATE","check_failed",{stage:"check",reason_code:diagnosticErrorCode(t),fallback:"report_error"},"warn"),{kind:"error",message:n}';
  for (const original of [resolver, failure]) {
    if (source.split(original).length !== 2) throw new Error('Original updater flow changed; reconcile the Mac update path before building.');
  }
  return source.replace(resolver, recovery).replace(failure, report);
}

export const MAC_NATIVE_HTTP_MARK = 'WUWA_MAC_NATIVE_HTTP_ADAPTER';

export const NATIVE_HTTP_CLIENT = 'const jsonpClient=new Request({timeout:10*1e3,baseURL:HOST});';

export const NATIVE_HTTP_CLIENT_PATCHED = `const jsonpClient=new Request({timeout:10*1e3,baseURL:HOST,...(window.__WUWATAPPO_HTTP_ADAPTER__?{adapter:window.__WUWATAPPO_HTTP_ADAPTER__}:{})});/* ${MAC_NATIVE_HTTP_MARK}: the upstream Request class only builds its AbortController and takes its one-way URL lock when no adapter is configured, so a configured adapter drops both, and the transport stops going through the WKWebView preflight path that can hang forever (.work/http-hang-diagnosis.md). The spread contributes nothing when scripts/mac-http.js did not run, which leaves the stock webview client byte for byte in place. */`;

export function patchMacNativeHttpAdapter(source) {
  if (source.includes(MAC_NATIVE_HTTP_MARK)) throw new Error('Mac native HTTP adapter is already wired; reconcile the patch order before building.');
  const found = source.split(NATIVE_HTTP_CLIENT).length - 1;
  if (found !== 1) throw new Error(`Expected 1 original jsonp client, found ${found}. Reconcile the app version before building.`);
  return source.replace(NATIVE_HTTP_CLIENT, () => NATIVE_HTTP_CLIENT_PATCHED);
}

export function patchMacAbout(source, region = 'CN') {
  const headings = [...source.matchAll(/<h2 (data-v-[a-f0-9]+)>系统配置<\/h2>/g)];
  if (headings.length !== 1) throw new Error('Original About system section changed; reconcile the Mac build information before building.');
  const original = headings[0][0], scope = headings[0][1];
  const remotes = [...source.matchAll(/t=([$\w]+)\(\(\)=>k\("about_content"\)\?String\(v\("about_content"\)\)\.trim\(\):""\)/g)];
  if (remotes.length !== 1) throw new Error('Original remote About content changed; reconcile the Mac build information before building.');
  const [remote, computed] = remotes[0];
  const info = region === 'GLOBAL'
    ? `<h2 ${scope}>macOS community build</h2><p ${scope}>Wuwa Tappo Global Mac · Unofficial · Apple Silicon · macOS 13+</p>`
    : `<h2 ${scope}>macOS 重建版</h2><p ${scope}>Wuwa Tappo CN Mac · 非官方重建 · Apple Silicon · macOS 13 及以上</p>`;
  const banner = `<section class="about-section" ${scope}>${info}</section>`;
  return source
    .replace(original, `${info}<h3 ${scope}>Windows 原版系统配置</h3>`)
    .replace(remote, `t=${computed}(()=>{const html=k("about_content")?String(v("about_content")).trim():"";return html?${JSON.stringify(banner)}+html.replace("系统配置","Windows 原版系统配置").replace("系統配備","Windows 原版系統配備"):""})`);
}

export function patchMacCountdownPaintPolicy(source) {
  if (source.includes('wuwa.countdownPaint')) throw new Error('Countdown paint switch is already applied; reconcile the patch order before building.');
  if (!source.includes('const APP_REGION="')) throw new Error('Original frontend entry module not found; reconcile the countdown paint switch before building.');
  if (source.split('export{').length !== 2 || !/(?<![\w$])export\{[^{}]*\};?\s*$/.test(source)) {
    throw new Error('Original entry module export tail changed; reconcile the countdown paint switch before building.');
  }
  const policy = `;(()=>{/* wuwa.countdownPaint diagnostic switch: countdown paint A/B for the GPU-process leak hunt; the WUWA_COUNTDOWN_PAINT launch env wins over the storage key; delete this block to restore stock rendering. */
try{const KEY="wuwa.countdownPaint",MODES={default:null,"no-shadow":{css:".reward-countdown__progress{filter:none!important}"},"no-svgfilter":{sel:"mask image[filter]",attr:"filter"},"no-mask":{sel:"path.reward-countdown__bar[mask]",attr:"mask"},"no-transition":{css:".reward-countdown__bar{transition:none!important}"},hidden:{css:".reward-countdown{display:none!important}"}},mode=window.__WUWATAPPO_COUNTDOWN_PAINT__??localStorage.getItem(KEY);
if(!mode||mode==="default"||!Object.prototype.hasOwnProperty.call(MODES,mode))return;
const root=document.documentElement,spec=MODES[mode];
if(spec.css){const style=document.createElement("style");style.setAttribute("data-wuwa-countdown-paint",mode);style.textContent=spec.css;(document.head??root).appendChild(style);return}
const strip=node=>{if(!node||node.nodeType!==1)return;if(node.matches(spec.sel))node.removeAttribute(spec.attr);for(const hit of node.querySelectorAll(spec.sel))hit.removeAttribute(spec.attr)};strip(root),new MutationObserver(list=>{for(const record of list){if(record.type==="attributes")strip(record.target);else for(const node of record.addedNodes)strip(node)}}).observe(root,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["filter","mask"]})}catch{}})();`;
  return `${source}\n${policy}\n`;
}

export const COUNTDOWN_PAINT_COST_MARK = 'WUWA_MAC_COUNTDOWN_PAINT_COST';

export function patchMacCountdownPaintCost(css) {
  if (css.includes(COUNTDOWN_PAINT_COST_MARK)) throw new Error('Mac countdown paint cost override is already applied; reconcile the patch order before building.');
  const stock = [
    ['countdown bar stroke-dasharray transition', /\.reward-countdown \.reward-countdown__bar\{[^}]*transition:stroke-dasharray[^}]*\}/g],
    ['countdown progress drop-shadow filter', /\.reward-countdown \.reward-countdown__progress\{[^}]*filter:drop-shadow\([^}]*\}/g],
  ];
  for (const [description, pattern] of stock) {
    const found = [...css.matchAll(pattern)].length;
    if (found !== 1) throw new Error(`Original ${description} changed; found ${found} stock rules, reconcile the Mac countdown paint cost override before building.`);
  }
  const override = `/* ${COUNTDOWN_PAINT_COST_MARK}: the countdown ring repaints every second at full window scale, and both the drop-shadow filters and the stroke-dasharray tween force WebKit to re-rasterize that layer instead of reusing its tile; neither override changes the ring geometry, the SVG mask is untouched. */
.reward-countdown .reward-countdown__progress{filter:none!important}
.reward-countdown .reward-countdown__bar{transition:none!important}`;
  return `${css}\n${override}\n`;
}

const SHORTCUT_CAPTURE_ACTIONS = ['togglePet', 'gameMode', 'switchScreen'];
const SHORTCUT_CAPTURE_CALL = /[$\w]+\([$\w]+,\{action:"(togglePet|gameMode|switchScreen)",binding:[$\w$.]+\.\1,disabled:![$\w]+\.value,label:[$\w]+\([$\w]+\)\("setting_[a-z_]+"\),onChange:[$\w]+\},null,8,\["binding","disabled","label"\]\),/g;

export function patchMacHideShortcutSettings(source) {
  // 1.0.3 renders one shortcut capture control as the first child of three setting-content rows
  // (togglePet, gameMode, switchScreen). set_shortcut_capture is still a placeholder, so the
  // controls are dropped and each row keeps only the switch it shipped before 1.0.3.
  const actions = [...source.matchAll(SHORTCUT_CAPTURE_CALL)].map(match => match[1]);
  const complete = SHORTCUT_CAPTURE_ACTIONS.every(action => actions.filter(hit => hit === action).length === 1);
  if (actions.length !== SHORTCUT_CAPTURE_ACTIONS.length || !complete) {
    throw new Error(`Original shortcut capture controls changed; found ${actions.length} of ${SHORTCUT_CAPTURE_ACTIONS.length} (${actions.join(', ') || 'none'}), reconcile the hidden shortcut settings before building.`);
  }
  return source.replace(SHORTCUT_CAPTURE_CALL, '');
}

export function patchGlobalAuthListener(source) {
  const bridge = 'async function onOpenUrl(e){return await listen("deep-link://new-url",t=>{e(t.payload)})}';
  const wake = 'async function onOpenUrl(e){return await listen("mac-oauth-callback-ready",()=>{getCurrent().then(t=>{if(t?.length)return e(t)}).catch(()=>console.warn("[macOS] OAuth callback could not be read"))})}';
  const current = 'try{const t=await getCurrent();t?.length&&handleRawUrls(t)}catch(t){console.warn("[overseas-auth] getCurrent failed:",t)}';
  const listener = 'try{unlisten=await onOpenUrl(t=>{handleRawUrls(t)})}catch(t){throw console.warn("[overseas-auth] onOpenUrl failed:",t),bound=!1,t}';
  if (source.split(bridge).length !== 2 || source.split(current + listener).length !== 2) throw new Error('Original GLOBAL OAuth callback binding changed; reconcile cold and warm callback delivery before building.');
  return source.replace(bridge, wake).replace(current + listener, listener + current);
}

export function patchMacLayoutBarriers(source) {
  const tree = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  const targets = [];
  function visit(node, callback) {
    if (!node || typeof node !== 'object') return;
    callback(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, callback));
      else if (value && typeof value === 'object') visit(value, callback);
    }
  }
  visit(tree, node => {
    if (node.type !== 'FunctionDeclaration') return;
    const content = source.slice(node.start, node.end);
    if (content.includes('[taskbar-insets] desktop state refresh failed')
      || (content.includes('[main-window-bounds] sync failed') && content.includes('syncMainWindowContentBoundsNow'))) targets.push(node);
  });
  if (targets.length !== 2) throw new Error('Original desktop layout barriers changed; reconcile macOS layout before building.');
  const frames = [];
  for (const target of targets) {
    const matches = [];
    visit(target.body, node => {
      if (node.type === 'AwaitExpression' && node.argument.type === 'NewExpression'
        && node.argument.callee.type === 'Identifier' && node.argument.callee.name === 'Promise'
        && source.slice(node.argument.start, node.argument.end).includes('requestAnimationFrame')) matches.push(node);
    });
    if (matches.length !== 1) throw new Error('Original desktop layout frame changed; reconcile macOS layout before building.');
    frames.push(matches[0]);
  }
  for (const frame of frames.sort((a, b) => b.start - a.start)) source = source.slice(0, frame.start) + 'await __wuwatappoMacLayoutBarrier()' + source.slice(frame.end);
  const helper = `async function __wuwatappoMacLayoutBarrier(){
  const nativeWindow=window.__TAURI__.window.getCurrentWindow();
  const [size,scale]=await Promise.all([nativeWindow.innerSize(),nativeWindow.scaleFactor()]);
  const root=document.documentElement;
  if(!root)throw new Error("macOS DOM layout root is unavailable");
  getComputedStyle(root).getPropertyValue("--pet-scale");
  const rootRect=root.getBoundingClientRect();
  const dockRect=document.querySelector(".pet-dock")?.getBoundingClientRect();
  const width=window.innerWidth,height=window.innerHeight;
  if(!Number.isFinite(scale)||scale<=0||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!Number.isFinite(size.width)||!Number.isFinite(size.height)||Math.abs(width-size.width/scale)>2||Math.abs(height-size.height/scale)>2)throw new Error("macOS layout viewport does not match native window");
  for(const rect of[rootRect,dockRect])if(rect&&![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite))throw new Error("macOS DOM layout geometry is invalid");
}`;
  return helper + source;
}
import { parse } from 'acorn';

const PET_LOOP_HEAD = /function ([$\w]+)\(([$\w]+)\)\{const ([$\w]+)=Math\.min\(\(\2-([$\w]+)\)\/1e3,\.028\);\4=\2;/g;
const PET_LOOP_WINDOW = 6000;

export const MAC_FPS_CAP_MARK = 'WUWA_MAC_FPS_CAP';

export const MAC_FPS_CAP_GATE = `/* ${MAC_FPS_CAP_MARK}: the room shell starts one self-scheduling animation-frame loop on mount and re-arms it forever, so the pet/emotion springs are integrated on every compositor frame (120 Hz on ProMotion) even when nothing is held. Frames that miss the budget are skipped before the spring integration and re-arm without touching the style objects, so no DOM write, layout or paint happens on a skipped frame; events, timers, network and Vue reactivity are untouched because only this loop consults the gate. A pressed emotion item keeps the stock frame rate, and a hidden document stops the beat. localStorage wuwa.fpsCap (integer 20-120) overrides the 30 fps default; anything else falls back to it. Delete this block and the two __wuwatappoFps* call sites to restore stock rendering. */
const __wuwatappoFpsState={cap:0,gap:0,next:0,applied:0,readAt:-1e9};
function __wuwatappoFpsCap(){
const state=__wuwatappoFpsState,now=performance.now();
if(state.cap&&now-state.readAt<500)return state.cap;
let cap=30;
try{const raw=localStorage.getItem("wuwa.fpsCap"),value=typeof raw==="string"?Number(raw.trim()):NaN;if(typeof raw==="string"&&raw.trim()!==""&&Number.isInteger(value)&&value>=20&&value<=120)cap=value}catch{}
state.cap=cap;state.readAt=now;
return cap
}
function __wuwatappoFpsStep(){return Math.max(.028,1.05/__wuwatappoFpsCap())}
function __wuwatappoFpsGate(items){
if(typeof document!=="undefined"&&document.visibilityState==="hidden")return!0;
if(items)for(const item of items.values())if(item&&item.held)return!1;
const state=__wuwatappoFpsState,cap=__wuwatappoFpsCap();
if(cap!==state.applied){state.applied=cap;state.gap=1e3/cap*.9;state.next=0}
const now=performance.now();
if(now<state.next)return!0;
state.next=now+state.gap;
return!1
}
`;

export function patchMacThrottleAnimation(source) {
  if (source.includes(MAC_FPS_CAP_MARK)) throw new Error('Mac frame rate cap is already applied; reconcile the patch order before building.');
  const heads = [...source.matchAll(PET_LOOP_HEAD)];
  if (heads.length !== 1) throw new Error(`Original pet animation frame loop changed; found ${heads.length} loop heads, reconcile the Mac frame rate cap before building.`);
  const [head, loop, stamp, step, last] = heads[0];
  const scope = source.slice(heads[0].index, heads[0].index + PET_LOOP_WINDOW);
  const items = /for\(const\[([$\w]+),([$\w]+)\]of ([$\w]+)\)/.exec(scope);
  const arms = [...scope.matchAll(new RegExp(`([$\\w]+)=requestAnimationFrame\\(${loop}\\)`, 'g'))];
  if (!items || arms.length !== 2 || arms[0][1] !== arms[1][1]) {
    throw new Error('Original pet animation frame loop changed; reconcile the Mac frame rate cap before building.');
  }
  // A skipped frame must re-arm through the stock tail call, so the chunk keeps exactly the frame
  // count it shipped with and L always holds a native handle for the unmount cancel.
  const bodyStart = heads[0].index + head.length;
  const armAt = heads[0].index + arms[0].index;
  if (armAt <= bodyStart || source[armAt + `${arms[0][1]}=requestAnimationFrame(${loop})`.length] !== '}') {
    throw new Error('Original pet animation frame loop changed; reconcile the Mac frame rate cap before building.');
  }
  const gated = `function ${loop}(${stamp}){if(!__wuwatappoFpsGate(${items[3]})){const ${step}=Math.min((${stamp}-${last})/1e3,__wuwatappoFpsStep());${last}=${stamp};`;
  return `${MAC_FPS_CAP_GATE}${source.slice(0, heads[0].index)}${gated}${source.slice(bodyStart, armAt)}}${source.slice(armAt)}`;
}

const CHEST_COUNTDOWN = /([$\w]+)\.value=([$\w]+)===null\?([$\w]+)\(([$\w]+)\.userInfo\?\.(left_treasure_chest|right_treasure_chest),([$\w]+)\):Math\.max\(0,\2-([$\w]+)\)/g;

export const MAC_CHEST_FALLBACK_MARK = 'WUWA_MAC_CHEST_FALLBACK';

export function macChestFallbackHelper(clock = 'co') {
  return `/* ${MAC_CHEST_FALLBACK_MARK}: activity_config_load_failed leaves the treasure chest timestamps at 0, so the stock projection collapses to 0 and the bubble renders without a countdown. A server deadline greater than 0 is recorded per side with its observation time; while the server sends nothing usable the last recorded deadline is reused for at most 90 minutes, then dropped. localStorage wuwa.chestFallback=off restores the stock projection and leaves the record alone. Only the two computed countdown values are routed here: the formatters, the progress ratio and the ring are untouched. Delete this block and the two __wuwatappoChestRemaining call sites to restore stock behaviour. */
const __wuwatappoChestCache={left:{deadline:0,stamp:0},right:{deadline:0,stamp:0}};
const __wuwatappoChestMaxAge=54e5;
function __wuwatappoChestKey(side){return"wuwa.chestDeadline."+side}
function __wuwatappoChestDisabled(){try{return localStorage.getItem("wuwa.chestFallback")==="off"}catch{return!1}}
function __wuwatappoChestLoad(side){
try{const raw=localStorage.getItem(__wuwatappoChestKey(side));if(typeof raw!=="string"||!raw)return null;const parsed=JSON.parse(raw),deadline=Number(parsed&&parsed.deadline),stamp=Number(parsed&&parsed.stamp);return Number.isFinite(deadline)&&Number.isFinite(stamp)&&deadline>0?{deadline,stamp}:null}catch{return null}
}
function __wuwatappoChestDrop(side){
__wuwatappoChestCache[side].deadline=0;__wuwatappoChestCache[side].stamp=0;
try{localStorage.removeItem(__wuwatappoChestKey(side))}catch{}
}
function __wuwatappoChestRemaining(side,raw,now){
const value=raw==null?0:Number(raw);
if(__wuwatappoChestDisabled())return ${clock}(raw,now);
if(Number.isFinite(value)&&value>0){
const deadline=Math.floor(value),cache=__wuwatappoChestCache[side],stamp=Date.now();
if(cache.deadline!==deadline||stamp-cache.stamp>3e5){cache.deadline=deadline;cache.stamp=stamp;try{localStorage.setItem(__wuwatappoChestKey(side),JSON.stringify({deadline,stamp}))}catch{}}
return ${clock}(raw,now)
}
const last=__wuwatappoChestLoad(side);
if(last&&last.deadline>now&&Date.now()-last.stamp<=__wuwatappoChestMaxAge)return ${clock}(last.deadline,now);
__wuwatappoChestDrop(side);
return 0
}
`;
}

export function patchMacChestCountdownFallback(source) {
  if (source.includes(MAC_CHEST_FALLBACK_MARK)) throw new Error('Mac chest countdown fallback is already applied; reconcile the patch order before building.');
  const sites = [...source.matchAll(CHEST_COUNTDOWN)];
  const sides = sites.map(match => match[5]).sort();
  const clocks = new Set(sites.map(match => match[3]));
  if (sites.length !== 2 || sides[0] !== 'left_treasure_chest' || sides[1] !== 'right_treasure_chest' || clocks.size !== 1) {
    throw new Error(`Original treasure chest countdown projection changed; found ${sites.length} of 2 (${sites.map(match => match[5]).join(', ') || 'none'}), reconcile the Mac chest countdown fallback before building.`);
  }
  const clock = [...clocks][0];
  if (!source.includes(`function ${clock}(e,t=is()){const o=No(e);return o<=0?0:Math.max(0,o-t)}`)) {
    throw new Error('Original treasure chest countdown clock changed; reconcile the Mac chest countdown fallback before building.');
  }
  const patched = source.replace(CHEST_COUNTDOWN, (_, target, offset, helper, store, field, now, stamp) => `${target}.value=${offset}===null?__wuwatappoChestRemaining("${field === 'left_treasure_chest' ? 'left' : 'right'}",${store}.userInfo?.${field},${now}):Math.max(0,${offset}-${stamp})`);
  return `${macChestFallbackHelper(clock)}${patched}`;
}

