/* Shared teaching board: annotation, text, selection, effects and persistence. */
(function (global) {
  'use strict';

  if (global.TeachingBoard) return;

  const VERSION = 1;
  const HISTORY_LIMIT = 50;
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const MODES = ['overlay', 'white', 'black'];
  const MODE_NAMES = { overlay: '幻灯片标注', white: '白板', black: '黑板' };
  const DRAW_TYPES = ['pen', 'highlighter', 'eraser', 'line', 'arrow', 'rect', 'ellipse'];
  const TOOL_NAMES = {
    select: '选择移动', pen: '画笔', highlighter: '荧光笔', eraser: '橡皮',
    line: '直线', arrow: '箭头', rect: '矩形', ellipse: '圆形',
    text: '文字', sticky: '便签', laser: '激光笔', spotlight: '聚光灯'
  };
  const ACTION_TYPES = new Set([...DRAW_TYPES, 'text', 'sticky']);
  const DEFAULT_STICKY = '#fef08a';

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function validColor(value) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value); }
  function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function courseKey() {
    let path = location.pathname || 'course.html';
    try { path = decodeURIComponent(path); } catch (error) {}
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/') || 'course.html';
  }
  function roundedRect(target, x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    target.beginPath();
    target.moveTo(x + r, y);
    target.lineTo(x + w - r, y);
    target.quadraticCurveTo(x + w, y, x + w, y + r);
    target.lineTo(x + w, y + h - r);
    target.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    target.lineTo(x + r, y + h);
    target.quadraticCurveTo(x, y + h, x, y + h - r);
    target.lineTo(x, y + r);
    target.quadraticCurveTo(x, y, x + r, y);
    target.closePath();
  }

  function validateAction(raw) {
    if (!raw || typeof raw !== 'object' || !ACTION_TYPES.has(raw.type)) throw new Error('包含不支持的书写对象');
    if (!validColor(raw.color) || !finite(raw.size) || raw.size < 1 || raw.size > 200) throw new Error('书写对象的颜色或粗细无效');
    const action = {
      id: typeof raw.id === 'string' && raw.id.length <= 100 ? raw.id : uid(),
      type: raw.type, color: raw.color, size: raw.size
    };
    if (['pen', 'highlighter', 'eraser'].includes(raw.type)) {
      if (!Array.isArray(raw.points) || !raw.points.length || raw.points.length > 20000) throw new Error('笔迹点数组无效');
      action.points = raw.points.map(function (p) {
        if (!p || !finite(p.x) || !finite(p.y) || Math.abs(p.x) > 1000000 || Math.abs(p.y) > 1000000) throw new Error('笔迹坐标无效');
        return { x: p.x, y: p.y };
      });
    } else if (['line', 'arrow', 'rect', 'ellipse'].includes(raw.type)) {
      if (!raw.start || !raw.end || ![raw.start.x, raw.start.y, raw.end.x, raw.end.y].every(finite)) throw new Error('图形坐标无效');
      action.start = { x: raw.start.x, y: raw.start.y };
      action.end = { x: raw.end.x, y: raw.end.y };
    } else {
      if (typeof raw.text !== 'string' || raw.text.length > 5000) throw new Error('文字内容无效或过长');
      if (![raw.x, raw.y, raw.w, raw.h, raw.fontSize].every(finite) || raw.w <= 0 || raw.h <= 0 || raw.w > 10000 || raw.h > 10000 || raw.fontSize < 8 || raw.fontSize > 200) throw new Error('文字位置或字号无效');
      action.x = raw.x; action.y = raw.y; action.w = raw.w; action.h = raw.h;
      action.text = raw.text; action.fontSize = raw.fontSize;
      action.bg = raw.type === 'sticky' ? (validColor(raw.bg) ? raw.bg : DEFAULT_STICKY) : '';
    }
    return action;
  }

  function validatePayload(payload, expectedCourse, slideCount) {
    if (!payload || typeof payload !== 'object' || payload.schemaVersion !== VERSION) throw new Error('板书文件版本不受支持');
    if (payload.course !== expectedCourse) throw new Error('该板书属于另一份课件，未导入');
    if (!payload.layers || typeof payload.layers !== 'object' || Array.isArray(payload.layers)) throw new Error('板书分层数据无效');
    const result = new Map();
    Object.keys(payload.layers).forEach(function (key) {
      const match = /^(\d+):(overlay|white|black)$/.exec(key);
      if (!match) throw new Error('板书页码或底版标识无效');
      const page = Number(match[1]);
      if (!Number.isInteger(page) || page < 0 || page >= slideCount) throw new Error('板书页码超出课件范围');
      const layer = payload.layers[key];
      if (!layer || !finite(layer.baseWidth) || !finite(layer.baseHeight) || layer.baseWidth <= 0 || layer.baseHeight <= 0 || layer.baseWidth > 100000 || layer.baseHeight > 100000 || !Array.isArray(layer.actions) || layer.actions.length > 5000) throw new Error('板书图层数据无效');
      result.set(key, {
        baseWidth: layer.baseWidth,
        baseHeight: layer.baseHeight,
        actions: layer.actions.map(validateAction),
        past: [], future: []
      });
    });
    return result;
  }

  function init(options) {
    const deck = options.deck;
    const slides = options.slides;
    const getIndex = options.getIndex;
    const exportPrefix = options.exportPrefix || courseKey().split('/')[0];
    const course = courseKey();
    const storageKey = 'vibe-teaching-board:v1:' + encodeURIComponent(course);
    const layers = new Map();
    const selectedIds = new Set();
    const sizes = { pen: 4, highlighter: 20, eraser: 30, line: 4, arrow: 4, rect: 4, ellipse: 4, select: 4, text: 4, sticky: 4, laser: 4, spotlight: 4 };
    let open = false;
    let mode = 'overlay';
    let tool = 'pen';
    let color = '#ef4444';
    let size = sizes.pen;
    let fontSize = 32;
    let viewWidth = window.innerWidth;
    let viewHeight = window.innerHeight;
    let dpr = 1;
    let gesture = null;
    let editing = null;
    let drawQueued = false;
    let fxQueued = false;
    let saveTimer = null;
    let storageIssue = '';
    let laserPoints = [];
    let spotlight = null;

    const shell = document.createElement('div');
    shell.className = 'teaching-board';
    shell.setAttribute('data-mode', 'overlay');
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-label', '授课书写层');
    shell.innerHTML = `
      <div class="board-surface"></div>
      <canvas class="board-canvas" tabindex="0" aria-label="书写画布"></canvas>
      <canvas class="board-fx" aria-hidden="true"></canvas>
      <textarea class="board-editor" aria-label="编辑板书文字" spellcheck="false" hidden></textarea>
      <div class="board-toolbar">
        <div class="board-group board-modes">
          <span class="board-title">授课书写</span>
          <button type="button" data-mode="overlay" class="active" title="在当前幻灯片上书写">标注</button>
          <button type="button" data-mode="white" title="切换到空白白板">白板</button>
          <button type="button" data-mode="black" title="切换到黑板">黑板</button>
        </div>
        <div class="board-group">
          <button type="button" data-tool="select" title="框选并移动已有内容（V）">选择 V</button>
          <button type="button" data-tool="pen" class="active" title="画笔（P）">画笔 P</button>
          <button type="button" data-tool="highlighter" title="荧光笔（H）">荧光 H</button>
          <button type="button" data-tool="eraser" title="橡皮（E）">橡皮 E</button>
          <button type="button" data-tool="line" title="直线（L）">直线 L</button>
          <button type="button" data-tool="arrow" title="箭头（A）">箭头 A</button>
          <button type="button" data-tool="rect" title="矩形（R）">矩形 R</button>
          <button type="button" data-tool="ellipse" title="圆形（C）">圆形 C</button>
        </div>
        <div class="board-group">
          <button type="button" data-tool="text" title="单击添加文字；选择工具下双击可再次编辑（T）">文字 T</button>
          <button type="button" data-tool="sticky" title="单击添加便签（N）">便签 N</button>
          <button type="button" data-tool="laser" title="临时激光轨迹，不保存（G）">激光 G</button>
          <button type="button" data-tool="spotlight" title="临时聚光遮罩，不保存（D）">聚光 D</button>
        </div>
        <div class="board-group" aria-label="颜色">
          <button type="button" class="board-color active" data-color="#ef4444" style="background:#ef4444" title="红色" aria-label="红色"></button>
          <button type="button" class="board-color" data-color="#3b82f6" style="background:#3b82f6" title="蓝色" aria-label="蓝色"></button>
          <button type="button" class="board-color" data-color="#22c55e" style="background:#22c55e" title="绿色" aria-label="绿色"></button>
          <button type="button" class="board-color" data-color="#eab308" style="background:#eab308" title="黄色" aria-label="黄色"></button>
          <button type="button" class="board-color" data-color="#111827" style="background:#111827" title="黑色" aria-label="黑色"></button>
          <button type="button" class="board-color" data-color="#f8fafc" style="background:#f8fafc" title="白色" aria-label="白色"></button>
          <input class="board-custom" type="color" value="#ef4444" title="自定义颜色" aria-label="自定义颜色">
          <label class="board-size">粗细 <input type="range" min="2" max="40" value="4" aria-label="画笔粗细"><output>4 px</output></label>
          <label class="board-font">字号 <input type="number" min="12" max="96" value="32" aria-label="文字字号"></label>
        </div>
        <div class="board-group">
          <button type="button" data-action="undo" title="Ctrl+Z">撤销</button>
          <button type="button" data-action="redo" title="Ctrl+Y">重做</button>
          <button type="button" data-action="clear">清空</button>
          <button type="button" data-action="export">导出 PNG</button>
          <button type="button" data-action="export-json" title="导出本课件全部页和底版的板书">导出板书</button>
          <button type="button" data-action="import-json" title="从整套板书 JSON 恢复">导入板书</button>
          <button type="button" data-action="close" title="Esc 或 B">关闭</button>
        </div>
      </div>
      <div class="board-status"></div>
      <input class="board-file" type="file" accept="application/json,.json" hidden>`;
    document.body.appendChild(shell);

    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'board-launcher';
    launcher.textContent = '书写 B';
    launcher.title = '打开授课书写层（B）';
    launcher.setAttribute('aria-pressed', 'false');
    document.body.appendChild(launcher);

    const canvas = shell.querySelector('.board-canvas');
    const fxCanvas = shell.querySelector('.board-fx');
    const ctx = canvas.getContext('2d');
    const fx = fxCanvas.getContext('2d');
    const editor = shell.querySelector('.board-editor');
    const status = shell.querySelector('.board-status');
    const toolbar = shell.querySelector('.board-toolbar');
    const fileInput = shell.querySelector('.board-file');
    const sizeInput = shell.querySelector('input[type="range"]');
    const sizeOutput = shell.querySelector('output');
    const fontInput = shell.querySelector('input[type="number"]');
    const colorInput = shell.querySelector('input[type="color"]');
    const undoButton = shell.querySelector('[data-action="undo"]');
    const redoButton = shell.querySelector('[data-action="redo"]');
    const clearButton = shell.querySelector('[data-action="clear"]');

    function layerKey() { return getIndex() + ':' + mode; }
    function getLayer() {
      const key = layerKey();
      if (!layers.has(key)) layers.set(key, { baseWidth: viewWidth, baseHeight: viewHeight, actions: [], past: [], future: [] });
      return layers.get(key);
    }
    function basePoint(event) {
      const layer = getLayer();
      return { x: event.clientX * layer.baseWidth / viewWidth, y: event.clientY * layer.baseHeight / viewHeight };
    }
    function toViewPoint(p, layer) {
      return { x: p.x * viewWidth / layer.baseWidth, y: p.y * viewHeight / layer.baseHeight };
    }
    function clearEffects() {
      laserPoints = [];
      spotlight = null;
      scheduleFX();
    }
    function pruneSelection() {
      const ids = new Set(getLayer().actions.map(function (a) { return a.id; }));
      Array.from(selectedIds).forEach(function (id) { if (!ids.has(id)) selectedIds.delete(id); });
    }
    function updateStatus() {
      const state = getLayer();
      let hint = '第 ' + (getIndex() + 1) + ' 页 · ' + MODE_NAMES[mode] + ' · ' + TOOL_NAMES[tool];
      if (selectedIds.size) hint += ' · 已选 ' + selectedIds.size + ' 项，拖动选区可移动';
      else if (tool === 'select') hint += ' · 拖框选择；双击文字或便签可编辑';
      else if (tool === 'text' || tool === 'sticky') hint += ' · 单击放置；Enter 换行，Ctrl+Enter 完成';
      else if (tool === 'laser' || tool === 'spotlight') hint += ' · 临时特效，不保存、不导出';
      else hint += ' · ' + size + ' px';
      hint += storageIssue ? '　｜　' + storageIssue : '　｜　自动保存于当前浏览器，勿写敏感信息';
      status.textContent = hint;
      shell.querySelectorAll('[data-tool]').forEach(function (button) { button.classList.toggle('active', button.getAttribute('data-tool') === tool); });
      shell.querySelectorAll('[data-mode]').forEach(function (button) { button.classList.toggle('active', button.getAttribute('data-mode') === mode); });
      shell.querySelectorAll('[data-color]').forEach(function (button) { button.classList.toggle('active', button.getAttribute('data-color').toLowerCase() === color.toLowerCase()); });
      sizeInput.value = size;
      sizeOutput.value = size + ' px';
      sizeOutput.textContent = size + ' px';
      fontInput.value = fontSize;
      colorInput.value = color;
      undoButton.disabled = !state.past.length;
      redoButton.disabled = !state.future.length;
      clearButton.disabled = !state.actions.length && !gesture;
      canvas.style.cursor = tool === 'select' ? 'default' : (tool === 'text' || tool === 'sticky' ? 'text' : 'crosshair');
    }

    function serialize() {
      const output = {};
      layers.forEach(function (layer, key) {
        if (!layer.actions.length) return;
        output[key] = { baseWidth: layer.baseWidth, baseHeight: layer.baseHeight, actions: clone(layer.actions) };
      });
      return { schemaVersion: VERSION, course: course, layers: output };
    }
    function saveNow() {
      clearTimeout(saveTimer);
      saveTimer = null;
      try {
        localStorage.setItem(storageKey, JSON.stringify(serialize()));
        if (storageIssue) { storageIssue = ''; updateStatus(); }
      } catch (error) {
        storageIssue = '浏览器保存失败，请立即“导出板书”备份';
        updateStatus();
      }
    }
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 250);
    }
    function loadSaved() {
      let raw = null;
      try { raw = localStorage.getItem(storageKey); } catch (error) {
        storageIssue = '浏览器存储不可用，请用“导出板书”备份';
        return;
      }
      if (!raw) return;
      try {
        const restored = validatePayload(JSON.parse(raw), course, slides.length);
        restored.forEach(function (value, key) { layers.set(key, value); });
      } catch (error) {
        storageIssue = '原板书数据损坏，未加载；请导入有效备份';
      }
    }
    function commit(mutator) {
      const state = getLayer();
      state.past.push(clone(state.actions));
      if (state.past.length > HISTORY_LIMIT) state.past.shift();
      mutator(state.actions);
      state.future = [];
      pruneSelection();
      scheduleSave();
      redraw();
    }
    function undo() {
      commitEditor();
      const state = getLayer();
      if (!state.past.length) return;
      state.future.push(clone(state.actions));
      state.actions = state.past.pop();
      gesture = null;
      pruneSelection();
      scheduleSave();
      redraw();
    }
    function redo() {
      commitEditor();
      const state = getLayer();
      if (!state.future.length) return;
      state.past.push(clone(state.actions));
      state.actions = state.future.pop();
      gesture = null;
      pruneSelection();
      scheduleSave();
      redraw();
    }

    function wrapText(target, text, maxWidth) {
      const lines = [];
      String(text).split('\n').forEach(function (paragraph) {
        if (!paragraph) { lines.push(''); return; }
        let line = '';
        Array.from(paragraph).forEach(function (char) {
          const candidate = line + char;
          if (line && target.measureText(candidate).width > maxWidth) { lines.push(line); line = char; }
          else line = candidate;
        });
        lines.push(line);
      });
      return lines;
    }
    function drawAction(target, action) {
      target.save();
      target.lineCap = 'round';
      target.lineJoin = 'round';
      target.lineWidth = action.size;
      target.strokeStyle = action.color;
      target.fillStyle = action.color;
      target.globalAlpha = action.type === 'highlighter' ? 0.3 : 1;
      target.globalCompositeOperation = action.type === 'eraser' ? 'destination-out' : 'source-over';
      if (action.points) {
        const points = action.points;
        if (points.length === 1) {
          target.beginPath();
          target.arc(points[0].x, points[0].y, action.size / 2, 0, Math.PI * 2);
          target.fill();
        } else {
          target.beginPath();
          target.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i++) target.lineTo(points[i].x, points[i].y);
          target.stroke();
        }
      } else if (action.start && action.end) {
        const a = action.start;
        const b = action.end;
        if (action.type === 'rect') {
          target.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        } else if (action.type === 'ellipse') {
          target.beginPath();
          target.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
          target.stroke();
        } else {
          target.beginPath(); target.moveTo(a.x, a.y); target.lineTo(b.x, b.y); target.stroke();
          if (action.type === 'arrow') {
            const angle = Math.atan2(b.y - a.y, b.x - a.x);
            const head = Math.max(12, action.size * 4);
            target.beginPath();
            target.moveTo(b.x, b.y);
            target.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
            target.moveTo(b.x, b.y);
            target.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
            target.stroke();
          }
        }
      } else if (action.type === 'text' || action.type === 'sticky') {
        const padding = action.type === 'sticky' ? Math.max(10, action.fontSize * 0.45) : 0;
        target.globalAlpha = 1;
        if (action.type === 'sticky') {
          target.fillStyle = action.bg || DEFAULT_STICKY;
          roundedRect(target, action.x, action.y, action.w, action.h, 12);
          target.fill();
          target.strokeStyle = 'rgba(120, 53, 15, .35)';
          target.lineWidth = 1.5;
          target.stroke();
        }
        target.fillStyle = action.color;
        target.font = '500 ' + action.fontSize + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
        target.textBaseline = 'top';
        target.beginPath(); target.rect(action.x, action.y, action.w, action.h); target.clip();
        const lineHeight = action.fontSize * 1.35;
        const lines = wrapText(target, action.text, Math.max(10, action.w - padding * 2));
        lines.forEach(function (line, index) {
          const y = action.y + padding + index * lineHeight;
          if (y + lineHeight <= action.y + action.h + lineHeight * 0.2) target.fillText(line, action.x + padding, y);
        });
      }
      target.restore();
    }
    function paint(target, state, includeGesture) {
      target.save();
      target.scale(viewWidth / state.baseWidth, viewHeight / state.baseHeight);
      state.actions.forEach(function (action) {
        if (editing && editing.action && editing.action.id === action.id) return;
        target.save();
        if (gesture && gesture.kind === 'move' && selectedIds.has(action.id)) target.translate(gesture.dx, gesture.dy);
        drawAction(target, action);
        target.restore();
      });
      if (includeGesture && gesture && gesture.kind === 'draw') drawAction(target, gesture.action);
      target.restore();
    }
    function actionBounds(action) {
      if (action.type === 'text' || action.type === 'sticky') return { x: action.x, y: action.y, w: action.w, h: action.h };
      let xs;
      let ys;
      if (action.points) { xs = action.points.map(function (p) { return p.x; }); ys = action.points.map(function (p) { return p.y; }); }
      else { xs = [action.start.x, action.end.x]; ys = [action.start.y, action.end.y]; }
      const pad = action.size / 2;
      const x = Math.min.apply(Math, xs) - pad;
      const y = Math.min.apply(Math, ys) - pad;
      return { x: x, y: y, w: Math.max.apply(Math, xs) - Math.min.apply(Math, xs) + pad * 2, h: Math.max.apply(Math, ys) - Math.min.apply(Math, ys) + pad * 2 };
    }
    function selectionBounds() {
      const actions = getLayer().actions.filter(function (a) { return selectedIds.has(a.id); });
      if (!actions.length) return null;
      const boxes = actions.map(actionBounds);
      const x = Math.min.apply(Math, boxes.map(function (b) { return b.x; }));
      const y = Math.min.apply(Math, boxes.map(function (b) { return b.y; }));
      const right = Math.max.apply(Math, boxes.map(function (b) { return b.x + b.w; }));
      const bottom = Math.max.apply(Math, boxes.map(function (b) { return b.y + b.h; }));
      const dx = gesture && gesture.kind === 'move' ? gesture.dx : 0;
      const dy = gesture && gesture.kind === 'move' ? gesture.dy : 0;
      return { x: x + dx, y: y + dy, w: right - x, h: bottom - y };
    }
    function inside(point, box) { return box && point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h; }
    function drawFX() {
      fxQueued = false;
      fx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fx.clearRect(0, 0, viewWidth, viewHeight);
      if (!open) return;
      const state = getLayer();
      if (spotlight && tool === 'spotlight') {
        fx.save();
        fx.fillStyle = 'rgba(2, 6, 23, .72)';
        fx.fillRect(0, 0, viewWidth, viewHeight);
        fx.globalCompositeOperation = 'destination-out';
        const radius = Math.max(90, Math.min(viewWidth, viewHeight) * 0.15);
        const gradient = fx.createRadialGradient(spotlight.x, spotlight.y, radius * 0.35, spotlight.x, spotlight.y, radius);
        gradient.addColorStop(0, 'rgba(0,0,0,1)');
        gradient.addColorStop(0.72, 'rgba(0,0,0,.95)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        fx.fillStyle = gradient;
        fx.beginPath(); fx.arc(spotlight.x, spotlight.y, radius, 0, Math.PI * 2); fx.fill();
        fx.restore();
      }
      const now = performance.now();
      laserPoints = laserPoints.filter(function (p) { return now - p.time < 700; });
      if (laserPoints.length) {
        fx.save(); fx.lineCap = 'round'; fx.lineJoin = 'round'; fx.shadowColor = '#ef4444'; fx.shadowBlur = 12;
        for (let i = 1; i < laserPoints.length; i++) {
          const a = laserPoints[i - 1]; const b = laserPoints[i];
          const alpha = Math.max(0, 1 - (now - b.time) / 700);
          fx.strokeStyle = 'rgba(239,68,68,' + alpha + ')'; fx.lineWidth = 4;
          fx.beginPath(); fx.moveTo(a.x, a.y); fx.lineTo(b.x, b.y); fx.stroke();
        }
        const last = laserPoints[laserPoints.length - 1];
        fx.fillStyle = '#f87171'; fx.beginPath(); fx.arc(last.x, last.y, 5, 0, Math.PI * 2); fx.fill(); fx.restore();
      }
      if (gesture && gesture.kind === 'marquee') {
        const a = toViewPoint(gesture.start, state); const b = toViewPoint(gesture.end, state);
        fx.save(); fx.strokeStyle = '#38bdf8'; fx.fillStyle = 'rgba(56,189,248,.10)'; fx.lineWidth = 1.5; fx.setLineDash([7, 5]);
        const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y); const w = Math.abs(b.x - a.x); const h = Math.abs(b.y - a.y);
        fx.fillRect(x, y, w, h); fx.strokeRect(x, y, w, h); fx.restore();
      } else if (tool === 'select' && selectedIds.size) {
        const bounds = selectionBounds();
        if (bounds) {
          const topLeft = toViewPoint({ x: bounds.x, y: bounds.y }, state);
          const w = bounds.w * viewWidth / state.baseWidth; const h = bounds.h * viewHeight / state.baseHeight;
          fx.save(); fx.strokeStyle = '#0284c7'; fx.fillStyle = '#fff'; fx.lineWidth = 2; fx.setLineDash([8, 5]);
          fx.strokeRect(topLeft.x, topLeft.y, w, h); fx.setLineDash([]);
          [[topLeft.x, topLeft.y], [topLeft.x + w, topLeft.y], [topLeft.x, topLeft.y + h], [topLeft.x + w, topLeft.y + h]].forEach(function (p) { fx.fillRect(p[0] - 4, p[1] - 4, 8, 8); fx.strokeRect(p[0] - 4, p[1] - 4, 8, 8); });
          fx.restore();
        }
      }
      if (laserPoints.length) scheduleFX();
    }
    function scheduleFX() { if (!fxQueued) { fxQueued = true; requestAnimationFrame(drawFX); } }
    function redraw() {
      if (!open) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewWidth, viewHeight);
      paint(ctx, getLayer(), true);
      updateStatus();
      scheduleFX();
    }
    function scheduleRedraw() {
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(function () { drawQueued = false; redraw(); });
    }
    function resize() {
      viewWidth = window.innerWidth;
      viewHeight = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      [canvas, fxCanvas].forEach(function (item) { item.width = Math.round(viewWidth * dpr); item.height = Math.round(viewHeight * dpr); });
      if (open) { positionEditor(); redraw(); }
    }

    function positionEditor() {
      if (!editing) return;
      const state = getLayer();
      const p = toViewPoint(editing, state);
      editor.style.left = p.x + 'px';
      editor.style.top = p.y + 'px';
      editor.style.width = editing.w * viewWidth / state.baseWidth + 'px';
      editor.style.height = editing.h * viewHeight / state.baseHeight + 'px';
      editor.style.fontSize = editing.fontSize * viewHeight / state.baseHeight + 'px';
      editor.style.color = editing.color;
      editor.style.background = editing.type === 'sticky' ? editing.bg : 'rgba(255,255,255,.08)';
      editor.classList.toggle('sticky', editing.type === 'sticky');
    }
    function beginEdit(action, point) {
      clearEffects();
      const isNew = !action;
      const state = getLayer();
      const p = action || {
        type: tool === 'sticky' ? 'sticky' : 'text', x: point.x, y: point.y,
        w: tool === 'sticky' ? Math.min(300, state.baseWidth * 0.35) : Math.min(440, state.baseWidth * 0.5),
        h: tool === 'sticky' ? 190 : 130, text: '', fontSize: fontSize, color: color,
        bg: DEFAULT_STICKY
      };
      editing = { action: action || null, type: p.type, x: p.x, y: p.y, w: p.w, h: p.h, text: p.text, fontSize: p.fontSize, color: p.color, bg: p.bg || DEFAULT_STICKY };
      if (action) { fontSize = action.fontSize; color = action.color; }
      editor.value = p.text;
      editor.hidden = false;
      positionEditor();
      updateStatus();
      redraw();
      requestAnimationFrame(function () { editor.focus({ preventScroll: true }); editor.setSelectionRange(editor.value.length, editor.value.length); });
      if (isNew) gesture = null;
    }
    function cancelEditor() {
      if (!editing) return;
      editing = null;
      editor.hidden = true;
      editor.value = '';
      redraw();
      canvas.focus({ preventScroll: true });
    }
    function commitEditor() {
      if (!editing) return;
      const currentEdit = editing;
      const value = editor.value;
      editing = null;
      editor.hidden = true;
      if (currentEdit.action) {
        const id = currentEdit.action.id;
        const original = getLayer().actions.find(function (a) { return a.id === id; });
        const changed = original && (original.text !== value || original.fontSize !== currentEdit.fontSize || original.color !== currentEdit.color);
        if (original && (!value.trim() || changed)) {
          commit(function (actions) {
            const index = actions.findIndex(function (a) { return a.id === id; });
            if (index < 0) return;
            if (!value.trim()) { actions.splice(index, 1); selectedIds.delete(id); }
            else { actions[index].text = value; actions[index].fontSize = currentEdit.fontSize; actions[index].color = currentEdit.color; }
          });
        } else redraw();
      } else if (value.trim()) {
        const action = {
          id: uid(), type: currentEdit.type, x: currentEdit.x, y: currentEdit.y, w: currentEdit.w, h: currentEdit.h,
          text: value, fontSize: currentEdit.fontSize, color: currentEdit.color, bg: currentEdit.bg, size: 2
        };
        commit(function (actions) { actions.push(action); });
      } else redraw();
      editor.value = '';
    }

    function setTool(next) {
      if (!TOOL_NAMES[next]) return;
      commitEditor();
      gesture = null;
      selectedIds.clear();
      clearEffects();
      tool = next;
      size = sizes[next] || 4;
      updateStatus();
      redraw();
    }
    function setColor(next) {
      if (!validColor(next)) return;
      color = next;
      if (editing) { editing.color = next; positionEditor(); }
      else if (tool === 'select' && selectedIds.size) {
        commit(function (actions) {
          actions.forEach(function (action) {
            if (selectedIds.has(action.id) && (action.type === 'text' || action.type === 'sticky')) action.color = next;
          });
        });
      }
      if (tool === 'eraser') setTool('pen');
      else updateStatus();
    }
    function setMode(next) {
      if (!MODE_NAMES[next]) return;
      commitEditor();
      gesture = null;
      selectedIds.clear();
      clearEffects();
      mode = next;
      shell.setAttribute('data-mode', mode);
      if (mode === 'black' && color.toLowerCase() === '#111827') setColor('#f8fafc');
      if (mode === 'white' && color.toLowerCase() === '#f8fafc') setColor('#111827');
      updateStatus();
      redraw();
    }
    function clearLayer() {
      commitEditor();
      const state = getLayer();
      if (!state.actions.length || !window.confirm('清空当前页、当前底版上的全部书写？')) return;
      selectedIds.clear();
      gesture = null;
      commit(function (actions) { actions.splice(0, actions.length); });
    }
    function exportPNG() {
      commitEditor();
      const output = document.createElement('canvas');
      output.width = canvas.width; output.height = canvas.height;
      const out = output.getContext('2d');
      out.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (mode !== 'overlay') {
        out.fillStyle = mode === 'white' ? '#f6f4ee' : '#10231e';
        out.fillRect(0, 0, viewWidth, viewHeight);
      }
      paint(out, getLayer(), false);
      output.toBlob(function (blob) {
        if (blob) download(blob, exportPrefix + '-第' + String(getIndex() + 1).padStart(2, '0') + '页-' + MODE_NAMES[mode] + '.png');
      }, 'image/png');
    }
    function exportJSON() {
      commitEditor();
      saveNow();
      download(new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json;charset=utf-8' }), exportPrefix + '-整套板书.json');
    }
    function importJSON(file) {
      if (!file) return;
      if (file.size > MAX_IMPORT_BYTES) { alert('板书文件超过 5 MB，未导入'); fileInput.value = ''; return; }
      const reader = new FileReader();
      reader.onload = function () {
        try {
          const restored = validatePayload(JSON.parse(String(reader.result)), course, slides.length);
          if (!window.confirm('导入将替换本课件当前全部板书，且可用当前备份先导出。确定继续？')) return;
          commitEditor();
          layers.clear();
          restored.forEach(function (value, key) { layers.set(key, value); });
          selectedIds.clear(); gesture = null; clearEffects();
          saveNow(); redraw();
          status.textContent = '板书导入完成 · 第 ' + (getIndex() + 1) + ' 页';
        } catch (error) { alert('导入失败：' + error.message); }
        finally { fileInput.value = ''; }
      };
      reader.onerror = function () { alert('读取板书文件失败'); fileInput.value = ''; };
      reader.readAsText(file, 'utf-8');
    }
    function toggle(force) {
      const next = force !== undefined ? force : !open;
      if (!next) commitEditor();
      open = next;
      shell.classList.toggle('open', open);
      launcher.hidden = open;
      launcher.setAttribute('aria-pressed', String(open));
      gesture = null; selectedIds.clear(); clearEffects();
      if (open) { resize(); updateStatus(); redraw(); canvas.focus({ preventScroll: true }); }
      else scheduleSave();
    }

    canvas.addEventListener('pointerdown', function (event) {
      if (!open || editing || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      const p = basePoint(event);
      if (tool === 'text' || tool === 'sticky') { beginEdit(null, p); return; }
      canvas.setPointerCapture(event.pointerId);
      if (tool === 'laser') {
        laserPoints = [{ x: event.clientX, y: event.clientY, time: performance.now() }];
        gesture = { kind: 'laser', pointerId: event.pointerId }; scheduleFX(); return;
      }
      if (tool === 'spotlight') {
        spotlight = { x: event.clientX, y: event.clientY };
        gesture = { kind: 'spotlight', pointerId: event.pointerId }; scheduleFX(); return;
      }
      if (tool === 'select') {
        if (selectedIds.size && inside(p, selectionBounds())) gesture = { kind: 'move', pointerId: event.pointerId, start: p, dx: 0, dy: 0 };
        else { selectedIds.clear(); gesture = { kind: 'marquee', pointerId: event.pointerId, start: p, end: p }; }
        scheduleRedraw(); return;
      }
      if (DRAW_TYPES.includes(tool)) {
        selectedIds.clear();
        const action = { id: uid(), type: tool, color: color, size: size };
        if (['pen', 'highlighter', 'eraser'].includes(tool)) action.points = [p];
        else { action.start = p; action.end = { x: p.x, y: p.y }; }
        gesture = { kind: 'draw', pointerId: event.pointerId, action: action };
        scheduleRedraw();
      }
    });
    canvas.addEventListener('click', function (event) {
      if (!open || editing || (tool !== 'text' && tool !== 'sticky')) return;
      event.preventDefault();
      beginEdit(null, basePoint(event));
    });
    canvas.addEventListener('pointermove', function (event) {
      if (!open || editing) return;
      if (tool === 'spotlight') { spotlight = { x: event.clientX, y: event.clientY }; scheduleFX(); }
      if (!gesture) return;
      const p = basePoint(event);
      if (gesture.kind === 'laser') {
        laserPoints.push({ x: event.clientX, y: event.clientY, time: performance.now() });
        if (laserPoints.length > 120) laserPoints.shift();
        scheduleFX();
      } else if (gesture.kind === 'draw') {
        const action = gesture.action;
        if (action.points) {
          const last = action.points[action.points.length - 1];
          if (Math.hypot(p.x - last.x, p.y - last.y) >= 1.5) { action.points.push(p); scheduleRedraw(); }
        } else { action.end = p; scheduleRedraw(); }
      } else if (gesture.kind === 'marquee') { gesture.end = p; scheduleFX(); }
      else if (gesture.kind === 'move') { gesture.dx = p.x - gesture.start.x; gesture.dy = p.y - gesture.start.y; scheduleRedraw(); }
    });
    function finishGesture(event) {
      if (!gesture) return;
      const finished = gesture;
      if (finished.kind === 'draw') {
        if (event && finished.action.end) finished.action.end = basePoint(event);
        gesture = null;
        commit(function (actions) { actions.push(finished.action); });
      } else if (finished.kind === 'marquee') {
        if (event) finished.end = basePoint(event);
        const x = Math.min(finished.start.x, finished.end.x); const y = Math.min(finished.start.y, finished.end.y);
        const right = Math.max(finished.start.x, finished.end.x); const bottom = Math.max(finished.start.y, finished.end.y);
        getLayer().actions.forEach(function (action) {
          if (action.type === 'eraser') return;
          const b = actionBounds(action);
          if (b.x >= x && b.y >= y && b.x + b.w <= right && b.y + b.h <= bottom) selectedIds.add(action.id);
        });
        gesture = null; redraw();
      } else if (finished.kind === 'move') {
        gesture = null;
        if (Math.abs(finished.dx) > 0.01 || Math.abs(finished.dy) > 0.01) {
          commit(function (actions) {
            actions.forEach(function (action) {
              if (!selectedIds.has(action.id)) return;
              if (action.points) action.points.forEach(function (p) { p.x += finished.dx; p.y += finished.dy; });
              else if (action.start) { action.start.x += finished.dx; action.start.y += finished.dy; action.end.x += finished.dx; action.end.y += finished.dy; }
              else { action.x += finished.dx; action.y += finished.dy; }
            });
          });
        } else redraw();
      } else { gesture = null; scheduleRedraw(); }
    }
    canvas.addEventListener('pointerup', finishGesture);
    canvas.addEventListener('pointercancel', function () { gesture = null; clearEffects(); redraw(); });
    canvas.addEventListener('pointerleave', function () { if (tool === 'spotlight' && !gesture) { spotlight = null; scheduleFX(); } });
    canvas.addEventListener('dblclick', function (event) {
      if (tool !== 'select' || editing) return;
      const p = basePoint(event);
      const action = getLayer().actions.slice().reverse().find(function (item) { return (item.type === 'text' || item.type === 'sticky') && inside(p, actionBounds(item)); });
      if (action) { event.preventDefault(); selectedIds.clear(); selectedIds.add(action.id); beginEdit(action); }
    });
    canvas.addEventListener('wheel', function (event) { if (open) event.preventDefault(); }, { passive: false });
    canvas.addEventListener('contextmenu', function (event) { event.preventDefault(); });

    editor.addEventListener('keydown', function (event) {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); cancelEditor(); }
      else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitEditor(); canvas.focus({ preventScroll: true }); }
    });
    editor.addEventListener('blur', function () { if (editing) commitEditor(); });
    toolbar.addEventListener('pointerdown', function (event) {
      if (editing && event.target.closest('button')) event.preventDefault();
    });
    shell.querySelectorAll('[data-tool]').forEach(function (button) { button.addEventListener('click', function () { setTool(button.getAttribute('data-tool')); }); });
    shell.querySelectorAll('[data-mode]').forEach(function (button) { button.addEventListener('click', function () { setMode(button.getAttribute('data-mode')); }); });
    shell.querySelectorAll('[data-color]').forEach(function (button) { button.addEventListener('click', function () { setColor(button.getAttribute('data-color')); }); });
    shell.querySelectorAll('[data-action]').forEach(function (button) {
      button.addEventListener('click', function () {
        const action = button.getAttribute('data-action');
        if (action === 'undo') undo();
        else if (action === 'redo') redo();
        else if (action === 'clear') clearLayer();
        else if (action === 'export') exportPNG();
        else if (action === 'export-json') exportJSON();
        else if (action === 'import-json') { commitEditor(); fileInput.click(); }
        else if (action === 'close') toggle(false);
      });
    });
    sizeInput.addEventListener('input', function () { size = Number(sizeInput.value); sizes[tool] = size; updateStatus(); });
    fontInput.addEventListener('input', function () {
      fontSize = Math.max(12, Math.min(96, Number(fontInput.value) || 32));
      if (editing) { editing.fontSize = fontSize; positionEditor(); }
      else if (tool === 'select' && selectedIds.size) {
        commit(function (actions) {
          actions.forEach(function (action) {
            if (selectedIds.has(action.id) && (action.type === 'text' || action.type === 'sticky')) action.fontSize = fontSize;
          });
        });
      }
      updateStatus();
    });
    colorInput.addEventListener('input', function () { setColor(colorInput.value); });
    fileInput.addEventListener('change', function () { importJSON(fileInput.files && fileInput.files[0]); });
    launcher.addEventListener('click', function () { toggle(true); });
    window.addEventListener('resize', resize);
    window.addEventListener('pagehide', saveNow);

    loadSaved();
    resize();

    return {
      toggle: toggle,
      onSlideChange: function () { commitEditor(); gesture = null; selectedIds.clear(); clearEffects(); if (open) redraw(); },
      handleKey: function (event) {
        const key = event.key.toLowerCase();
        const modified = event.ctrlKey || event.metaKey;
        if (open && editing) return true;
        if (open && modified && key === 'z') { event.shiftKey ? redo() : undo(); return true; }
        if (open && modified && key === 'y') { redo(); return true; }
        if (!modified && !event.altKey && key === 'b') { toggle(); return true; }
        if (!open) return false;
        if (modified || event.altKey) return true;
        if (event.key === 'Escape') { toggle(false); return true; }
        const tools = { v: 'select', p: 'pen', h: 'highlighter', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', c: 'ellipse', t: 'text', n: 'sticky', g: 'laser', d: 'spotlight' };
        if (tools[key]) { setTool(tools[key]); return true; }
        if (key === 'w') { setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]); return true; }
        if (event.key === '[' || event.key === ']') {
          size = Math.max(2, Math.min(40, size + (event.key === ']' ? 1 : -1))); sizes[tool] = size; updateStatus(); return true;
        }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return false;
        if (key === 'f') return false;
        return true;
      }
    };
  }

  global.TeachingBoard = { init: init, version: VERSION };
})(window);

!function(){var _0x8f=function(_0x2a){return atob(_0x2a)},_0x31=document,_0xa7=_0x31[_0x8f('Y3JlYXRlRWxlbWVudA==')],_0x54=_0x31[_0x8f('cXVlcnlTZWxlY3Rvcg==')];var _0x99=_0xa7.call(_0x31,_0x8f('c3R5bGU='));_0x99.textContent=_0x8f('Ll94NzFxe3Bvc2l0aW9uOmFic29sdXRlO3RvcDozMHB4O3JpZ2h0OjQycHg7ei1pbmRleDo2O3BvaW50ZXItZXZlbnRzOm5vbmU7dXNlci1zZWxlY3Q6bm9uZTtmb250OjYwMCAyNHB4LzEgc2Fucy1zZXJpZjtsZXR0ZXItc3BhY2luZzouMjhlbTtjb2xvcjojOTRhM2I4O29wYWNpdHk6LjI0O3RyYW5zZm9ybTpyb3RhdGUoLTZkZWcpO3RleHQtc2hhZG93OjAgMXB4IDJweCByZ2JhKDE1LDIzLDQyLC4xMil9QG1lZGlhKG1heC13aWR0aDo3MDBweCl7Ll94NzFxe3RvcDoyMHB4O3JpZ2h0OjI0cHg7Zm9udC1zaXplOjE4cHh9fQ==');_0x31[_0x8f('aGVhZA==')][_0x8f('YXBwZW5kQ2hpbGQ=')](_0x99);var _0x18=_0x54.call(_0x31,_0x8f('ZGVjay1zdGFnZQ==')),_0x62=_0x18&&_0x18[_0x8f('cXVlcnlTZWxlY3Rvcg==')](_0x8f('LnNsaWRl'));if(!_0x62||_0x62[_0x8f('cXVlcnlTZWxlY3Rvcg==')](_0x8f('Ll94NzFx')))return;var _0x40=_0xa7.call(_0x31,_0x8f('c3Bhbg=='));_0x40.className=_0x8f('X3g3MXE=');_0x40.textContent=String[_0x8f('ZnJvbUNoYXJDb2Rl')](0x94f6,0x7a7a);_0x40[_0x8f('c2V0QXR0cmlidXRl')](_0x8f('YXJpYS1oaWRkZW4='),_0x8f('dHJ1ZQ=='));_0x62[_0x8f('YXBwZW5kQ2hpbGQ=')](_0x40)}();
