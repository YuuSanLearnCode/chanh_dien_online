// Chánh Điện Tịnh Tâm — live server
// Runs on the streaming PC. Serves the overlay + control panel, listens to a TikTok LIVE room,
// keeps the list of seated viewers, generates Vietnamese voice lines with Edge TTS and pushes
// everything to the overlay over WebSocket.
//
//   cd live && npm install && node server.mjs        → http://localhost:3000/live/control.html
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // repo root: serves /assets, /live
const TTS_DIR = path.join(__dirname, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }
const PORT = +process.env.PORT || 3000;

/* ------------------------------------------------------------------ state */
const settings = {
  title: 'LINH QUANG BẢO ĐIỆN',
  subtitle: '0783 783 783',
  voice: 'vi-VN-NamMinhNeural',      // or vi-VN-HoaiMyNeural
  pitch: -18,                        // Hz
  rate: -20,                         // %
  music: true, mo: true, moBpm: 52, musicVol: 50, prayVol: 100, ttsVol: 100, sfxVol: 100,
  autoChant: true, chantEveryMin: 3,
  seatMode: 'auto',                  // auto | 24 | 36 | 64 | 100
  joinOnEnter: false,                // also seat viewers who only enter the room
  gifts: { readAll: true, minDiamonds: 1 },
};
const viewers = new Map();           // id -> { id, name, skin, avatar, coins, joinedAt, lastAt, lastText, lastTextAt, demo }
const startedAt = Date.now();
const LAST_ID_FILE = path.join(__dirname, '.last_tiktok');
let tiktok = null, tiktokState = { status: 'idle', uniqueId: fs.existsSync(LAST_ID_FILE) ? fs.readFileSync(LAST_ID_FILE, 'utf8').trim() : 'phapsuhuyentri', error: '' };
const log = [];
function addLog(s){ const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`; log.push(line); if (log.length > 300) log.shift(); broadcast({ t:'log', line }, 'control'); console.log(line); }

const CAPS = [24, 36, 64, 100];
function capacity(){ if (settings.seatMode !== 'auto') return +settings.seatMode; const n = viewers.size; return CAPS.find(c => n <= c) || 100; }

/* skins: sprites that exist in /assets. Walking strips exist for man / woman / granny. */
// A comment changes the outfit only when it IS the keyword (≤ 3 words), so "Nam mô A Di Đà Phật" never reads as "nam".
const SKIN_WORDS = [
  ['master', ['cao tăng','cao tang']], ['monk', ['sư','su','sư thầy','su thay','thầy','thay']], ['nun', ['ni','ni cô','ni co','sư cô','su co']],
  ['child', ['tiểu','tieu','chú tiểu','chu tieu','bé','be']], ['granny', ['bà','ba','áo nâu','ao nau','cụ','cu']],
  ['woman', ['nữ','nu','chị','chi','gái','gai']], ['man', ['nam','anh','trai']],
];
function skinFromText(t){
  const w = String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w || w.split(' ').length > 3) return null;
  for (const [skin, words] of SKIN_WORDS) if (words.some(k => w === k || w.startsWith(k + ' '))) return skin;
  return null;
}
const DEFAULT_SKINS = ['man', 'woman', 'woman', 'man', 'granny'];

function pub(v){ return { id:v.id, name:v.name, skin:v.skin, avatar:v.avatar||'', coins:v.coins, demo:!!v.demo }; }
function snapshot(){ return { t:'state', settings, viewers:[...viewers.values()].map(pub), cap: capacity(), startedAt, tiktok: tiktokState }; }

function seat(id, name, opts = {}){
  let v = viewers.get(id);
  if (v){ v.lastAt = Date.now(); if (opts.avatar) v.avatar = opts.avatar; return { v, isNew:false }; }
  if (viewers.size >= 100){                     // full: the longest-quiet non-donor stands up
    const quiet = [...viewers.values()].filter(x => x.coins === 0).sort((a,b) => a.lastAt - b.lastAt)[0];
    if (!quiet) return { v:null, isNew:false };
    viewers.delete(quiet.id); broadcast({ t:'leave', id: quiet.id });
  }
  v = { id, name: hasBadWord(name) ? 'Ẩn danh' : (name||id).slice(0, 18), skin: opts.skin || DEFAULT_SKINS[viewers.size % DEFAULT_SKINS.length],
        avatar: opts.avatar || '', coins: 0, joinedAt: Date.now(), lastAt: Date.now(), demo: !!opts.demo };
  viewers.set(id, v);
  broadcast({ t:'join', v: pub(v), cap: capacity() });
  return { v, isNew:true };
}

/* ------------------------------------------------------------- events in */
const BAD_WORDS = [
  'đm','đkm','đcm','đmm','đĩ','đéo','đụ','địt','lồn','cặc','buồi','dái','chó đẻ','súc vật','óc chó','vãi lồn','vl','vcl','cc','clm','đmẹ','mẹ mày','bố mày','con đĩ','thằng chó','ngu lồn','cứt','ăn cứt','chết tiệt',
  'dm','dkm','dcm','dmm','dit','suc vat','oc cho','vai lon','thang cho','an cut',
  'sex','porn','xxx','jav','nude','18+','ấu dâm','hiếp dâm','loạn luân','kích dục','phim sex','clip nóng',
  'cờ bạc','tài xỉu','cá độ','nổ hũ','nhà cái','lô đề','kubet','rikvip','go88','sunwin','b52','iwin','hitclub',
  'ma túy','cần sa','đập đá','thuốc lắc','kẹo ke','tự tử','giết người','chặt đầu','khủng bố','phản động','lừa đảo','bịp'
];
function hasBadWord(s){
  const tok = String(s || '').toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = []; for (const x of tok){ const last = out[out.length - 1]; if ([...x].length === 1 && last && last.one) last.s += x; else out.push({ s: x, one: [...x].length === 1 }); }
  const t = ' ' + out.map(o => o.s).join(' ') + ' ';
  return BAD_WORDS.some(w => t.includes(' ' + w + ' '));
}
const PRAY_TOPICS = [
  [['binh an','cau an'], 'Nguyện xin Thần Ganesha che chở gia đạo bình an, tai qua nạn khỏi'],
  [['cau duyen','tinh duyen','nhan duyen','luong duyen','xin duyen','duyen'], 'Nguyện xin Thần Ganesha ban phước nhân duyên tốt đẹp, tình duyên viên mãn'],
  [['cau tai','tai loc','phat tai','tien tai'], 'Nguyện xin Thần Ganesha ban phước tài lộc dồi dào, công việc hanh thông'],
  [['cau tu','cau con','con cai'], 'Nguyện xin Thần Ganesha ban phước con cái, gia đình sum vầy hạnh phúc'],
  [['giai han','tai uong','het xui','xa xui','giai xui'], 'Nguyện xin Thần Ganesha hóa giải vận hạn, xua tan xui rủi'],
  [['xoa no','tra no','het no','no nan'], 'Nguyện xin Thần Ganesha xóa tan nợ nần, đón nhận thịnh vượng sung túc'],
];
function topicPrayer(s){
  const w = ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ') + ' ';
  const p = PRAY_TOPICS.find(x => x[0].some(k => w.includes(' ' + k + ' ')));
  return p ? p[1] : null;
}

function onChat(id, name, text, avatar){
  text = String(text || '').slice(0, 120);
  const want = skinFromText(text);
  const { v, isNew } = seat(id, name, { avatar, skin: want || undefined });
  if (!v) return;
  if (!isNew && want && want !== v.skin){ v.skin = want; broadcast({ t:'skin', id, skin: want }); }
  if (hasBadWord(text)) return;
  v.lastText = text; v.lastTextAt = Date.now();
  broadcast({ t:'chat', id, name: v.name, text });
}

function onGift(id, name, giftName, count, diamonds, avatar){
  giftName = String(giftName || 'quà').slice(0, 30); count = Math.max(1, Math.min(9999, +count || 1));
  const { v } = seat(id, name, { avatar });
  if (!v) return;
  const coins = Math.max(1, (diamonds || 1) * (count || 1));
  v.coins += coins;
  const prayer = (v.lastText && Date.now() - v.lastTextAt < 90_000 && topicPrayer(v.lastText)) || pickPrayer();
  const tier = coins >= 99 ? 3 : coins >= 10 ? 2 : 1;
  const busy = ttsQueue.length >= 2 && tier === 1;
  const line = busy
    ? `Om Gam Ganapataye Namaha. Tín chủ ${spoken(v.name)} dâng ${giftName}${count > 1 ? ' ' + count + ' lần' : ''} lên Thần Ganesha.`
    : `Om Gam Ganapataye Namaha. Tín chủ ${spoken(v.name)} thành tâm dâng ${giftName}${count > 1 ? ', ' + count + ' lần' : ''} lên Thần Ganesha. ${prayer}.`;
  broadcast({ t:'gift', id, name: v.name, giftName, count, coins, total: v.coins, tier, prayer });
  if (settings.gifts.readAll || coins >= settings.gifts.minDiamonds) say(line, { tag:'gift', id, tier });
}

function pickPrayer(){
  const P = [
    'Nguyện xin Thần Ganesha xóa bỏ mọi chướng ngại, dẫn lối thành công',
    'Nguyện xin Ngài ban phước tài lộc dồi dào, công việc hanh thông, vạn sự cát tường',
    'Nguyện xin Ngài khai mở trí tuệ sáng suốt, cầu được ước thấy',
    'Nguyện xin Ngài che chở gia đạo bình an, tai qua nạn khỏi, phúc lộc đầy nhà',
    'Nguyện xin Ngài xóa tan nợ nần vướng bận, đón nhận thịnh vượng và sung túc',
    'Nguyện xin Ngài ban phước nhân duyên tốt đẹp, cuộc sống luôn ngập tràn hoan hỷ'
  ];
  return P[Math.floor(Math.random() * P.length)];
}
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'ẩn danh';

/* ------------------------------------------------------------------ TTS */
const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
function esc(s){ return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])); }
function say(text, meta = {}){
  const item = { text: String(text).slice(0, 500), meta };
  if (meta.tag === 'gift' && meta.id){
    const same = ttsQueue.findIndex(x => x.meta?.tag === 'gift' && x.meta?.id === meta.id);
    if (same >= 0){ ttsQueue[same] = item; return; }
  }
  if ((meta.tier || 0) >= 2){
    const idx = ttsQueue.findIndex(x => (x.meta?.tier || 0) < (meta.tier || 0));
    if (idx >= 0) ttsQueue.splice(idx, 0, item);
    else ttsQueue.push(item);
    if (ttsQueue.length > 8) ttsQueue.pop();
    pumpTTS(); return;
  }
  if (ttsQueue.length >= 6) { addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; }
  ttsQueue.push(item); pumpTTS();
}
let clockSynced = false;
async function syncEdgeClock(){
  if (clockSynced) return;
  try {
    const r = await fetch('https://www.bing.com', { method: 'HEAD', signal: AbortSignal.timeout(2500) });
    const d = r.headers.get('date');
    if (d) { MsEdgeTTS._clockOffsetMs = Date.parse(d) - Date.now(); clockSynced = true; }
  } catch {}
}
async function pumpTTS(){
  if (ttsBusy || !ttsQueue.length) return; ttsBusy = true;
  const { text, meta } = ttsQueue.shift();
  try {
    await syncEdgeClock();
    const file = `tts_${Date.now()}_${++ttsSeq}.mp3`;
    const tts = new MsEdgeTTS();
    await tts.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(esc(text), { pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`, rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%`, volume: '+0%' });
    const chunks = [];
    await new Promise((res, rej) => { audioStream.on('data', c => chunks.push(c)); audioStream.on('close', res); audioStream.on('error', e => chunks.length > 0 ? res() : rej(e)); });
    try { tts.close(); } catch {}
    if (chunks.length) {
      fs.writeFileSync(path.join(TTS_DIR, file), Buffer.concat(chunks));
      broadcast({ t:'tts', url: `/live/tts/${file}`, text, ...meta });
    }
    const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 40) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch {} }
  } catch (e) { clockSynced = false; addLog('TTS lỗi: ' + (e?.message || e)); }
  ttsBusy = false; setTimeout(pumpTTS, 150);
}

const CHANTS = [
  ['Om Gam Ganapataye Namaha. Nguyện xin Thần Ganesha xóa bỏ mọi chướng ngại và ban phước lành.', '/assets/music/kinhdailoc.mp3'],
  ['Om Gam Ganapataye Namaha. Nguyện ánh sáng trí tuệ và thịnh vượng soi chiếu đến tất cả mọi người.', '/assets/music/kinhdailoc2.mp3'],
];
let chantIdx = 0, chantTimer = null;
function chant(){ const [text, url] = CHANTS[chantIdx++ % CHANTS.length]; broadcast({ t:'chant', text }); broadcast({ t:'tts', url, text, tag:'chant' }); }
function scheduleChant(){ clearInterval(chantTimer); if (settings.autoChant) chantTimer = setInterval(chant, Math.max(1, settings.chantEveryMin) * 60_000); }
scheduleChant();

/* --------------------------------------------------------------- TikTok */
let TikTokLib = null;
async function connectTikTok(uniqueId){
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!uniqueId) return;
  try { fs.writeFileSync(LAST_ID_FILE, uniqueId); } catch {}
  await disconnectTikTok();
  tiktokState = { status: 'connecting', uniqueId, error: '' }; broadcast({ t:'tiktok', ...tiktokState });
  try {
    TikTokLib ||= await import('tiktok-live-connector');
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = TikTokLib;
    const conn = new TikTokLiveConnection(uniqueId, { enableExtendedGiftInfo: false, processInitialData: false });
    const uid = u => u?.displayId || u?.uniqueId || u?.idStr || (u?.id && u.id !== '0' ? u.id : '') || u?.userId || u?.secUid || u?.nickname || 'anon';
    const av = u => u?.avatarThumb?.urlList?.[0] || u?.profilePicture?.url?.[0] || u?.profilePicture?.urlList?.[0] || u?.avatarThumb?.url?.[0] || '';
    const nm = u => u?.nickname || u?.displayId || u?.uniqueId || 'ẩn danh';
    conn.on(WebcastEvent.CHAT, d => {
      const txt = d.content ?? d.comment ?? '';
      onChat(uid(d.user), nm(d.user), txt, av(d.user));
      if (txt) addLog(`💬 ${nm(d.user)}: ${txt}`);
    });
    const streaks = new Map(), giftTimers = new Map(), streakClean = new Map();
    conn.on(WebcastEvent.GIFT, d => {
      const id = uid(d.user), name = nm(d.user), avatar = av(d.user);
      const type = d.gift?.type ?? d.giftDetails?.giftType ?? d.extendedGiftInfo?.type;
      const count = d.repeatCount || d.comboCount || 1;
      const gname = d.gift?.name || d.giftDetails?.giftName || d.extendedGiftInfo?.name || 'quà';
      const dia = d.gift?.diamondCount ?? d.giftDetails?.diamondCount ?? d.extendedGiftInfo?.diamond_count ?? 1;
      const key = (d.groupId && d.groupId !== '0') ? d.groupId : `${id}_${d.giftId || gname}`;
      const flush = () => {
        giftTimers.delete(key);
        const prev = streaks.get(key) || 0;
        if (count <= prev) return;
        streaks.set(key, count); if (streaks.size > 200) streaks.delete(streaks.keys().next().value);
        clearTimeout(streakClean.get(key));
        streakClean.set(key, setTimeout(() => { streaks.delete(key); streakClean.delete(key); }, 8000));
        onGift(id, name, gname, count - prev, dia, avatar);
        addLog(`🎁 ${name} tặng ${gname} x${count}`);
      };
      clearTimeout(giftTimers.get(key));
      if (d.repeatEnd || (type !== 1 && !d.gift?.combo)) flush();
      else giftTimers.set(key, setTimeout(flush, 2200));
    });
    conn.on(WebcastEvent.MEMBER, d => { if (settings.joinOnEnter) seat(uid(d.user), nm(d.user), { avatar: av(d.user) }); });
    conn.on(WebcastEvent.LIKE, d => broadcast({ t:'like', id: uid(d.user), n: d.count || d.likeCount || 1 }));
    conn.on(ControlEvent.DISCONNECTED, () => { tiktokState = { ...tiktokState, status: 'disconnected' }; broadcast({ t:'tiktok', ...tiktokState }); addLog('TikTok: mất kết nối'); });
    conn.on(ControlEvent.ERROR, e => addLog('TikTok lỗi: ' + (e?.info || e?.message || e)));
    const st = await conn.connect();
    tiktok = conn;
    tiktokState = { status: 'connected', uniqueId, error: '', roomId: st?.roomId || '' };
    addLog(`✅ Đã kết nối live @${uniqueId}`);
  } catch (e) {
    tiktokState = { status: 'error', uniqueId, error: String(e?.message || e) };
    addLog(`❌ Không kết nối được @${uniqueId}: ${tiktokState.error}`);
  }
  broadcast({ t:'tiktok', ...tiktokState });
}
async function disconnectTikTok(){ if (tiktok){ try { await tiktok.disconnect(); } catch {} tiktok = null; } tiktokState = { status:'idle', uniqueId:'', error:'' }; broadcast({ t:'tiktok', ...tiktokState }); }

/* ------------------------------------------------------------- test data */
const DEMO_NAMES = ['Diệu Hạnh','Minh Tâm','Thiện Đức','Huệ An','Tịnh Nhã','Quảng Trí','Chơn Như','Pháp Hỷ','Nguyên Thanh','Tâm Đăng','Diệu Liên','Trí Hải','Phước Lộc','Hạnh Nguyện','Như Ý','Bảo Châu','Thanh Lương','Từ Tâm','An Lạc','Giác Hoa','Tuệ Minh','Liên Hương','Thu Hà','Ngọc Lan','Đức Anh','Hải Đăng','Mai Anh','Phương Thảo','Trung Kiên','Quang Huy','Bảo Ngọc','Diệu Linh'];
function fillDemo(n){
  const have = [...viewers.values()].filter(v => v.demo).length;
  for (let i = have; i < n && viewers.size < 100; i++){
    const name = DEMO_NAMES[i % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ' ' + (Math.floor(i / DEMO_NAMES.length) + 1) : '');
    seat('demo_' + i, name, { demo: true, skin: ['man','woman','woman','man','granny','monk','nun','child'][i % 8] });
  }
}
function clearSeats(){ viewers.clear(); broadcast(snapshot()); addLog('Đã làm trống bồ đoàn'); }

/* ------------------------------------------------------------- control */
function onControl(m){
  switch (m.cmd){
    case 'connect': connectTikTok(m.uniqueId); break;
    case 'disconnect': disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    case 'chat': { const n = String(m.name || 'Khách').slice(0, 18); onChat('sim_' + n, n, String(m.text || 'Nam mô A Di Đà Phật').slice(0, 120)); break; }
    case 'gift': { const n = String(m.name || 'Khách').slice(0, 18); onGift('sim_' + n, n, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000)); break; }
    case 'fill': fillDemo(clamp(m.n, 1, 100)); addLog(`Đổ người mẫu: ${viewers.size} người`); break;
    case 'clear': clearSeats(); break;
    case 'bell': broadcast({ t:'bell' }); break;
    case 'mo': broadcast({ t:'mo1' }); break;
    case 'chant': chant(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 400), { tag:'say' }); break;
    case 'settings':
      applySettings(m.settings || {});
      scheduleChant(); broadcast({ t:'settings', settings, cap: capacity() }); break;
    case 'bots': setBots(!!m.on, +m.n || 12, m.pace); break;
  }
}

// Only known keys, right types, sane ranges: the panel is local, but nothing from the socket is trusted blindly.
const SETTING_RULES = {
  title: v => String(v).slice(0, 40), subtitle: v => String(v).slice(0, 60),
  voice: v => ['vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), moBpm: v => clamp(v, 20, 120), chantEveryMin: v => clamp(v, 1, 60),
  musicVol: v => clamp(v, 0, 100), prayVol: v => clamp(v, 0, 100), ttsVol: v => clamp(v, 0, 100), sfxVol: v => clamp(v, 0, 100),
  music: Boolean, mo: Boolean, autoChant: Boolean, joinOnEnter: Boolean,
  seatMode: v => ['auto', '24', '36', '64', '100'].includes(String(v)) ? String(v) : 'auto',
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
function applySettings(o){ for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in o) settings[k] = fn(o[k]); }

/* ----------------------------------------------------------------- bots */
let botTimer = null;
const BOT_LINES = ['Nam mô A Di Đà Phật', 'Nam mô Bổn Sư Thích Ca Mâu Ni Phật', 'Cầu cho gia đình bình an', 'Con xin thành tâm sám hối', 'nữ', 'nam', 'bà',
  'Nguyện cầu cha mẹ mạnh khỏe', 'Mô Phật, an lạc quá', 'Chúc mọi người một ngày bình an', 'sư', 'Cầu công việc hanh thông'];
function setBots(on, n, pace){
  clearInterval(botTimer); botTimer = null;
  if (on){
    n = clamp(n, 1, 100);
    for (let i = 0; i < n; i++) seat('bot_' + i, DEMO_NAMES[(i + 7) % DEMO_NAMES.length] + ' ·bot', { demo: true });
    const every = { slow: 4000, mid: 1800, fast: 700 }[pace] || 1800;
    botTimer = setInterval(() => {
      const ids = [...viewers.keys()].filter(id => id.startsWith('bot_')); if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)], v = viewers.get(id), r = Math.random();
      if (r < .62) onChat(id, v.name, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]);
      else if (r < .9) broadcast({ t:'like', id, n: 1 + Math.floor(Math.random() * 4) });
      else if (r < .985) onGift(id, v.name, 'Hoa hồng', 1 + Math.floor(Math.random() * 3), 1);
      else onGift(id, v.name, 'Đèn hoa sen', 1, 99);
    }, every);
    addLog(`🤖 Bật ${n} bot, nhịp ${pace}`);
  } else {
    for (const id of [...viewers.keys()]) if (id.startsWith('bot_')) { viewers.delete(id); broadcast({ t:'leave', id }); }
    addLog('🤖 Tắt bot');
  }
  broadcast({ t:'bots', on }, 'control');
}

/* -------------------------------------------------------------- server */
// Security notes (this file is meant to be shared publicly):
//  • listens on 127.0.0.1 only; nothing is reachable from the LAN or internet unless HOST is changed on purpose
//  • Host header must be localhost/127.0.0.1 (blocks DNS-rebinding pages from talking to the server)
//  • WebSocket only accepts pages served by this server (Origin check), so other sites open in the
//    same browser cannot send control commands
//  • static files: only /assets and /live, no dot-files, no node_modules, no server source, no path escapes
//  • no TikTok password, cookie or session is ever used or stored; only public room events are read
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.mp3':'audio/mpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const okHost = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
const SEP = path.sep;
function resolveStatic(urlPath){
  let p = urlPath === '/' ? '/live/control.html' : urlPath;
  if (!/^\/(assets|live)\//.test(p)) return null;
  if (p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules')) return null;
  if (/\.(mjs|json|md|log)$/i.test(p) && !p.startsWith('/assets/')) return null;      // never serve server code / package files
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + SEP)) return null;
  return file;
}
const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!okHost(req.headers.host)) return false;
    if (!origin) return true;                                   // OBS / non-browser clients send no Origin
    try { return okHost(new URL(origin).host); } catch { return false; }
  } });
function broadcast(msg, only){ const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control') ws.send(JSON.stringify({ t:'logs', lines: log }));
  ws.on('message', buf => {
    if (ws.role !== 'control') return;                          // overlays only listen
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});
server.listen(PORT, HOST, () => {
  addLog(`Server chạy tại http://localhost:${PORT}  ·  Bảng điều khiển: http://localhost:${PORT}/live/control.html  ·  Overlay: http://localhost:${PORT}/live/overlay.html`);
  if (tiktokState.uniqueId) connectTikTok(tiktokState.uniqueId);
});
