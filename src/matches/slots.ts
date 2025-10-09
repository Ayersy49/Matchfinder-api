// src/matches/slots.ts

export type Team = 'A' | 'B';
export type Slot = { team: Team; pos: string; userId: string | null };

/** Format stringinden (örn: 7v7) takım başına slot sayısı çıkarır. */
export function teamSizeFromFormat(format?: string): number {
  const m = /(\d+)\s*v\s*(\d+)/i.exec(format || '');
  if (!m) return 7; // default 7v7
  const left = Number(m[1] || 7);
  return Math.max(1, Math.min(left, 11));
}

/** Varsayılan pozisyon listeleri (takım başına) */
export const DEFAULT_SLOTS: Record<string, string[]> = {
  '5v5':   ['GK', 'CB', 'CM', 'LW', 'ST'],
  '7v7':   ['GK', 'LB', 'CB', 'RB', 'CM', 'LW', 'ST'],
  '8v8':   ['GK', 'LB', 'CB', 'RB', 'CM', 'AM', 'LW', 'ST'],
  '11v11': ['GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LW', 'ST'],
};

/** Maç oluştururken ilk slotları üretir (A ve B takımları için). */
export function buildInitialSlots(fmt?: string, overridePositions?: string[]): Slot[] {
  const base =
    (overridePositions && overridePositions.length)
      ? overridePositions
      : (DEFAULT_SLOTS[(fmt || '').toLowerCase()] ?? DEFAULT_SLOTS['7v7']);

  const a: Slot[] = base.map(pos => ({ team: 'A' as const, pos, userId: null }));
  const b: Slot[] = base.map(pos => ({ team: 'B' as const, pos, userId: null }));
  return [...a, ...b];
}

/** Eski tek listeden (pos sadece string) yeni yapıya çevirme. */
export function upgradeLegacySlots(raw: any, fmt?: string): Slot[] {
  // Zaten yeni format mı?
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object' && 'team' in raw[0]) {
    return raw as Slot[];
  }

  const base = DEFAULT_SLOTS[(fmt || '').toLowerCase()] ?? DEFAULT_SLOTS['7v7'];

  // Önce A takımının slotları, sonra B takımının slotları
  const a: Slot[] = base.map(pos => ({ team: 'A' as const, pos, userId: null }));
  const b: Slot[] = base.map(pos => ({ team: 'B' as const, pos, userId: null }));

  // Eski raw: [{pos:'GK', userId?}, ...] ya da sadece ['GK', ...] olabilir
  const legacy = Array.isArray(raw) ? raw : [];
  let i = 0;
  for (const item of legacy) {
    const uid = (item && typeof item === 'object') ? (item.userId ?? null) : null;
    if (!uid) continue;

    const target = i < a.length ? a[i] : b[i - a.length];
    if (target) target.userId = uid;
    i++;
  }

  return [...a, ...b];
}

/** normalizeSlots: dışarıdan bu isimle kullanmak isteyen controller’lar için kısayol */
export function normalizeSlots(raw: any, fmt?: string): Slot[] {
  return upgradeLegacySlots(raw, fmt);
}

/** Dengeye göre otomatik takım seçer. */
export function autoPickTeam(slots: Slot[]): Team {
  const a = slots.filter(s => s.team === 'A' && s.userId).length;
  const b = slots.filter(s => s.team === 'B' && s.userId).length;
  return a <= b ? 'A' : 'B';
}

/** Kullanıcıyı takıma yerleştirir (tercih varsa ona, yoksa auto). */
export function assignUserToTeam(slots: Slot[], userId: string, preferred?: Team): Slot[] {
  const team = preferred || autoPickTeam(slots);

  // Önce tercih edilen takımda boş var mı?
  const emptyPref = slots.find(s => s.team === team && !s.userId);
  if (emptyPref) {
    emptyPref.userId = userId;
    return slots;
  }

  // Karşı takımda boş var mı?
  const emptyAny = slots.find(s => !s.userId);
  if (emptyAny) {
    emptyAny.userId = userId;
    return slots;
  }

  throw new Error('match full');
}

/** Kullanıcıyı tüm slotlardan temizler (ayrılma / takım değiştirme). */
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
