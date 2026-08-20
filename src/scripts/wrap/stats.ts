/**
 * Per-group statistics for the one-off "wrapped" broadcast.
 *
 * Computed in a single streaming pass over a message backup, because the live
 * database only retains 48 hours. Nothing is stored: the numbers exist for the
 * length of one script run and are rendered straight into an image.
 */

import fs from 'fs';
import zlib from 'zlib';
import readline from 'readline';

/** Hours counted as "late night" for the night-owl award, in local time. */
const NIGHT_HOURS = new Set([0, 1, 2, 3, 4]);
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;

export interface MemberStat {
  userId: string;
  /** Preferred display name, already screened for renderability. */
  name: string;
  /** Raw @username, kept so a screened-out name can fall back to first_name. */
  username?: string;
  firstName?: string;
  messages: number;
  chars: number;
  emoji: number;
  questions: number;
  night: number;
  activeDays: number;
}

export interface GroupWrap {
  chatId: string;
  messages: number;
  members: number;
  activeDays: number;
  firstDay: string;
  lastDay: string;
  avgLen: number;
  perDay: number;
  hours: number[];
  months: Array<[string, number]>;
  busiestDay: { day: string; n: number };
  top: MemberStat[];
  awards: {
    nightOwl?: MemberStat;
    novelist?: MemberStat;
    emoji?: MemberStat;
    questioner?: MemberStat;
    regular?: MemberStat;
  };
  emojiShare: number;
  questionShare: number;
}

interface Acc {
  messages: number;
  chars: number;
  hours: number[];
  days: Map<string, number>;
  months: Map<string, number>;
  members: Map<string, MemberStat & { dayset: Set<string> }>;
  emoji: number;
  questions: number;
}

const newAcc = (): Acc => ({
  messages: 0,
  chars: 0,
  hours: new Array(24).fill(0),
  days: new Map(),
  months: new Map(),
  members: new Map(),
  emoji: 0,
  questions: 0,
});

/**
 * Names the bot will not put on a card.
 *
 * A wrap gives someone a trophy in front of their whole group, in the bot's
 * voice. A handle containing a slur must never be the thing amplified, so such
 * names fall back to a first name and then to a neutral placeholder. This is a
 * high-signal list, not a profanity filter - ordinary rudeness passes.
 */
const UNRENDERABLE =
  /(fuckjew|jewkill|killjew|gasjew|k[i1]ke|n[i1]gg|f[a4]gg?ot|tr[a4]nny|ret[a4]rd|h[i1]tl[e3]r|n[a4]z[i1]|holocaust|whitepower|heilh)/i;

/**
 * Homoglyphs NFKC does not collapse: Cyrillic/Greek lookalikes and the
 * small-capital Latin block, all of which are one keystroke away in any
 * "fancy text" generator.
 */
/**
 * Homoglyph folding pairs, written as escapes so no invisible character can
 * hide in the source. Left column folds to the right column.
 */
const CONFUSABLE_FROM =
  '\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0456\u0455\u0501' + // Cyrillic a e o p c y x i s d
  '\u04bb\u0438\u044f\u0454\u043d\u043c\u0442\u0432\u043a\u0437\u0433' + // Cyrillic
  '\u03b1\u03bf\u03c1\u03b5\u03b9\u03c4\u03bd\u03c9\u03dd' + // Greek a o p e i t v w f
  '\u029c\u026a\u1d1b\u029f\u1d07\u0280\u0274\u1d0f\u1d00\u1d04' + // small caps h i t l e r n o a c
  '\u1d05\u1d0b\u1d0d\u1d18\u1d1c\u1d20\u1d21\u028f\u1d22\u0262' + // small caps d k m p u v w y z g
  '\u0299\u1d0a\u2113'; // small caps b j, script l

const CONFUSABLE_TO =
  'aeopcyxisd' + 'hnrehmtbkzg' + 'aopeitvwf' + 'hitlernoac' + 'dkmpuvwyzg' + 'bjl';

// The two columns must stay the same length or every later pair silently shifts.
if (process.env.NODE_ENV !== 'production' && [...CONFUSABLE_FROM].length !== CONFUSABLE_TO.length) {
  throw new Error(
    `Confusable table misaligned: ${[...CONFUSABLE_FROM].length} from, ${CONFUSABLE_TO.length} to`
  );
}

const CONFUSABLES = new Map<string, string>(
  [...CONFUSABLE_FROM].map((ch, i) => [ch, CONFUSABLE_TO[i]])
);

/**
 * Letter-shaped blocks NFKC leaves alone.
 *
 * NFKC decomposes the squared and circled Latin blocks but not the negative
 * (filled) variants or the regional indicators, so "\u{1F177}\u{1F178}\u{1F1F9}" survives
 * normalisation intact. Each of these ranges is a contiguous A-Z run, so the
 * offset from its base is the letter.
 */
const ENCLOSED_RANGES: Array<[number, number]> = [
  [0x1f130, 0x1f149], // squared capital A-Z
  [0x1f150, 0x1f169], // negative circled capital A-Z
  [0x1f170, 0x1f189], // negative squared capital A-Z
  [0x1f1e6, 0x1f1ff], // regional indicator A-Z
  [0x24b6, 0x24cf], // circled capital A-Z
  [0x24d0, 0x24e9], // circled small a-z
];

function foldEnclosed(ch: string): string | undefined {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return undefined;
  for (const [lo, hi] of ENCLOSED_RANGES) {
    if (cp >= lo && cp <= hi) return String.fromCharCode(97 + (cp - lo));
  }
  return undefined;
}

/**
 * Folds a display name to plain lowercase letters for screening only.
 *
 * NFKC collapses the mathematical, enclosed and fullwidth alphabets that
 * "fancy text" tools produce; the confusable map handles the lookalikes it
 * leaves behind; diacritics and separators are then stripped. Screening runs
 * on the fold, but the original is what gets displayed, so a stylised but
 * harmless name still renders as its owner wrote it.
 */
export function foldForScreening(name: string): string {
  const nfkc = name.normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of nfkc) out += CONFUSABLES.get(ch) ?? foldEnclosed(ch) ?? ch;
  return out
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks
    .replace(/[^a-z0-9\u1200-\u137f]/g, ''); // keep Latin, digits, Ethiopic
}

/** Insignia that carry meaning on their own, whatever letters accompany them. */
const BANNED_SYMBOLS = /[\u5350\u534d\u0fd5-\u0fd8\u16b1]/; // swastika forms, sig rune

export function isRenderableName(name: string): boolean {
  if (BANNED_SYMBOLS.test(name)) return false;
  return !UNRENDERABLE.test(foldForScreening(name));
}

/**
 * Picks a display name, preferring @username but never rendering a slur.
 */
export function displayNameFor(username?: string | null, firstName?: string | null): string {
  const candidates = [username, firstName].filter((v): v is string => !!v && v.trim().length > 0);

  // Deliberately not a fallback chain. Someone whose @username is a slur does
  // not get named via their first name instead - a blocked signal anywhere
  // means the bot does not put this person's chosen text on a card. Checking
  // the joined string too catches a slur split across the two fields.
  if (candidates.some(c => !isRenderableName(c))) return 'A member';
  if (candidates.length > 1 && !isRenderableName(candidates.join(''))) return 'A member';

  if (username) return '@' + username;
  if (firstName) return firstName;
  return 'A member';
}

/**
 * Streams a backup and accumulates per-group statistics.
 *
 * @param file        path to a .jsonl or .jsonl.gz export
 * @param tzOffsetHrs hours to add to UTC before bucketing by hour/day
 */
export async function computeWraps(
  file: string,
  tzOffsetHrs: number,
  onProgress?: (n: number) => void
): Promise<Map<string, GroupWrap>> {
  const stream = file.endsWith('.gz')
    ? fs.createReadStream(file).pipe(zlib.createGunzip())
    : fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const acc = new Map<string, Acc>();
  let seen = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    seen++;
    if (onProgress && seen % 100000 === 0) onProgress(seen);

    // Bots and channel posts are infrastructure, not participants.
    if (m.is_bot || m.is_channel || !m.user_id) continue;

    const chatId = String(m.telegram_chat_id);
    let a = acc.get(chatId);
    if (!a) {
      a = newAcc();
      acc.set(chatId, a);
    }

    const content: string = m.content ?? '';
    const local = new Date(new Date(m.timestamp).getTime() + tzOffsetHrs * 3600 * 1000);
    const day = local.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const hour = local.getUTCHours();

    const hasEmoji = EMOJI.test(content);
    const isQuestion = content.includes('?') || content.includes('፧');

    a.messages++;
    a.chars += content.length;
    a.hours[hour]++;
    a.days.set(day, (a.days.get(day) ?? 0) + 1);
    a.months.set(month, (a.months.get(month) ?? 0) + 1);
    if (hasEmoji) a.emoji++;
    if (isQuestion) a.questions++;

    const uid = String(m.user_id);
    let mem = a.members.get(uid);
    if (!mem) {
      mem = {
        userId: uid,
        name: displayNameFor(m.username, m.first_name),
        username: m.username ?? undefined,
        firstName: m.first_name ?? undefined,
        messages: 0,
        chars: 0,
        emoji: 0,
        questions: 0,
        night: 0,
        activeDays: 0,
        dayset: new Set(),
      };
      a.members.set(uid, mem);
    }
    // Prefer the most recent name we see for this person.
    if (m.username || m.first_name) {
      mem.name = displayNameFor(m.username ?? mem.username, m.first_name ?? mem.firstName);
    }
    mem.messages++;
    mem.chars += content.length;
    if (hasEmoji) mem.emoji++;
    if (isQuestion) mem.questions++;
    if (NIGHT_HOURS.has(hour)) mem.night++;
    mem.dayset.add(day);
  }

  return finalize(acc);
}

/** Turns raw accumulators into the shape the renderer wants. */
function finalize(acc: Map<string, Acc>): Map<string, GroupWrap> {
  const out = new Map<string, GroupWrap>();

  for (const [chatId, a] of acc) {
    if (a.messages === 0) continue;

    const members = [...a.members.values()].map(m => {
      m.activeDays = m.dayset.size;
      return m;
    });
    members.sort((x, y) => y.messages - x.messages);

    const days = [...a.days.entries()].sort();
    const busiest = [...a.days.entries()].sort((x, y) => y[1] - x[1])[0];

    /**
     * Awards need a floor, or they land on someone with three messages who
     * happened to send them all at 3am. 5% of the leader's volume, minimum 20.
     */
    const floor = Math.max(20, Math.round(members[0].messages * 0.05));
    const eligible = members.filter(m => m.messages >= floor);

    /**
     * Awards go to distinct people where possible. The loudest member tends to
     * top every metric at once, which makes four trophies for one person and a
     * boring card; taken winners are skipped while any candidate remains.
     */
    const taken = new Set<string>();
    const best = (fn: (m: MemberStat) => number): MemberStat | undefined => {
      const pool = eligible.length > 0 ? eligible : members;
      const pick = (skipTaken: boolean): MemberStat | undefined => {
        let top: MemberStat | undefined;
        let bestVal = 0;
        for (const m of pool) {
          if (skipTaken && taken.has(m.userId)) continue;
          const v = fn(m);
          if (v > bestVal) {
            bestVal = v;
            top = m;
          }
        }
        return top;
      };
      const winner = pick(true) ?? pick(false);
      if (winner) taken.add(winner.userId);
      return winner;
    };

    out.set(chatId, {
      chatId,
      messages: a.messages,
      members: members.length,
      activeDays: a.days.size,
      firstDay: days[0][0],
      lastDay: days[days.length - 1][0],
      avgLen: +(a.chars / a.messages).toFixed(1),
      perDay: Math.round(a.messages / a.days.size),
      hours: a.hours,
      months: [...a.months.entries()].sort(),
      busiestDay: { day: busiest[0], n: busiest[1] },
      top: members.slice(0, 5),
      awards: {
        nightOwl: best(m => m.night),
        novelist: best(m => (m.messages >= 20 ? m.chars / m.messages : 0)),
        emoji: best(m => m.emoji),
        questioner: best(m => m.questions),
        regular: best(m => m.activeDays),
      },
      emojiShare: +((a.emoji / a.messages) * 100).toFixed(1),
      questionShare: +((a.questions / a.messages) * 100).toFixed(1),
    });
  }

  return out;
}
