// src/matches/slots.ts

export type Team = 'A' | 'B';

export type Slot = {
  team: Team;
  pos: string;            // GK/LB/.../SUB
  userId: string | null;  // gerçek kullanıcı
  // Yer tutucu / “+1” bilgisi
  placeholder?: 'ADMIN' | 'GUEST';
  guestOfUserId?: string | null; // placeholder === 'GUEST' ise kim getiriyor
};

// ✅ Slot boş mu? (ne kullanıcı ne de placeholder var)
export function isFree(s: Slot): boolean {
  return !s.userId && !s.placeholder;
}

/** Varsayılan yedek sayısı (takım başı). */
export const DEFAULT_RESERVES_PER_TEAM = 2;

/** Format metninden takım kişi sayısı (7v7 → 7). */
export function teamSizeFromFormat(format?: string): number {
  const m = /(\d+)\s*v\s*(\d+)/i.exec(format || '');
  if (!m) return 7;
  const left = Number(m[1] || 7);
  return Math.max(1, Math.min(left, 11));
}

/** Şablon pozisyonları */
export const DEFAULT_SLOTS: Record<string, string[]> = {
  '5v5'  : ['GK', 'CB', 'CM', 'LW', 'ST'],
  '6v6'  : ['GK', 'LB', 'RB', 'DM', 'AM', 'ST'],
  '7v7'  : ['GK', 'LB', 'CB', 'RB', 'CM', 'LW', 'ST'],
  '8v8'  : ['GK', 'LB', 'CB', 'RB', 'CM', 'AM', 'LW', 'ST'],
  '9v9'  : ['GK', 'LB', 'RB', 'CB', 'DM', 'CM', 'AM', 'RW', 'LW'],
  '10v10': ['GK', 'LB', 'CB', 'RB', 'DM', 'CM', 'AM', 'RW', 'LW', 'ST'],
  '11v11': ['GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LW', 'ST'],
};

/** Format -> takım başı SUB sayısı: 5-6:1, 7-9:2, 10-11:3 */
function subsPerTeam(fmt?: string, override?: number) {
  if (typeof override === 'number') return Math.max(0, override);
  const n = teamSizeFromFormat(fmt);
  if (n <= 6) return 1;
  if (n <= 9) return 2;
  return 3; // 10-11
}

/** SUB sayısını format kuralına göre tam olarak sabitler.
 *  - Eksikse ekler
 *  - Fazlaysa SADECE boş (isFree) SUB'ları kırpar
 */
function ensureSubsCount(base: Slot[], fmt?: string, override?: number): Slot[] {
  const out = [...base];
  const wantPerTeam = subsPerTeam(fmt, override);

  // Mevcut SUB sayıları
  let a = out.filter(s => s.team === 'A' && s.pos === 'SUB').length;
  let b = out.filter(s => s.team === 'B' && s.pos === 'SUB').length;

  // Eksikleri ekle
  while (a < wantPerTeam) { out.push({ team: 'A', pos: 'SUB', userId: null }); a++; }
  while (b < wantPerTeam) { out.push({ team: 'B', pos: 'SUB', userId: null }); b++; }

  // Fazlaları (yalnızca boş SUB ise) kırp
  while (a > wantPerTeam) {
    const i = out.findIndex(s => s.team === 'A' && s.pos === 'SUB' && isFree(s));
    if (i === -1) break;
    out.splice(i, 1); a--;
  }
  while (b > wantPerTeam) {
    const i = out.findIndex(s => s.team === 'B' && s.pos === 'SUB' && isFree(s));
    if (i === -1) break;
    out.splice(i, 1); b--;
  }

  return out;
}


export function positionsForFormat(fmt?: string, overridePositions?: string[]): string[] {
  if (overridePositions && overridePositions.length) return overridePositions.map(String);
  const key = String(fmt || '7v7').toLowerCase();
  return DEFAULT_SLOTS[key] ?? DEFAULT_SLOTS['7v7'];
}

/** Takım başı N yedek (SUB) ekler. */
export function addReserves(base: Slot[], perTeam = DEFAULT_RESERVES_PER_TEAM): Slot[] {
  // fmt’i burada bilmiyoruz; sayıyı override olarak veriyoruz
  return ensureSubsCount(base, /*fmt*/ undefined, /*override*/ perTeam);
}

/** Maç oluştururken ilk slotları üretir (A ve B) + varsayılan yedekleri ekler. */
export function buildInitialSlots(
  fmt?: string,
  overridePositions?: string[],
  reservesPerTeam = DEFAULT_RESERVES_PER_TEAM,
): Slot[] {
  const base = positionsForFormat(fmt, overridePositions);
  const a: Slot[] = base.map((pos) => ({ team: 'A', pos, userId: null }));
  const b: Slot[] = base.map((pos) => ({ team: 'B', pos, userId: null }));
  return addReserves([...a, ...b], reservesPerTeam);
}

/** Eski tek listeden (team alanı olmayan) yeni yapıya çevirir + yedek ekler. */
export function upgradeLegacySlots(
  raw: any,
  fmt?: string,
  reservesPerTeam = DEFAULT_RESERVES_PER_TEAM,
): Slot[] {
  // Yeni format ise, SUB yoksa yedek ekle.
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object' && 'team' in raw[0]) {
  const arr = raw as Slot[];
  return ensureSubsCount(arr, fmt, reservesPerTeam);
  }

  // Legacy: ['GK', ...] veya [{pos:'GK', userId?}, ...]
  const basePos = positionsForFormat(fmt);
  const a: Slot[] = basePos.map((pos) => ({ team: 'A', pos, userId: null }));
  const b: Slot[] = basePos.map((pos) => ({ team: 'B', pos, userId: null }));

  const all = [...a, ...b];
  const legacy = Array.isArray(raw) ? raw : [];
  let i = 0;
  for (const item of legacy) {
    const uid = item && typeof item === 'object' ? (item.userId ?? null) : null;
    if (uid && i < all.length) all[i].userId = uid;
    i++;
  }

  return ensureSubsCount(all, fmt, reservesPerTeam);
}

/** Güvenli normalize: boş/yanlış/legacy ise uygun hale getirir (yedek dahil). */
export function normalizeSlots(
  raw: any,
  fmt?: string,
  reservesPerTeam = DEFAULT_RESERVES_PER_TEAM,
): Slot[] {
  return upgradeLegacySlots(raw, fmt, reservesPerTeam);
}

/** Takımı otomatik seç (placeholder’lar da dolu sayılır) */
export function autoPickTeam(slots: Slot[]): Team {
  const a = slots.filter((s) => s.team === 'A' && (s.userId || s.placeholder)).length;
  const b = slots.filter((s) => s.team === 'B' && (s.userId || s.placeholder)).length;
  return a <= b ? 'A' : 'B';
}

/** Kullanıcıyı tüm slotlardan temizler. */
export function removeUser(slots: Slot[], userId: string): boolean {
  let changed = false;
  for (const s of slots) {
    if (s.userId === userId) {
      s.userId = null;
      changed = true;
    }
  }
  return changed;
}

/** Pozisyon + takım tercihiyle yerleştir (SUB/any fallback). */
export function assignToPositionOrReserve(
  slots: Slot[],
  userId: string,
  desiredPos?: string,  // ör. 'ST'
  preferredTeam?: Team, // 'A' | 'B'
): { ok: boolean; pos?: string } {
  const want = desiredPos?.trim().toUpperCase();

  const tryPick = (predicate: (s: Slot) => boolean): Slot | undefined =>
    slots.find((s) => isFree(s) && predicate(s));

  // 0) önce aynı kullanıcı varsa temizle
  removeUser(slots, userId);

  // 1) istenen pozisyon + takım tercihi
  if (want) {
    const exactTeam = tryPick((s) => s.pos === want && (!preferredTeam || s.team === preferredTeam));
    if (exactTeam) { exactTeam.userId = userId; return { ok: true, pos: exactTeam.pos }; }

    // 2) istenen pozisyon ama karşı takım
    const exactAny = tryPick((s) => s.pos === want);
    if (exactAny) { exactAny.userId = userId; return { ok: true, pos: exactAny.pos }; }

    // 3) takım tercihi varsa SUB
    const subTeam = tryPick((s) => s.pos === 'SUB' && (!preferredTeam || s.team === preferredTeam));
    if (subTeam) { subTeam.userId = userId; return { ok: true, pos: subTeam.pos }; }
  }

  // 4) pozisyon belirtilmemişse ⇢ önce tercih edilen takımda herhangi bir boşluk
  const anyTeamPref = tryPick((s) => !want && (!preferredTeam || s.team === preferredTeam));
  if (anyTeamPref) { anyTeamPref.userId = userId; return { ok: true, pos: anyTeamPref.pos }; }

  // 5) hiçbir şey bulunamazsa global herhangi bir boşluk
  const any = tryPick(() => true);
  if (any) { any.userId = userId; return { ok: true, pos: any.pos }; }

  return { ok: false };
}

/** Admin yer tutucu veya oyuncu +1 yerleştir. */
export function reserveSlot(
  slots: Slot[],
  team: Team,
  pos: string,
  type: 'ADMIN' | 'GUEST',
  byUserId?: string,
): boolean {
  const p = pos.trim().toUpperCase();
  const i = slots.findIndex((s) => s.team === team && s.pos === p && isFree(s));
  if (i === -1) return false;
  slots[i] = { ...slots[i], placeholder: type, guestOfUserId: type === 'GUEST' ? (byUserId ?? null) : null };
  return true;
}

/** Rezervasyonu kaldır (kontroller controller’da yapılır). */
export function releaseReserved(
  slots: Slot[],
  team: Team,
  pos: string,
): boolean {
  const p = pos.trim().toUpperCase();
  const i = slots.findIndex((s) => s.team === team && s.pos === p && s.placeholder);
  if (i === -1) return false;
  slots[i] = { ...slots[i], placeholder: undefined, guestOfUserId: undefined };
  return true;
}
