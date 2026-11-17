// YouTube "Gifts powered by Jewels" detection — an earlier overlay's deep-scan (src/chat/youtube-innertube-patch.js,
// findGiftMeta / extractGiftChatItems), ported without the youtube-chat parser patch (the connector parses InnerTube
// itself). Gift renderers / view-models vary; any action whose JSON mentions jewels / gift metadata is deep-walked
// for jewelsAmount, giftName, comboCount, the author and the id.

type Data = Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any

export interface GiftMeta {
  jewelsAmount: number; giftName: string; giftUrl: string; comboCount: number; altText: string;
  authorName: string; authorChannelId: string; id: string; timestampUsec: string; displayMessage: string;
}

function asText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  const n = node as Data;
  if (typeof n.simpleText === 'string') return n.simpleText;
  if (Array.isArray(n.runs)) return n.runs.map((r: Data) => (!r ? '' : typeof r.text === 'string' ? r.text : r.emoji ? (r.emoji.shortcuts?.[0] || r.emoji.emojiId || '') : '')).join('');
  if (n.accessibility?.accessibilityData) return String(n.accessibility.accessibilityData.label || '');
  if (typeof n.label === 'string') return n.label;
  if (typeof n.altText === 'string') return n.altText;
  return '';
}
function toInt(v: unknown) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  const n = parseInt(String(v).replace(/,/g, '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function findGiftMeta(root: unknown): GiftMeta | null {
  if (!root || typeof root !== 'object') return null;
  let jewelsAmount = 0, giftName = '', giftUrl = '', comboCount = 0, altText = '', authorName = '', authorChannelId = '', id = '', timestampUsec = '', displayMessage = '';
  let foundJewelKey = false, foundGiftishKey = false;
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
    seen.add(obj);
    if (Array.isArray(obj)) { for (const v of obj) if (v && typeof v === 'object') stack.push(v); continue; }
    for (const [k, v] of Object.entries(obj as Data)) {
      const lk = k.toLowerCase();
      if (lk === 'jewelsamount' || lk === 'jewels_amount' || lk === 'jewelamount') { const n = toInt(v); if (n > 0) { jewelsAmount = Math.max(jewelsAmount, n); foundJewelKey = true; } }
      if (lk === 'giftname' || lk === 'gift_name') { const t = asText(v) || (typeof v === 'string' ? v : ''); if (t) { giftName ||= t; foundGiftishKey = true; } }
      if (lk === 'gifturl' || lk === 'gift_url') { if (typeof v === 'string' && v) { giftUrl ||= v; foundGiftishKey = true; } }
      if (lk === 'combocount' || lk === 'combo_count') { const n = toInt(v); if (n > 0) comboCount = Math.max(comboCount, n); }
      if (lk === 'alttext' || lk === 'alt_text') { const t = asText(v) || (typeof v === 'string' ? v : ''); if (t) altText ||= t; }
      if (lk === 'authorexternalchannelid' && typeof v === 'string') authorChannelId ||= v;
      if ((lk === 'authorname' || lk === 'authordisplayname' || lk === 'displayname') && !authorName) { const t = asText(v); if (t) authorName = t; }
      if (lk === 'author' && v && typeof v === 'object' && !authorName) { authorName = asText((v as Data).name) || asText((v as Data).displayName) || authorName; if (typeof (v as Data).channelId === 'string') authorChannelId ||= (v as Data).channelId; }
      if (lk === 'id' && typeof v === 'string' && v.length > 8 && !id) id = v;
      if (lk === 'timestampusec' && (typeof v === 'string' || typeof v === 'number')) timestampUsec = String(v);
      if (lk === 'displaymessage' || lk === 'headertext' || lk === 'primarytext') { const t = asText(v); if (t) displayMessage ||= t; }
      if (/giftmessage|giftpurchase|giftevent|livechatgift|ytgift|jewel/i.test(k)) foundGiftishKey = true;
      if (typeof v === 'string' && /jewels?/i.test(v)) {
        const m = v.match(/([0-9][0-9,]*)\s*jewels?\b/i);
        if (m) { const n = toInt(m[1]); if (n > 0) { jewelsAmount = Math.max(jewelsAmount, n); foundJewelKey = true; } }
        if (!authorName) { const am = v.match(/^(.+?)\s+sent\b/i); if (am) authorName = am[1].replace(/^@/, '').trim(); }
        if (!giftName) { const gm = v.match(/\bsent\s+(.+?)(?:\s*\(|$)/i); if (gm) giftName = gm[1].trim(); }
      }
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  if (!foundJewelKey && !foundGiftishKey) return null;
  if (!jewelsAmount && !giftName && !foundJewelKey) return null;
  return { jewelsAmount, giftName: giftName || altText || '', giftUrl, comboCount, altText, authorName: (authorName || '').replace(/^@/, '').trim(), authorChannelId, id, timestampUsec, displayMessage };
}

function actionLooksLikeGift(action: unknown) {
  if (!action || typeof action !== 'object') return false;
  let blob = '';
  try { blob = JSON.stringify(action); } catch { return false; }
  // membership gift purchases are handled as memberships (they say "gift" too)
  if (/liveChatSponsorshipsGift(Purchase|Redemption)AnnouncementRenderer/.test(blob) && !/jewel/i.test(blob)) return false;
  return /jewelsAmount|jewels_amount|"Jewels"|giftMessage|GiftMessage|giftEventDetails|giftMetadata|yt-gift|liveChatGift/i.test(blob);
}

export interface GiftItem { id: string; author: string; channelId: string; ts: number; jewels: number; giftName: string; comboCount: number; display: string }

/** Every Jewels gift in one get_live_chat response. */
export function extractGiftItems(data: unknown): GiftItem[] {
  const out: GiftItem[] = [];
  const actions = (data as Data)?.continuationContents?.liveChatContinuation?.actions;
  if (!Array.isArray(actions)) return out;
  const ids = new Set<string>();
  actions.forEach((action: unknown, idx: number) => {
    if (!actionLooksLikeGift(action)) return;
    const meta = findGiftMeta(action);
    if (!meta) return;
    const jewels = meta.jewelsAmount || 0;
    const label = meta.giftName || meta.altText || 'Gift';
    const ts = meta.timestampUsec ? Number(meta.timestampUsec) / 1000 : Date.now();
    const id = meta.id || `yt-jewel:${meta.authorName || 'anon'}:${jewels}:${label}:${idx}:${Math.round(ts)}`;
    if (ids.has(id)) return;
    ids.add(id);
    out.push({ id, author: meta.authorName || 'youtube_user', channelId: meta.authorChannelId, ts, jewels, giftName: label, comboCount: meta.comboCount, display: meta.displayMessage || (jewels > 0 ? `sent ${label} (${jewels} Jewel${jewels === 1 ? '' : 's'})` : `sent ${label}`) });
  });
  return out;
}
