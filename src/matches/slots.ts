// src/matches/slots.ts

export type Team = 'A' | 'B';

export type Slot = {
  team: Team;
  pos: string;            // GK/LB/.../SUB
  userId: string | null;  // boşsa null
};

/** Varsayılan yedek sayısı (takım başı). 2 → istersen 3 yap. */
export const DEFAULT_RESERVES_PER_TEAM = 2;

/** Format metninden takım kişi sayısı (7v7 → 7). */
export function teamSizeFromFormat(format?: string): number {
  const m = /(\d+)\s*v\s*(\d+)/i.exec(format || '');
  if (!m) return 7;
  const left = Number(m[1] || 7);
  return Math.max(1, Math.min(left, 11));
}

/** Şablon pozisyonları (mevcutların yanına yenilerini ekledik). */
export const DEFAULT_SLOTS: Record<string, string[]> = {
  '5v5'  : ['GK', 'CB', 'CM', 'LW', 'ST'],
  '6v6'  : ['GK', 'LB', 'RB', 'DM', 'AM', 'ST'],
  '7v7'  : ['GK', 'LB', 'CB', 'RB', 'CM', 'LW', 'ST'],
  '8v8'  : ['GK', 'LB', 'CB', 'RB', 'CM', 'AM', 'LW', 'ST'],
  '9v9'  : ['GK', 'LB', 'RB', 'CB', 'DM', 'CM', 'AM', 'RW', 'LW'],
  '10v10': ['GK', 'LB', 'CB', 'RB', 'DM', 'CM', 'AM', 'RW', 'LW', 'ST'],
  '11v11': ['GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LW', 'ST'],
};

/** Format/override’dan base pozisyon dizisini verir. */
export function positionsForFormat(fmt?: string, overridePositions?: string[]): string[] {
  if (overridePositions && overridePositions.length) {
    return overridePositions.map(String);
  }
  const key = String(fmt || '7v7').toLowerCase();
  return DEFAULT_SLOTS[key] ?? DEFAULT_SLOTS['7v7'];
}

/** Takım başı N yedek (SUB) ekler. */
export function addReserves(base: Slot[], perTeam = DEFAULT_RESERVES_PER_TEAM): Slot[] {
  if (perTeam <= 0) return base;
  const out = [...base];
  for (const team of ['A', 'B'] as Team[]) {
    for (let i = 1; i <= perTeam; i++) {
      out.push({ pos: 'SUB', team, userId: null });
    }
  }
  return out;
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
  // Zaten yeni format mı?
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object' && 'team' in raw[0]) {
    // yeni format ama SUB hiç yoksa yedek ekleyelim
    const arr = raw as Slot[];
    const hasSub = arr.some((s) => s.pos === 'SUB');
    return hasSub ? arr : addReserves(arr, reservesPerTeam);
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
    if (uid && i < all.length) {
      all[i].userId = uid;
    }
    i++;
  }

  return addReserves(all, reservesPerTeam);
}

/** Güvenli normalize: boş/yanlış/legacy ise uygun hale getirir (yedek dahil). */
export function normalizeSlots(
  raw: any,
  fmt?: string,
  reservesPerTeam = DEFAULT_RESERVES_PER_TEAM,
): Slot[] {
  return upgradeLegacySlots(raw, fmt, reservesPerTeam);
}

/** Basit denge: hangi takım daha az doluysa onu döndür. */
export function autoPickTeam(slots: Slot[]): Team {
  const a = slots.filter((s) => s.team === 'A' && s.userId).length;
  const b = slots.filter((s) => s.team === 'B' && s.userId).length;
  return a <= b ? 'A' : 'B';
}

/** Kullanıcıyı tüm slotlardan temizler (ayrılma / tekrar katılma öncesi). */
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

/**
 * Pozisyon + takım tercihiyle yerleştir; bulunamazsa SUB’a, o da yoksa herhangiine düşer.
 * Yerleştirme yapabildiyse dönülen pos'u string olarak verir.
 */
export function assignToPositionOrReserve(
  slots: Slot[],
  userId: string,
  desiredPos?: string,          // ör. 'ST'
  preferredTeam?: Team,         // 'A' | 'B'
): { ok: boolean; pos?: string } {
  const want = desiredPos?.trim().toUpperCase();

  const tryPick = (predicate: (s: Slot) => boolean): Slot | undefined =>
    slots.find((s) => !s.userId && predicate(s));

  // 0) önce aynı kullanıcı varsa temizle
  removeUser(slots, userId);

  // 1) istenen pozisyon + takım tercihi
  if (want) {
    const exactTeam = tryPick((s) => s.pos === want && (!preferredTeam || s.team === preferredTeam));
    if (exactTeam) {
      exactTeam.userId = userId;
      return { ok: true, pos: exactTeam.pos };
    }
    // 2) istenen pozisyon ama karşı takım
    const exactAny = tryPick((s) => s.pos === want);
    if (exactAny) {
      exactAny.userId = userId;
      return { ok: true, pos: exactAny.pos };
    }
    // 3) takım tercihi varsa SUB
    const subTeam = tryPick((s) => s.pos === 'SUB' && (!preferredTeam || s.team === preferredTeam));
    if (subTeam) {
      subTeam.userId = userId;
      return { ok: true, pos: subTeam.pos };
    }
  }

  // 4) pozisyon belirtilmemişse ⇢ önce tercih edilen takımda herhangi bir boşluk
  const anyTeamPref = tryPick((s) => !want && (!preferredTeam || s.team === preferredTeam));
  if (anyTeamPref) {
    anyTeamPref.userId = userId;
    return { ok: true, pos: anyTeamPref.pos };
  }

  // 5) hiçbir şey bulunamazsa global herhangi bir boşluk
  const any = tryPick(() => true);
  if (any) {
    any.userId = userId;
    return { ok: true, pos: any.pos };
  }

  return { ok: false };
}
