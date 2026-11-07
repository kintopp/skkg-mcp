import OpenSeadragon from 'openseadragon';
import {
  App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts,
} from '@modelcontextprotocol/ext-apps/app-with-deps';
import {
  parseResult, errorText, isAllowedService, infoUrl, startPosition, step, caption,
  creditLine, objectName, viewingContext,
} from './model.js';
const PREVIEW = window.parent === window;
const root = document.getElementById('root');

const app = PREVIEW ? null : new App(
  { name: 'skkg-image-viewer', version: '0.1.0' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
);

let result = null;
let pos = 0;
let osd = null;
let nodes = null;
let displayMode = 'inline';

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, val] of Object.entries(props)) {
    if (k === 'class') e.className = val;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), val);
    else e.setAttribute(k, val);
  }
  e.append(...kids.filter((x) => x != null));
  return e;
};

function reportSize() {
  if (!app) return;
  requestAnimationFrame(() => {
    app.sendSizeChanged({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  });
}

function destroyViewer() {
  osd?.destroy();
  osd = null;
}

function showStatus(text, isError = false) {
  destroyViewer();
  result = null;
  nodes = null;
  root.replaceChildren(el('p', { id: 'status', role: 'status', class: isError ? 'error' : '' }, text));
  reportSize();
}

const openLink = (url) => {
  if (app) app.openLink({ url }).catch(() => {});
  else window.open(url, '_blank', 'noopener');
};

// Inline, a plain wheel or one-finger drag scrolls the conversation; a modifier key, a pinch,
// or two fingers zoom and pan. Fullscreen has no conversation to scroll.
const syncGestures = () => osd?.setCooperativeGestures(displayMode === 'inline' && !document.fullscreenElement);

function createViewer(element) {
  osd = OpenSeadragon({
    element,
    prefixUrl: '',
    crossOriginPolicy: 'Anonymous',
    showNavigationControl: false,
    showNavigator: true,
    navigatorPosition: 'BOTTOM_RIGHT',
    navigatorSizeRatio: 0.15,
    animationTime: 0.4,
    blendTime: 0.1,
    constrainDuringPan: true,
    visibilityRatio: 0.5,
    minZoomImageRatio: 0.8,
    maxZoomPixelRatio: 3,
    gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
  });
  syncGestures();
  osd.addHandler('open-failed', () => { if (nodes) showMessage('SKKG\'s image server did not deliver this image.'); });
  osd.addHandler('open', () => { if (nodes) nodes.message.hidden = true; });
}

function showMessage(text) {
  nodes.message.replaceChildren(text);
  nodes.message.hidden = false;
}

function showImage(next, notify) {
  pos = next;
  const m = result.images[pos];
  nodes.caption.textContent = caption(result, pos);
  nodes.counter.textContent = `${pos + 1} / ${result.images.length}`;
  nodes.prev.disabled = pos === 0;
  nodes.next.disabled = pos === result.images.length - 1;
  nodes.credit.textContent = creditLine(result, pos);
  if (isAllowedService(m.iiif_service)) {
    nodes.message.hidden = true;
    osd.open(infoUrl(m.iiif_service));
  } else {
    osd.close();
    showMessage('This image cannot be shown here.');
  }
  if (notify && app) app.updateModelContext({ content: [{ type: 'text', text: viewingContext(result, pos) }] }).catch(() => {});
  reportSize();
}

// Only an actual turn reloads the image and tells the model.
function turn(delta) {
  const next = step(pos, delta, result.images.length);
  if (next !== null) showImage(next, true);
}

function toggleFullscreen() {
  const mode = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  app.requestDisplayMode({ mode }).then((r) => { displayMode = r?.mode ?? displayMode; applyMode(); }).catch(() => {});
}

function applyMode() {
  document.documentElement.classList.toggle('fullscreen', displayMode === 'fullscreen');
  if (nodes?.fullscreen) nodes.fullscreen.textContent = displayMode === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen';
  syncGestures();
  reportSize();
}

const zoomBy = (f) => { if (osd) { osd.viewport.zoomBy(f); osd.viewport.applyConstraints(); } };

function render(s) {
  destroyViewer();
  result = s;
  const main = s.objects[0];
  const site = main?.website_url;
  const title = s.type === 'object' ? objectName(main) : (main ? `Image of ${objectName(main)}` : s.id);
  const several = s.images.length > 1;

  const prev = el('button', { type: 'button', title: 'Previous image (p)', onclick: () => turn(-1) }, '‹');
  const next = el('button', { type: 'button', title: 'Next image (n)', onclick: () => turn(1) }, '›');
  const counter = el('span', { class: 'counter' });
  const fullscreen = app ? el('button', { type: 'button', onclick: toggleFullscreen }, 'Fullscreen') : null;
  const toolbar = el('div', { class: 'toolbar' },
    ...(several ? [prev, counter, next] : []),
    el('button', { type: 'button', title: 'Zoom in', onclick: () => zoomBy(1.5) }, '+'),
    el('button', { type: 'button', title: 'Zoom out', onclick: () => zoomBy(1 / 1.5) }, '−'),
    el('button', { type: 'button', title: 'Whole image (0)', onclick: () => osd?.viewport.goHome() }, 'Reset'),
    site ? el('button', { type: 'button', title: 'The object on SKKG\'s website', onclick: () => openLink(site) }, 'Website') : null,
    fullscreen,
  );
  const captionEl = el('span', { class: 'meta' });
  const header = el('header', {}, el('h1', {}, title), captionEl);
  const canvas = el('div', { class: 'canvas' });
  const message = el('p', { class: 'message', role: 'status' });
  message.hidden = true;
  const frame = el('div', { class: 'frame' }, canvas, message);
  // The image's rights only; the object's rights, warnings, and data date are in the model's reply.
  const credit = el('p', { class: 'credit' });

  nodes = { caption: captionEl, counter, prev, next, credit, message, fullscreen };
  root.replaceChildren(header, toolbar, frame, credit);
  createViewer(canvas);
  showImage(startPosition(s), false);
  applyMode();
}

function onKey(ev) {
  // A held key would load an image from SKKG's server on every repeat.
  if (!result || ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'n') turn(1);
  else if (ev.key === 'p') turn(-1);
}

function applyHost(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.padding = `${top + 8}px ${right + 12}px ${bottom + 8}px ${left + 12}px`;
  }
  if (ctx.displayMode) { displayMode = ctx.displayMode; applyMode(); }
}

document.addEventListener('keydown', onKey);
document.addEventListener('fullscreenchange', syncGestures);

if (PREVIEW) {
  // import.meta.env.DEV is false in the build, so the sample stays out of the page.
  if (import.meta.env.DEV) import('./sample.js').then(({ SAMPLE }) => render(SAMPLE));
  else showStatus('This page opens inside an MCP host, from skkg_view_image.');
} else {
  // No `tools` capability: the host's tools/list round-trip suppresses ontoolresult on Safari (odeuropa).
  app.ontoolinputpartial = () => showStatus('Loading images…');
  app.ontoolinput = () => showStatus('Loading images…');
  app.ontoolresult = (r) => {
    const err = errorText(r);
    if (err) { showStatus(err, true); return; }
    const parsed = parseResult(r);
    if (parsed) render(parsed);
    else if (!nodes) showStatus('The images could not be opened.', true);
  };
  app.onhostcontextchanged = () => applyHost(app.getHostContext());
  app.onteardown = async () => { destroyViewer(); return {}; };
  app.connect().then(() => applyHost(app.getHostContext()));
}
