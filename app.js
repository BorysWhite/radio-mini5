/* Рації MINI-5: зчитування по Bluetooth, перегляд, порівняння, експорт. */
(function () {
  'use strict';
  const C = window.RadioCore;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------- Журнал ----------------
  const logLines = [];
  function log(msg) {
    const t = new Date().toLocaleTimeString('uk-UA');
    logLines.push(t + '  ' + msg);
    if (logLines.length > 400) logLines.shift();
    const el = $('#log');
    if (el) { el.textContent = logLines.join('\n'); el.scrollTop = el.scrollHeight; }
  }

  // ---------------- Bluetooth ----------------
  const SVC = 0xffe0;
  const OTHER_SVCS = [0xfff0, '6e400001-b5a3-f393-e0a9-e50e24dcca9e'];

  class BleLink {
    constructor() {
      this.buf = []; this.waiters = []; this.device = null; this.onDisconnect = null;
      this._onData = (e) => {
        const dv = e.target.value;
        const v = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        for (const b of v) this.buf.push(b);
        if (this.rawLog < 12) { this.rawLog++; log('  сирі дані: ' + Array.from(v, (x) => x.toString(16).padStart(2, '0')).join(' ')); }
        for (const w of this.waiters.slice()) w();
      };
    }

    async connect(showAll) {
      const opts = showAll
        ? { acceptAllDevices: true, optionalServices: [SVC].concat(OTHER_SVCS) }
        : { filters: [{ namePrefix: 'walkie' }, { services: [SVC] }], optionalServices: [SVC].concat(OTHER_SVCS) };
      this.device = await navigator.bluetooth.requestDevice(opts);
      log('Обрано пристрій: ' + (this.device.name || 'без назви'));
      this.device.addEventListener('gattserverdisconnected', () => {
        log('Зв\'язок з рацією розірвано');
        if (this.onDisconnect) this.onDisconnect();
      });
      // Після повторного підключення старий обробник даних прибираємо, інакше байти дублюються
      if (this.rxChar) { try { this.rxChar.removeEventListener('characteristicvaluechanged', this._onData); } catch (e) { /* ignore */ } }
      this.rxChar = null; this.txChar = null; this.small = false; this.buf = []; this.rawLog = 0;
      const server = await this.device.gatt.connect();
      let service = null;
      for (const s of [SVC].concat(OTHER_SVCS)) {
        try { service = await server.getPrimaryService(s); log('Сервіс: ' + service.uuid); break; } catch (e) { /* далі */ }
      }
      if (!service) throw new Error('На цьому пристрої немає сервісу для програмування. Можливо, обрано не рацію.');
      const chars = await service.getCharacteristics();
      // Спершу беремо відому характеристику рації FFE1, інші лише як запасний варіант
      const main = chars.find((c) => c.uuid.startsWith('0000ffe1'));
      for (const c of chars) {
        const p = c.properties;
        log('Характеристика ' + c.uuid + ': ' + ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => p[k]).join(', '));
      }
      const ordered = main ? [main].concat(chars.filter((c) => c !== main)) : chars;
      for (const c of ordered) {
        const p = c.properties;
        if (!this.rxChar && (p.notify || p.indicate)) this.rxChar = c;
        if (!this.txChar && (p.writeWithoutResponse || p.write)) this.txChar = c;
      }
      log('Прийом: ' + this.rxChar.uuid.slice(4, 8) + ', передача: ' + this.txChar.uuid.slice(4, 8));
      if (!this.rxChar || !this.txChar) throw new Error('Не знайдено канал обміну з рацією.');
      this.rxChar.addEventListener('characteristicvaluechanged', this._onData);
      await this.rxChar.startNotifications();
      log('Підключено');
    }

    get connected() { return !!(this.device && this.device.gatt && this.device.gatt.connected); }

    disconnect() { try { if (this.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ } }

    clear() { this.buf = []; }

    takeAll() { const b = Uint8Array.from(this.buf); this.buf = []; return b; }

    async _send(chunk) {
      const c = this.txChar;
      if (c.properties.writeWithoutResponse && c.writeValueWithoutResponse) return c.writeValueWithoutResponse(chunk);
      if (c.writeValueWithResponse && c.properties.write) return c.writeValueWithResponse(chunk);
      return c.writeValue(chunk);
    }

    async write(bytes) {
      if (this.small || bytes.length <= 20) {
        for (let i = 0; i < bytes.length; i += 20) await this._send(bytes.slice(i, i + 20));
        return;
      }
      try { await this._send(bytes); } catch (e) {
        log('Великий пакет не пройшов, ділю на частини по 20 байт');
        this.small = true;
        for (let i = 0; i < bytes.length; i += 20) await this._send(bytes.slice(i, i + 20));
      }
    }

    read(n, timeout) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (this.buf.length >= n) {
            this.waiters = this.waiters.filter((w) => w !== check);
            clearTimeout(tm);
            resolve(Uint8Array.from(this.buf.splice(0, n)));
          }
        };
        const tm = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== check);
          reject(new Error('немає відповіді за ' + timeout + ' мс (отримано ' + this.buf.length + ' з ' + n + ' байт)'));
        }, timeout);
        this.waiters.push(check);
        check();
      });
    }
  }

  // ---------------- Збережені зчитування ----------------
  const KEY = 'mini5.images.v1';
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

  function loadImages() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }
  function saveImages(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) {
      alert('Не вдалося зберегти: пам\'ять браузера заповнена. Видаліть старі зчитування.');
      return false;
    }
  }
  function addImage(img, meta) {
    const list = loadImages();
    const item = Object.assign({ id: 'i' + Date.now(), date: new Date().toISOString(), b64: toB64(img) }, meta);
    list.unshift(item);
    saveImages(list);
    return item;
  }
  const getImage = (id) => loadImages().find((x) => x.id === id);
  const bytesOf = (item) => fromB64(item.b64);
  const fmtDate = (iso) => new Date(iso).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // ---------------- Експорт ----------------
  async function saveFile(bytes, name, mime) {
    const blob = new Blob([bytes], { type: mime });
    const file = typeof File === 'function' ? new File([blob], name, { type: mime }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const safeName = (s) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_');
  const stamp = (iso) => iso.slice(0, 16).replace(/[-:T]/g, '');

  function csvOf(list) {
    const rows = [['Канал', 'Назва', 'Прийом МГц', 'Передача МГц', 'Тон передачі', 'Тон прийому', 'Потужність', 'Смуга', 'У скануванні']];
    for (const c of list) {
      rows.push([c.n, c.name, C.mhz(c.rx), c.tx === null ? 'заборонено' : C.mhz(c.tx), C.toneText(c.txTone), C.toneText(c.rxTone),
        c.power === 'Low' ? 'низька' : 'висока', c.mode === 'NFM' ? 'вузька' : c.mode === 'AM' ? 'AM' : 'широка', c.scan ? 'так' : 'ні']);
    }
    return '\ufeff' + rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(';')).join('\r\n');
  }

  // ---------------- Відображення каналу ----------------
  function describe(c) {
    const parts = [];
    if (c.duplex === 'off') parts.push('лише прийом');
    else if (c.duplex === 'split') parts.push('передача ' + C.mhz(c.tx));
    else if (c.duplex) parts.push('зсув ' + c.duplex + C.mhz(c.offset, 3));
    const tt = C.toneText(c.txTone), rt = C.toneText(c.rxTone);
    if (tt && tt === rt) parts.push('тон ' + tt);
    else {
      if (tt) parts.push('тон перед. ' + tt);
      if (rt) parts.push('тон прий. ' + rt);
    }
    parts.push(c.power === 'Low' ? 'низька' : 'висока');
    parts.push(c.mode === 'NFM' ? 'вузька' : c.mode === 'AM' ? 'AM' : 'широка');
    if (!c.scan) parts.push('поза скануванням');
    if (c.bcl) parts.push('блок. зайнятого');
    return parts.join(', ');
  }

  function channelRow(c, cls) {
    return '<li class="ch ' + (cls || '') + '"><span class="num">' + String(c.n).padStart(3, '0') + '</span>' +
      '<span class="main"><span class="freq">' + C.mhz(c.rx) + '<small>МГц</small></span>' +
      (c.name ? '<span class="name">' + esc(c.name) + '</span>' : '') +
      '<span class="meta">' + esc(describe(c)) + '</span></span></li>';
  }

  // ---------------- Стан інтерфейсу ----------------
  const link = new BleLink();
  let busy = false;

  function setDisplay(a, b, mode) {
    $('#lcdA').textContent = a;
    $('#lcdB').textContent = b;
    $('#lcd').dataset.mode = mode || '';
  }

  function refreshRadioTab() {
    const connected = link.connected;
    $('#btnConnect').hidden = connected;
    $('#linkAll').hidden = connected;
    $('#btnDisconnect').hidden = !connected;
    $('#btnRead').disabled = !connected || busy;
    $('#readBox').hidden = !connected;
    if (!busy) {
      if (connected) setDisplay((link.device.name || 'Рація') + ' на зв\'язку', 'Готово до зчитування', 'rx');
      else {
        const last = loadImages()[0];
        setDisplay('Рацію не підключено', last ? 'Останнє: ' + last.label + ', ' + fmtDate(last.date) : 'Зчитувань ще немає');
      }
    }
  }

  function fillSelect(sel, current) {
    const list = loadImages();
    sel.innerHTML = list.length
      ? list.map((x) => '<option value="' + x.id + '"' + (x.id === current ? ' selected' : '') + '>' + esc(x.label) + ', ' + fmtDate(x.date) + '</option>').join('')
      : '<option value="">немає зчитувань</option>';
  }

  function renderChannels() {
    const sel = $('#selImage');
    fillSelect(sel, sel.value || (loadImages()[0] || {}).id);
    const item = getImage(sel.value);
    const box = $('#chList');
    $('#chTools').hidden = !item;
    if (!item) {
      box.innerHTML = '<p class="empty">Тут з\'являться канали після першого зчитування рації або відкриття файлу CHIRP.</p>';
      $('#chCount').textContent = '';
      return;
    }
    const q = $('#chSearch').value.trim().toLowerCase();
    const all = C.decodeImage(bytesOf(item));
    const list = q ? all.filter((c) => (c.name.toLowerCase().includes(q) || C.mhz(c.rx).includes(q) || String(c.n) === q)) : all;
    $('#chCount').textContent = 'Заповнено каналів: ' + all.length + (q ? ', знайдено: ' + list.length : '') + (item.model ? '. Модель: ' + item.model : '');
    box.innerHTML = list.length ? '<ul class="chs">' + list.map((c) => channelRow(c)).join('') + '</ul>' : '<p class="empty">Нічого не знайдено.</p>';
  }

  function renderCompare() {
    const a = $('#cmpA'), b = $('#cmpB');
    const list = loadImages();
    fillSelect(a, a.value || (list[1] || list[0] || {}).id);
    fillSelect(b, b.value || (list[0] || {}).id);
    const out = $('#cmpOut');
    const ia = getImage(a.value), ib = getImage(b.value);
    if (!ia || !ib || list.length < 2) {
      out.innerHTML = '<p class="empty">Зчитайте обидві рації, і тут буде видно, чим відрізняються їхні канали.</p>';
      return;
    }
    if (ia.id === ib.id) { out.innerHTML = '<p class="empty">Оберіть два різні зчитування.</p>'; return; }
    const ca = new Map(C.decodeImage(bytesOf(ia)).map((c) => [c.n, c]));
    const cb = new Map(C.decodeImage(bytesOf(ib)).map((c) => [c.n, c]));
    const nums = Array.from(new Set([...ca.keys(), ...cb.keys()])).sort((x, y) => x - y);
    const key = (c) => c ? [c.name, c.rx, c.tx, C.toneText(c.txTone), C.toneText(c.rxTone), c.power, c.mode, c.scan, c.bcl].join('|') : '';
    let same = 0; const rows = [];
    for (const n of nums) {
      const x = ca.get(n), y = cb.get(n);
      if (key(x) === key(y)) { same++; continue; }
      rows.push('<div class="diff"><div class="dn">Канал ' + String(n).padStart(3, '0') + '</div>' +
        '<div class="dc"><span class="who">' + esc(ia.label) + '</span>' + (x ? '<ul class="chs">' + channelRow(x) + '</ul>' : '<p class="none">порожній</p>') + '</div>' +
        '<div class="dc"><span class="who">' + esc(ib.label) + '</span>' + (y ? '<ul class="chs">' + channelRow(y) + '</ul>' : '<p class="none">порожній</p>') + '</div></div>');
    }
    out.innerHTML = '<p class="summary">' + (rows.length ? 'Відрізняються каналів: <b>' + rows.length + '</b>. Однакових: ' + same + '.' : 'Канали обох рацій однакові (' + same + ').') + '</p>' + rows.join('');
  }

  function renderSaved() {
    const list = loadImages();
    const box = $('#saved');
    box.innerHTML = list.length ? list.map((x) =>
      '<li><span><b>' + esc(x.label) + '</b><br><small>' + fmtDate(x.date) + (x.source === 'file' ? ', з файлу' : '') + '</small></span>' +
      '<span class="row-btns"><button class="ghost" data-rename="' + x.id + '">Перейменувати</button>' +
      '<button class="ghost danger" data-del="' + x.id + '">Видалити</button></span></li>').join('')
      : '<li class="empty">Поки що нічого не збережено.</li>';
  }

  function showTab(name) {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.panel').forEach((p) => { p.hidden = p.id !== 'p-' + name; });
    if (name === 'channels') renderChannels();
    if (name === 'compare') renderCompare();
    if (name === 'radio') { refreshRadioTab(); renderSaved(); }
    window.scrollTo(0, 0);
  }

  // ---------------- Дії ----------------
  async function doConnect(showAll) {
    if (!navigator.bluetooth) return;
    try {
      setDisplay('Пошук рації…', 'Оберіть «walkie-talkie» у списку', 'busy');
      link.onDisconnect = () => refreshRadioTab();
      await link.connect(showAll);
    } catch (e) {
      if (e.name === 'NotFoundError') log('Пошук скасовано');
      else { log('Помилка підключення: ' + e.message); alert(e.message); }
    }
    refreshRadioTab();
  }

  async function doRead() {
    if (busy || !link.connected) return;
    busy = true; refreshRadioTab();
    const bar = $('#bar'), pct = $('#pct');
    $('#progress').hidden = false;
    $('#afterRead').hidden = true;
    bar.style.width = '0%';
    setDisplay('Зчитування…', 'Не вимикайте рацію', 'busy');
    try {
      const r = await C.download(link, {
        log,
        progress: (done, total, ms) => {
          const p = Math.round(done / total * 100);
          bar.style.width = p + '%';
          const left = done ? Math.round(ms / done * (total - done) / 1000) : 0;
          pct.textContent = p + '%' + (done > 5 ? ', лишилось близько ' + left + ' с' : '');
          $('#lcdB').textContent = 'Блок ' + done + ' з ' + total;
        }
      });
      const n = loadImages().filter((x) => x.source !== 'file').length + 1;
      const label = ($('#label').value.trim() || ('Рація ' + n));
      const item = addImage(r.img, { label, model: r.model, fw: r.fw, source: 'radio' });
      const count = C.decodeImage(r.img).length;
      setDisplay('Зчитано: ' + item.label, 'Каналів: ' + count, 'rx');
      $('#label').value = '';
      $('#afterRead').hidden = false;
      renderSaved();
    } catch (e) {
      log('Помилка: ' + e.message);
      setDisplay('Зчитування не вдалося', 'Деталі в журналі нижче', 'tx');
      alert(e.message);
    } finally {
      busy = false;
      $('#progress').hidden = true;
      $('#btnRead').disabled = !link.connected;
    }
  }

  async function doImport(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const img = C.fromChirpImg(bytes);
      const item = addImage(img, { label: file.name.replace(/\.img$/i, ''), source: 'file' });
      $('#selImage').value = item.id;
      renderChannels();
    } catch (e) { alert(e.message); }
  }

  // ---------------- Запуск ----------------
  function init() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

    if (!navigator.bluetooth) {
      $('#noBt').hidden = false;
      $('#btnConnect').disabled = true;
      $('#linkAll').hidden = true;
      log('Браузер не підтримує Web Bluetooth');
    } else if (navigator.bluetooth.getAvailability) {
      navigator.bluetooth.getAvailability().then((ok) => { if (!ok) { $('#btOff').hidden = false; } }).catch(() => {});
    }

    $('#btnConnect').addEventListener('click', () => doConnect(false));
    $('#linkAll').addEventListener('click', (e) => { e.preventDefault(); doConnect(true); });
    $('#btnDisconnect').addEventListener('click', () => { link.disconnect(); setTimeout(refreshRadioTab, 200); });
    $('#btnRead').addEventListener('click', doRead);
    $('#goChannels').addEventListener('click', () => { $('#selImage').value = (loadImages()[0] || {}).id; showTab('channels'); });

    $('#selImage').addEventListener('change', renderChannels);
    $('#chSearch').addEventListener('input', renderChannels);
    $('#cmpA').addEventListener('change', renderCompare);
    $('#cmpB').addEventListener('change', renderCompare);

    $('#btnImg').addEventListener('click', () => {
      const it = getImage($('#selImage').value); if (!it) return;
      saveFile(C.toChirpImg(bytesOf(it)), 'MINI-5_' + safeName(it.label) + '_' + stamp(it.date) + '.img', 'application/octet-stream');
    });
    $('#btnCsv').addEventListener('click', () => {
      const it = getImage($('#selImage').value); if (!it) return;
      saveFile(new TextEncoder().encode(csvOf(C.decodeImage(bytesOf(it)))), 'MINI-5_' + safeName(it.label) + '_' + stamp(it.date) + '.csv', 'text/csv');
    });
    $('#btnOpen').addEventListener('click', () => $('#fileIn').click());
    $('#fileIn').addEventListener('change', (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; });

    $('#saved').addEventListener('click', (e) => {
      const del = e.target.dataset.del, ren = e.target.dataset.rename;
      if (del) {
        const it = getImage(del);
        if (it && confirm('Видалити зчитування «' + it.label + '»? Це стосується лише копії в програмі, рація не зміниться.')) {
          saveImages(loadImages().filter((x) => x.id !== del)); renderSaved(); refreshRadioTab();
        }
      }
      if (ren) {
        const list = loadImages(); const it = list.find((x) => x.id === ren);
        const v = it && prompt('Нова назва', it.label);
        if (v && v.trim()) { it.label = v.trim(); saveImages(list); renderSaved(); refreshRadioTab(); }
      }
    });

    $('#btnCopyLog').addEventListener('click', async () => {
      const text = logLines.join('\n') + '\n\n' + navigator.userAgent;
      try { await navigator.clipboard.writeText(text); $('#btnCopyLog').textContent = 'Скопійовано'; }
      catch (e) { prompt('Скопіюйте журнал вручну:', text); }
      setTimeout(() => { $('#btnCopyLog').textContent = 'Скопіювати журнал'; }, 2000);
    });

    window.addEventListener('beforeunload', () => link.disconnect());
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

    log('Програма запущена, версія ' + window.APP_VERSION);
    showTab('radio');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
