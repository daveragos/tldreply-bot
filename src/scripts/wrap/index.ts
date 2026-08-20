/**
 * One-off "group wrapped" broadcast.
 *
 *   npm run wrap                          render every group to ./wraps, send nothing
 *   npm run wrap -- --only <chatId>       render a single group
 *   npm run wrap -- --send                actually post to every group
 *   npm run wrap -- --send --only <id>    post to one group (do this first)
 *
 * Deliberately not a bot command: this runs once, from an operator's machine,
 * and leaves nothing behind in the bot. Statistics come from a message backup
 * rather than the database, since the database only retains 48 hours.
 *
 * Rendering is always safe. Sending is not — it posts to real groups with real
 * members — so it requires --send and prints what it is about to do first.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Api } from 'grammy';
import { InputFile } from 'grammy';
import { Database } from '../../db/database';
import { logger } from '../../utils/logger';
import { computeWraps, GroupWrap } from './stats';
import { renderWrap, fontsAvailable, WrapView } from './render';

dotenv.config();

const TZ_OFFSET = Number.parseInt(process.env.WRAP_TZ_OFFSET ?? '3', 10);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Turns raw stats into the strings the card shows. */
function toView(w: GroupWrap, title: string): WrapView {
  const a = w.awards;
  const awards: WrapView['awards'] = [];

  if (a.nightOwl && a.nightOwl.night > 0) {
    awards.push({
      title: 'Night owl',
      who: a.nightOwl.name,
      detail: `${a.nightOwl.night.toLocaleString()} messages after midnight`,
    });
  }
  if (a.novelist) {
    awards.push({
      title: 'The novelist',
      who: a.novelist.name,
      detail: `${Math.round(a.novelist.chars / a.novelist.messages)} characters per message`,
    });
  }
  if (a.emoji && a.emoji.emoji > 0) {
    awards.push({
      title: 'Emoji champion',
      who: a.emoji.name,
      detail: `${a.emoji.emoji.toLocaleString()} messages with emoji`,
    });
  }
  if (a.questioner && a.questioner.questions > 0) {
    awards.push({
      title: 'Most curious',
      who: a.questioner.name,
      detail: `${a.questioner.questions.toLocaleString()} questions asked`,
    });
  }
  if (a.regular) {
    awards.push({
      title: 'Never misses',
      who: a.regular.name,
      detail: `showed up on ${a.regular.activeDays} different days`,
    });
  }

  return {
    title,
    periodLabel: `${prettyDay(w.firstDay)} — ${prettyDay(w.lastDay)}`,
    messages: w.messages,
    members: w.members,
    activeDays: w.activeDays,
    perDay: w.perDay,
    avgLen: w.avgLen,
    hours: w.hours,
    months: w.months,
    busiestDay: { day: prettyDay(w.busiestDay.day), n: w.busiestDay.n },
    top: w.top.map(t => ({ name: t.name, messages: t.messages })),
    awards,
    footer: `${w.avgLen} chars per message · ${w.emojiShare}% with emoji · ${w.questionShare}% questions`,
  };
}

function caption(w: GroupWrap, title: string): string {
  return (
    `✨ <b>${title} — Wrapped</b>\n\n` +
    `${w.messages.toLocaleString()} messages from ${w.members.toLocaleString()} people ` +
    `across ${w.activeDays} days.\n\n` +
    `Thanks for all the noise. 💛`
  );
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN;
  const dbUrl = process.env.DATABASE_URL;
  if (!token || !dbUrl) {
    console.error('TELEGRAM_TOKEN and DATABASE_URL must be set. Check your .env file.');
    process.exit(1);
  }

  const font = fontsAvailable();
  if (!font.ok) {
    console.error(`\nMissing fonts: ${font.missing.join(', ')}`);
    console.error('Install them, e.g.  sudo apt install fonts-dejavu-core fonts-noto-core\n');
    process.exit(1);
  }

  const backup = arg('backup') ?? findLatestBackup();
  if (!backup || !fs.existsSync(backup)) {
    console.error('No backup found. Pass --backup <file> or run: npm run db:export');
    process.exit(1);
  }

  const only = arg('only');
  const send = has('send');
  const outDir = path.resolve(arg('out') ?? './wraps');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\nReading ${path.basename(backup)}...`);
  const wraps = await computeWraps(backup, TZ_OFFSET, n =>
    process.stdout.write(`\r  ${n.toLocaleString()} messages`)
  );
  process.stdout.write('\n');

  const db = new Database(dbUrl);
  const api = new Api(token);

  try {
    // Only groups the bot is still configured for are eligible.
    const rows = await db.query(
      'SELECT telegram_chat_id, title FROM groups WHERE gemini_api_key_encrypted IS NOT NULL',
      []
    );
    const configured = new Map<string, string | null>(
      rows.rows.map((r: { telegram_chat_id: string; title: string | null }) => [
        String(r.telegram_chat_id),
        r.title,
      ])
    );

    const targets = [...wraps.entries()]
      .filter(([id]) => configured.has(id))
      .filter(([id]) => !only || id === only)
      .sort((a, b) => b[1].messages - a[1].messages);

    if (targets.length === 0) {
      console.error('\nNo matching configured groups.\n');
      process.exit(1);
    }

    console.log(`\n${targets.length} group(s) to ${send ? 'SEND to' : 'render'}:\n`);

    const rendered: Array<{ id: string; title: string; file: string; w: GroupWrap }> = [];

    for (const [chatId, w] of targets) {
      // The stored title is often null; ask Telegram for the current one.
      let title = configured.get(chatId) ?? '';
      try {
        const chat = await api.getChat(chatId);
        if ('title' in chat && chat.title) title = chat.title;
      } catch {
        /* group may be gone; fall through to whatever we have */
      }
      if (!title) title = `Group ${chatId.slice(-6)}`;

      const png = renderWrap(toView(w, title));
      const file = path.join(outDir, `wrap-${chatId.replace('-', 'n')}.png`);
      fs.writeFileSync(file, png);
      rendered.push({ id: chatId, title, file, w });

      console.log(
        `  ${title.padEnd(28).slice(0, 28)} ${String(w.messages).padStart(8)} msgs  ` +
          `${String(w.members).padStart(5)} people  →  ${path.basename(file)} (${Math.round(png.length / 1024)} KB)`
      );
    }

    if (!send) {
      console.log(`\nRendered to ${outDir}. Nothing was sent.`);
      console.log('Review the images, then re-run with --send to post them.\n');
      return;
    }

    console.log(`\n⚠️  Posting to ${rendered.length} group(s) in 5 seconds. Ctrl-C to abort.\n`);
    await new Promise(r => setTimeout(r, 5000));

    let ok = 0;
    for (const r of rendered) {
      try {
        await api.sendPhoto(r.id, new InputFile(r.file), {
          caption: caption(r.w, r.title),
          parse_mode: 'HTML',
        });
        ok++;
        console.log(`  ✓ sent to ${r.title}`);
      } catch (error) {
        console.error(`  ✗ ${r.title}: ${error instanceof Error ? error.message : error}`);
      }
      // Telegram throttles bulk sends; stay well inside the limit.
      await new Promise(res => setTimeout(res, 1500));
    }
    console.log(`\nSent ${ok} of ${rendered.length}.\n`);
  } catch (error) {
    logger.error('Wrap failed:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

/** Newest export in ./backups, so the common case needs no flags. */
function findLatestBackup(): string | undefined {
  const dir = path.resolve('./backups');
  if (!fs.existsSync(dir)) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.jsonl.gz') || f.endsWith('.jsonl'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(dir, files[0]) : undefined;
}

if (require.main === module) {
  void main();
}
