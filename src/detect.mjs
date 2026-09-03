// Finding the moments worth wombong inside a .slp.
//
// Slippi's own stats already segment a game into "conversions" (one player's
// uninterrupted punish on the other). That is almost exactly a clip: it starts
// at the opening hit and ends when the punish does. What it does not do is rank
// them, and a game has ~20 conversions of which maybe three are worth posting.
//
// So this module scores every conversion and keeps the ones that read as a
// highlight to a human: kills, long strings, big damage, and deaths off the
// bottom or the side (spikes and edgeguards) rather than a stray up-throw upair.

// slippi-js ships both an ESM and a CommonJS build behind this path, and the
// two runtimes we have to work in disagree about which one they get: Node 24
// resolves the ESM build (named exports, no default), the Node inside Electron
// resolves the CommonJS one (default only). createRequire sidesteps the
// argument by always loading the CommonJS build.
import { createRequire } from "node:module";

const { SlippiGame, characters, stages, moves } = createRequire(import.meta.url)("@slippi/slippi-js/node");

export const FPS = 60;

// How much room to leave around the action. Melee clips read badly if they cut
// in exactly on the first hit - you want to see the neutral that earned it.
export const PRE_ROLL = 100;     // ~1.7s before the opening hit
export const POST_ROLL_KILL = 165; // ~2.7s after a kill, so the KO lands on screen
export const POST_ROLL = 75;     // ~1.2s after a non-lethal punish
export const MAX_FRAMES = 18 * FPS;
export const MIN_FRAMES = 2 * FPS;

// Melee death action states, which tell us where the stock left the screen.
const DEATH_DOWN = 0;
const DEATH_SIDES = new Set([1, 2]);

const pct = (n) => Math.round(n * 10) / 10;

/** Read a replay and describe it, without computing stats. Used for the list. */
export function readHeader(file) {
  const game = new SlippiGame(file);
  const settings = game.getSettings();
  const meta = game.getMetadata();
  if (!settings?.players?.length) throw new Error("Not a readable replay");

  const players = settings.players.map((p) => {
    const names = meta?.players?.[p.playerIndex]?.names ?? {};
    return {
      index: p.playerIndex,
      port: p.port ?? p.playerIndex + 1,
      teamId: settings.isTeams ? p.teamId : null,
      character: characters.getCharacterName(p.characterId),
      characterShort: characters.getCharacterShortName(p.characterId),
      characterId: p.characterId,
      color: characters.getCharacterColorName(p.characterId, p.characterColor),
      code: (p.connectCode || names.code || "").trim(),
      name: (names.netplay || p.displayName || p.nametag || "").trim(),
      isCpu: p.type === 1,
    };
  });

  return {
    file,
    stage: stages.getStageName(settings.stageId),
    stageId: settings.stageId,
    isTeams: !!settings.isTeams,
    isSingles: players.length === 2,
    startAt: meta?.startAt ?? null,
    lastFrame: meta?.lastFrame ?? settings.lastFrame ?? null,
    durationSec: meta?.lastFrame ? Math.round(meta.lastFrame / FPS) : null,
    players,
    // A friendly one-liner: "Fox vs Marth"
    matchup: players.map((p) => p.characterShort).join(" vs "),
  };
}

// --- doubles ---------------------------------------------------------------
// slippi-js computes NO stats for anything but 1v1: getSinglesPlayerPermutations
// bails on `players.length !== 2`, so every computer downstream sees an empty
// permutation list and a doubles game comes back with zero conversions and zero
// stocks. The raw frames still carry everything we need, so for those games we
// rebuild the two structures the scorer wants - conversions and stocks - and
// hand them to exactly the same grade() as singles.

// Melee's death action states: 0 down, 1/2 sides, 3 up, 4-10 the star and
// screen KO variants. Anything in that range means the stock is gone.
const isDeadState = (s) => s != null && s >= 0 && s <= 10;

const NO_ONE = 6;                  // lastHitBy sentinel for "not hit by a player"
const PUNISH_RESET_FRAMES = 45;    // slippi's own gap for ending a punish
const SAME_MOVE_FRAMES = 10;       // multi-hit moves land repeatedly; group them
// The gap between the killing blow and the blast zone is the victim's flight
// time, which at kill percent is long - measured 51 to 243 frames across one
// doubles game. The attacker still has to match, and Melee's own lastHitBy is
// what the game uses to award the KO, so a generous window is safe here.
const KILL_WINDOW = 300;

/** Rebuild conversions + stocks from raw frames. Works for any player count. */
function statsFromFrames(game, header) {
  const frames = game.getFrames() ?? {};
  const order = Object.keys(frames).map(Number).sort((a, b) => a - b);

  const teamOf = new Map(header.players.map((p) => [p.index, p.teamId]));
  const prev = new Map();
  const damage = [];   // { frame, victim, attacker, amount, moveId }
  const stocks = [];   // slippi shape: { playerIndex, endFrame, deathAnimation }

  for (const n of order) {
    const players = frames[n]?.players;
    if (!players) continue;
    for (const key of Object.keys(players)) {
      const post = players[key]?.post;
      if (!post || post.percent == null) continue;
      const i = post.playerIndex ?? Number(key);
      const was = prev.get(i);
      prev.set(i, post);
      if (!was) continue;

      const by = post.lastHitBy;
      const hitByPlayer = by != null && by !== NO_ONE && by !== i && teamOf.has(by);

      const dealt = post.percent - was.percent;
      if (dealt > 0 && hitByPlayer) {
        // The move that did it is on the attacker's own post frame.
        const moveId = players[String(by)]?.post?.lastAttackLanded ?? 0;
        damage.push({
          frame: n, victim: i, attacker: by, amount: dealt, moveId,
          beforePercent: was.percent,
        });
      }

      // Not stocksRemaining: Melee ticks that counter down when the KO
      // animation *finishes*, by which point the player is already respawning
      // and actionStateId is long past the Dead* state that names the blast
      // zone. Entering a Dead* state is the actual moment of the KO.
      if (isDeadState(post.actionStateId) && !isDeadState(was.actionStateId)) {
        stocks.push({
          playerIndex: i,
          endFrame: n,
          deathAnimation: post.actionStateId,
          killedBy: hitByPlayer ? by : null,
        });
      }
    }
  }

  // Group damage into punishes: same attacker on same victim, no gap longer
  // than slippi's own punish reset.
  const runs = new Map();   // `${attacker}v${victim}` -> open conversion
  const conversions = [];
  const close = (key) => {
    const c = runs.get(key);
    if (c) { conversions.push(c); runs.delete(key); }
  };

  for (const d of damage) {
    if (header.isTeams && teamOf.get(d.attacker) === teamOf.get(d.victim)) continue;
    const key = `${d.attacker}v${d.victim}`;
    let c = runs.get(key);
    if (c && d.frame - c.endFrame > PUNISH_RESET_FRAMES) { close(key); c = null; }
    if (!c) {
      c = {
        playerIndex: d.victim, lastHitBy: d.attacker,
        startFrame: d.frame, endFrame: d.frame,
        startPercent: 0, endPercent: 0,
        moves: [], didKill: false, openingType: "unknown",
      };
      c.startPercent = Math.max(0, d.beforePercent);
      runs.set(key, c);
    }
    const last = c.moves.at(-1);
    if (last && last.moveId === d.moveId && d.frame - last.frame <= SAME_MOVE_FRAMES) {
      last.hitCount++;
      last.damage += d.amount;
    } else {
      c.moves.push({
        playerIndex: d.attacker, frame: d.frame, moveId: d.moveId,
        hitCount: 1, damage: d.amount,
      });
    }
    c.endFrame = d.frame;
    c.endPercent = c.startPercent + c.moves.reduce((s, m) => s + m.damage, 0);
  }
  for (const key of [...runs.keys()]) close(key);

  // Attach kills: a death shortly after a punish, by that same attacker.
  for (const s of stocks) {
    if (s.killedBy == null) continue;
    let best = null;
    for (const c of conversions) {
      if (c.playerIndex !== s.playerIndex || c.lastHitBy !== s.killedBy) continue;
      const gap = s.endFrame - c.endFrame;
      if (gap < 0 || gap > KILL_WINDOW) continue;
      if (!best || c.endFrame > best.endFrame) best = c;
    }
    if (best) {
      best.didKill = true;
      // slippi's own conversions run to the death, and grade() relies on that to
      // find the stock (and so the blast zone) that this punish ended.
      best.endFrame = s.endFrame;
    }
  }

  conversions.sort((a, b) => a.startFrame - b.startFrame);
  return { conversions, stocks };
}

/** Which stock ended around this frame, and how did it end. */
function deathNear(stocks, victim, frame) {
  let best = null;
  for (const s of stocks) {
    if (s.playerIndex !== victim || s.endFrame == null) continue;
    const d = Math.abs(s.endFrame - frame);
    if (d <= 90 && (!best || d < Math.abs(best.endFrame - frame))) best = s;
  }
  return best;
}

/**
 * Score + label one conversion.
 * Returns null for the ones that are not worth showing anybody.
 */
function grade(conv, stocks, header) {
  const hits = conv.moves ?? [];
  if (!hits.length) return null;

  const attacker = conv.lastHitBy;
  const victim = conv.playerIndex;
  if (attacker == null || attacker === victim) return null;

  const damage = pct(conv.endPercent - conv.startPercent);
  const hitCount = hits.length;
  const death = conv.didKill ? deathNear(stocks, victim, conv.endFrame) : null;
  const tags = [];
  let score = 0;

  if (conv.didKill) {
    score += 40;
    tags.push("kill");
    // A kill that started from (near) zero is the single most postable thing
    // in Melee, so it outranks everything else regardless of hit count.
    if (conv.startPercent < 15) { score += 70; tags.push("zero-to-death"); }
    else if (conv.startPercent < 45) { score += 20; tags.push("early-kill"); }

    if (death) {
      if (death.deathAnimation === DEATH_DOWN) { score += 30; tags.push("spike"); }
      else if (DEATH_SIDES.has(death.deathAnimation)) { score += 12; tags.push("side-ko"); }
    }
    // Killing off a single read is its own kind of highlight.
    if (hitCount === 1 && conv.startPercent < 90) { score += 10; tags.push("read"); }
  }

  score += Math.min(damage, 120) * 0.55;
  score += Math.min(hitCount, 12) * 6;
  if (hitCount >= 5) tags.push(`${hitCount}-hit`);
  if (damage >= 55) { score += 10; tags.push("big-damage"); }
  if (conv.openingType === "neutral-win") score += 10;
  else if (conv.openingType === "counter-attack") score += 6;

  // Tight, fast punishes look better than a long scrappy exchange.
  const span = Math.max(1, (hits.at(-1).frame - hits[0].frame) || 1);
  if (hitCount >= 3 && span / hitCount < 35) { score += 8; tags.push("fast"); }

  if (score < 45) return null;   // below this it is just... playing the game

  const firstHit = hits[0].frame;
  const lastAction = death?.endFrame ?? Math.max(conv.endFrame, hits.at(-1).frame);
  let startFrame = firstHit - PRE_ROLL;
  let endFrame = lastAction + (conv.didKill ? POST_ROLL_KILL : POST_ROLL);

  // Keep clips inside the replay and inside a postable length.
  startFrame = Math.max(-123, Math.round(startFrame));
  endFrame = Math.min(header.lastFrame ?? endFrame, Math.round(endFrame));
  if (endFrame - startFrame > MAX_FRAMES) startFrame = endFrame - MAX_FRAMES;
  if (endFrame - startFrame < MIN_FRAMES) return null;

  const by = header.players.find((p) => p.index === attacker);
  const on = header.players.find((p) => p.index === victim);

  return {
    id: `${attacker}-${firstHit}`,
    score: Math.round(score),
    tags,
    startFrame,
    endFrame,
    durationSec: pct((endFrame - startFrame) / FPS),
    didKill: !!conv.didKill,
    damage,
    hitCount,
    startPercent: pct(conv.startPercent),
    endPercent: pct(conv.endPercent),
    openingType: conv.openingType,
    attacker,
    victim,
    byName: by?.name || by?.code || `P${(by?.port ?? attacker + 1)}`,
    byChar: by?.characterShort ?? "?",
    onName: on?.name || on?.code || `P${(on?.port ?? victim + 1)}`,
    onChar: on?.characterShort ?? "?",
    moves: hits.map((h) => moves.getMoveShortName(h.moveId)),
    finisher: moves.getMoveShortName(hits.at(-1).moveId),
    // Human summary, used as the default clip title.
    label: null,   // filled in below
  };
}

function titleFor(c) {
  const kind = c.tags.includes("zero-to-death") ? "0-to-death"
    : c.tags.includes("spike") ? "spike"
      : c.didKill ? "kill"
        : `${c.hitCount}-hit punish`;
  return `${c.byChar} ${kind} on ${c.onChar} (${c.damage}%)`;
}

/**
 * Every clip-worthy moment in one replay, best first, with no notion of whose
 * highlights they are. Kept separate from findClips so the result can be cached
 * on disk once and re-ranked for whoever is looking at it - re-parsing 458
 * replays because the connect code changed would cost two minutes.
 */
export function analyzeRaw(file) {
  const game = new SlippiGame(file);
  const header = readHeader(file);

  // Singles gets slippi's own conversion logic, which is far better tested than
  // ours. Doubles gets nothing from slippi at all, so we rebuild it from frames.
  const stats = game.getStats();
  const source = stats?.conversions?.length ? stats : statsFromFrames(game, header);
  header.detectedBy = stats?.conversions?.length ? "slippi-stats" : "frames";
  if (!source?.conversions?.length) return { ...header, clips: [] };

  const clips = [];
  for (const conv of source.conversions) {
    const c = grade(conv, source.stocks ?? [], header);
    if (!c) continue;
    c.label = titleFor(c);
    clips.push(c);
  }

  // Two conversions can describe the same on-screen moment (a trade, or a
  // punish that slippi split). Merge anything that overlaps heavily.
  clips.sort((a, b) => a.startFrame - b.startFrame);
  const merged = [];
  for (const c of clips) {
    const prev = merged.at(-1);
    if (prev && c.startFrame < prev.endFrame - FPS && c.attacker === prev.attacker) {
      if (c.score > prev.score) { merged[merged.length - 1] = { ...c, startFrame: Math.min(prev.startFrame, c.startFrame) }; }
      else prev.endFrame = Math.max(prev.endFrame, c.endFrame);
      continue;
    }
    merged.push(c);
  }

  merged.sort((a, b) => b.score - a.score);
  return { ...header, clips: merged };
}

/**
 * Re-rank one replay's clips for a particular player, without re-parsing.
 * `perspective` is a connect code; your own highlights get a nudge so they
 * float above an opponent's equally-good punish.
 */
export function rankFor(result, perspective) {
  const mine = perspective
    ? result.players.find((p) => p.code?.toUpperCase() === perspective.toUpperCase())?.index
    : null;
  return result.clips
    .map((c) => {
      const yours = mine != null ? c.attacker === mine : null;
      return { ...c, yours, score: yours ? c.score + 25 : c.score };
    })
    .sort((a, b) => b.score - a.score);
}

/** Every clip-worthy moment in one replay, ranked for `perspective`. */
export function findClips(file, { perspective = null, limit = 40 } = {}) {
  const raw = analyzeRaw(file);
  return { ...raw, clips: rankFor(raw, perspective).slice(0, limit) };
}
