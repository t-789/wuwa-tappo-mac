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

const CHEST_VISIBILITY_GATES = /const ([$\w]+)=pe\(\(\)=>([$\w]+)\.value\|\|!([$\w]+)\.isLoggedIn\?!0:([$\w]+)\.value<=0\),([$\w]+)=pe\(\(\)=>\2\.value\|\|!\3\.isLoggedIn\?!0:([$\w]+)\.value<=0\)/g;

const CHEST_CLICK_GATES = /,([$\w]+)=pe\(\(\)=>([$\w]+)\.value\|\|!([$\w]+)\.isLoggedIn\?!0:([$\w]+)\.value>=([$\w]+)\),([$\w]+)=pe\(\(\)=>([$\w]+)\.value\|\|!([$\w]+)\.isLoggedIn\?!1:([$\w]+)\.value>=([$\w]+)&&([$\w]+)\.value<([$\w]+)\)/g;

const CHEST_RENDER_GATE = /function ([$\w]+)\(\)\{return ([$\w]+)\.value\|\|([$\w]+)\.value\|\|!([$\w]+)\.value\?!1:!!\(([$\w]+)\.value&&([$\w]+)\.value\|\|([$\w]+)\.value&&([$\w]+)\.value\)\}/g;

const CHEST_BUSY_GATE = /const ([$\w]+)=W\(!1\),([$\w]+)=pe\(\(\)=>([$\w]+)\.value\|\|([$\w]+)\.value\|\|([$\w]+)\.isLoggedIn&&!\1\.value\)/g;

export const MAC_CHEST_DIAGNOSTICS_MARK = 'WUWA_MAC_CHEST_DIAGNOSTICS';

export function macChestDiagnosticsHelper(vars) {
  const roles = Object.entries(vars).map(([role, name]) => `${role}:"${name}"`).join(",");
  return `/* ${MAC_CHEST_DIAGNOSTICS_MARK}: diagnostic build only. Every 5 seconds, while the document is visible, the treasure chest gate state is copied to localStorage wuwa.chestDbg so the "two grey chests, not clickable" report can be diagnosed offline. This block only reads the existing refs and computed gates: no ref is written here, no request is issued and no rendering changes. While localStorage wuwa.chestDbg holds "off" nothing is written on that tick. Deleting this block together with the anchor it sits behind restores stock behaviour. qt is the computed kt that disables both reward buttons, fn the forced-refresh flag, and mi/br/qn the three refs kt is built from (mount-in-progress, login-in-progress, chest-ready), so a grey-button capture can be read without guessing which term stayed set. The minified identifiers a snapshot was read from are recorded inside the snapshot as vars, so an older capture stays readable after a rebuild. xo is the read-only view the chest in-flight guard block below publishes at globalThis.__wuwatappoChestXoProbe: whether the refresher slot is still in flight, how long it has been pending, how many calls ran a body against how many failed, and the last failure reason with its name and code. Its gate field is the network store status read at snapshot time, gateAtCall is the status the last refresher call saw as it entered (the very value the stock gate branch compares one statement later), so a capture can separate a call the gate skipped from a call that issued a request and failed; skips counts the calls whose entry gate was not online or unknown, and onlineAt is the first moment this build observed the store online. It is null when that block is absent, so this snapshot stays readable without it. */
const __wuwatappoChestDbgRecord=()=>{
try{
if(localStorage.getItem("wuwa.chestDbg")==="off")return;
localStorage.setItem("wuwa.chestDbg",JSON.stringify({t:Date.now(),isLoggedIn:!!${vars.user}.isLoggedIn,qt:!!${vars.loading}.value,fn:!!${vars.request}.value,mi:!!${vars.mi}.value,br:!!${vars.br}.value,qn:!!${vars.qn}.value,left:{raw:${vars.user}.userInfo?.left_treasure_chest??null,remaining:${vars.left}.value,show:!!${vars.leftShow}.value},right:{raw:${vars.user}.userInfo?.right_treasure_chest??null,remaining:${vars.right}.value,show:!!${vars.rightShow}.value},clicks:{re:${vars.clicks}.value,need:${vars.need},upper:${vars.upper}},visible:{zr:!!${vars.visibleLeft}.value,jr:!!${vars.visibleRight}.value},xo:typeof globalThis.__wuwatappoChestXoProbe==="function"?globalThis.__wuwatappoChestXoProbe():null,vars:{${roles}}}))
}catch{}
};
const __wuwatappoChestDbgTimer=setInterval(()=>{
try{if(document.hidden)return}catch{}
__wuwatappoChestDbgRecord()
},5e3);
`;
}

export function patchMacChestStateDiagnostics(source) {
  if (source.includes(MAC_CHEST_DIAGNOSTICS_MARK)) throw new Error('Mac chest state diagnostics are already applied; reconcile the patch order before building.');
  const gates = [...source.matchAll(CHEST_VISIBILITY_GATES)];
  if (gates.length !== 1) throw new Error(`Original treasure chest visibility gates changed; found ${gates.length} of 1, reconcile the Mac chest state diagnostics before building.`);
  const [, leftShow, loading, user, left, rightShow, right] = gates[0];
  const clickGates = [...source.matchAll(CHEST_CLICK_GATES)];
  const click = clickGates.length === 1 ? clickGates[0] : null;
  const clickConsistent = !!click && [click[2], click[7]].every(name => name === loading) && [click[3], click[8]].every(name => name === user) && [click[9], click[11]].every(name => name === click[4]) && click[10] === click[5];
  if (!clickConsistent) throw new Error(`Original treasure chest click gates changed; found ${clickGates.length} of 1 consistent with the visibility gates, reconcile the Mac chest state diagnostics before building.`);
  const clicks = click[4], need = click[5], upper = click[12];
  const render = [...source.matchAll(CHEST_RENDER_GATE)];
  const anchor = render.length === 1 ? render[0] : null;
  if (!anchor || anchor[2] !== loading || anchor[6] !== leftShow || anchor[8] !== rightShow) throw new Error(`Original treasure chest render gate changed; found ${render.length} of 1 reusing the same gates, reconcile the Mac chest state diagnostics before building.`);
  const request = anchor[3], visibleLeft = anchor[5], visibleRight = anchor[7];
  const busyGates = [...source.matchAll(CHEST_BUSY_GATE)];
  const busy = busyGates.length === 1 ? busyGates[0] : null;
  if (!busy || busy[2] !== loading || busy[5] !== user || !source.includes(`${busy[3]}=W(!0)`) || !source.includes(`${busy[4]}=W(!1)`)) {
    throw new Error(`Original treasure chest busy gate changed; found ${busyGates.length} of 1 built from the same loading gate, reconcile the Mac chest state diagnostics before building.`);
  }
  const qn = busy[1], mi = busy[3], busyLogin = busy[4];
  return source.replace(anchor[0], () => anchor[0] + "\n" + macChestDiagnosticsHelper({ user, loading, request, left, right, leftShow, rightShow, clicks, need, upper, visibleLeft, visibleRight, mi, br: busyLogin, qn }));
}


const CHEST_LOGIN_WATCHER = /Oe\(\(\)=>([$\w]+)\.isLoggedIn,([$\w]+)=>{([$\w]+)\.value=!1,[$\w]+\+\+,[$\w]+=null,[$\w]+=null,[$\w]+=null,[$\w]+\(\),\2&&([$\w]+)\(\)},\{flush:"sync"\}\)/g;

export const MAC_CHEST_READY_FIX_MARK = 'WUWA_MAC_CHEST_READY_FIX';

export function macChestReadyFixHelper({ user, ready, refresh, status, watch }) {
  return `/* ${MAC_CHEST_READY_FIX_MARK}: the login watcher right below fires on a login transition only, so a session restored from cookies before mount never runs the chest refresher ${refresh}(): ${ready} stays false, the third term of the button gate stays true, and both reward buttons render disabled until the next login. This block replays that first run on a timer after setup has finished, and it is gate aware rather than blind. A blind replay is not enough on this build: ${refresh}() reaches the refresher, and that refresher issues no request unless the network store is still usable - its stock branch only enters the request when the status reads online or unknown, and every other status logs "activityInfo skipped: network gate" and returns, leaving the ready flag false with nothing left to fire it. During the first seconds of a cold boot the health check still reports offline, reconnecting or degraded, so a replay fired then is skipped in silence: that is the boot race this block closes, and it is why two calls can enter, succeed and still leave ${ready} false. Every attempt therefore reads ${status}.value.status first and asks for a refresh only for the two statuses the stock branch accepts, which is the same predicate the stock status watcher next to the refresher spells out (${watch}(()=>${status}.value.status,...)). Three triggers, each armed only while ${user}.isLoggedIn is true and ${ready}.value is false: one replay deferred to a timer so it lands after setup, one watch on ${status}.value.status that fires the moment the store turns online or unknown with the gate still false, and a low frequency fallback of at most 6 attempts 10 seconds apart, which covers the health check backoff window. The chain stops for good as soon as ${ready} turns true, the session drops or the budget is spent, so a failing boot costs at most 7 refreshes instead of a request storm. The replay is deferred on purpose: ${refresh}() reaches the config refresh synchronously, that refresh reads bindings the setup scope declares further down, and an inline call would hit their temporal dead zone, which the async body of ${refresh} would only surface as a rejected promise with ${ready} still false. The status watch cannot hit that dead zone, because a status change is delivered from the network task, never from the synchronous remainder of setup. While localStorage wuwa.chestReadyFix holds "off" no timer and no watch is installed at all and stock behaviour is restored. Deleting this block restores stock behaviour. */
(()=>{
try{if(localStorage.getItem("wuwa.chestReadyFix")==="off")return}catch{}
const __wuwatappoChestRetryLimit=6,__wuwatappoChestRetryGap=1e4;
let __wuwatappoChestRetries=0,__wuwatappoChestTimer=null,__wuwatappoChestStopped=!1;
function __wuwatappoChestArmed(){try{return!!${user}.isLoggedIn&&!${ready}.value}catch{return!1}}
function __wuwatappoChestOpen(){try{const s=${status}.value.status;return s==="online"||s==="unknown"}catch{return!1}}
function __wuwatappoChestStop(){__wuwatappoChestStopped=!0;if(__wuwatappoChestTimer===null)return;try{clearTimeout(__wuwatappoChestTimer)}catch{}__wuwatappoChestTimer=null}
function __wuwatappoChestFire(){if(!__wuwatappoChestArmed())return __wuwatappoChestStop();if(!__wuwatappoChestOpen())return;try{${refresh}()}catch{}}
function __wuwatappoChestTick(){__wuwatappoChestTimer=null,__wuwatappoChestFire();if(__wuwatappoChestStopped||__wuwatappoChestRetries>=__wuwatappoChestRetryLimit)return;__wuwatappoChestRetries++,__wuwatappoChestTimer=setTimeout(__wuwatappoChestTick,__wuwatappoChestRetryGap)}
try{${watch}(()=>${status}.value.status,()=>__wuwatappoChestFire(),{flush:"sync"})}catch{}
__wuwatappoChestTimer=setTimeout(__wuwatappoChestTick,0)
})();
`;
}

function chestXoAnchor(source, label) {
  const heads = [...source.matchAll(CHEST_XO_HEAD)];
  if (heads.length !== 1) throw new Error(`Original treasure chest refresher changed; found ${heads.length} of 1, reconcile the Mac ${label} before building.`);
  const head = heads[0];
  const gate = CHEST_XO_GATE.exec(source.slice(head.index + head[0].length));
  if (!gate || gate[1] !== head[5] || gate[3] !== head[3] || gate[4] !== head[1]) throw new Error(`Original treasure chest refresher gate changed; found 0 of 1 consistent with its slot, reconcile the Mac ${label} before building.`);
  return { head, inflight: head[1], done: head[2], force: head[3], refresh: head[4], options: head[5], status: gate[2] };
}

export function patchMacChestReadyFix(source) {
  if (source.includes(MAC_CHEST_READY_FIX_MARK)) throw new Error('Mac chest ready fix is already applied; reconcile the patch order before building.');
  const watchers = [...source.matchAll(CHEST_LOGIN_WATCHER)];
  if (watchers.length !== 1) throw new Error(`Original treasure chest login watcher changed; found ${watchers.length} of 1, reconcile the Mac chest ready fix before building.`);
  const [watcher] = watchers;
  const watch = watcher[0].slice(0, watcher[0].indexOf('('));
  const { status } = chestXoAnchor(source, 'chest ready fix');
  return source.replace(watcher[0], () => "\n" + macChestReadyFixHelper({ user: watcher[1], ready: watcher[3], refresh: watcher[4], status, watch }) + watcher[0]);
}

const CHEST_XO_HEAD = /let ([$\w]+)=null,([$\w]+)=!1,([$\w]+)=!1;async function ([$\w]+)\(([$\w]+)\)\{/g;

const CHEST_XO_GATE = /^if\(([$\w]+)\?\.force,([$\w]+)\.value\.status,\1\?\.force&&\(([$\w]+)=!0\),([$\w]+)\)return \4;/;

const CHEST_XO_SETTLE = /([$\w]+)=([$\w]+);try\{await \2\}finally\{\1===\2&&\(\1=null\)\}/g;

export const MAC_CHEST_XO_GUARD_MARK = 'WUWA_MAC_CHEST_XO_GUARD';

export function macChestXoGuardHelper({ inflight, done, force, status }) {
  return `/* ${MAC_CHEST_XO_GUARD_MARK}: the chest refresher slot right below is the one chest gate term no snapshot can see. The refresher keeps a single in-flight promise and every caller awaits it, so a config load that rejects reaches the app only as an unhandled rejection inside a fire-and-forget call: nothing is logged, the ready flag never turns true, and the lookups stay grey for the rest of the session. This block adds observation only and changes no gate. (1) ${inflight} is observed through then(fulfilled, rejected) on the very promise the refresher created: the derived promise is discarded, the original one still rejects into the await of the caller, and the stock error path of the app is untouched, so this cannot swallow a failure it only records it. The reason is kept as a bounded string plus its name and numeric code, which is what separates a timed-out transport (code ETIMEDOUT), a business envelope (code -1 from the unwrapper) and the network gate branch that issues no request at all. (2) A slot that has stayed pending past 20 seconds is treated as stuck and cleared before the next refresh reads it, which is the only case the stock finally cannot cover: that finally clears the slot when the promise settles, and a promise that never settles never reaches it. The slot stays a plain let: this block only assigns null to it, and the stock finally keeps its exact shape. (3) The whole view is published at globalThis.__wuwatappoChestXoProbe for the chest diagnostics snapshot, and while localStorage wuwa.chestReadyFix holds "off" every hook returns before it writes anything, which leaves the stock slot, the stock reset and the absence of any observer exactly as they shipped. (4) Three of those fields exist for the boot race the ready fix block closes: gateAtCall is the network store status read as a call enters, which is the very value the stock gate branch compares one statement later in the same tick, so a capture separates a call the gate skipped from a call that issued a request and failed; skips counts the runs whose entry gate was not online or unknown, the runs that issue no request at all and leave the ready flag false with nothing left to fire it; onlineAt is the first moment this build observed the store online, stamped at any refresher entry or snapshot read and never rewritten. Every access to the network store is wrapped, so a snapshot can never throw into the render path. Deleting this block and the three hooks it installs restores stock behaviour. */
const __wuwatappoChestXoState=globalThis.__wuwatappoChestXo||(globalThis.__wuwatappoChestXo={calls:0,runs:0,settles:0,failures:0,expired:0,skips:0,error:null,errorName:null,code:null,gate:null,gateAtCall:null,onlineAt:null,force:!1,since:0,promise:null});
const __wuwatappoChestXoMaxAge=2e4;
function __wuwatappoChestXoOff(){try{return localStorage.getItem("wuwa.chestReadyFix")==="off"}catch{return!1}}
function __wuwatappoChestXoOpen(value){return value==="online"||value==="unknown"}
function __wuwatappoChestXoMark(value){const st=__wuwatappoChestXoState;if(value!=="online"||st.onlineAt!=null)return;st.onlineAt=Date.now()}
function __wuwatappoChestXoSettle(promise,error){
const st=__wuwatappoChestXoState;
if(st.promise!==promise)return;
st.settles++;
if(!error)return;
st.failures++,st.error=String(error&&error.message||error).slice(0,300),st.errorName=error&&error.name?String(error.name).slice(0,80):null,st.code=error&&typeof error.code==="number"?error.code:null;
}
function __wuwatappoChestXoStart(promise){
const st=__wuwatappoChestXoState;
if(__wuwatappoChestXoOff())return;
st.runs++,st.promise=promise,st.since=Date.now(),st.error=null,st.errorName=null,st.code=null;
__wuwatappoChestXoOpen(st.gateAtCall)||st.skips++;
try{promise.then(()=>__wuwatappoChestXoSettle(promise,null),error=>__wuwatappoChestXoSettle(promise,error))}catch{}
}
function __wuwatappoChestXoEnter(options){
const st=__wuwatappoChestXoState;
if(__wuwatappoChestXoOff())return;
st.calls++,st.force=!!options?.force;
try{st.gateAtCall=${status}.value.status,st.gate=st.gateAtCall}catch{}
__wuwatappoChestXoMark(st.gateAtCall);
if(!${inflight}||st.promise!==${inflight}||!st.since||Date.now()-st.since<=__wuwatappoChestXoMaxAge)return;
${inflight}=null,st.promise=null,st.since=0,st.expired++
}
function __wuwatappoChestXoProbe(){
const st=__wuwatappoChestXoState;
let gate=null;
try{gate=${status}.value.status}catch{}
__wuwatappoChestXoOff()||__wuwatappoChestXoMark(gate);
return{inflight:!!${inflight},ageMs:${inflight}&&st.since?Date.now()-st.since:0,calls:st.calls,runs:st.runs,settles:st.settles,failures:st.failures,expired:st.expired,skips:st.skips,error:st.error,errorName:st.errorName,code:st.code,gate,gateAtCall:st.gateAtCall,onlineAt:st.onlineAt,force:!!${force},done:!!${done}}
}
try{globalThis.__wuwatappoChestXoProbe=__wuwatappoChestXoProbe}catch{}
`;
}

export function patchMacChestXoGuard(source) {
  if (source.includes(MAC_CHEST_XO_GUARD_MARK)) throw new Error('Mac chest in-flight guard is already applied; reconcile the patch order before building.');
  const { head, inflight, done, force, refresh, options, status } = chestXoAnchor(source, 'chest in-flight guard');
  const slot = `let ${inflight}=null,${done}=!1,${force}=!1;`;
  const entry = `async function ${refresh}(${options}){`;
  const patched = `${source.slice(0, head.index)}${slot}\n${macChestXoGuardHelper({ inflight, done, force, status })}${entry}__wuwatappoChestXoEnter(${options});${source.slice(head.index + head[0].length)}`;
  const settles = [...patched.matchAll(CHEST_XO_SETTLE)].filter(match => match[1] === inflight);
  if (settles.length !== 1) throw new Error(`Original treasure chest refresher reset changed; found ${settles.length} of 1 on its own slot, reconcile the Mac chest in-flight guard before building.`);
  const settle = settles[0];
  const promise = settle[2];
  const reset = `${inflight}=${promise};try{await ${promise}}finally{${inflight}===${promise}&&(${inflight}=null)}`;
  if (settle[0] !== reset) throw new Error('Original treasure chest refresher reset changed; reconcile the Mac chest in-flight guard before building.');
  return `${patched.slice(0, settle.index)}${inflight}=${promise};__wuwatappoChestXoStart(${promise});try{await ${promise}}finally{${inflight}===${promise}&&(${inflight}=null)}${patched.slice(settle.index + settle[0].length)}`;
}
