/*
 * Ядро роботи з Baofeng MINI-5 / UV-5R Mini.
 * Протокол і розмітка пам'яті перенесені з відкритого драйвера CHIRP
 * (chirp/drivers/baofeng_uv17Pro.py, клас UV5RMini). Тут лише зчитування:
 * жодна функція цього файлу нічого не записує в рацію.
 */
(function (root) {
  'use strict';

  const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  // Послідовність входу в режим програмування (як у CHIRP)
  const IDENT = enc('PROGRAMCOLORPROU');
  // Запасний варіант, яким CHIRP входить у споріднену UV-5G Mini з прошивкою V0.05
  const IDENTS = [IDENT, enc('PROGRAMGMRS5RMIU')];
  const MAGICS = [
    { cmd: [0x46], len: 16, key: 'F' },
    { cmd: [0x4d], len: 15, key: 'M' },
    {
      cmd: [0x53, 0x45, 0x4e, 0x44, 0x21, 0x05, 0x0d, 0x01, 0x01, 0x01, 0x04,
        0x11, 0x08, 0x05, 0x0d, 0x0d, 0x01, 0x11, 0x0f, 0x09, 0x12, 0x09, 0x10,
        0x04, 0x00],
      len: 1, key: 'SEND'
    }
  ];

  // Ділянки пам'яті рації, які зчитуються, і їх розмір
  const REGIONS = [[0x0000, 0x8040], [0x9000, 0x0040], [0xa000, 0x01c0]];
  const MEM_TOTAL = 0x8240;
  const BLOCK = 0x40;
  const CHANNELS = 999;
  const CH_SIZE = 32;

  const TOTAL_BLOCKS = REGIONS.reduce((n, [, size]) => n + size / BLOCK, 0);

  // Простий XOR-шифр обміну (ключ "CO 7")
  const SYM = enc('CO 7');
  function crypt(buf) {
    const out = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      const s = SYM[i % 4];
      const b = buf[i];
      const doIt = s !== 0x20 && b !== 0x00 && b !== 0xff && b !== s && b !== (s ^ 0xff);
      out[i] = doIt ? b ^ s : b;
    }
    return out;
  }

  const DCS = [23, 25, 26, 31, 32, 36, 43, 47, 51, 53, 54, 65, 71, 72, 73, 74, 114,
    115, 116, 122, 125, 131, 132, 134, 143, 145, 152, 155, 156, 162, 165, 172,
    174, 205, 212, 223, 225, 226, 243, 244, 245, 246, 251, 252, 255, 261, 263,
    265, 266, 271, 274, 306, 311, 315, 325, 331, 332, 343, 346, 351, 356, 364,
    365, 371, 411, 412, 413, 423, 431, 432, 445, 446, 452, 454, 455, 462, 464,
    465, 466, 503, 506, 516, 523, 526, 532, 546, 565, 606, 612, 624, 627, 631,
    632, 645, 654, 662, 664, 703, 712, 723, 731, 732, 734, 743, 754];

  function decodeTone(v) {
    if (v === 0 || v === 0xffff) return null;
    if (v >= 0x0258) return { type: 'CTCSS', value: v / 10 };
    let idx, pol;
    if (v > 0x69) { idx = v - 0x6a; pol = 'I'; } else { idx = v - 1; pol = 'N'; }
    const code = DCS[idx];
    if (code === undefined) return { type: '?', value: v };
    return { type: 'DCS', value: code, pol };
  }

  function toneText(t) {
    if (!t) return '';
    if (t.type === 'CTCSS') return t.value.toFixed(1);
    if (t.type === 'DCS') return 'D' + String(t.value).padStart(3, '0') + t.pol;
    return '?' + t.value;
  }

  // Частота: 4 байти BCD, молодший байт першим, одиниця 10 Гц
  function lbcd(b, off) {
    let v = 0, mul = 1;
    for (let i = 0; i < 4; i++) {
      const x = b[off + i];
      const hi = x >> 4, lo = x & 0x0f;
      if (hi > 9 || lo > 9) return null;
      v += (hi * 10 + lo) * mul;
      mul *= 100;
    }
    return v * 10;
  }

  const AIR = [108000000, 135999999];

  function decodeChannel(img, n) {
    const o = (n - 1) * CH_SIZE;
    if (img[o] === 0xff) return null;
    const rx = lbcd(img, o);
    if (rx === null || rx === 0) return null;
    const txBytes = img.slice(o + 4, o + 8);
    const tx = txBytes.every((x) => x === 0xff) ? null : lbcd(img, o + 4);
    const rxTone = decodeTone(img[o + 8] | (img[o + 9] << 8));
    const txTone = decodeTone(img[o + 10] | (img[o + 11] << 8));
    const b14 = img[o + 14], b15 = img[o + 15];
    const lowpower = b14 & 0x03;
    const narrow = (b15 >> 6) & 1;
    const bcl = (b15 >> 3) & 1;
    const scan = (b15 >> 2) & 1;
    let name = '';
    for (let i = 0; i < 12; i++) {
      const c = img[o + 20 + i];
      if (c === 0x00 || c === 0xff) break;
      name += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '·';
    }
    name = name.trim();
    let mode = narrow ? 'NFM' : 'FM';
    if (rx >= AIR[0] && rx <= AIR[1]) mode = 'AM';
    let duplex = '', offset = 0;
    if (tx === null) duplex = 'off';
    else if (tx !== rx) {
      const d = tx - rx;
      if (Math.abs(d) > 70000000) { duplex = 'split'; offset = tx; }
      else { duplex = d > 0 ? '+' : '-'; offset = Math.abs(d); }
    }
    return {
      n, name, rx, tx, duplex, offset, rxTone, txTone,
      power: lowpower === 1 ? 'Low' : 'High',
      mode, scan: !!scan, bcl: !!bcl
    };
  }

  function decodeImage(img) {
    const list = [];
    for (let n = 1; n <= CHANNELS; n++) {
      const ch = decodeChannel(img, n);
      if (ch) list.push(ch);
    }
    return list;
  }

  function mhz(hz, digits) {
    if (hz === null || hz === undefined) return '';
    return (hz / 1e6).toFixed(digits === undefined ? 5 : digits);
  }

  // ---------- Файли, сумісні з CHIRP ----------
  const MAGIC = Uint8Array.from([0x00, 0xff, 0x63, 0x68, 0x69, 0x72, 0x70, 0xee,
    0x69, 0x6d, 0x67, 0x00, 0x01]);

  function toChirpImg(img) {
    const meta = JSON.stringify({
      rclass: 'UV5RMini', vendor: 'Baofeng', model: 'UV-5R Mini',
      variant: '', chirp_version: 'py3dev'
    });
    const b64 = enc(btoa(meta));
    const out = new Uint8Array(MEM_TOTAL + MAGIC.length + b64.length);
    out.set(img.subarray(0, MEM_TOTAL), 0);
    out.set(MAGIC, MEM_TOTAL);
    out.set(b64, MEM_TOTAL + MAGIC.length);
    return out;
  }

  function fromChirpImg(bytes) {
    let end = bytes.length;
    outer: for (let i = 0; i + MAGIC.length <= bytes.length; i++) {
      for (let j = 0; j < MAGIC.length; j++) {
        if (bytes[i + j] !== MAGIC[j]) continue outer;
      }
      end = i; break;
    }
    let meta = null;
    if (end < bytes.length) {
      try {
        const b64 = String.fromCharCode.apply(null, bytes.subarray(end + MAGIC.length));
        meta = JSON.parse(atob(b64));
      } catch (e) { meta = null; }
    }
    if (end < MEM_TOTAL) throw new Error('Файл замалий: це не образ MINI-5 / UV-5R Mini.');
    if (meta && meta.model && meta.model !== 'UV-5R Mini') {
      throw new Error('Файл від іншої рації: ' + meta.vendor + ' ' + meta.model + '.');
    }
    return bytes.slice(0, MEM_TOTAL);
  }


  const hex = (a) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(' ');
  const ascii = (a) => Array.from(a, (x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Вхід у режим програмування: пароль, підтвердження 06, службові запити F, M, SEND
  async function enterProgramMode(link, log) {
    const take = () => (link.takeAll ? link.takeAll() : (link.clear(), new Uint8Array(0)));
    let entered = false;
    const answers = [];
    for (let attempt = 0; attempt < 3 && !entered; attempt++) {
      for (const id of IDENTS) {
        await sleep(attempt ? 700 : 300);
        const junk = take();
        if (junk.length) log('відкинуто зайве від рації: ' + hex(junk));
        log('→ вхід у режим програмування (' + ascii(id) + ', спроба ' + (attempt + 1) + ')');
        await link.write(id);
        let r;
        try { r = await link.read(1, 2500); } catch (e) { log('← тиша'); answers.push('тиша'); continue; }
        if (r[0] === 0x06) { log('← підтвердження 06'); entered = true; break; }
        await sleep(400);
        const extra = take();
        const all = hex(r) + (extra.length ? ' ' + hex(extra) : '');
        log('← несподівано: ' + all + '  «' + ascii(r) + ascii(extra) + '»');
        answers.push(all);
      }
    }
    if (!entered) {
      throw new Error('Рація не входить у режим програмування (відповіді: ' + answers.join('; ') + '). ' +
        'Закрийте OLA Radio і від\'єднайте рацію від інших пристроїв, вимкніть і ввімкніть рацію, знову MENU → 4 → ON, і повторіть.');
    }

    const info = {};
    for (const m of MAGICS) {
      await link.write(Uint8Array.from(m.cmd));
      const r = await link.read(m.len, 3000);
      info[m.key] = r;
      log('← ' + m.key + ': ' + hex(r) + (m.key === 'M' ? '  «' + ascii(r) + '»' : ''));
    }
    return info;
  }

  // ---------- Зчитування з рації ----------
  // link: { write(Uint8Array), read(n, timeoutMs) -> Uint8Array, clear() }
  async function download(link, opts) {
    opts = opts || {};
    const log = opts.log || function () {};
    const info = await enterProgramMode(link, log);
    const img = await readBlocks(link, opts);
    return { img, model: ascii(info.M || []).trim(), fw: hex(info.F || []) };
  }

  // Читання всієї пам'яті (рація вже в режимі програмування)
  async function readBlocks(link, opts) {
    const log = opts.log || function () {};
    const progress = opts.progress || function () {};
    const img = new Uint8Array(MEM_TOTAL);
    let pos = 0, done = 0;
    const t0 = Date.now();
    for (const [start, size] of REGIONS) {
      for (let addr = start; addr < start + size; addr += BLOCK) {
        const frame = Uint8Array.from([0x52, (addr >> 8) & 0xff, addr & 0xff, BLOCK]);
        let d = null, lastErr = null;
        for (let attempt = 0; attempt < 3 && !d; attempt++) {
          try {
            if (attempt > 0) {
              log('↻ повтор блоку 0x' + addr.toString(16).padStart(4, '0'));
              await sleep(300);
              link.clear();
            }
            await link.write(frame);
            const r = await link.read(BLOCK + 4, 3000);
            if (r[0] !== 0x52 || r[1] !== ((addr >> 8) & 0xff) || r[2] !== (addr & 0xff)) {
              throw new Error('заголовок блоку ' + hex(r.subarray(0, 4)));
            }
            d = r;
          } catch (e) { lastErr = e; }
        }
        if (!d) {
          throw new Error('Зв\'язок перервався на блоці 0x' + addr.toString(16) +
            ' (' + (lastErr && lastErr.message) + '). Підійдіть ближче до рації й повторіть.');
        }
        img.set(crypt(d.subarray(4)), pos);
        pos += BLOCK;
        done++;
        progress(done, TOTAL_BLOCKS, Date.now() - t0);
      }
    }
    log('✓ зчитано ' + pos + ' байт за ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с');
    return img;
  }

  // ---------- Запис у рацію ----------
  // Як у CHIRP для Bluetooth: блоки по 0x80, неповний блок доповнюється 0xFF,
  // на кожен блок рація відповідає 06. Після запису рація перезапускається.
  const WBLOCK = 0x80;
  const TOTAL_WBLOCKS = REGIONS.reduce((n, [, size]) => n + Math.ceil(size / WBLOCK), 0);

  async function writeBlocks(link, img, opts) {
    const log = opts.log || function () {};
    const progress = opts.progress || function () {};
    if (!img || img.length < MEM_TOTAL) throw new Error('Немає повного образу пам\'яті для запису.');
    let src = 0, done = 0;
    const t0 = Date.now();
    for (const [start, size] of REGIONS) {
      for (let addr = start; addr < start + size; addr += WBLOCK) {
        const cnt = Math.min(WBLOCK, start + size - addr);
        const data = new Uint8Array(WBLOCK).fill(0xff);
        data.set(img.subarray(src, src + cnt));
        src += cnt;
        const frame = new Uint8Array(4 + WBLOCK);
        frame.set([0x57, (addr >> 8) & 0xff, addr & 0xff, WBLOCK]);
        frame.set(crypt(data), 4);
        await link.write(frame);
        let ack;
        try { ack = await link.read(1, 4000); } catch (e) {
          throw new Error('Рація не підтвердила запис блоку 0x' + addr.toString(16) + ' (' + e.message + ').');
        }
        if (ack[0] !== 0x06) throw new Error('Рація відхилила блок 0x' + addr.toString(16) + ': ' + hex(ack));
        done++;
        progress(done, TOTAL_WBLOCKS, Date.now() - t0);
      }
    }
    log('✓ записано ' + done + ' блоків за ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с');
  }

  // ---------- Кодування каналів (як CHIRP set_memory) ----------
  function lbcdPut(b, off, hz) {
    let v = Math.round(hz / 10);
    for (let i = 0; i < 4; i++) {
      const two = v % 100; v = Math.floor(v / 100);
      b[off + i] = ((Math.floor(two / 10)) << 4) | (two % 10);
    }
  }

  function encodeTone(t) {
    if (!t) return 0;
    if (t.type === 'CTCSS') return Math.round(t.value * 10);
    if (t.type === 'DCS') {
      const idx = DCS.indexOf(t.value);
      if (idx < 0) throw new Error('Невідомий код DCS ' + t.value);
      return t.pol === 'I' ? idx + 1 + 0x69 : idx + 1;
    }
    return 0;
  }

  function parseTone(text) {
    const s = String(text || '').trim().toUpperCase();
    if (!s) return null;
    let m = s.match(/^D(\d{3})([NI])$/);
    if (m) return { type: 'DCS', value: parseInt(m[1], 10), pol: m[2] };
    const v = parseFloat(s);
    if (!isNaN(v)) return { type: 'CTCSS', value: v };
    throw new Error('Не розумію тон «' + text + '»');
  }

  // ch: { name, rx (Гц), tx (Гц або null), txTone, rxTone, power 'High'|'Low', mode 'FM'|'NFM'|'AM', scan }
  function encodeChannel(img, n, ch) {
    const o = (n - 1) * CH_SIZE;
    const raw = new Uint8Array(CH_SIZE);
    if (!ch) { raw.fill(0xff); img.set(raw, o); return; }
    raw.fill(0x00, 0, 16); raw.fill(0xff, 16, 32);
    lbcdPut(raw, 0, ch.rx);
    if (ch.tx === null || ch.tx === undefined) raw.fill(0xff, 4, 8); else lbcdPut(raw, 4, ch.tx);
    const rt = encodeTone(ch.rxTone), tt = encodeTone(ch.txTone);
    raw[8] = rt & 0xff; raw[9] = rt >> 8; raw[10] = tt & 0xff; raw[11] = tt >> 8;
    raw[14] = ch.power === 'Low' ? 1 : 0;
    raw[15] = (ch.mode === 'NFM' ? 0x40 : 0) | (ch.scan === false ? 0 : 0x04);
    const name = String(ch.name || '').slice(0, 12);
    for (let i = 0; i < name.length; i++) raw[20 + i] = name.charCodeAt(i) & 0x7f;
    img.set(raw, o);
  }

  // Налаштування (зсуви в образі, як у CHIRP)
  const SET = { squelch: 0x8040, dualWatch: 0x8044, alarmMode: 0x8051, alarmTone: 0x8052, sk1: 0x8072 };
  const ALARM_MODES = ['лише гучна сирена на рації', 'сирена передається в ефір', 'в ефір передається код'];
  function readSettings(img) {
    const sk = { 0x07: 'FM-радіо', 0x1c: 'сканування', 0x1d: 'пошук частоти' };
    return {
      alarmMode: img[SET.alarmMode],
      alarmModeText: ALARM_MODES[img[SET.alarmMode]] || ('код ' + img[SET.alarmMode]),
      alarmTone: !!img[SET.alarmTone],
      sk1: img[SET.sk1],
      sk1Text: sk[img[SET.sk1]] || ('інше, код 0x' + img[SET.sk1].toString(16)),
      squelch: img[SET.squelch],
      dualWatch: !!img[SET.dualWatch]
    };
  }

  const api = {
    download, enterProgramMode, readBlocks, writeBlocks, encodeChannel, encodeTone, parseTone, readSettings, SET,
    TOTAL_WBLOCKS, CH_SIZE, DCS, decodeImage, decodeChannel, decodeTone, toneText, crypt, mhz,
    toChirpImg, fromChirpImg, MEM_TOTAL, TOTAL_BLOCKS, REGIONS, BLOCK, IDENT, MAGICS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RadioCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
