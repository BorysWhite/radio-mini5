# Мої рації MINI-5

PWA для Baofeng MINI-5 / UV-5R Mini: зчитування пам'яті по Bluetooth (Web Bluetooth),
перегляд каналів, порівняння двох рацій, експорт у CHIRP (.img) і CSV.

- `radio-core.js` — протокол і розбір пам'яті, перенесено з CHIRP `drivers/baofeng_uv17Pro.py` (клас `UV5RMini`).
  BLE: сервіс 0xFFE0, характеристика 0xFFE1 (notify + write without response), ім'я пристрою `walkie-talkie`.
  Вхід: `PROGRAMCOLORPROU` → 06, потім `F`(16), `M`(15), `SEND!…`(1). Читання блоками 0x40: `R addrHi addrLo 40` → 4 байти заголовка + 64 байти, XOR-ключ «CO 7».
  Ділянки: 0x0000+0x8040, 0x9000+0x40, 0xA000+0x1C0 (разом 0x8240). Канал 32 байти, 999 каналів.
- `app.js` — BleLink (буфер сповіщень, поділ записів на 20 байт), інтерфейс, localStorage `mini5.images.v1`.
- Версія 1.0.0: лише зчитування. Запис (версія 2): блоки 0x80 по BLE, див. `_upload` у CHIRP; перед записом обов'язкова резервна копія.
- iPhone: Safari не підтримує Web Bluetooth, працює лише в браузері Bluefy.
- Схема розгортання: GitHub Pages, див. skill mac-iphone-apps. При оновленні міняти VERSION у `sw.js` і APP_VERSION в `index.html`.
