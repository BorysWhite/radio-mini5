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

  // ---------- Зчитування з рації ----------
  // link: { write(Uint8Array), read(n, timeoutMs) -> Uint8Array, clear() }
  async function download(link, opts) {
    opts = opts || {};
    const log = opts.log || function () {};
    const progress = opts.progress || function () {};
    const hex = (a) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(' ');
    const ascii = (a) => Array.from(a, (x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');

    link.clear();
    log('→ вхід у режим програмування');
    await link.write(IDENT);
    let ack;
    try { ack = await link.read(1, 3000); } catch (e) {
      throw new Error('Рація не відповіла. Перевірте, що на рації увімкнено Wireless CPS (MENU → 4 → ON), і спробуйте ще раз.');
    }
    if (ack[0] !== 0x06) throw new Error('Несподівана відповідь рації: ' + hex(ack));
    log('← підтвердження 06');

    const info = {};
    for (const m of MAGICS) {
      await link.write(Uint8Array.from(m.cmd));
      const r = await link.read(m.len, 3000);
      info[m.key] = r;
      log('← ' + m.key + ': ' + hex(r) + (m.key === 'M' ? '  «' + ascii(r) + '»' : ''));
    }
    const modelStr = ascii(info.M || []).trim();

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
              await new Promise((r) => setTimeout(r, 300));
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
    return { img, model: modelStr, fw: hex(info.F || []) };
  }

  const api = {
    download, decodeImage, decodeChannel, decodeTone, toneText, crypt, mhz,
    toChirpImg, fromChirpImg, MEM_TOTAL, TOTAL_BLOCKS, REGIONS, BLOCK, IDENT, MAGICS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RadioCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
