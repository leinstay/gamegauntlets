// mock-api.js — canned backend used when the page is opened with ?mock=1.
// Mirrors the shapes described in docs/plans/2026-09-19-rewrite-plan.md
// ("API contract" / GameCard) closely enough to exercise the whole UI
// (wheel, settings, search, card, marbles, dictionaries) with no server.

const GAMES = [
  game({
    id: 1,
    name: "Grimdark Survivors",
    image: "https://steamcdn-a.akamaihd.net/steam/apps/2192780/header.jpg",
    description: "A bullet-hell action roguelike set in a grim, pixel-art world overrun by Warhammer-flavored horrors.",
    release: { date: "2024-04-01", precision: "quarter" },
    score: 95, steam: 96, critics: 88, criticsSource: "opencritic", igdb: 82, gamefaqs: 90,
    main: 8, complete: 22, difficulty: "Tough", ggp: 190,
    price: 1999, final: 1999, discount: 0,
    genres: ["Action", "Indie", "RPG"], tags: ["Bullet Hell", "Roguelike", "Top-Down"],
    steamAppid: 2192780,
  }),
  game({
    id: 2,
    name: "This War of Mine",
    image: "https://steamcdn-a.akamaihd.net/steam/apps/282070/header.jpg",
    description: "A war survival game where you do not play as a soldier, but as a group of civilians.",
    release: { date: "2014-11-14", precision: "day" },
    score: 91, steam: 94, critics: 85, criticsSource: "opencritic", igdb: 88, gamefaqs: 80,
    main: 11, complete: 20, difficulty: "Just Right", ggp: 210,
    price: 1999, final: 999, discount: 50,
    genres: ["Simulation", "Strategy"], tags: ["Survival", "War", "Atmospheric"],
    steamAppid: 282070, gogId: "1424847320",
  }),
  game({
    id: 3,
    name: "Ori and the Blind Forest",
    image: "https://steamcdn-a.akamaihd.net/steam/apps/261570/header.jpg",
    description: "A visually stunning, emotionally driven platformer through a dying forest.",
    release: { date: "2015-03-11", precision: "day" },
    score: 97, steam: 97, critics: 90, criticsSource: "metacritic", igdb: 89, gamefaqs: 92,
    main: 8, complete: 13, difficulty: "Easy-Just Right", ggp: 230,
    price: 1999, final: 1999, discount: 0,
    genres: ["Platformer", "Adventure"], tags: ["Metroidvania", "Beautiful", "Atmospheric"],
    steamAppid: 261570,
  }),
  game({
    id: 4,
    name: "Vampire: The Masquerade - Bloodlines",
    image: "https://steamcdn-a.akamaihd.net/steam/apps/2600/header.jpg",
    description: "A cult-classic action RPG set in the World of Darkness, where you awaken as a fledgling vampire.",
    release: { date: "2004-11-16", precision: "day" },
    score: 88, steam: 92, critics: 79, criticsSource: "metacritic", igdb: 85, gamefaqs: 88,
    main: 16, complete: 33, difficulty: "Just Right-Tough", ggp: 180,
    price: 999, final: 999, discount: 0,
    genres: ["RPG", "Action"], tags: ["Story Rich", "Immersive Sim", "Classic"],
    steamAppid: 2600,
  }),
  game({
    id: 5,
    name: "Fallout: New Vegas",
    image: "https://steamcdn-a.akamaihd.net/steam/apps/22380/header.jpg",
    description: "A post-apocalyptic RPG set in the Mojave Wasteland, where the fate of New Vegas is in your hands.",
    release: { date: "2010-10-19", precision: "day" },
    score: 92, steam: 95, critics: 84, criticsSource: "metacritic", igdb: 87, gamefaqs: 90,
    main: 33, complete: 62, difficulty: "Just Right", ggp: 250,
    price: 999, final: 499, discount: 50,
    genres: ["RPG"], tags: ["Open World", "Post-apocalyptic", "Story Rich"],
    steamAppid: 22380,
  }),
  game({
    id: 6,
    name: "DARK SOULS III",
    image: "https://steamcdn-a.akamaihd.net/steam/apps/374320/header.jpg",
    description: "Enter a world of darkness and death, where twisted enemies and hidden paths threaten every step.",
    release: { date: "2016-04-12", precision: "day" },
    score: 93, steam: 93, critics: 89, criticsSource: "opencritic", igdb: 90, gamefaqs: 85,
    main: 33, complete: 96, difficulty: "Unforgiving", ggp: 260,
    price: 3999, final: 1999, discount: 50,
    genres: ["RPG", "Action"], tags: ["Souls-like", "Dark Fantasy", "Difficult"],
    steamAppid: 374320,
  }),
  game({
    id: 7,
    name: "Highway Blossoms",
    image: "https://steamcdn-a.akamaihd.net/steam/apps/469780/header.jpg",
    description: "A slice-of-life visual novel about two women hunting for treasure on a road trip across the desert.",
    release: { date: "2016-03-30", precision: "day" },
    score: 78, steam: 88, critics: null, criticsSource: null, igdb: 74, gamefaqs: null,
    main: 4, complete: 6, difficulty: "Simple", ggp: 120,
    price: 999, final: 999, discount: 0,
    genres: ["Casual", "Indie"], tags: ["Visual Novel", "Romance", "Story Rich"],
    steamAppid: 469780,
  }),
  game({
    id: 8,
    name: "Overlord II",
    image: "https://steamcdn-a.akamaihd.net/steam/apps/20920/header.jpg",
    description: "Command an army of mischievous Minions and carve a path of glorious domination.",
    release: { date: "2009-06-23", precision: "day" },
    score: 74, steam: 78, critics: 68, criticsSource: "metacritic", igdb: 71, gamefaqs: 75,
    main: 13, complete: 20, difficulty: "Easy", ggp: 140,
    price: 999, final: 999, discount: 0,
    genres: ["Action", "Strategy"], tags: ["Dark Comedy", "Third-Person"],
    steamAppid: 20920,
  }),
];

function game(g) {
  return {
    id: g.id,
    name: g.name,
    image: g.image,
    description: g.description,
    release: g.release,
    score: g.score,
    scores: { steam: g.steam, critics: g.critics, criticsSource: g.criticsSource, igdb: g.igdb, gamefaqs: g.gamefaqs },
    time: { main: g.main, complete: g.complete },
    difficulty: g.difficulty,
    ggp: g.ggp,
    // Real GameCard.price.currency is always "USD" or "RUB" (src/lib/game-card.js priceBlock), never a symbol.
    price: { amount: g.price, final: g.final, discount: g.discount, currency: "USD" },
    platforms: ["Windows"],
    genres: g.genres,
    tags: g.tags,
    links: {
      steam: g.steamAppid ? `https://store.steampowered.com/app/${g.steamAppid}/` : null,
      gog: g.gogId ? `https://www.gog.com/game/${g.gogId}` : null,
      hltb: `https://howlongtobeat.com/?q=${encodeURIComponent(g.name)}`,
      igdb: `https://www.igdb.com/search?type=1&q=${encodeURIComponent(g.name)}`,
      gamefaqs: `https://gamefaqs.gamespot.com/search?game=${encodeURIComponent(g.name)}`,
      opencritic: `https://opencritic.com/search?criteria=${encodeURIComponent(g.name)}`,
      metacritic: `https://www.metacritic.com/search/game/${encodeURIComponent(g.name)}/results`,
      wikipedia: `https://en.wikipedia.org/wiki/${encodeURIComponent(g.name.replace(/ /g, "_"))}`,
    },
  };
}

const DICTIONARIES = {
  genres: ["Action", "Adventure", "Casual", "Indie", "RPG", "Simulation", "Strategy", "Platformer"],
  tags: ["Bullet Hell", "Roguelike", "Survival", "Story Rich", "Souls-like", "Metroidvania", "Open World", "Atmospheric"],
  categories: ["Single-player", "Multi-player", "Steam Achievements", "Full controller support", "Steam Cloud"],
  languages: ["English", "Russian", "German", "French", "Japanese"],
  voiceovers: ["English", "Russian", "German", "French"],
  developers: ["CD Projekt Red", "Obsidian Entertainment", "Moon Studios", "FromSoftware", "11 bit studios"],
  publishers: ["Devolver Digital", "Bethesda Softworks", "Bandai Namco", "Annapurna Interactive"],
  difficulty: ["Simple", "Easy", "Just Right", "Tough", "Unforgiving"],
};

// Unlike every other dictionary field, `presets` returns { value: <integer id>, name } straight from
// the DB (src/api/dictionaries.js loadPresets) rather than a value==name pair — matched here so a
// selection made under ?mock=1 round-trips through settings.js/wheel-query.js the same way the real
// integer preset ids do.
const PRESETS = [
  { value: 101, name: "GGG #1" },
  { value: 102, name: "Speedrun GG" },
  { value: 103, name: "Indie GG" },
  { value: 104, name: "Coop GG" },
];

function pick(n) {
  const pool = [...GAMES];
  const out = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  // pad by repeating if the caller asked for more segments than we have games
  while (out.length < n) out.push(GAMES[out.length % GAMES.length]);
  return out;
}

export async function getSession() {
  return { csrf: "mock-csrf-token", user: null, lang: "en" };
}

export async function request(method, path, body) {
  const url = new URL(path, location.origin);
  const p = url.pathname;

  if (p === "/api/stats") {
    return { rolls: 128734, users: 4210, games: GAMES.length * 1500 };
  }

  if (p.startsWith("/api/dictionaries/")) {
    const field = p.split("/").pop();
    if (field === "presets") return PRESETS;
    const values = DICTIONARIES[field] || [];
    return values.map((v) => ({ value: v, name: v }));
  }

  if (p === "/api/games/search") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    return GAMES.filter((g) => g.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map((g) => ({ id: g.id, name: g.name, image: g.image }));
  }

  if (p.match(/^\/api\/games\/\d+$/)) {
    const id = Number(p.split("/").pop());
    return GAMES.find((g) => g.id === id) || null;
  }

  if (p === "/api/wheel" && method === "POST") {
    const segments = Math.min(16, Math.max(1, Number(body?.segments) || 12));
    if (body?.filters?.steamLibrary) return { error: "privacy" };
    return { games: pick(segments) };
  }

  if (p === "/api/wheel/random" && method === "POST") {
    return { game: pick(1)[0] };
  }

  if (p === "/api/wheel/marbles" && method === "POST") {
    const segments = pick(Math.min(16, Math.max(1, Number(body?.segments) || 12)));
    const rows = ["name,score,price"].concat(segments.map((g) => `"${g.name}",${g.score},${g.price.final / 100}`));
    return new Blob([rows.join("\n")], { type: "text/csv" });
  }

  if (p === "/api/auth/logout") return { ok: true };

  throw new Error(`mock-api: no handler for ${method} ${p}`);
}
