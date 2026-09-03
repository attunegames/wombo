// Positions straight out of the replay, for previewing a clip without Dolphin.
//
// There is no headless Melee renderer, so a real video preview costs a 25s
// emulator boot. But the .slp already stores every player's exact position on
// every frame, which is enough to answer the only questions you actually ask
// before rendering: is this the moment I meant, and are my in/out points right.
//
// So this returns a compact motion track the browser can draw as a schematic:
// stage outline, a dot per player, percent and stocks. Instant, ~17KB for an
// 18 second clip.

import { createRequire } from "node:module";

const { SlippiGame, characters, stages } = createRequire(import.meta.url)("@slippi/slippi-js/node");

// Stage geometry in Melee's own units. Community-measured values - close
// enough to read a position against, not survey-grade. Fountain's side
// platforms actually rise and fall; they are drawn at their mid height.
const GEOMETRY = {
  32: { // Final Destination
    name: "Final Destination",
    main: [-85.6, 85.6, 0], plats: [],
    blast: { l: -246, r: 246, t: 188, b: -140 },
  },
  31: { // Battlefield
    main: [-68.4, 68.4, 0],
    plats: [[-57.6, -20, 27.2], [20, 57.6, 27.2], [-18.8, 18.8, 54.4]],
    blast: { l: -224, r: 224, t: 200, b: -108 },
  },
  28: { // Dream Land N64
    main: [-77.3, 77.3, 0],
    plats: [[-61.4, -31.7, 30.1], [31.7, 63.1, 30.2], [-19, 19, 51.4]],
    blast: { l: -255, r: 255, t: 250, b: -123 },
  },
  8: { // Yoshi's Story
    main: [-56, 56, 0],
    plats: [[-59.5, -31.7, 23.5], [31.7, 59.5, 23.5], [-15.8, 15.8, 42]],
    blast: { l: -175.7, r: 173.6, t: 168, b: -91 },
  },
  2: { // Fountain of Dreams
    main: [-63.4, 63.4, 0],
    plats: [[-49.5, -21.5, 22], [21.5, 49.5, 22], [-14.3, 14.3, 42.8]],
    blast: { l: -198.8, r: 198.8, t: 202.5, b: -146.3 },
  },
  3: { // Pokemon Stadium
    main: [-87.8, 87.8, 0],
    plats: [[-55, -25, 25], [25, 55, 25]],
    blast: { l: -230, r: 230, t: 180, b: -111 },
  },
};

// Anything unusual (Kongo, an unlisted stage) still previews, just with a
// generic platform, rather than failing.
const FALLBACK = {
  main: [-80, 80, 0], plats: [],
  blast: { l: -240, r: 240, t: 200, b: -130 },
};

const isDead = (s) => s != null && s >= 0 && s <= 10;

/**
 * Motion tracks for a frame range.
 * `step` of 2 gives 30 samples/sec, which is plenty to read a punish.
 */
export function motionFor(file, { start, end, step = 2 }) {
  const game = new SlippiGame(file);
  const settings = game.getSettings();
  const frames = game.getFrames() ?? {};

  const geo = GEOMETRY[settings.stageId] ?? FALLBACK;
  const players = settings.players.map((p) => ({
    index: p.playerIndex,
    port: p.port ?? p.playerIndex + 1,
    char: characters.getCharacterShortName(p.characterId),
    team: settings.isTeams ? p.teamId : null,
  }));

  const tracks = {};
  for (const p of players) tracks[p.index] = { x: [], y: [], pct: [], st: [], dead: [] };

  const from = Math.max(-123, Math.round(start));
  const to = Math.round(end);
  const at = [];
  for (let n = from; n <= to; n += step) {
    const fr = frames[n];
    if (!fr?.players) continue;
    at.push(n);
    for (const p of players) {
      const q = fr.players[p.index]?.post;
      const t = tracks[p.index];
      if (!q) { // player already gone for the frame; repeat the last sample
        t.x.push(t.x.at(-1) ?? 0); t.y.push(t.y.at(-1) ?? 0);
        t.pct.push(t.pct.at(-1) ?? 0); t.st.push(t.st.at(-1) ?? 0); t.dead.push(1);
        continue;
      }
      t.x.push(Math.round(q.positionX * 10) / 10);
      t.y.push(Math.round(q.positionY * 10) / 10);
      t.pct.push(Math.round(q.percent));
      t.st.push(q.stocksRemaining ?? 0);
      t.dead.push(isDead(q.actionStateId) ? 1 : 0);
    }
  }

  return {
    stage: stages.getStageName(settings.stageId),
    geometry: geo,
    players,
    step,
    from,
    to,
    frames: at,
    tracks,
  };
}
