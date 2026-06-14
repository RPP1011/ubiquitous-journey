// Configuration for the small market economy. Agents have professions (not
// factions); everyone needs food; specialists trade at a market using per-agent
// PRICE BELIEFS that update from trades and spread by gossip — the economic
// belief surface from the spec's economy.md.

// --- commodities ------------------------------------------------------------
export const COMMODITIES = ['food', 'wood', 'ore', 'tool', 'herb', 'potion'];
export const BASE_PRICE = { food: 4, wood: 3, ore: 5, tool: 14, herb: 3, potion: 12 };

// --- professions (legacy: kept only as a colour/label LEGEND) ----------------
// Townspeople are NO LONGER born into a profession (Phase 1: occupation is
// EMERGENT — see GOODS + Agent.chooseOccupation). This table survives purely so
// the Town tab can show a trade-colour legend and old saves/tools that look up a
// profession key still resolve a colour. Nothing assigns `agent.profession` any
// more; the production knowledge lives in GOODS below.
export const PROFESSIONS = {
  farmer:     { label: 'Farmer',     color: 0xe0c04a, model: 'knight',    site: 'field',  output: 'food' },
  woodcutter: { label: 'Woodcutter', color: 0x5f8f3a, model: 'knight',    site: 'forest', output: 'wood' },
  miner:      { label: 'Miner',      color: 0x9aa0a8, model: 'barbarian', site: 'mine',   output: 'ore'  },
  smith:      { label: 'Smith',      color: 0xcf6a2c, model: 'barbarian', site: 'forge',  output: 'tool', inputs: { wood: 1, ore: 1 } },
  forager:    { label: 'Forager',    color: 0x8fbf6a, model: 'knight',    site: 'meadow', output: 'herb' },
  apothecary: { label: 'Apothecary', color: 0x7fb0c0, model: 'knight',    site: 'hut',    output: 'potion', inputs: { herb: 1 } },
};

// --- goods catalogue (the EMERGENT-occupation production knowledge) -----------
// Each producible good knows WHERE it's made (POI site), whether it's a raw
// resource anyone can gather (no inputs) or a CRAFTED good gated on holding its
// inputs, the deed-tags producing it earns (so a chosen occupation steers the
// agent's class), and the colour it reads as. `chooseOccupation` weighs these by
// believed price, proximity and the agent's ambition. Raw goods anyone can do;
// crafted goods (tool, potion) require the inputs in inventory.
export const GOODS = {
  // raw goods carry ONLY their craft tag — identity is what you make. ENDURANCE used to ride
  // every row, and as the one tag shared by all production it became most agents' TOP profile
  // tag (measured: 88/140), blurring farmer/woodcutter/miner into a generic survivor/merchant
  // mush (the class monoculture). A unit farmed is FARMING, full stop.
  food:   { site: 'field',  raw: true,  inputs: null,            color: 0xe0c04a, tags: ['FARMING'] },
  wood:   { site: 'forest', raw: true,  inputs: null,            color: 0x5f8f3a, tags: ['WOODCUT'] },
  ore:    { site: 'mine',   raw: true,  inputs: null,            color: 0x9aa0a8, tags: ['MINING'] },
  herb:   { site: 'meadow', raw: true,  inputs: null,            color: 0x8fbf6a, tags: ['FORAGE'] },
  tool:   { site: 'forge',  raw: false, inputs: { wood: 1, ore: 1 }, color: 0xcf6a2c, tags: ['SMITHING', 'CRAFTING', 'TOOLMAKING'] },
  potion: { site: 'hut',    raw: false, inputs: { herb: 1 },     color: 0x7fb0c0, tags: ['CRAFTING', 'SMITHING'] },
};

// Producible goods, partitioned for the chooser. RAW: gather anywhere with no
// inputs. CRAFTED: gated on holding the recipe inputs.
export const RAW_OUTPUTS     = (Object.keys(GOODS) as (keyof typeof GOODS)[]).filter((g) => GOODS[g].raw);
export const CRAFTED_OUTPUTS = (Object.keys(GOODS) as (keyof typeof GOODS)[]).filter((g) => !GOODS[g].raw);

// --- recipe knowledge (own-state craft gating; Phase-4 prerequisite) ---------
// A crafted good is producible only by an agent that KNOWS its recipe (own-state
// `agent.recipes`, read freely by cognition — no epistemic-split issue). Raw goods
// (food/wood/ore/herb) need no recipe: anyone may gather them. Recipe knowledge is
// transferable (teach/apprentice/shadow) and forgettable at generational turnover.
// ALWAYS-LIVE on the mainline: produce()/trade gate on `agent.recipes`, and recipe
// knowledge is GRADED (per-recipe confidence backing the craftable Set).
// ORDERING DEPENDENCY: `gated` reads CRAFTED_OUTPUTS above — keep this block BELOW it.
export const RECIPES = {
  // Which crafted goods are recipe-gated. Derived from GOODS (every non-raw good),
  // pinned here so the gate set is config, not a logic scan.
  gated: CRAFTED_OUTPUTS.slice(),     // ['tool','potion']
  // DAY-1 SEEDING: which recipes a freshly-spawned current PRODUCER is born knowing.
  // 'all' ⇒ every gated recipe (so every working townsperson keeps crafting exactly
  // as today). Children inherit a subset; newcomers learn.
  seedKnown: 'all',
  rediscoverPerSec: 0,       // self-rediscovery rate while stuck without a recipe (stub; 0 ⇒ off).
  // GRADED RECIPE KNOWLEDGE (docs/architecture/10-lld §6, §19 gap #1). Each recipe carries a graded
  // CONFIDENCE (the belief table's four fields, applied to own craft knowledge): half-learned from
  // a poor/brief teacher (below craftMinConf ⇒ in mind but not yet craftable), firmed by repeated
  // study/watching, and FORGOTTEN if not practised (use-it-or-lose-it) — so a craft dies out of a
  // town once its last practising holder stops (the "lost recipe"). A recipe is craftable (enters
  // the Set the produce/trade gates read) only at/above craftMinConf.
  craftMinConf: 0.45,        // graded confidence at/above which a recipe is "known" enough to craft
  studyGain: 0.34,           // confidence one TAUGHT study session adds (a few sessions, or a good teacher)
  forgetPerTick: 0.004,      // confidence a NON-practised recipe loses per cognition tick (slow fade)
  // (the per-session tuition is KNOW.studyTuition — the same coin the planner gates study on — moved
  //  to a co-located teacher as a conserved transfer; see the study executor + resolver.teachRecipe.)
};

// who spawns: a town of GENERIC townsfolk (no birthright trade). Each gets a
// starter kit (see ECON.starterKit) and CHOOSES what to do from GOODS each work
// decision. Same headcount as the old profession roster (23 souls).
export const ROSTER = [
  { n: 300 },                 // MEGATOWN: one dense core of 300 townsfolk (× TOWNS.centers.length = 1 town)
];

// --- economy tuning ---------------------------------------------------------
export const ECON = {
  startGold: 40,
  startStock: 2,              // units of own output to start with
  // a generic townsperson's starter kit (no birthright trade): some food, a tool
  // to be productive, and a couple of raw inputs so a first craft is reachable.
  starterKit: { food: 4, tool: 1, wood: 1, ore: 1, herb: 1 },
  keep: { food: 3, wood: 1, ore: 1, tool: 1, herb: 1, potion: 1 }, // reserve kept for personal use
  rationMul: 2,               // campaign rations: a townsfolk combatant keeps rationMul x keep.food (trade.wantQty)
  maxStack: 24,

  // --- occupation chooser (emergent profession) ---------------------------
  // each work decision an agent picks WHAT good to make, scoring producible
  // goods by believed price, proximity to the site, and ambition affinity. It
  // sticks to its current choice (hysteresis) unless another is clearly better,
  // so the town doesn't thrash to a single good.
  chooseStickiness: 1.5,      // multiplier favouring the agent's current _trade (switching cost)
  proximityWeight: 0.6,       // how strongly nearer sites are preferred (0..1)
  ambitionTradeBoost: 1.5,    // boost a good whose tags serve the agent's ambition
  // MASTERY → increasing returns + COMPETITIVE EXCLUSION. Per-field mastery (units of a
  // good ever made, slow-decaying so it persists — agent.mastery) gives a STEEP, lasting
  // productivity edge: a seasoned specialist out-produces a novice several-fold, floods
  // the field cheaply, and so makes it EXTREMELY HARD for a low-mastery unit to compete
  // there — newcomers are economically pushed to open niches. Folded into BOTH production
  // throughput AND the occupation score (so a master strongly prefers, and dominates, its
  // craft). This is also the persistent vocation-skill that fixes the idle-decay ceiling.
  masteryGain: 1.3,           // productivity edge per sqrt(units mastered). Steep + EARLY (production is
                              //   sparse, so the edge must arrive within a few units): ~4 units→×3.6, ~9→×4.9,
                              //   ~16→cap. A head-start of a handful of units thus dominates a novice (×1) and
                              //   compounds (a faster producer masters faster) — the field closes to newcomers.
  masteryChoiceWeight: 0.45,  // how much of the (steep) productivity edge feeds the occupation CHOICE — kept
                              //   well below 1 so mastery keeps a master LOYAL to its craft without herding the
                              //   whole town into the highest-value field (the edge lives mostly in throughput)
  // THE TOOLSET RULE (planner produce + act.produce): production requires a TOOLSET; a
  // SITE is just the permanent, non-consumable one. A crafted good may be made AFIELD
  // when a portable toolset (a tool) is in the pack — slower, and the tool wears per
  // unit (the field-craft the ambushed-alchemist scenario needs; docs 15 M0b).
  fieldCraftMul: 0.5,         // afield smithing-timer rate (the bench you didn't haul)
  fieldCraftWear: 0.5,        // tool wear PER UNIT crafted afield (at-site crafting stays wear-free)
  tradeDeedWeight: 0.15,      // IDENTITY weight of a routine buy/sell deed (vs 1.0 for a produce/craft
                              //   deed): trading is universal, so it's damped to let what an agent MAKES
                              //   define its vocation/class — only a DEDICATED trader still reads as a Merchant.
                              //   0.35 wasn't enough once market dwell hit ~27% of all agent time: the market
                              //   emits a STREAM of 3-tag deeds and TRADE still topped 98/146 profiles
                              //   (merchant-primary 106/146). At 0.15 the TRADE-10 merchant bar needs ~2x
                              //   the deals — a vocation, not a side effect of buying lunch
  // goods are scored by NET margin (price minus believed input costs), not gross
  // sticker price, so the town doesn't all chase the dearest good and bid its inputs
  // to the moon; and an agent's own unsold glut damps making more of it.
  marginFloor: 0.25,          // tiny positive margin floor: a break-even good stays a last resort
  saturationWeight: 0.5,      // how hard the agent's OWN unsold surplus of a good damps choosing it
  // the effective-value-of-labour valve (decide.js): when the best trade's margin is
  // thin, the WEALTH motive to work shrinks and leisure-valuing souls down tools —
  // but an ambitious soul keeps at it (an ambition-scaled intrinsic floor). Subjective,
  // not a town-wide cutoff, so the town self-thins its glutted trades until value recovers.
  laborValueRef: 5,           // net margin (gold/unit) that counts as labour "fully worth it" (saturates lv→1)
  workIntrinsicFloor: 0.4,    // ambition-scaled floor on the work motive (the driven work even unpaid)
  // DEMAND-AWARENESS: a maker sitting on unsold stock marks its own price belief down,
  // so a craft whose output won't clear loses its (stale, inflated) margin and the herd
  // disperses across trades instead of relocating to the next-dearest good.
  unsoldMarkdown: 0.04,       // belief markdown PER surplus-unit PER second of holding unsold stock
  unsoldMarkdownMax: 0.06,    // cap on the per-tick markdown (so a big glut can't crash a belief instantly)

  produceRate: 0.32,          // units/sec for raw producers
  toolBoost: 1.7,             // production multiplier while holding a tool
  toolWearPerGain: 0.10,      // tools worn PER UNIT produced (closes the money loop)
  smithSecsPerTool: 4.5,      // smith time to forge one tool (needs inputs)

  eatRate: 0.5,               // hunger restored per sec while eating (1:1 food)
  eatUrgent: 0.45,            // hunger below this = EAT NOW (suppress commerce; survival first)
  nibbleBelow: 0.25,          // critical hunger: auto-nibble from the pack while moving (no goal; drainNeeds)

  // price-belief learning (decentralised tatonnement -> competitive prices)
  priceLearn: 0.25,           // participant belief moves toward the clearing price
  priceGossip: 0.04,          // per-sec drift toward a chatting neighbour
  priceGossipPerTick: 0.04 / 6, // per fixed-tick (tickHz=6) drift — the gossip-bridge form
  tatonnementUp: 1.004,       // unfilled buyers raise their bid belief each tick
  tatonnementDown: 0.996,     // unfilled sellers lower their ask belief each tick
  priceBounds: [1, 40],

  tradesPerCommodityPerTick: 6,

  // ECONOMIC FRICTION → social slights. A deal is mutually agreeable by the math
  // (midpoint of two beliefs), but selfish folk don't see it that way: in a SHORTAGE
  // (price well above base) the buyer resents the seller as a gouger; in a GLUT (well
  // below) the seller resents the buyer as a lowballer — the harder the deviation and
  // the greedier the soul, the sharper the grudge. These are the AMBIENT negative
  // opinions a peaceful economy was missing — the fuel the telephone game ([[beliefs]])
  // amplifies into reputations and feuds. Small per-deal + clamped; affinity-gossip
  // scrubs the minor ones, so only the genuinely contentious harden.
  slightMargin: 0.2,          // price must deviate from base by this fraction to gall a party
  slightAmount: 0.05,         // base standing hit (then scaled 0.4..1.4 by greed × up to 3 by severity)

  // --- LOGISTICS: the market is a PLACE, not a town-wide ether -------------
  // Trade only clears between agents physically AT a market (within marketRange of a
  // market POI). So a remote producer must HAUL its load in to sell + restock — a
  // real journey whose distance, terrain chokepoints (the river/ravines), and road
  // danger now matter. A hauler cut down en route loses its cargo and the town goes
  // short. The `market` goal (decide/act) drives the haul.
  marketRange: 18,            // how near a market a trader must be to deal
  haulLoad: 5,                // surplus units worth hauling to market (triggers a trip)
  caravanFleeRange: 6,        // a laden caravan presses on; only bolts when a raider is THIS close
};

// --- stored wealth (purse vs stash) — Phase-4 covert-economy prerequisite -----
// Splits an agent's gold into a CARRIED PURSE (gold, lootable on death) and a
// BANKED STASH (stash, burglable while away — the urchin's target in Ex. 5).
// MIGRATION BASELINE-IDENTICAL: enabled=false ⇒ seedStash is a no-op, 100% stays
// in the purse, stash=0 everywhere, and the 12k soak / econstats are byte-stable.
// Flip enabled=true in Phase 4 to make merchants bank a fraction of their wealth.
export const WEALTH = {
  enabled: false,             // day-one OFF (SCARECROW pattern) — keeps the soak byte-stable
  // fraction of an agent's INITIAL gold that is moved to the stash at spawn,
  // keyed by what it produces (_trade) — a settled merchant banks more, a raw
  // producer keeps it liquid. Read by trade.seedStash; only consulted when enabled.
  stashRatio: { tool: 0.6, potion: 0.5, default: 0.3 },
  minPurse: 8,                // never bank below this — an agent must keep coin to trade
  // HOME BANKING (the cellar strongbox — act.ts, always-live, gated by OWNING a cellared
  // home): resting at one's own cellar-home deposits surplus purse gold into the stash
  // (conserved transfer; not on the body — robbery/corpse-loot can't reach it; escheat
  // passes it to the heir) and withdraws when the purse runs low.
  bank: {
    keepPurse: 30,            // bank only the surplus above this walking-around money
    chunk: 5,                 // gold moved per (2s-throttled) banking beat while resting
    withdrawBelow: 10,        // a purse this thin draws savings back out
  },
};

// --- the urchin: covert epistemic acquisition (Phase 4, Ex.5) -----------------
// The adversarial flagship. An empty-pursed agent backward-chains a heist through an
// EPISTEMIC ATOM: `shadow` (surveil) the mark to CONSOLIDATE a believed stash location
// (an `assoc` belief), then `approach` + `burgle` it. `shadow` IS the epistemic `gather`.
// ALWAYS-LIVE on the mainline: the urchin planner primitives + heist deriver run.
export const URCHIN = {
  shadowCost: 4,             // planner cost of the slow/safe surveil (the epistemic gather)
  consolidateAfter: 4,       // surveil sightings before the loose tally becomes an `assoc` belief
  sightGain: 0.3,            // confidence added to `assoc` per surveil sighting (capped 1)
  surveilBudget: 18,         // sim-seconds the surveil step runs before goal-expiry drains it
  standoffRange: 14,         // surveil holds OUTSIDE the mark's modelled sight (2nd-order ToM v1)
  // --- the LIVE steal-goal deriver (docs/architecture/10-lld §13; the flagship heist) ---
  // A poor + larcenous townsperson forms a steal goal against a believed-prosperous mark. The
  // disposition gate (greed) is what stops "everyone turns thief when broke" — poverty is the
  // circumstance, character is the choice. Picks the mark from BELIEF cues (most-established in
  // mind ≈ a settled, prosperous local), never the roster. Kept selective so theft is narrative
  // spice, not economic collapse (the take is conserved either way — gold moves, never mints).
  deriveBelowGold: 26,       // only an agent poorer than this considers a heist (circumstance)
  // DISPOSITION GATE (the design's "what you'll even consider"): larcenous == uncaring about
  // others' welfare (LOW altruism) AND bold (HIGH risk_tolerance). Read off the traits the spawn
  // actually seeds (there is no `greed` trait). A scrupulous or timid soul never reaches for theft —
  // poverty is the circumstance, character is the choice, so only this corner of personality-space does.
  deriveAltruismMax: 0.4,    // altruism at/below which an agent is uncaring enough to steal
  deriveRiskMin: 0.55,       // risk_tolerance at/above which it is bold enough to try
  // (the believed haul the heist aims for is the wealth-cue estimate — see ESTIMATE / estimateHaul.)
  deriveExpiry: 110,         // sim-seconds a steal goal persists before it cools
  surveilDwell: 4.5,         // sim-seconds of holding at standoff per accrued surveil sighting (slow gather)
};

// MULTIPLE TOWNS (open world): the world holds several dense town cores with
// wilderness + trade roads between them, rather than one town spread thin (a
// bigger map with the SAME townsfolk thins the social drama — measured; more
// dense cores is the fix). Each town = a centre + a "home" radius its townsfolk
// live/work/defend within. Town 0 stays at the origin so its terrain/landmarks
// are unchanged. Every origin-hardcoded subsystem reads an agent's townAnchor.
export const TOWNS = {
  centers: [[0, 0]],              // MEGATOWN: a single dense core at the origin. The monster frontier
                                  //   band (0.45..0.92 × ARENA_RADIUS=600 ⇒ 270..552) still rings it as
                                  //   wilderness; with one town the inter-town layer (caravans / arbitrage /
                                  //   migration / road graph) is dormant by construction (no second town to
                                  //   trade or migrate to) — those subsystems no-op cleanly, not crash.
  radius: 200,                    // a town's home band (wander / work / defence). Widened from 70 so 300
                                  //   townsfolk aren't crammed into a hamlet's footprint — still < 270 so
                                  //   the home band stays clear of the monster frontier.
  names: ['Eastmarket'],          // the one town's name (dateline)
  // SPECIALIZATION (comparative advantage): each town's resource sites are skewed so
  // it surpluses some goods and runs short on OTHERS — creating real inter-town demand
  // that makes caravans + arbitrage matter. CRUCIAL LESSON: a FOOD deficit is fatal
  // (a food-poor town starves + depopulates), but ore/wood/herb deficits are NOT —
  // they just throttle tool/potion crafting. So every town keeps ENOUGH fields to feed
  // itself, and specializes in the non-essential goods. Trade flows in crafting inputs.
  // (counts per kind; towns beyond this list fall back to the balanced default.)
  profiles: [
    // MEGATOWN: one self-sufficient profile (no trade partner ⇒ it must produce EVERY good
    // itself). Site counts scaled ~10× the old hamlet so 300 townsfolk have reachable work of
    // every kind; FOOD is weighted heaviest — a food deficit is the only fatal one (a food-poor
    // town starves + depopulates; ore/wood/herb shortfalls only throttle crafting).
    { field: 60, forest: 36, mine: 36, meadow: 30 },   // Eastmarket — the one town: balanced + abundant
  ],
  // STONE WALLS ringing each town's built core. The ring sits just INSIDE the
  // resource ring (sites scatter from r=18 outward), so it encloses the market /
  // forges / huts but leaves the surrounding farms + mines as open countryside —
  // a walled town with fields beyond. `gates` evenly-spaced angular gaps let
  // townsfolk, caravans and the player in/out (gate 0 faces +x, toward the next
  // town along the trade road). goTo funnels traffic to a gate the same way it
  // funnels across a river ford. See js/sim/walls.js (collision is config-pure +
  // headless-safe; the mesh is browser-only). Set `radius: 0` to disable.
  // `funnel`: the gate waypoint only OVERRIDES a mover's heading within this many
  // metres of the doorway — far from the wall the field (target + road blend) owns
  // the heading; collideWalls still hard-blocks the ring at any range. Without this
  // gate, a 200m march at a walled town centre was a forced straight line at the
  // far gate, which silently defeated the road-pull blend (and any future field).
  // radius is the NO-GRID FALLBACK only: with CITY.enabled the wall derives from the
  // CityGrid's half-extent + `margin` (walls.ts wallRadiusFor) so the ring encloses the
  // whole town plan, and Cities moves it out when the grid grows. Gates stay 4 evenly-
  // spaced (gate 0 faces +x) — the lattice's axis streets exit through them.
  wall: { radius: 16, thickness: 2, height: 5, gates: 4, gateWidth: 8, funnel: 40, margin: 4 },
};

// THE GAZETTE / REPORTER — a roaming "gazetteer" agent interviews newsworthy
// townsfolk and publishes a town newspaper about their emergent adventures (prose
// optionally LLM-written, template fallback). Deterministic on the tick; the LLM
// is a browser side-channel. See js/sim/reporter.js + js/sim/gazette.js.
export const REPORTER = {
  enabled: true,
  count: 1,                  // gazetteers in the world (>= towns to cover them all)
  name: 'the Gazetteer',     // role name (the inspector/dialogue read this)
  tickEvery: 2,              // self-throttle (sim-seconds) for selection/interview checks
  selectEvery: 8,            // how often it re-evaluates who's most newsworthy
  interviewRange: 6,         // must be this close to its subject to interview
  dwellSecs: 2,              // …and linger this long (a brief co-located "interview")
  travelTimeout: 90,         // give up chasing a subject after this and re-select
  subjectCooldown: 120,      // don't re-feature the same soul within this window
  minNewsworthy: 0.5,        // skip filing if nobody clears this bar (no forced filler)
  // newsworthiness weights (deterministic scalar over read-only state)
  wSalience: 1.0, wRecency: 0.6, wEpithet: 0.8, wRole: 0.5, wBeats: 0.25,
  wRival: 0.5, wEscape: 0.4, recencyWindow: 60,
};

// NPC BOUNTY-HUNTERS — agents READ the Gazette's opportunity notices and answer
// them: a brave townsperson near a market sees a posted bounty, sets out to hunt
// the quarry, and (first to finish — racing the player) claims the giver's reward.
// This turns the newspaper into a live labour market. See js/sim/bounties.js.
export const BOUNTY = {
  enabled: true,
  tickEvery: 3,              // self-throttle (sim-seconds) for the reading/credit pass
  readEvery: 9,             // how often a town's folk "read the paper" for new work
  maxConcurrent: 2,         // at most this many NPC bounty-hunters out at once
  recruitRisk: 0.62,        // only townsfolk at least this brave answer a bounty
  readRange: 22,            // must be within this of a market to "read" the gazette
  ttl: 160,                 // give up + go home if not done within this (sim-seconds)
  takeChance: 0.5,          // per eligible reader per read, chance to actually take it
};

// TOWN ALERT — reading a Gazette THREAT advisory makes a town batten down: its
// Watch musters early (brave folk answer the call) and caravans hold off the
// dangerous roads. Channel 2 of "agents exploit the journals".
export const ALERT = {
  duration: 110,             // sim-seconds a published threat keeps a town on alert
  watchBonus: 4,             // …adding this to the town's Watch muster target
};

// MARKET ARBITRAGE — agents READ a price report and chase the profit: a trader
// holding surplus of a good that the Gazette says is DEAR in another town hauls it
// there to sell (the localized market means selling AT the dear town nets the higher
// price). Channel 3 of "agents exploit the journals". Crossing the wilds is risky —
// an arbitrage haul is a lone caravan, and may be ambushed.
export const ARBITRAGE = {
  enabled: true,
  tickEvery: 3,              // self-throttle (sim-seconds)
  readEvery: 9,              // how often traders read the paper for a price edge
  maxConcurrent: 2,          // at most this many arbitrage hauls at once
  readRange: 22,             // must be within this of a market to read the report
  minSurplus: 3,             // must hold at least this much of the good to bother hauling
  ttl: 150,                  // give up + go home if the haul isn't done in this
  sellDwell: 14,             // sim-seconds at the dear market to sell what it can, then head home
  takeChance: 0.5,           // per eligible reader per read, chance to set out
};

export const GAZETTE = {
  cap: 60,                   // ring-buffer of published articles
  briefMemories: 4,          // top salient memory phrases fed into an article
  briefBeats: 3,             // recent chronicle beats mentioning the subject
  // --- the intel desks: the paper sells USEFUL info, not just storied souls ----
  marketMargin: 4,           // a good's town demand/supply must differ by THIS (units) to be news
  wireEvery: 10,             // sim-seconds between "wire dispatch" (market/threat/opportunity) checks
  wireFloor: 1.0,            // minimum reader-value to bother publishing a dispatch
  cooldownMarket: 150,       // don't re-run the same price story within this (sim-seconds)
  cooldownThreat: 300,       // …or the same named-foe advisory
  cooldownOpp: 220,          // …or the same posted opportunity
};

// utility weights per action
export const WEIGHT = {
  eat:       1.40,
  market:    1.00,
  work:      0.80,
  rest:      0.85,
  socialize: 0.90,   // raised: agents were aimless (~a third of their time wandering); a town
                     //   that gathers and chats reads as ALIVE. Still below work/eat so the
                     //   economy holds — it claims IDLE time, it doesn't starve commerce.
  wander:    0.15,
  sightsee:  0.75,   // LEISURE VARIETY: a curious soul takes in a named landmark — purposeful
                     //   idle-time (restores comfort + a little society, scratches wanderlust) so
                     //   leisure isn't all home-sitting + aimless wander. Pulled by the leisure
                     //   valve (when labour is cheap) and scaled by curiosity; below work so it
                     //   claims IDLE time, never starves commerce.
  fight:     1.60,
  flee:      1.80,
  plan:      1.30,    // a goal-stack plan step: high, but below flee/fight/eat
  migrate:   1.55,    // an uprooting migrant's march to its new home town. Must beat a HELD plan
                      //   even with the incumbent's ×1.18 stickiness (1.30×1.18≈1.53): the poor —
                      //   exactly who emigrates — chronically hold a seek_fortune/sate plan, and at
                      //   1.25 the journey-tracker probe watched every departure lapse 250m short,
                      //   the mover never once out-scoring its own money plan. Urgent eat (~2.5),
                      //   flee (~1.9+) and a comfort emergency still preempt — survival first;
                      //   the journey resumes the next tick. Only ever scored while a._migrating.
  comfort:   1.80,    // seek home/tavern when comfort low: a real pull that, when comfort runs
                      //   genuinely low, beats a routine work/market/plan urge so the agent
                      //   actually goes home (kept below eat/flee — survival still wins)
  build:     3.00,    // commission/advance a home: a deliberate, rare, ROI-GATED capital project
                      //   (qualifyHome is a strict chronic-comfort + wealth gate, so this only ever
                      //   competes when the agent genuinely needs a home). It must out-pull a routine
                      //   market trip (urgency-scaled up to ~3.9) REGARDLESS of the agent's ambition,
                      //   or low-ambition qualifiers never commit and the build is flaky. The decide
                      //   formula gives it a high floor (×1.4) + committed stickiness (×1.8).
  ambition:  1.00,    // AMBITION-ACTIVITY (Phase B1): the candidate that pursues a STANDING ambition
                      //   activity (work/seek_glory/sightsee/socialize) when no enemy/opportunity is in
                      //   sight — so an idle agent DOES its ambition's activity instead of aimless
                      //   wandering. Score = this × (MOTIVE.ambitionDriveFloor + the matching personality
                      //   drive), so a DRIVEN soul (~1.25) out-pulls a routine market/comfort urge while a
                      //   half-hearted one (~0.35) still drifts to leisure — personality orders who
                      //   pursues what hardest. decide() CLAMPS it below WEIGHT.plan (a live memory-
                      //   derived plan always wins) and pushes it AFTER the ambitionFavor tilt (no
                      //   double-scale); urgent survival/needs (eat/flee/emergency-comfort) out-score
                      //   it too, so a hungry or threatened agent tends itself first.
};

// --- longer-term motivations (ambitions) ------------------------------------
// Every NPC carries a persistent ambition that biases its short-term action
// choice over many ticks, so agents live visible arcs instead of only servicing
// immediate needs. Targets are tuned to be reachable within a play session; on
// fulfilment the agent rolls a fresh ambition. See js/sim/motivation.js.
// --- OATH ECONOMICS (js/sim/motivation.ts swearOath/resolveOath + agent.drainNeeds) ----
// An oath is a COMFORT LOAN with a courage coupon: taking it costs peace of mind and the
// unresolved vow gnaws — but while the word is HELD AND HONOURED it pays continuously
// (fear damps faster, boredom slower: a sworn life has purpose). Keeping it lifts the
// gnaw and pays the existing closure XP/triumph; BREAKING it scars permanently — each
// forsworn vow lowers the comfort CEILING for life (the forsworn sleep poorly), feeds
// the biography ("twice forsworn") and a formative memory. All own-state; tuning here.
export const OATHS = {
  swearComfortCost: 0.08,   // the vow's weight lands when taken (immediate comfort hit)
  gnawComfortMul: 1.25,     // comfort drains this much faster while a sworn oath is unresolved
  liveFearDamp: 0.5,        // EXTRA fear decay per sec while sworn (courage of the committed)
  livePurposeMul: 0.6,      // novelty (boredom) drain multiplier while sworn — purpose fills a life
  forswornCapStep: 0.06,    // PERMANENT comfort-ceiling loss per broken oath…
  forswornCapFloor: 0.45,   // …bounded: the forsworn sleep poorly, not impossibly
};

export const MOTIVE = {
  pull: 1.0,             // global scale on how hard an ambition tilts utility
  reassignGrace: 6,      // sim-seconds before a freshly-set ambition can complete
  wealthTarget: 140,     // gold held to feel "wealthy"
  masteryLevel: 12,      // total class level to feel "accomplished" (raised with
                         //   the Phase-1 narrative-XP headroom: level 4 became
                         //   trivial once storied lives reach 15-30, so mastery
                         //   would complete instantly; 12 keeps it a real arc)
  renownKills: 8,        // monsters slain for "renown" (raised with Phase B1: a standing
                         //   seek_glory prowl lands kills far faster than incidental danger did,
                         //   so 4 completed in minutes and the cohort evaporated into reroll)
  wanderDist: 1400,      // metres roamed for "wanderlust" (raised with Phase B1: life.dist accrues
                         //   from ALL walking — at 420 any errand-runner completed it in ~5 min and
                         //   the wanderlust cohort drained into the never-completing kinds)
  socialAmount: 70,      // accumulated socialising for "belonging" (raised with Phase B1 — the
                         //   standing socialize activity accrues it steadily, so 22 was minutes)
  revengeTimeout: 120,   // sim-seconds a grudge-revenge persists if unfulfilled
  // --- memory-derived goal expiries (Phase 3) ---
  avengeExpiry: 120,     // sim-seconds an avenge goal persists before it cools
  fortuneExpiry: 180,    // sim-seconds a seek_fortune goal persists
  fortuneTarget: 140,    // gold-held target a windfall-seeker chases (== wealthTarget)
  // --- Phase B breadth: succoured/grieve/delve goal expiries ---
  repayExpiry: 240,      // sim-seconds a repay-a-kindness goal persists
  grieveExpiry: 90,      // sim-seconds a grief (mourning) goal lingers before it lifts
  delveExpiry: 200,      // sim-seconds a delve(place) goal persists
  succourHunger: 0.4,    // hunger at/below which receiving a gift counts as being succoured
  // --- PERSISTENT AMBITION STANDING ACTIVITY (Phase B1) ---
  // A slow ambition STAMPS a standing activity intent (a._ambitionIntent) each cognition tick,
  // so decide() mints a candidate that out-scores aimless wander. The intent tracks the agent's
  // own slow ambition (which persists over minutes) yet needs/flee/comfort still interrupt (they
  // out-score it). See js/sim/features/ambition_goals.js + the ambition-activity candidate in decide.
  gloryFrontierMin: 0.45,   // inner edge of the renown prowl band the seek_glory march heads to (× ARENA_RADIUS; outer ~0.92)
  ambitionDriveFloor: 0.25, // base pull of the ambition-activity candidate before the matching
                            //   personality drive is added (decide) — low enough that a low-drive
                            //   soul keeps its leisure variety instead of being conscripted, high
                            //   enough that every ambition claims real idle time (aligned dwell)
  // --- ToM motive INFERENCE (docs/architecture/17 §7) ---
  attributeAt: 0.45,        // §7.2a write bar: a witness persists believedMotive only when the posterior
                            //   conf is at/above this — sub-threshold reads (the common stranger case)
                            //   write nothing, leaving any prior attribution intact. The single most
                            //   load-bearing inference knob (the prior×likelihood calibration target).
  legibleAt: 0.7,           // an honest, cue-rich act is "clearly read" at/above this conf (calibration)
  ambiguityFloor: 0.15,     // §7.2a: below this the read is illegible (nothing happens). Between this and
                            //   attributeAt is the AMBIGUOUS band — a salient deed there files a puzzle.
  puzzleAt: 0.6,            // §7.6: a sub-threshold deed files an `unresolved` puzzle only if its
                            //   magnitude is at/above this (a killing, a large theft — worth brooding on).
  puzzleRing: 6,            // capacity of the DEDICATED a._puzzles store (separate from the episodic rings)
  deliberatePasses: 3,      // bounded re-tries on a still-murky puzzle before it's let go to fade
};

// --- QUANTITIES: numeric-threshold plan composition (docs/architecture/10, Phase 1) ----
// The planner composes several acquisitions toward a numeric goal (hold >= N gold, a need
// raised above a level) rather than emitting a single advancing step. Greedy: take the
// acquisition with the best believed yield-for-cost, then the next, until the believed
// total crosses the target. When the target is UNREACHABLE (the common case for a poor
// agent), it (1) WIDENS toward riskier sources scaled by how bold the agent is, (2)
// SATISFICES — commits the best partial plan it CAN reach (earn the 50, not the 80) — and
// (3) puts the goal on a brief COOLDOWN so the unreachable sum is not re-attempted every
// tick (anti-livelock). The drive persists in motivation and rebuilds. ALWAYS-LIVE on the
// mainline: threshold composition (gold/need) runs at the solveAtom seam.
export const QUANTITY = {
  partialCooldown: 12,   // sim-seconds an UNREACHABLE threshold goal rests before re-planning
  widenRiskTol: 0.6,     // risk_tolerance at/above which the failure search WIDENS (sells into
                         //   the keep reserve / acts on thinner leads) — the bold widen, the timid don't
  needMeal: 0.34,        // believed need-level a single `consume` raises (graded-needs composition)
};

// --- KNOWLEDGE: Know(topic) + the observe/ask/study channels (docs/architecture/10, Phase 2) ---
// Knowledge is a requirement like any other: `Know(topic)` reads a topic's HOME (a field on
// the belief table for facts about others — assoc=Loc, lastPos=Whereabouts, priceBeliefs=Price
// — or own-state for a Recipe) and reports it known only if present AND confident enough. The
// three write channels differ in cost, in how trustworthy the result is, and in side-effects:
// `observe` (first-hand, slow, trusted — the generalised `shadow`), `ask` (cheap, vaguer, tips
// the subject off), `study` (taught, trusted, costs tuition). And confidence FOLDS INTO COST —
// an action leaning on a shaky belief costs more, so an agent scouts before a high-stakes bet.
// ALWAYS-LIVE on the mainline: the observe/ask/study rows + confidenceSurcharge.
export const KNOW = {
  minConf: 0.45,         // a topic must be at least this confident to satisfy a Know() requirement
  observeCost: 4,        // first-hand watching: slow but trusted (subsumes the urchin's `shadow`)
  askCost: 1.5,          // being told: cheap and quick, but vaguer + tips the subject off
  studyTuition: 6,       // taught: gold paid for trusted instruction (recipes)
  confCostScale: 8,      // how hard a LOW-confidence belief inflates the cost of acting on it —
                         //   cost-includes-confidence, so agents scout before they commit
  observeGain: 0.18,     // confidence accrued into a topic's home per sim-second of first-hand watching
  askGain: 0.3,          // confidence a single (cheap, vaguer) ask adds to a topic's home
};

// --- ROB: the take-from-a-person acquire row (docs/architecture/10, Phase 3) -----------
// The acquire table's `person` row — taking gold from a mark by FORCE (robbery; tax/alms are
// the same moved-shape with a different social trace). MOVED, so the executor debits the mark
// as it credits the robber (closed money loop), exactly like loot/burgle. ALWAYS-LIVE on the
// mainline: the `rob` acquire row is registered and plannable.
export const ROB = {
  amount: 5,             // believed gold taken (the fallback when a goal carries no explicit haul amount)
};

// --- ESTIMATE: the wealth-cue haul inference (docs/architecture/10-lld §15) -------------
// A believed quantity that can NEVER be observed (the gold inside a mark's purse/cache) is an
// EXPECTED VALUE with a confidence, inferred from perceivable PROXIES — never the real ledger. It
// replaces the flat URCHIN.deriveTarget / ROB.amount constant: a thief estimates each mark's haul
// from cues on its OWN belief (how established/notable the mark is, whether it has SEEN a stash),
// anchored on a faction prior. Every input is itself a belief, so the estimate is WRONG precisely
// when the cues mislead (a flashy-but-broke mark reads fat, yields little — and `take` is conserved,
// so an empty mark simply gives up less). The confidence folds into the heist's COST (a hazy estimate
// makes the raid expensive → the urchin cases it longer). ALWAYS-LIVE on the mainline: the urchin
// deriver targets the believed-richest mark and `haulSurcharge` folds the estimate into the cost.
export const ESTIMATE = {
  basePrior: 10,         // believed haul for a mark of unknown category (anchors a bare belief)
  priorConf: 0.12,       // confidence of the bare prior before any cue firms it (a pure guess)
  estCap: 60,            // ceiling on a believed haul — no runaway estimate from stacked cues
  // FACTION PRIOR (the only believed "category" a belief carries — lastFaction): a settled
  // townsperson is worth more to rob than an outsider passing through or a coinless raider.
  categoryPrior: { townsfolk: 14, outsider: 8, rival: 9, bandit: 6, wilds: 5, monster: 0 } as Record<string, number>,
  // CUES — each NUDGES the estimate toward what it implies and FIRMS confidence by its weight
  // (firmUp: conf += (1-conf)*weight, asymptotic toward certainty like any evidence accrual):
  establishedNudge: 10,  // gold a well-established (high-confidence) belief adds — a settled local reads prosperous
  establishedWeight: 0.3,
  assocNudge: 8,         // a SEEN stash/cache (assoc) is direct evidence of stored wealth
  assocWeight: 0.35,
  notorietyNudge: 12,    // a notable / notorious figure (believed fame) reads richer
  firsthandWeight: 0.25, // a first-hand belief (hops 0) firms the estimate; hearsay keeps it shaky
  confCostScale: 7,      // how hard a HAZY haul estimate inflates the heist cost (case it longer)
};

// --- HOLD-UNTIL: waiting for the world to change (docs/architecture/10, Phase 4) -------
// Some plans must WAIT rather than act: a small party holds in concealment until it sees the
// raiders leave, then the camp is briefly weak. A hold-until step keeps the agent somewhere
// safe/hidden, re-checks a believed condition each tick, and advances when it becomes
// believed-true. It abandons two ways, and they differ: the DEADLINE passes (the window never
// opened — the goal's expiresAt drops it) or the spot stops being SAFE (discovered — the
// reactive flee preempts the held step, the same flee any agent would). ALWAYS-LIVE on the
// mainline: the `hold` row is plannable.
export const HOLD = {
  cost: 1,               // planner cost of inserting a wait (cheap, but not free, vs. acting now)
};

// --- RECRUIT: building a force (docs/architecture/10, Phase 5 — the recruiter capstone) ----
// A would-be leader builds toward a believed force that outmatches a camp the SAME way it builds
// toward 80 gold — by accumulation. But a command does not BIND another agent (they decide for
// themselves), so `recruit`'s effect is not "+1 to my force" — it is a BELIEF: I believe this
// candidate will follow, held at a COMPLIANCE confidence reflecting how likely they are to (a
// loyal friend high, a wary stranger low, read off the candidate's standing). Believed force =
// own strength + Σ each candidate's strength × compliance. The planner adds recruits greedily —
// cheapest reliable force first — until the believed sum outmatches the camp. The follower side
// is an ordinary goal (the reputation-gated party-join the sim already has). ALWAYS-LIVE on the
// mainline: the `force_ge` composer + the `recruit` row run.
export const RECRUIT = {
  selfStrength: 1,       // a lone leader's own believed strength (the base of the muster)
  candidateStrength: 1,  // a candidate's believed strength before the compliance discount
  minStanding: -0.2,     // a candidate must be believed at least this well-disposed to approach
  minCompliance: 0.15,   // a recruit contributing less believed force than this isn't worth a row
  offerWarmth: 0.08,     // how much perceiving an offer warms a candidate toward the leader (its OWN belief)
  musterRiskTol: 0.6,    // risk_tolerance at/above which a leader will try to muster against a strong foe
  notorietyTilt: 0.6,    // a notorious leader's offer payoff is tilted by notoriety×this (infamy draws a following, §9.3)
};

// --- WARBAND: the recruiter follow-through (docs/architecture/10-lld §19 item 4, §12) -------
// RECRUIT wires only the BELIEF half — a leader makes an Offer the candidate perceives, the
// candidate WARMS toward the leader through its own belief. WARBAND turns a warmed candidate into
// an actual MARCHING NPC ally: the candidate forms its OWN decision to join the offering leader's
// band (reading only its own _offers + belief-standing + personality — the epistemic split holds),
// then the SAME band machinery the player's Party uses flips the flags (inParty / bandLeaderId /
// groupType:'warband' / partySlot / combatant) and the existing decide()/follow steer-fill march
// it. No parallel system, no foreign-mind write: recruitment stays an Inform; the follower decides.
// ALWAYS-LIVE on the mainline: a warmed candidate forms its own join decision and marches.
export const WARBAND = {
  joinStanding: 0.35,    // believed-standing toward the offerer at/above which a candidate will join
  minPayoff: 0,          // believed offer payoff at/above which the join is worth considering
  joinRiskTol: 0.45,     // risk_tolerance scale: the bolder accept a thinner offer (× this damps the bar)
  offerTtl: 30,          // sim-seconds an unanswered offer stays actionable before it lapses
  maxFollowers: 6,       // hard cap on an NPC leader's recruited band (matches PARTY.maxSize ceiling)
};

// --- AFFECT: changing another entity's physical state (docs/architecture/10, Phase 5) ----
// The Affect rows beyond strike(→dead): `free` (→ freed — cut a captive's bonds) and `wreck`
// (→ not intact — sabotage). Each is a trivial final act gated by a hard requirement (be there,
// unopposed); combat already resolves the third (strike→dead). The plan reasons against a
// BELIEVED physical state and is as exposed to being wrong as a raid on a moved cache — the
// captives may have been moved by arrival. ALWAYS-LIVE on the mainline: the free/wreck rows
// are plannable (no tuning fields — the rows are trivial final acts).
export const AFFECT = {
};

// --- CAPTIVE: the captivity → rescue arc TRIGGER (docs/architecture/10-lld §19 item 3, §12) ----
// The Affect `free` row is correct + unit-tested but DORMANT — nothing in the sim ever makes an
// agent a captive, so no deriver fires it. This block wires the missing trigger: when a hostile
// captor-faction combatant DEFEATS a non-combatant townsperson, with a small chance the victim is
// CAPTURED instead of killed (revived, `_held`, anchored). That is EXECUTION (ground truth, on the
// combat path). Perception then writes a `captive` flag on the WITNESS's BELIEF about the captive
// (the epistemic split), and the affect deriver — reading beliefs + own personality ONLY — forms a
// goalFree for a sufficiently-liked believed-captive. The freed captive's gratitude EMERGES from it
// perceiving `_freedBy` (a positive, per-perceiver warmth through its OWN belief). ALWAYS-LIVE on
// the mainline: capture-on-defeat + the `captive` belief + the `goalFree` rescue deriver run.
export const CAPTIVE = {
  captureChance: 0.25,           // P(capture instead of kill) on a qualifying lethal blow
  captorFactions: ['bandit', 'rival', 'monster'],  // who takes prisoners (raiders/rivals/beasts)
  reviveHpFrac: 0.35,            // health the captured victim is left at (alive but cowed)
  rescueStanding: 0.3,           // believed standing above which a captive is worth rescuing (a friend)
  rescueRiskTol: 0.45,           // a rescuer must be at least this bold OR…
  rescueAltruism: 0.6,           // …this kind to attempt a rescue (disposition gate — not everyone)
  guardReach: 4,                 // a believed-hostile within this of the captive is a GUARD to clear first (§7)
  gratitudeWarmth: 0.5,          // standing bump the freed captive feels toward its rescuer (its OWN belief)
};

// --- LEDGER: the obligation store (docs/architecture/10, Phase 5 — the one new machinery) ----
// A small per-agent store of standing INTENTIONS, each a (trigger, deferred action, counterparty,
// expiry), checked against perception each tick. It absorbs the two things pushed out of the
// one-shot plan: COMMITMENTS ("I'll pay you when you deliver") and RECURRENCE (a debt due each
// season — a trigger that is a time). Structurally a little belief table with decay: a handful of
// entries per agent, most empty. A ledger entry OUTLIVES every plan (unlike a hold-until, which
// dies with its plan) — which is exactly why a commitment cannot just be a hold-until step.
// ALWAYS-LIVE on the mainline: the per-tick obligation arm/settle/discharge wiring runs.
export const LEDGER = {
  max: 8,                // hard cap on outstanding obligations per agent (bounded, like the belief table)
  commitExpiry: 300,     // sim-seconds an armed commitment persists before it lapses unkept
};

// --- ARCS: the emergent-arc / saga registry (docs/architecture/12 §3 — the narrative spine) ----
// The bounds + timescales for sim.sagas. Tuning only; the store math lives in js/sim/arcs.ts.
export const ARCS = {
  lapsedReopenSecs: 240,   // a key whose tale just LAPSED rests this long before re-opening (anti grudge-churn)
  maxOpen: 256,          // hard cap on concurrently-open arcs (the WEAKEST incumbent evicted via close).
                         //   Sized UP from 96 when fellowships/warbands became long-lived (the endures +
                         //   resolve-at-battle fixes), then again from 192 when spotlight casting spread
                         //   arc entry across the roster (30 multi-arc agents; a nemesis raider alone
                         //   carried ~55 vendetta keys and 38 were evicted 'crowded_out'). Eviction is
                         //   the backstop, not a routine outcome.
  maxClosed: 320,        // ring of completed arcs the Gazette/UI read — sized so a populous town's
                         //   narrative HISTORY persists across a long session instead of churning out
                         //   in seconds (a 30-min trace produced ~100 real arcs post-churn-fix; 64 was
                         //   far too small and evicted ordinary agents' stories before they were read).
  maxBeats: 12,          // bounded per-arc chapter trail (open + rounds + close)
  openTtl: 180,          // sim-seconds an open arc lives unresolved before sweep lapses it; re-armed
                         //   by each fresh `round` beat (a slow feud outlives an open-and-shut one)
  roundNoteGap: 20,      // min sim-seconds between throttled round-beat chronicle notes per arc
  sweepSecs: 4,          // self-throttle for sagas.sweep() (matches the chronicle poll cadence)
  gazetteFreshSecs: 120, // a closed arc is "fresh" news for this long (matches the director-saga cooldown)
};

// --- SIGNALS: the narrative-signal catalog (docs/architecture/13 — the values probes read) -------
// Per-agent, bounded, event-folded values the observer layer measures. Tuning only; the store math
// lives in js/sim/signals.ts. Orderings, not measurements — fast half-life ~Gazette cadence, slow ~5×.
export const SIGNALS = {
  goldHalfFast: 120,     // fast gold EWMA half-life (sim-s) — ~the Gazette cadence (recent fortunes)
  goldHalfSlow: 600,     // slow gold EWMA half-life — ~5× the fast (the long baseline)
  lossRing: 8,           // bounded ring of recent downward gold steps (tagged robbed/spent/gifted/fined)
  lossMin: 1,            // a gold step smaller than this is noise — not ringed
  snubHalfLife: 90,      // snubsFelt decays toward 0 with this half-life (a cold shoulder fades;
                         //   shortened for the 50-belief social bandwidth — more mouths, faster fade)
  snubCap: 40,           // ceiling on the felt-snub counter (readable magnitude, not an unbounded tally)
  // GOSSIP-ABOUT-SELF snub (docs/architecture/13 §3 snubsFelt): when an agent overhears a chatting
  // neighbour HOLDING a negative opinion of IT (soured standing and/or raised suspicion), that is a
  // PERCEIVED cold shoulder ("they speak ill of me") — own-state evidence that feeds the snub counter.
  // At most ONE snub per gossip-ingest pass (the `break` already bounds it to one partner/tick).
  snubGossipStanding: -0.2,  // a teller's standing toward me at/below this counts as ill-spoken
  snubGossipSuspicion: 0.3,  // …or a teller's suspicion of me at/above this (a whispered doubt)
  scarcityHalf: 1200,    // long-run price EWMA half-life per good (the scarcity baseline)
  grievanceMax: 64,      // LRU cap on the sparse pairwise grievance map (rule 5 — never an N² matrix)
  grievanceMinRounds: 3, // a grievance with at least this many blows is "a feud" (escalation/one-sidedness read)
  // SECOND SLICE (the catalog tail) — orderings, not measurements; the harness takes the numbers.
  standHalfFast: 120,    // fast roster-mean-standing EWMA half-life (sim-s) — Fall-from-Grace's social half
  standHalfSlow: 600,    // slow standing EWMA half-life (~5× the fast — the long social baseline)
  reversalGate: 15,      // a (goldFast−goldSlow) sign flip counts as a fortuneReversal only past this gap
  dispHalf: 300,         // displacement EWMA half-life — distance from the believed home/bed (the wanderer)
  poorBand: 8,           // gold at/below this is the POVERTY band (timeInBand: "the long winter")
  richBand: 120,         // gold at/above this is the WEALTH band
  outlawBand: 0.3,       // notoriety at/above this is the OUTLAW band
  presumedDeadConf: 0.05,// a belief whose confidence decayed to/below this reads as "presumed gone" (Family C)
  quietMax: 256,         // bound on the per-subject last-beat map (quietIndex — the forgotten man)
  witnessMax: 12,        // cap on the witness ids retained per dramatic event (witnessSet — casting)
  witnessRing: 32,       // cap on the witness-set ring (how many recent events keep a witness list)
  triangleArcCap: 64,    // bound on open arcs scanned for shared-third-party collision hints (Family B)
};

// --- STATUS: the status-delta / failure sensor (docs/architecture/12 §5 — fall-from-grace) --------
// The omniscient observer probe's thresholds. Reads TREND EWMAs (not a running max), requires an
// INVOLUNTARY cause for ruin (spending is not ruin), and clears its flags past a recover band
// (hysteresis) so fall–recover–fall can fire more than once. Tuning only; logic in statusSensor.ts.
export const STATUS = {
  passSecs: 6,           // self-throttle for the observer pass (sim-s); not every tick
  ruinFrac: 0.85,        // RUIN when goldFast <= goldSlow * this (a FAST fall below the baseline)
  involuntaryFrac: 0.5,  // …AND the involuntary (robbed/fined) share of recent losses is >= this
  lossWindow: 300,       // the window (sim-s) over which the involuntary loss share is measured
  shunStanding: -0.35,   // SHUNNED beat when the true roster mean opinion crosses below this
  snubThreshold: 3,      // the `slandered` MEMORY fires only once snubsFelt reaches this (perceivable)
  retireSurcharge: 4,    // RETIRE when feltSurcharge('burgle') crosses this (a burned-out thief)
  recoverFracGold: 0.95, // ruin clears when goldFast recovers past this fraction of the (relaxed) baseline
  recoverFracThresh: 0.6,// shun/slander/retire flags clear when pulled back across this fraction of the bar
  minGoldHigh: 20,       // ignore ruin below this baseline (a pauper who was always poor isn't "ruined")
};

// --- WEALTH: the believed-wealth cue bridge + recognition channel (docs/architecture/12 §6) -------
// The town can esteem someone FOR being rich — a belief (never ground truth), written by a visible
// cue in perception, read in cognition to nudge esteem. Gated per-disposition (deference vs envy).
export const ESTEEM = {
  sightWeight: 0.2,      // per-sighting weight the visible prosperity cue firms the belief by
  recognizeMin: 0.45,    // believedWealth·wealthConf above which the recognition channel engages
  deferWarm: 0.03,       // per-tick standing WARM the deferential give a believed-rich, non-suspect local
  envyCool: 0.025,       // per-tick standing COOL the envious give the believed-rich (the envious mirror)
  suspectGate: 0.4,      // a believed-suspect local earns no deference (suspicion above this blocks it)
};

// --- RAGS: the rags-to-riches arc (docs/architecture/12 §3.5 / §6) --------------------------------
// Opens on a real wealth climb; closes 'celebrated' on DEFERENCE MASS (count of perceivers warmed
// past a bar) — NOT net mean standing, which the §6 envy mirror could hold below threshold forever.
export const RAGS = {
  openGold: 120,         // goldSlow crossing this (a real climb, not a windfall flicker) opens the arc
  deferBar: 0.25,        // a perceiver counts toward deference mass when its standing toward a exceeds this
  celebrateMass: 4,      // that many warmed perceivers ⇒ the climb is socially recognised → 'celebrated'
};

// --- ROMANCE: the Star-Crossed enactment (docs/architecture/12 §8) -------------------------------
// `_courtingId` (set by the romance trope / the authoring API) was narrated but never enacted; this
// makes the lovers SEEK each other (a watchable courtship) so the union/heartbreak is earned. Tuning.
export const ROMANCE = {
  weight: 1.4,           // the utility weight of the court candidate (a strong social pull, below survival)
  courtGap: 2.5,         // the stand-off distance the lovers linger at (closer = HOLD, no jostling)
  courtWarm: 0.02,       // per-tick standing WARM from lingering beside the believed sweetheart
};

// --- OUTLAW: NPC infamy + the pro-outlaw warming hook (docs/architecture/12 §9) -------------------
// An NPC robber accrues a town-read `notoriety` (generalised from player-only); the desperate warm to
// a robber-of-the-rich (the Robin Hood mirror, FOUR conjuncts — review 5). Tuning only.
export const OUTLAW = {
  warmRisk: 0.6,         // a witness this bold or bolder may admire a robbery (conjunct: larcenous/bold)
  warmAltru: 0.4,        // …and this uncaring or less (low altruism)
  warmPoorGold: 30,      // …and this poor or poorer (the desperate make folk heroes)
  warmAllyBar: 0.2,      // …and NOT allied to the victim (standing toward victim at/below this)
  warmVictimWealth: 0.4, // …and believes the victim WEALTHY (robs the rich — needs §6 believedWealth)
  warmth: 0.3,           // the standing WARM a qualifying witness gives the bold robber
  dreadAt: 0.45,         // notoriety crossing this opens the `outlaw` arc (a rising infamy)
  legendAt: 0.85,        // notoriety crossing this closes it 'celebrated' (an outlaw legend)
};

// --- CAUTION: outcome-conditioned caution (docs/architecture/11-outcome-conditioned-caution-lld) ---
// The burned-hand half of regret: a per-agent, per-STRATEGY signed surcharge — written when a watched
// theft-shaped act's realized yield falls short of its believed yield, when the venture dies on the
// road (waste), or when it nearly kills you (peril); eroded by time and by genuine success — added to
// that strategy's `cost` the same way confidenceSurcharge is. NATURE stays fixed (never mutates
// personality); experience is nurture — a decaying, bounded, belief-shaped record decaying toward 0.
// ALWAYS-LIVE on the mainline: the caution field writes, feltSurcharge, and emits run.
// Every number is a STARTING POINT with a stated ORDERING (the harness tunes; this paragraph doesn't):
// partialCooldown(12) ≪ halfLife; |windfall| < burn.shortfall < burn.peril; cap ~ routeRisk(6).
export const CAUTION = {
  watched: ['burgle', 'rob', 'loot'],   // the three theft-shaped rows: a bet yield + a substitute row + a clean exec walk
  halfLife: 72,           // = 6·PLAN.partialCooldown(12): a goal is retried several times within one
                          //   strategy memory, and retirement arcs are observable in the ~150s eval window
  cap: 8,                 // |s| burn clamp — reads like one extra believed hostile on the route (routeRisk=6):
                          //   strongly dissuasive, NEVER infeasible (the no-timidity-lock guarantee, C8/C12)
  capDiscount: 2,         // = cap/4: emboldening (negative s) is real but shallow — keen, not invincible
  shortfallRatio: 0.5,    // realized < ratio·expected ⇒ shortfall; ratio·exp ≤ realized < exp ⇒ neutral (NO write); ≥ exp ⇒ windfall
  burn: { shortfall: 2.0, waste: 1.5, peril: 4.0 } as Record<string, number>,
  windfall: -0.75,        // |windfall| ≪ burns (loss-averse on purpose); diminishing in n
  luckDiscount: 0.7,      // attribution: burn *= (1 − plantimeConf · luckDiscount) — confident-and-wrong ⇒ small burn
  rtRelief: 0.6,          // felt = s · (1 − risk_tolerance · rtRelief), POSITIVE side only (the bold shrug)
  perilFear: 0.5,         // mood.fear at/above which a watched act in progress counts as peril (own-state signal)
  maxKeys: 12,            // bounded store (oldest-t evicted); sized for the qualified-key follow-up
};

// --- episodic memory (three-tier ring buffers) ------------------------------
// Salient life-events flow STM -> MTM -> LTM by consolidation; medium fades over
// minutes, long-term sticks. Feeds the inspector biography and (later) goals.
// See js/sim/memory.js.
export const MEMORY = {
  stm: 8, mtm: 16, ltm: 10,    // ring capacities: short / medium / long term
  minSalience: 0.25,           // below this an event isn't worth remembering at all
  consolidateEvery: 8,         // sim-seconds between consolidation passes
  mtmThreshold: 0.35,          // STM salience needed to consolidate into MTM
  ltmThreshold: 0.6,           // MTM salience needed to consolidate into LTM
  kindRepeatDamp: 0.6,         // salient(): a repeat of an already-picked episode KIND competes at
                               //   salience × this^n — keeps one life's formative set DIVERSE
                               //   (four "joined with X" rows was the whole median biography)
  mtmDecay: 0.006,             // salience lost per sim-second in medium term (a memory lasts ~minutes,
                               //   not the ~15s the old 0.02 gave — "medium term" should mean minutes)
  ltmDecay: 0.00025,           // long-term is FORMATIVE + sticky: the old 0.004 erased even a 0.8
                               //   memory in ~200s (every LTM episode read salience 0.00 in the life
                               //   trace), so "most salient memory" was meaningless. ~0.45 fade / 30min.
  dedupWindow: 8,              // s within which a repeat episode reinforces, not duplicates
};

// --- FACTION RELATIONS (data-driven pairwise hostility) ----------------------
// Phase-1 drama: the world is no longer a hardcoded town-vs-monster split. We
// stand up several true factions (see FACTIONS below) with DATA-DRIVEN enmity:
// FACTION_RELATIONS lists who each faction treats as an enemy at baseline (before
// reputation/standing). factionHostile(a,b) is the single lookup wired into both
// the combat-time predicate (simulation.isHostile) and the belief-time one
// (Agent.considerHostile), so cross-faction conflict is a config knob, not code.
//
// The relations are symmetric by construction (we union both directions in the
// lookup), so listing A->B is enough. `monster` is hostile to everyone (the old
// wild threat); the organized BANDIT camp and the RIVAL clan have specific feuds.
export const FACTION_RELATIONS = {
  monster:   ['townsfolk', 'outsider', 'wilds', 'bandit', 'rival'],
  bandit:    ['townsfolk', 'rival'],   // raiders: prey on the town, feud the rival clan
  rival:     ['townsfolk'],            // a rival settlement that clashes with the town
  // townsfolk / outsider / wilds list no baseline enemies — they are dragged into
  // conflict only by the factions above (or, for the player-outsider, reputation).
};

// Baseline hostility between true factions (before reputation/standing). Looks up
// FACTION_RELATIONS in BOTH directions so the table only needs one entry per feud.
// Same faction is never self-hostile. Guarded: an unknown faction is simply at
// peace (never throws), so a new/typo'd faction can't freeze the fixed tick.
export function factionHostile(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b || !a || !b) return false;
  const rels: Record<string, string[]> = FACTION_RELATIONS;
  const ra = rels[a];
  if (ra && ra.indexOf(b) !== -1) return true;
  const rb = rels[b];
  if (rb && rb.indexOf(a) !== -1) return true;
  return false;
}

// Monster threat that lurks in the wilds and attacks the village/player.
// leashR: a TERRITORIAL predator won't pursue a foe further than this from its home
// ground (its lair / camp anchor) — so frontier threats stay on the frontier and
// menace only townsfolk who venture out, rather than chasing a victim into the
// village and razing it. Director RAIDERS have no home/leash (they DO assault the
// town) but withdraw on a TTL. This leash is the structural anti-massacre guarantee.
export const MONSTER = { count: 0, model: 'barbarian', faction: 'monster', name: 'Bandit', threat: 1.1, leashR: 50 };  // PEACEFUL SIM: no monster spawns (progression-without-combat experiment)

// THE AVENGER — the player's deeds make lasting ENEMIES. When the player MURDERS a
// townsperson, the most capable of the slain's kin becomes a persistent personal
// nemesis who hunts the player down (where a normal grudge would just decay). This is
// the player woven INTO the drama as a subject, not a spectator.
export const AVENGER = {
  enabled: true,
  max: 3,            // cap concurrent avengers hunting the player — a spree won't swarm them
  ttl: 240,          // sim-seconds an avenger hunts before the thirst fades unslaked
};

// THE LEGEND — the player's cumulative REPUTATION as a force the world reads. Witnessed
// deeds build it (murdering townsfolk → NOTORIETY; slaying threats → FAME); it fades
// slowly if you stop. Crucially WITNESS-GATED (the epistemic split: a murder no one sees
// builds no legend — you can kill in secret). The town REACTS: a known butcher empties
// the street before them. This is the player as a node the whole town forms a belief about.
export const LEGEND = {
  enabled: true,
  perMurder: 0.34,    // notoriety per WITNESSED townsfolk murder (~2 → villain, ~3 → infamous)
  perHeroic: 0.2,     // fame per WITNESSED slaying of a monster/threat (~4 → a hero)
  decayPerTick: 0.985, // legend fades when you stop (applied per ~6s director roll → half-life ~5 min: infamy lingers, but a reformed villain is eventually forgotten)
  dreadAt: 0.33,      // notoriety → "a dangerous sort, best given a wide berth"
  villainAt: 0.66,    // notoriety → "a villain of the realm"
  heroAt: 0.66,       // fame → "a hero of the realm"
  fearRisk: 0.42,     // only townsfolk below this risk_tolerance recoil from a butcher
  fearRange: 9,       // and only within this range (a bubble of unease, not a panic)
};

// THE PROTÉGÉ — the active payoff of FAME (notoriety makes the timid flee; fame INSPIRES).
// A green youth, dazzled by a famous player's deeds, attaches as a student — follows,
// fights at their side, and GROWS, eventually coming into their own as a hero in the
// player's footsteps. The player's legend literally seeds the next generation of heroes.
export const PROTEGE = {
  enabled: true,
  fameAt: 0.5,        // player fame at which an admiring youth is moved to follow
  maxLevel: 6,        // only the GREEN (low-level) idolise a famous hero this way
  graduateSecs: 160,  // shadow the hero this long (and survive) → they come into their own
  xpPerTick: 0.12,    // accelerated learning at a hero's side (narrative xp per director roll)
};

// THE GRATEFUL — the warm MIRROR of the Avenger. When the player SAVES a townsperson's
// life (slaying the threat right beside them), that soul becomes a loyal GUARDIAN who
// shadows and defends the player for a time, then parts with thanks. The player's GOOD
// deeds make lasting friends, just as murder makes lasting enemies.
export const GRATEFUL = {
  enabled: true,
  max: 2,            // cap concurrent grateful guardians — don't drown the player in escorts
  ttl: 150,          // sim-seconds a guardian shadows the player before a grateful farewell
  rescueRadius: 6,   // how close the imperilled townsperson must be to the slain threat
  gift: 6,           // a parting token of thanks (a gold TRANSFER from their purse, no mint)
};

// --- ORGANIZED FACTION CAMPS (bandit camp + rival clan) ----------------------
// Beyond the wandering monster threat, the world seeds two organized factions at
// their own camps on the frontier: an aggressive BANDIT camp (a leader + a few
// followers with raid-oriented goals the Director can trigger) and a RIVAL clan
// (a smaller, less aggressive settlement that feuds with the town). Each spawns a
// LEADER (slightly tougher, holds the camp's raid orders) plus FOLLOWERS. They
// start FAR from the town core (ring fraction of ARENA_RADIUS) so cross-faction
// enmity ESCALATES over the run instead of instantly massacring the town — the
// anti-massacre pacing the soak's townMin>0 invariant depends on. Combatants
// carry no economy (profession null) — the freeze lesson: the work/trade paths
// guard on that, so an unguarded economy access can't throw on the fixed tick.
export const CAMPS = {
  bandit: {
    faction: 'bandit', model: 'barbarian', name: 'Bandit',
    leaderName: 'Bandit Chief',
    leaders: 0, followers: 0,       // PEACEFUL SIM: no bandit camp spawns (target=0 ⇒ no reinforcement, no spies)
    threat: 1.05, leaderThreat: 1.25,
    ringMin: 0.70, ringMax: 0.88,   // camp distance from town centre (× ARENA_RADIUS)
    scatter: 5,                     // followers scatter this far around the leader
    patrolR: 20,                    // members PATROL within this of the camp anchor when
                                    //   idle — a frontier LAIR, not a mob that roams the
                                    //   village (so they only menace townsfolk who venture
                                    //   to the frontier, like the monsters do)
    reinforceEvery: 35,             // sim-seconds between rank top-ups (keeps the faction
                                    //   alive vs monster/rival attrition; reinforcements are
                                    //   gold-neutral so they never mint money)
    reinforceMax: 1,                // at most this many replacements per top-up (gradual)
    leashR: 50,                     // won't chase a foe further than this from the anchor
    // raid orders the Director (sibling subsystem) may flip on: when raiding, the
    // camp's members treat the town as a target and advance. Pure data — the
    // bandit camp degrades to "lurk near camp" if no Director ever triggers it.
    raidActive: false,
  },
  rival: {
    faction: 'rival', model: 'knight', name: 'Clansman',
    leaderName: 'Clan Elder',
    leaders: 0, followers: 0,       // PEACEFUL SIM: no rival clan camp spawns
    threat: 0.95, leaderThreat: 1.15,
    ringMin: 0.72, ringMax: 0.90,
    scatter: 5,
    patrolR: 20,
    reinforceEvery: 35,
    reinforceMax: 1,
    leashR: 50,
    raidActive: false,
  },
};

// --- party (companions the player recruits) ---------------------------------
// Recruited townsfolk follow the leader in a loose ring and fight whatever the
// player fights. Recruitment is gated on the NPC actually liking you (standing).
export const PARTY = {
  maxSize: 4,
  recruitStanding: 0.3,     // min standing toward the player to agree to join
  spacing: 2.4,             // follow-ring radius around the leader
  catchUpDist: 7,           // beyond this a companion runs to keep up
  teleportDist: 90,         // snap a hopelessly-lost companion to the leader
};

// --- STEER: the potential-field locomotion primitive (Phase 2b) -------------
// One executor (js/sim/agent/steer.js) drives ALL locomotion-shaped behaviours
// from a weighted force field: attractors pull, repulsors push, the agent steps
// along the normalised weighted sum. Each "behaviour" is a steer-FILL — a pure
// (agent, ctx) -> { attractors[], repulsors[], speed } built from the agent's OWN
// beliefs + mental map + own state (NEVER the roster), so it is belief-gated by
// construction. The field reuses goTo's exact stepping body (_stepAlong), so the
// feel — speeds, arrival radius, barrier-deflection, terrain slow, arena clamp,
// wall collision, grounding — is byte-identical to the old goTo/fleeFrom path.
//
// Speeds reuse SIM.moveSpeed/runSpeed; arrival reuses SIM.arriveDist; the stand-off
// gaps reuse SOCIAL.shadowGap / ECON.marketRange directly (NOT duplicated here — a
// duplicate could drift). This block owns fleeAway (was the literal `6` in fleeFrom)
// and the road-pull trio below. The force WEIGHTS are dimensionless ratios; every fill
// in the 2b pass was single-force (a strict XOR refuge-OR-threat, matching the old
// code, NOT the simultaneous refuge+threat field the doc sketches), and the ROAD blend
// is the first feature to exercise steer()'s weighted-sum path: a second, weaker
// attractor toward the trade road on long caravan/arbitrage/expedition legs.
export const STEER = {
  wAttract: 1.0,   // default attractor weight (single-attractor fills)
  wThreat:  1.0,   // repulsor weight in the flee/avoid away-branch
  fleeAway: 6,     // synthetic away-target distance (was the literal 6 in fleeFrom)
  // ROADS (legible travel arteries, js/sim/roads.js): the LONG-RANGE fills (caravan /
  // arbitrage / expedition) blend a SECOND, milder attractor toward the nearest
  // trade-road point — the first live use of steer()'s weighted-sum substrate.
  // wRoad stays WELL below wAttract so the true target remains the PRIMARY attractor
  // (facing/arrival unchanged) and travellers cut corners near both route ends
  // instead of zigzagging onto the road — a preference, never a constraint.
  wRoad: 0.55,        // road-pull weight (dimensionless, vs wAttract's 1.0)
  roadSnapDist: 25,   // only a road within this lateral reach pulls (off-route legs stay straight)
  roadMinDist: 40,    // only a LONG leg road-snaps; local hops walk straight at the target
  roadAhead: 16,      // bias the road point this far AHEAD along the segment toward the
                      //   destination — the pull always has a forward component (no backtrack,
                      //   no oscillation around the centreline)
};

// --- HAUNTS & DAILY RHYTHM (legible place + time, steer-only, own-state) ------
// Two GENTLE locomotion biases that make idle agents recognisable by WHERE and WHEN —
// without touching any candidate score (S2 parity-safe). Both are own-state reads only
// (the agent's own _haunt point + its own deterministic diurnal phase + ctx.time), folded
// into the WANDER steer-fill as a SECOND, weaker attractor (the true wander target stays the
// PRIMARY attractor, like the ROAD blend), so an idle agent drifts back toward "its spot"
// instead of roaming uniformly — breaking the wander/market-dwell monoculture.
//
// HAUNT: the agent stamps _haunt (a favourite {x,z}) where it had a GOOD MOMENT — a windfall
// caution outcome or a positive goal closure (own-state, in act.js). The wander field then
// pulls gently back toward it. `pull` stays WELL below STEER.wAttract so the haunt only
// BIASES the roam (the random wander target remains primary): a preference, never a trap.
//
// RHYTHM: each agent gets a deterministic per-id diurnal PHASE (early-riser .. night-owl), so
// at its own "dusk" the haunt pull strengthens (×duskBoost) — some drift to-spot early, some
// late. ctx.time / dayLength gives the time-of-day; the per-id phase shifts each agent's dusk
// window. Gentle bias, never a behaviour gate (the agent still wanders, just leans homeward).
export const HAUNT = {
  pull:       0.35,   // base haunt attractor weight in the wander field (vs STEER.wAttract 1.0) — gentle
  duskBoost:  1.8,    // multiply `pull` during the agent's own dusk window (homeward-at-dusk lean)
  recordSal:  0.5,    // only a good moment at/above this salience stamps the haunt (avoid trivia)
  moveToward: 0.15,   // on a fresh good moment, ease the stored haunt this fraction toward the new spot
                      //   (a haunt drifts to where good things keep happening; 0 = first-spot-sticks)
  dayLength:  240,    // sim-seconds per in-world day (the diurnal clock period)
  duskWidth:  0.16,   // half-width of the dusk window as a fraction of the day (phase within this of its dusk centre → dusk)
  maxDist:    120,    // ignore a haunt farther than this from the agent (stale/cross-map) — no long treks
};

// --- NPC bands (parties as an AI abstraction beyond the player) --------------
// Townsfolk who like each other (mutual positive belief-standing, which emerges
// from chatting) and are near each other form small adventuring/mutual-defense
// bands. Members reuse the player-companion follow/defend AI, pointed at their
// own leader. See js/sim/groups.js.
export const BAND = {
  formEvery: 1.5,      // sim-seconds between group-formation attempts (sim-wide).
                       //   quicker cadence on the 2x map: more concurrent groups
                       //   keep TYPE diversity from collapsing to all-circle.
  formAttempts: 13,    // distinct anchors tried per formation tick (group volume).
                       //   raised for the 2x map: a 4x-larger area means each tick
                       //   samples a sparser slice, so more anchors keep group VOLUME
                       //   (and thus TYPE diversity) from thinning out. Bumped again
                       //   in Phase 3: terrain concealment (forest/low ground cuts
                       //   sight -> fewer belief pairs) thins formation a touch, so
                       //   more anchors restore reliable >=2 TYPE diversity.
  joinStanding: 0.28,  // mutual standing each must hold of the other to associate
  joinRange: 16,       // how close the two must be to form (modestly widened for the 2x
                       //   map; kept tight so anchors match genuinely-adjacent kindred
                       //   pairs -> reliable non-circle TYPE variety, not generic circles)
  affinityGain: 0.012, // standing gained per tick chatting peacefully with a neighbour
  affinityCap: 0.7,    // friendliness ceiling from familiarity alone
};

// --- sociability: who an agent SEEKS OUT when it chooses to socialise ---------
// The `socialize` goal is no longer a solo trip to the market — an agent walks to
// a believed-FRIEND and stands with them (belief-only: it heads for where it THINKS
// the friend is). Standing adjacent lets the per-tick gossip/affinity passes do the
// actual bonding, so friends who seek each other COMPOUND their familiarity into
// groups, courtship and lineage. Falls back to the market when no friend is known.
export const SOCIAL = {
  friendStanding: 0.15, // believed standing that marks someone a FRIEND worth seeking out
  knownConf: 0.12,      // min belief confidence to trust I still know where they are
  distancePenalty: 0.02,// per-metre discount when choosing among friends (favour near & dear)
  bondBonus: 0.03,      // EXTRA standing/sec for deliberately spending time together (vs incidental
                        //   proximity) — quality time bonds faster than just passing nearby
  shadowGap: 6,         // stand-off distance the `shadow` disposition (doubt-the-mask schema) trails a suspect at
  // SOFT AVOIDANCE — "cross the street" (docs/architecture/13 §3 snubsFelt). A merely-SUSPECTED,
  // soured-but-NOT-hostile nearby neighbour earns a faint, LOW-priority berth (a mild steer-away),
  // SHORT of fleeing — social discomfort, not panic. Reads ONLY my OWN belief (suspicion/standing/
  // hostile/lastPos). Gated bold (suspicion ABOVE the soft bar AND standing cool) and scored low so
  // it never out-pulls work/market/survival; the chronicle's "neighbours cross the street" made real.
  avoidSuspicion: 0.4,  // believed suspicion at/above this (but not hostile) earns a wide berth
  avoidStanding: 0,     // …AND a believed standing at/below this (a cool acquaintance, not a friend)
  avoidRange: 7,        // only a suspect I believe is THIS close unsettles me (a near-street berth)
  avoidWeight: 0.35,    // the soft-avoid candidate's score — low, so work/market/survival win
};

// ============================================================================
// PHASE-1 BUILDINGS — emergent private homes + one town tavern, walk-through
// benefit zones, paid in WOOD + the owner's own LABOUR time (gold never minted
// or burned). TUNE HERE, never in logic. (COMFORT/BUILD/SURVEYOR mirror the
// SIM/WEIGHT/BAND style — plain exports, order-independent.)
// ============================================================================

// --- COMFORT need (Phase-1 buildings demand pressure) -----------------------
// A 4th need: comfort. Drains over time like the others. An UNHOUSED agent's
// comfort is CLAMPED to `unhousedCap` each drain tick — that low ceiling is the
// standing demand that makes building a home worthwhile (a housed agent has no
// cap and can sit at 1.0). Restored at the agent's OWN home or at ANY tavern;
// a tavern ALSO tops up `social`. Drain rate is in the same 1/seconds units as
// SIM.hungerDrain / socialDrain.
export const COMFORT = {
  enabled: true,
  init: [0.4, 0.85],          // [min,max] starting comfort (rand, like other needs)
  drain: 1 / 110,             // comfort lost per sim-second (slower than hunger)
  unhousedCap: 0.65,          // an agent with no home can't exceed this comfort. Set ABOVE the
                              //   seek/urgent line (0.55) so an unhoused soul is no longer PERMANENTLY
                              //   comfort-urgent — it reaches contentment for ~11s windows where the
                              //   OTHER needs (novelty/social/work) get airtime. Home-building pressure
                              //   is preserved by raising BUILD.qualifyComfort in lockstep (still
                              //   chronically below it → still wants a home). Part of the need-decomposition:
                              //   comfort is one drive among several now, not a monopolising attractor.
  restoreRate: 1.2,           // comfort restored per sec at home / a tavern — fast enough that a
                              //   short visit actually tops the need up before the agent drifts off
                              //   to a market/social pull (else comfort limit-cycles around the cap)
  tavernSocialRate: 0.45,     // social ALSO restored per sec while at a tavern
  // BELIEVED-BEST comfort routing (decide.ts nearestComfortSource, the homeless path):
  // among the places an agent KNOWS OF (its own place-beliefs), the felt quality
  // (benefitFelt, stamped by experience in act.ts) competes with the kind's CULTURAL
  // PRIOR — everyone knows what a tavern is for; a shrine is solace only to its own
  // faithful — discounted by distance over `sourceRange` metres.
  kindPrior: { tavern: 1.0, shrine: 0.65 },
  sourceRange: 40,
  // the `comfort` decide candidate fires when comfort dips below this AND a
  // home/tavern is reachable; weighted by WEIGHT.comfort.
  seekBelow: 0.55,
  // hysteresis: an agent already AT its comfort source keeps restoring until
  // comfort reaches `satisfiedAt`, its pull multiplied by `dwellBoost` so a market
  // or social urge can't yank it away half-comfortable (the cap limit-cycle fix).
  // `seekBoost` keeps it committed to the trip HOME once chosen (so a mid-walk market
  // pull can't divert it), and is what makes a low-comfort agent reliably reach home.
  satisfiedAt: 0.85,
  seekBoost: 3.0,
  dwellBoost: 5.0,
  // comfort emergency: below `urgentBelow` the pull is multiplied by `urgentBoost`
  // so a desperately-uncomfortable agent goes home over a routine market/plan haul
  // (the same survival-before-commerce idea as the hunger `eatUrgent` gate). Set at
  // the seek threshold so the urgency holds for the WHOLE trip home — the agent isn't
  // diverted by a market pull the moment comfort ticks back above a low boundary.
  urgentBelow: 0.55,
  urgentBoost: 2.5,
};

// NOVELTY — a distinct need in the decomposed need-space (the monolithic "comfort"
// is now one drive among several). Boredom builds over time; a curious soul relieves
// it by taking in a fresh sight (sightsee) or roving to new places. This is what
// gives leisure VARIETY a real motive — purposeful outings driven by a need, not a
// weak also-ran candidate. Restored by visiting a landmark; scaled by curiosity in
// decide. Sibling needs to add next in this same shape: SAFETY (security near the
// Watch/town vs the frontier), and finer splits of comfort (coziness vs satiety).
export const NOVELTY = {
  enabled: true,
  init: [0.5, 0.9],           // [min,max] starting novelty (rand, like the other needs)
  restore: 1.1,               // novelty restored per sec while taking in a fresh sight
  seekBelow: 0.5,             // bored below this → a curious soul seeks a new sight (sightsee)
  satisfiedAt: 0.9,           // a good outing tops boredom right up
};

// --- BUILD: private home commissioning + the multi-tick construction process -
// A qualifying townsperson commissions a HOME (private capital) paid in WOOD +
// its OWN labour time. No gold is minted/burned: wood is consumed (a renewable
// commodity), and if the owner is short it BUYS wood at market (gold MOVES to a
// seller — the existing closed loop). `woodNeeded` units are reserved and
// consumed as progress accrues; `progressPerSec` accrues only while the owner is
// standing on the plot. On completion the home becomes a comfort source.
export const BUILD = {
  enabled: true,
  // --- qualify gate (the ROI-style demand test, read in decide.js) ---
  qualifyComfort: 0.65,       // owner's comfort must be chronically AT/BELOW this to want a home.
                              //   Raised in lockstep with COMFORT.unhousedCap (0.65) so an unhoused
                              //   soul — which oscillates 0.55..0.65 — is still chronically below it and
                              //   still wants a home: leisure variety is unblocked WITHOUT losing the
                              //   building-pressure demand signal.
  qualifyComfortStreak: 18,   // …for this many sim-seconds continuously (chronic, not a blip)
  wealthGate: 60,             // …and hold at least this much surplus gold (a wealth gate, no spend)
  woodNeeded: 8,              // WOOD units a home costs (reserved+consumed over the build)
  woodBuyChunk: 2,            // when short on the plot, buy up to this many wood/tick at market
  progressPerSec: 0.06,       // build progress (0..1) accrued per sec standing on the plot
  staminaPerSec: 0.04,        // energy drained per sec of building (labour cost; guarded)
  toolWearPerSec: 0.02,       // tool wear per sec building (ties tooling to construction)
  maxConcurrentPerTown: 3,    // cap simultaneous private build sites per town (paces the town)
  commissionCooldown: 40,     // sim-seconds an owner waits after a failed/aborted commission
  abandonAfter: 220,          // abort a site with no progress for this long (owner gives up)
  tavernTownLabor: 0.5,       // public-tavern ambient town-labour accrual factor (× progressPerSec)
  // TRUTH-SIDE DISPLACEMENT BACKSTOP (Phase 2a): when a home is razed while the owner is
  // away, the owner won't PERSONALLY re-commission until he DISCOVERS the ruin by sight
  // (his cognition gates his own build). So housing stock could decay if he never returns.
  // After this grace window (sim-seconds) with the owner still unhoused (truth: no building
  // carries his ownerId), the TOWN re-commissions the rebuild on his behalf via the public
  // town-labour path. Truth-side (reads ground-truth building presence, never beliefs).
  rebuildGraceTicks: 120,
  // benefit a finished home confers (comfort source; homes are not social hubs)
  homeBenefit: { comfort: 1.0, social: 0.0 },
};

// --- SURVEYOR: town plot allocation + public-tavern commissioning ------------
// A town official (sibling of Patrician/Watch). PURE-MATH plot allocation along
// lanes radiating from each TOWNS.centers core: the next free slot facing the
// street, inside the town radius, outside the central plaza, non-overlapping
// with existing plots/POIs. ALSO commissions ONE tavern per town from a town
// "fund" (a virtual labour pool — NOT gold) when none exists and pop is high.
export const SURVEYOR = {
  enabled: true,
  tickEvery: 5,               // sim-seconds between survey passes (self-throttled)
  lanes: 6,                   // streets radiating from the core (plot rows)
  plazaR: 10,                 // min radius from the core (keep the central plaza clear)
  laneInnerR: 14,             // first plot sits at least this far out (just past the plaza/walls)
  laneStep: 7,                // radial spacing between successive plots on a lane
  plotClear: 4.5,             // min centre-to-centre clearance vs other plots AND world POIs
  maxPlotR: 60,               // don't allocate plots beyond this radius (inside the home band)
  // --- public tavern ---
  tavernEnabled: true,
  tavernMinPop: 14,           // only commission a tavern once the town holds this many townsfolk
  tavernWood: 14,             // WOOD a tavern costs (drawn from the town fund, built by townsfolk)
  tavernBenefit: { comfort: 1.0, social: 1.0 },  // a tavern restores comfort AND social
  tavernWealth: 2,            // cosmetic wealth tier passed to buildingGen (a grander build)
  // --- public granary (the town larder — see GRANARY for the stock/draw tuning) ---
  granaryEnabled: true,
  granaryMinPop: 10,          // commission the town larder once the town holds this many townsfolk
  granaryWood: 10,            // WOOD a granary costs (the same town fund — wood + labour, never gold)
  granaryWealth: 1,           // cosmetic wealth tier (a plain civic store, not a grand hall)
  // --- the SHRINE: a congregation's civic work (one per town, names its god) ---
  shrineEnabled: true,
  shrineMinFlock: 8,          // the town's DOMINANT god needs this many local faithful to raise one
  shrineWood: 8,              // a modest build — a spire, not a hall
  shrineWealth: 2,            // but finely made (cosmetic tier for buildingGen)
  shrineBenefit: { comfort: 0.7, social: 0.4 },  // a quiet place of solace (below the tavern's pull)
};

// --- city tile grid (Z-levelled) --------------------------------------------
// When a population founds a city it drops a CityGrid (js/world/cityGrid.js): a local
// discrete tile fabric with a road lattice, on which buildings claim a footprint + a
// vertical span of LEVELS (storeys up / cellars down). The sim lives on level 0; the
// levels are a building's height (and, below ground, the dungeon-style undercity).
export const CITY = {
  enabled: true,
  tile: 4,            // metres per tile (≈ corridor/house-module width; ~dungeon tile)
  gridTiles: 16,      // tiles per side (16×4 = 64 m core grid, centred on the city anchor)
  block: 4,           // road lattice period — a street every 4th line, 3-wide blocks between
  levelHeight: 3,     // metres per Z-level (one storey)
  minLevel: -2,       // how deep a city may dig (undercity / cellars)
  maxLevel: 4,        // how high it may build (5 storeys: level 0..4)
  // THE TOWN PLAN (zones, js/world/cityGrid.ts zoneOf): a central PLAZA kept permanently
  // open (no plot may take a plaza tile — the square the town gathers on), a CIVIC band
  // fronting it (tavern/granary/guildhall/shrine prefer it: the heart of town reads as a
  // square ringed by its institutions), HOMES beyond. Distances in TILES (Chebyshev).
  zone: {
    plazaR: 2,        // plaza half-width — a ~5×5-tile open square at the town heart
    civicDepth: 3,    // the civic band extends this many tiles past the plaza edge
  },
  // SETTLEMENT GROWTH + DENSIFICATION (js/world/cityGrid.ts grow/zoneFreeFrac): when a
  // claim fails the grid grows a block-ring per side (the town expands outward, world
  // positions preserved) up to maxTiles; when the residential band runs TIGHT first,
  // new homes rise an extra storey instead of sprawling — density before sprawl.
  growth: {
    enabled: true,
    maxTiles: 32,     // growth cap, tiles per side (16 -> 24 -> 32: the town quadruples)
    denseBelow: 0.35, // homes-zone free fraction below which new homes build UP (+1 storey)
    homeMaxLevels: 3, // a dense town's homes cap at three storeys
  },
  // building COMPONENTS — a building is a sparse map of (tx,ty,level)→part (wall/floor/
  // roof/door), each with hp + material, so raids can knock it down piece by piece and
  // fire can spread. Tuning for that destruction model (js/world/buildingParts.js).
  part: {
    woodHp: 30,        // a wood component's integrity
    stoneHp: 80,       // stone is far tougher (and won't burn)
    fireIgnite: 0.55,  // chance a torch sets a flammable part alight
    firePerSec: 9,     // hp a burning part loses per second
    fireSpread: 0.7,   // per-second chance fire jumps to an adjacent flammable part
    shelterMin: 0.55,  // wall+roof fraction a building needs to still shelter (give benefit)
  },
  // building-footprint COLLISION — OFF by default. When enabled, a footprint tile
  // reads solid in agent movement (axis-separated slide, like dungeon/town walls).
  // Ships false so streets/buildings stay passable and the 12k-frame soak is stable;
  // a later opt-in pass threads the grid into goTo (see js/sim/agent/movement.js).
  collide: false,
  // FOOTPRINT (in TILES) + STOREYS the construction system derives per build kind.
  // A home is ~1×1, a tavern ~2×2..3×3; storeys scale with wealth. Tuning lives here.
  foot: {
    homeW: 1, homeD: 1,           // a private home: a single tile footprint
    tavernW: 2, tavernD: 2,       // the town tavern: a 2×2 (occasionally 3-wide) block
    tavernLevels: 2,              // the tavern rises two storeys
    granaryW: 2, granaryD: 1,     // the town granary: a long low store
    granaryLevels: 1,             // a single storey (a barn, not a hall)
    hallW: 2, hallD: 2,           // a fellowship's guildhall: a 2×2 block like the tavern
    hallLevels: 2,                // …and it too rises two storeys (a place of standing)
    shrineW: 1, shrineD: 1,       // a god's shrine: a single tile…
    shrineLevels: 2,              // …rising two storeys (a spire over the civic band)
  },
  // RAID damage tuning — how a raider near a building takes its component shell apart.
  raid: {
    reach: 6,            // metres a raider must be within a building to strike it (~1.5 tiles)
    strikeChance: 1.2,   // per-second chance an adjacent raider batters a wall
    strikeDmg: 14,       // hp a strike removes from the nearest wall/door part
    torchChance: 0.25,   // per-second chance an adjacent raider hurls a torch
  },
  // EMERGENT FOUNDING — a persistent dense cluster of townsfolk far from any city
  // founds a new town. Bounded + self-throttled; ships DISABLED so it never
  // destabilises the soak. Tuning lives here (cities.js reads only CITY.found.*).
  found: {
    enabled: false,      // OFF by default — opt-in once proven safe
    checkEvery: 30,      // sim-seconds between founding scans (self-throttle)
    persistSecs: 120,    // a cluster must hold this long before it founds a town
    minCluster: 8,       // …with at least this many bodies
    minDist: 120,        // …and sit at least this far from every existing town centre
    maxCities: 6,        // hard cap on total towns (can never run away)
  },
};

// Social-group TYPES. `cohesion:'travel'` groups physically follow a leader and
// reuse the player-companion follow/defend AI (combatant ones fight, others flee
// together). `cohesion:'loose'` groups are affiliations — members don't follow,
// but cluster (socialise) and read as allies. Which type a pair forms is decided
// in js/sim/groups.js from their ambitions, professions and temperament.
export const GROUP_TYPES = {
  warband: { label: 'warband', cohesion: 'travel', combatant: true,  maxFollowers: 2 },
  hearth:  { label: 'hearth',  cohesion: 'travel', combatant: false, maxFollowers: 2 },
  // `pull` (Phase B2): how hard LOOSE membership tilts a member toward the group's LIFE —
  // a guild's work candidate (the shared craft IS the bond), a circle's socialise candidate
  // (gathering on the believed anchor). Read in decide's loose-group block; tune here.
  guild:   { label: 'guild',   cohesion: 'loose',  combatant: false, maxFollowers: 3, pull: 1.5 },
  circle:  { label: 'circle',  cohesion: 'loose',  combatant: false, maxFollowers: 3, pull: 2.2 },
};

// --- THE GUILDHALL: a named fellowship gets a PLACE ---------------------------
// An enduring, funded LOOSE group (guild/circle) commissions a HALL near the town
// core (groups.js, the execution side) via the same public-works machinery the
// tavern uses. On completion every member is stamped `groupHallId` and the loose-
// group socialise pull converges on the HALL (a fixed point) instead of the
// anchor's wandering person — which is what should RAISE the groupCohesion metric
// (signals.ts): members now share one spot. Tune here, never in logic.
export const HALL = {
  minMembers: 3,      // anchor + followers a loose group must hold to deserve a hall
  minAgeSecs: 90,     // …and have ENDURED this long since formation (stamped at first join)
  woodCost: 6,        // WOOD the anchor banks into the site (a real inventory — conserved)
  benefit: { comfort: 0.0, social: 1.0 },  // a hall is a social hub, not a bedroom
};

// --- group cohesion (Phase B2 metric reference) ------------------------------
// The truth-side groupCohesion(sim) observer (signals.ts) scores each group 0..1 by
// clamp01(1 - meanPairwiseDist/refDist) × coActFrac — tight clusters acting alike read high.
export const COHESION = {
  refDist: 18,     // metres at/beyond which a group's spatial cohesion reads 0
};

// --- starvation --------------------------------------------------------------
// Hunger is LETHAL: once a townsperson's hunger has sat empty for graceSecs its health
// drains until it eats or dies (Agent.drainNeeds). Townsfolk only — monsters/bandits keep
// no economy (the freeze lesson) and a lethal stomach would passively wipe their ecology.
// A starvation death takes the same alive=false path as an expedition loss; the corpse
// reaper files the chronicle beat and escheats the purse (gold stays conserved).
export const STARVE = {
  graceSecs: 60,       // seconds at empty hunger before health starts to drain (covers the walk home)
  healthPerSec: 2.0,   // health lost per starving second (~a minute from full health)
};

// --- alms (begging + charity) --------------------------------------------------
// The DESTITUTE channel starvation left open: a pauper (no food, no coin, hungry) BEGS at the
// market — a visible act (resolver.solicitAlms writes a plea into bystanders' perceivable
// `_pleas` mailbox, the recruiter-offer Inform pattern) — and a bystander DECIDES for itself
// off its OWN personality (altruism) or kinship + its own surplus, paying via the conserved
// repay plan (goto->pay; the receiver's succour hook fires, so gratitude emerges). Altruism
// becomes LEGIBLE behaviour: the kind feed beggars, the uncaring walk past.
// --- subsistence (the goalSate live trigger) -----------------------------------
// Hunger POSED to the planner as a goal (features/subsistence): the planner then chooses by
// cost between buying (has coin) and FORAGING at a field (capital-free gather — raw goods need
// no profession). The survival route the role-gated/destitute were missing.
export const SUBSIST = {
  priority: 0.85,    // survival-grade stack priority (above ambition 0.45, below avenge 0.9)
  sateTo: 0.7,       // plan until hunger is restored to this level
  ttl: 60,           // goal expiry (refreshed while the want persists)
};

// --- granary (the public larder) -----------------------------------------------
// The town's CIVIC answer to starvation, one rung above begging on the survival ladder. The
// Surveyor commissions ONE granary per grown town (SURVEYOR.granary*); a tithe IN KIND stocks
// it — a fraction of every FOOD unit cleared at that town's market goes into the larder
// (market.ts; food is produced/consumed, not a conserved quantity like gold, so the tax mints
// nothing) — and a destitute hungry soul DRAWS one meal from it (resolver.granaryDraw,
// co-location-gated like deliverTo). Begging is for when the larder is bare too.
export const GRANARY = {
  titheFrac: 0.15,   // food units tithed into the town granary per cleared market unit
  titheRange: 80,    // metres from the granary a clearing buyer must be (its town's market)
  stockCap: 12,      // the larder holds at most this much food — a buffer, NOT a hoard (a high
                     //   cap kept taxing long after need was met, lifting meals out of circulation)
  drawMeal: 1,       // food units a destitute draws per visit
  drawRange: 3.4,    // metres from the granary a draw lands (co-location, ~talkRange)
  drawEvery: 2,      // seconds between draw attempts while standing at the larder (throttle)
  drawBump: 0.05,    // candidate rank above the beg score (the civic answer wins the tie)
  urgentWeight: 1.6, // STARVING (hunger < ECON.nibbleBelow): the larder is the emergency room —
                     //   pitched over WEIGHT.plan (1.3) so a cross-map forage plan can't march a
                     //   dying pauper past the town larder (the seed-31 probe found exactly that:
                     //   21 destitute starved ~83m from town while the larders sat stocked),
                     //   and under the danger/flee tier (survival from violence still wins)
  emptyMemory: 45,   // sim-seconds an agent remembers finding the larder bare (beg wins meanwhile)
};

export const ALMS = {
  begWeight: 0.8,          // beg scale: maxes ~1.2, UNDER WEIGHT.plan 1.3 — begging is the LAST resort, claimed only when the planner found no forage/buy route (no plan candidate to lose to)
  almsRange: 9,            // metres a plea carries from the beggar
  solicitEvery: 3,         // seconds between a beggar's solicitations (throttle)
  pleaTtl: 20,             // seconds a perceived plea stays fresh in a bystander's mailbox
  pleaCap: 4,              // bounded mailbox: oldest plea dropped beyond this
  donorAltruismMin: 0.55,  // altruism at/above this is moved by a stranger's plea (kin always are)
  donorSurplusGold: 12,    // a donor keeps this much for itself — only real surplus is given
  giveAmt: 4,              // coins per alms gift (a few meals at the stalls)
};

// --- group names (Phase B3 legibility) ----------------------------------------
// A fresh emergent group coins a NAME at formation (groups.js _join, drawn via the seeded
// rng()) so a fellowship is a CHARACTER in the story — "Wenna joined the Hearthside Circle"
// reads; "agent 41 set groupType circle" doesn't. Names are flavour only (no mechanics).
export const GROUP_NAMES = {
  warband: ['the Iron Banners', 'the Red Wolves', 'the Oathblades', 'the Storm Riders', 'the Grim Company'],
  hearth:  ['the Quiet Folk', 'the Hearthkeepers', 'the Homebound', 'the Emberwatch'],
  guild:   ['the Hammerfast Guild', 'the Honest Hands', 'the Masters\' Circle', 'the Trade Compact'],
  circle:  ['the Hearthside Circle', 'the Old Friends', 'the Evening Company', 'the Market Fellows'],
};

// --- dungeons (Daggerfall-style sublevels) ----------------------------------
// A dungeon is a procedurally-assembled tile labyrinth built into a Group that
// sits far BELOW the overworld (the arena clamp only constrains x/z, so a deep
// Y offset keeps the two worlds spatially isolated — agents 400m apart never
// perceive or strike one another). Entering swaps fog/lighting for the gloom.
export const DUNGEON = {
  y: -400,                  // world Y the whole dungeon is built at
  tile: 3.0,                // size of one grid tile (corridor width)
  wallH: 3.4,               // wall / ceiling height
  radius: 4,                // maze radius -> grid is (2*r+1) tiles per side
  entranceCount: 3,         // cave mouths scattered in the wilds
  entranceRange: 3.2,       // how close to a portal you must stand to use it
  baseMonsters: 4,          // monsters on level 1
  monstersPerLevel: 2,      // +this many each level deeper
  maxTorches: 14,           // point-light budget per level
  relicDepth: 1,            // from this depth down, the treasure holds a relic
  fog: { color: 0x05060a, near: 2, far: 26 },
};

// --- general sim tuning (shared with movement/perception) -------------------
export const SIM = {
  tickHz: 6,
  corpseTtl: 90,            // sim-seconds a corpse lingers before it is REAPED from the roster.
                           //   Without this, dead townsfolk/monsters/rivals were never removed and
                           //   accumulated forever (a 30-min trace held 256 corpses vs 92 living) —
                           //   bloating every pass + reading as a tripled "population". The grace
                           //   window lets looting / obituary / witness folds fire before reaping.
  corpseReapSecs: 4,       // self-throttle for the reaper sweep (sim-seconds)
  talkRange: 3.4,            // gossip range (prices AND beliefs): ~adjacent (widened a touch
                             //   so the 2x map's looser clusters still chatter)
  moveSpeed: 4.4,            // faster travel so agents still cross the 2x map and meet (was 3.4)
  runSpeed: 7.2,             // scaled with moveSpeed
  arriveDist: 0.7,

  hungerDrain: 1 / 600,     // PEACEFUL/MEGATOWN: ~10-min hunger clock (was 1/95 ≈ 95s). The widened
                            //   200m town puts the single market a ~90s round-trip from the rim; a 95s
                            //   clock starved the outskirts faster than they could refuel (304→106 in 30min).
                            //   A 6× clock keeps the refuel loop well inside budget while `eat` still fires.
  energyDrain: 1 / 140,
  socialDrain: 1 / 90,
  noveltyDrain: 1 / 130,    // boredom builds slowly — the NOVELTY need (drives sightsee/exploration)
  restRate: 0.40,
  socializeRate: 0.50,

  // --- Theory-of-Mind (belief layer) ---
  visionRange: 22,          // how far an agent perceives others (widened for the 2x map so
                            //   perception/gossip-target acquisition doesn't thin out)
  // --- Phase 3: terrain-shaped perception + movement ---
  // perception: high ground extends sight, concealment (forest/low ground) cuts it.
  vantagePerMeter: 0.02,    // +sight per metre of the SEER's elevation (capped in perceive)
  concealWeight: 0.5,       // how strongly a target's concealment (0..0.7) shrinks effective range
  // movement: crossing a barrier cell is slow, funnelling routes through fords/bridges.
  waterSpeedMul: 0.4,       // speed multiplier wading the river (vs steering to a ford)
  ravineSpeedMul: 0.5,      // speed multiplier crossing a ravine floor
  beliefDecayStride: 4,     // decay each agent's table every Kth tick at K×dt (linear fades ⇒ exact; 1/K the walks)
  tieRetention: 3,          // non-uniform decay: confidence in a |standing|=1 tie (beloved/blood-enemy)
                            //   fades (1+this)× slower than a stranger's — relationships consolidate,
                            //   acquaintances churn. Keyed on standing ONLY (never suspicion/hostile:
                            //   rumour-fed fear of strangers must fade, or feuds metastasize town-wide).
  placeRetention: 4,        // non-agent (placeKind) beliefs fade (1+this)× slower: buildings don't
                            //   walk — only their believed STATE changes, rarely (decay-side of the
                            //   never-evict-home precedent; the homecoming's stale belief persists).
  beliefsPerAgent: 25,      // bounded ToM table size — the MEASURED optimum (test/beliefsweep.mjs,
                            //   caps 12..300 × 2 seeds): tables PIN at the cap at every size (minds
                            //   always saturate — the cap IS the curator), 12 was too small (the
                            //   alms post-mortem: a donor couldn't keep the pauper in mind long
                            //   enough to pay), 50 cost ~40% more ms/frame AND measured worse on
                            //   every legibility axis, and ≥100 ANNIHILATED the town (the hostile
                            //   latch never cools; the bound is the throttle on how many enemies
                            //   one mind can hold — bounded forgetting is a survival mechanism).
                            //   25 + tie-weighted retention: best correlations, healthy town.
  gossipFalloff: 0.85,      // confidence multiplier when a belief is passed along
  gossipCap: 0.8,           // ceiling on second-hand confidence
  confidenceDecay: 1 / 240, // belief certainty fades per second
  suspicionDecay: 1 / 120,
  actOnBeliefMin: 0.35,     // min confidence to act on a believed-hostility
  reacquireConf: 0.75,      // belief confidence at/above which a pursuit chases the last
                            //   SIGHTING (lastPos); below it (but >= actOnBeliefMin) the
                            //   quarry is out of sight and stale, so the pursuer instead
                            //   intercepts at the INFERRED destination (destination-intent)
  // flee hysteresis (Schmitt band) — kills the flee<->work pacing limit-cycle:
  // start fleeing a threat within dangerRange, stop only once it's beyond the
  // larger safeRange. While in danger, economic activity is suppressed.
  dangerRange: 12,          // a believed-hostile this close puts an agent in danger
  safeRange: 20,            // ...and it keeps fleeing until the threat is this far off
  // ANIMACY (schema substrate): a subject must move at least this far (m², squared) BETWEEN
  // consecutive sightings to register as having acted alive (filters perception jitter).
  moveEvidenceEps: 0.04,
};

// MENTAL MAP / Theory-of-Mind DESTINATION inference. The agent's known PLACES are
// shared STATIC geography (gates/POIs/landmarks) — never live entities — queried by
// AFFORDANCE ('exit'/'conceal'/'safe'/'crowd'/'resource'). `inferDestination` scores
// each known place by (heading match × wHeading) + (intent-conditional affordance
// bonus × wAfford) − (distance × wNear) and takes the argmax; the chosen destination
// is CACHED on the belief for `destTTL` seconds (re-inferred only on lapse, cleared the
// instant perception re-acquires the quarry). Tuning lives here, not in logic.
export const MAP = {
  knownPlaces: 8,           // per-agent view cap (~8 places an agent in its town knows)
  wHeading: 1.0,            // headingMatch (0..1) weight: is the quarry AIMED at it?
  wAfford:  0.6,            // intent-conditional affordance bonus (flee→exit/conceal, raid/hunt→crowd)
  wNear:    0.015,          // distance cost per metre (nearer is likelier); tuned vs arena scale
  destTTL:  6,              // seconds an inferred destination is trusted before re-inference
  // affordance vocabulary by place kind (data-driven; the affords() lookup table).
  affordances: {
    gate:    ['exit', 'safe'],
    ford:    ['exit'],
    vale:    ['conceal', 'safe'],
    peak:    ['conceal'],
    town:    ['crowd', 'safe', 'resource'],
    market:  ['crowd', 'safe', 'resource'],
    forge:   ['resource'], mine: ['resource'], field: ['resource'],
    well:    ['crowd', 'safe', 'water'],   // plaza furniture — the square's non-commercial gathering spot
    forest:  ['conceal', 'resource'], meadow: ['resource'],
    // PLACES-AS-PERCEPTS (Phase 2a): a tavern/rest site affords shelter+rest (a hearth to sit
    // by), a home affords shelter+rest+private (your own roof). `shelter`/`rest`/`private` are
    // the new affordance strings the belief-backed comfort path queries via map.nearest().
    rest:    ['safe', 'shelter', 'rest'], hut: ['safe', 'shelter', 'rest'],
    tavern:  ['crowd', 'safe', 'shelter', 'rest'],
    // THE GUILDHALL: a fellowship's hall is a GATHERING place (crowd/social), like the
    // tavern's social role — but deliberately NOT 'rest'/'shelter', so the belief-backed
    // comfort path (map.nearest(['shelter','rest'])) never reroutes strangers to it.
    guildhall: ['crowd', 'safe', 'gather', 'social'],
    home:    ['safe', 'conceal', 'shelter', 'rest', 'private'],
    granary: ['safe', 'larder'],   // the public larder — what the destitute's granary trip queries
    // THE SHRINE: a god's holy place — 'sanctify' (faith reads it; deliberately NOT
    // shelter/rest, so the comfort path never reroutes strangers to another god's spire).
    shrine:  ['safe', 'sanctify'],

    frontier:['exit'],       // the heading-extension fallback place
  },
};

// SCARECROW — the canonical "mistake a prop for a person" percept (js/sim/percept.js).
// A config-gated world spawn (default OFF so soak/depth baselines are untouched); tests
// spawn Scarecrows directly via sim.spawnPercept(). When enabled, `count` props per town
// are placed in the `ring` annulus, dressed as `appearsAs` so an observer files a person-
// belief about them and may hunt/strike them — yet nothing that assumes a real mind fires.
export const SCARECROW = {
  enabled: false,           // config-gated world spawn (bonus); tests spawn directly
  count: 0,                 // per-town scarecrows when enabled
  appearsAs: 'bandit',      // the faction it is dressed as (what it appears to be)
  hp: 40,
  ring: [22, 40],           // [minR,maxR] annulus from town centre for a field scarecrow
};

// SCHEMA — the InteractionSchema reasoning layer (js/sim/schemas/). The schema CATALOGUE
// is DATA (catalogue.js); this block is the interpreter's bounds/tuning only. `enabled`
// is the master gate (reason() no-ops when false → the byte-stable framework proof). The
// priority bands are documented for the catalogue rows (Step 2 authors them).
export const SCHEMA = {
  enabled: true,            // master gate — reason() early-returns when false
  strikeLogCap: 8,          // bounded self-engagement tally (evict the stalest `first`)
  inertThreshold: 2,        // schema #6: inertEvidence above which a 'hostile' flips false
  goalDwellTicks: 4,        // min-dwell (ticks) for a schema-set direct-goal lock (anti-thrash)
  // priority bands (used by catalogue rows, Step 2):
  //   flee .9 · intercept .85 · hide .95 · suspect .5 · brawl .7 · inert .6
};

// LEVEL-OF-DETAIL (Phase 3 — Scale): amortized cognition. The SLOW deliberative
// passes (reason() + decide(), with plan() riding along) run EVERY tick for RELEVANT
// agents and only every `stride`th tick for the distant/idle tail — hung on the
// existing fixed-tick accumulator. perceive/decay/gossip/market/society stay every
// tick (cheap + correctness-bearing: no blind window, no half-finished trade), and
// act(dt)/movement stay EVERY FRAME (bodies keep moving smoothly while cognition is
// thinned). The relevance gate lives ENTIRELY in Simulation (truth-side); no cognition
// file gains a relevance/roster read. Tuned so the dense working town stays MOSTLY
// full-fidelity (only true frontier/idle agents thinned) — the WIN is the cost metric
// + the mechanism, not aggressive thinning. All knobs here (tuning-in-config).
export const LOD = {
  enabled: true,                 // master gate
  stride: 6,                     // low-relevance agents reason/decide every 6th tick (6Hz->1Hz)
  fullFidelityBelow: 40,         // N <= 40 => everyone full-fidelity (scenarios <=15 + the
                                 //   2-5-agent sub-sims in soak/scenarios stay byte-identical)
  playerRadius: 28,              // within this of the player => relevant (player present)
  townCentreRadius: 45,          // within this of own townAnchor => relevant (headless fallback).
                                 //   Town sites scatter to ~town.radius*0.7 (~49m); 45 keeps the
                                 //   dense working town ~82% full-fidelity, thinning only the
                                 //   distant/idle frontier tail (lairing monsters, far wanderers).
  hostileConf: 0.35,             // threat-belief confidence => relevant; aligned with
                                 //   SIM.actOnBeliefMin (the threshold decide actually acts on),
                                 //   so the gate promotes EXACTLY when decide would react.
  recentWindow: 3.0,             // seconds; a recent goal-kind change keeps an agent full-fidelity
                                 //   (hysteresis against relevant<->irrelevant thrash at the edge).
};

// Information provenance: how an agent learned something sets its confidence.
export const SOURCE = {
  WITNESSED: { tag: 'witnessed', conf: 1.0 },
  TALKED:    { tag: 'talked',    conf: 0.8 },
  OVERHEARD: { tag: 'overheard', conf: 0.6 },
  RUMOR:     { tag: 'rumor',     conf: 0.4 },
};

// HEARSAY — how a belief's CONTENT (not just its confidence) garbles as it passes
// mouth to mouth. The town is named for this: gossip should DISTORT, not merely
// fade. Each social hop deepens provenance (BeliefState.hops) and:
//   (a) AMPLIFIES the opinion toward the extreme — outrage grows in the retelling,
//       and bad news grows fastest (negBias) — clamped so it converges, not blows up;
//   (b) can curdle a merely-SUSPICIOUS belief into a (false) HOSTILITY — a feud born
//       of pure talk, the rumour that kills — bounded by hop depth so it's occasional.
// All effects are clamped + gated; confidence still caps/decays as before, so a lie
// left unreinforced still dies. Tuning here changes how cruel the grapevine is.
export const HEARSAY = {
  chargeThresh: 0.3,      // only a CHARGED opinion (|standing|>=this) grows in the retelling;
                          //   mild goodwill/coolness spreads undistorted, so the social fabric holds
  amplify: 0.22,          // how hard each retelling pushes a charged |standing| toward the extreme
  negBias: 1.6,           // bad news amplifies this much harder than good
  maxHops: 5,             // provenance-depth cap (5+ all read "a tale much retold")
  // PLACE HEARSAY (mergePlaceFrom): building news travels place-shaped — no garbling
  // (a place has no reputation to curdle), just kind/where/shelter/quality.
  placeQualityDamp: 0.7,  // a TOLD benefitFelt lands at this fraction (hearing < having sat there)
  placeGossipConf: 0.45,  // a teller only passes on places it still holds at least this confidently
  tipStanding: 0.85,      // a name blackened past this (by compounding retellings) can curdle…
  tipChancePerHop: 0.10,  // …into a FALSE hostility, this chance per hop past the first (capped 0.5)
  // DESTINATION-INTENT: the max time gap (s) between two sightings for the second to record an
  // observed HEADING. Wider than a cognition tick (1/tickHz≈0.167s) so consecutive sightings of
  // a moving quarry build a heading, but small enough that a long-lost-then-resighted subject
  // reads as a "jump" (no stale heading). Below this, observe() updates the unit heading; above
  // it the heading resets (a fresh anchor). Gates the inferDestination heading-match term.
  predictMaxGap: 0.6,
};

// Factions (RPG layer). Townsfolk are the village; the player is an outsider.
// Phase-1 drama stood up two organized factions beyond the wild monster threat:
// an aggressive BANDIT camp and a RIVAL clan (see CAMPS + FACTION_RELATIONS).
export const FACTIONS = {
  townsfolk: { label: 'Townsfolk', color: 0x6fb7ff },
  outsider:  { label: 'Outsider',  color: 0xeaeaea },
  wilds:     { label: 'Wilds',     color: 0x5f9f4f },
  bandit:    { label: 'Bandits',   color: 0xb5562a },
  rival:     { label: 'Rival Clan', color: 0x8f6fc0 },
  monster:   { label: 'Monsters',  color: 0x8a3b3b },
};

// A generous name pool — a peaceful town GROWS (births) well past its starting size,
// and camps/reinforcements draw names too, so a short list runs dry and agents fall
// back to "Unit<id>" (ugly in the chronicle). Keep this comfortably larger than any
// realistic living population.
export const NAMES = [
  'Bjorn', 'Astrid', 'Cedric', 'Mira', 'Tomas', 'Greta', 'Ulric', 'Sela',
  'Dain', 'Romy', 'Hollis', 'Yara', 'Pavel', 'Edda', 'Nils', 'Wren',
  'Garrik', 'Osric', 'Pell', 'Vesna', 'Corin', 'Halla', 'Sten', 'Lda',
  'Aldric', 'Bram', 'Cael', 'Doran', 'Elsa', 'Fenn', 'Goran', 'Hilde',
  'Ivar', 'Jorah', 'Katla', 'Leif', 'Magda', 'Nessa', 'Orin', 'Petra',
  'Quill', 'Rurik', 'Sasha', 'Torin', 'Una', 'Viggo', 'Wanda', 'Xander',
  'Yrsa', 'Zev', 'Alba', 'Borin', 'Cira', 'Doln', 'Elke', 'Finn',
  'Gwen', 'Hark', 'Inga', 'Jarl', 'Ketil', 'Lible', 'Mads', 'Nadia',
  'Oren', 'Pia', 'Roland', 'Saskia', 'Tove', 'Ursa', 'Vren', 'Wystan',
  'Yana', 'Zoltan', 'Anka', 'Bertil', 'Cosmin', 'Dagny', 'Egil', 'Frida',
  'Gunnar', 'Heloise', 'Isolde', 'Joran', 'Kerstin', 'Lothar', 'Maren', 'Norah',
  'Odo', 'Perrin', 'Runa', 'Solveig', 'Tobias', 'Ulla', 'Verena', 'Wilmar',
];

export const PLAYER_COLOR = 0xeaeaea;

// --- LINEAGE: births + apprenticeship + mentorship (js/sim/lineage.js) -------
// Renewal without aging. A mutually-fond pair that is SAFE (no believed-hostile
// in danger range) and FED (hunger ok), over time, produces a CHILD townsperson
// — the child inherits a blend of the parents' personality + a fraction of their
// behaviour tags, so trades/temperaments run in families. Population growth is
// SOFT-CAPPED here (Director raids are the real population control; this cap just
// stops runaway growth). Apprenticeship lets a young/low-level townsperson learn
// a master's dominant tags, fast-tracking that class (a guild-style bond).
// Everything is gated + guarded so it never throws/stalls on the fixed tick.
export const LINEAGE = {
  // cadence — the whole subsystem is self-throttled to this interval (sim-seconds)
  tickEvery: 4,

  // --- births (run off PERSISTENT COUPLES — see lineage.js) ---
  birthEnabled: true,
  popSoftCap: 28,            // per-town living-townsfolk cap (scaled ×towns in lineage).
                             //   Tuned DOWN from 40 once the eat fix made births actually
                             //   bind it: ~28/town keeps recurring, deep, storied characters
                             //   (bigger pops tell SHALLOWER stories — measured) + stays performant.
  mateRange: 16,            // how close two unattached townsfolk must be to WED (court).
                            //   the bond persists after, so they bear children even once
                            //   they drift apart to work — this is what lets the loop pulse
  pairStanding: 0.3,        // mutual belief-standing each must hold of the other to be fond
  fedHunger: 0.4,           // both parents' hunger must be >= this (well-enough fed)
  gestationSecs: 12,        // sim-seconds a couple must stay FIT (fed+safe) to bear a child
  birthCooldownSecs: 30,    // after a birth, a parent rests this long before another
  dowry: 6,                 // gold MOVED from a parent to the child (never minted);
                            //   0 => child starts with nothing. Capped at parent gold.
  inheritTagFraction: 0.3,  // fraction of each parent's behaviour-tag weight seeded
  inheritTagTop: 5,         // top-N dominant tags per parent carried over
  personalityJitter: 0.08,  // +/- noise on the blended personality traits

  // --- apprenticeship ---
  apprenticeEnabled: true,
  apprenticeEvery: 12,      // sim-seconds between apprenticeship passes
  apprenticeMaxLevel: 4,    // only townsfolk at/below this TOTAL class level apprentice
  masterMinLevel: 6,        // a master must hold this TOTAL class level to teach
  masterRange: 18,          // master must be within this range of the apprentice
  copyTagFraction: 0.3,     // fraction of the master's dominant-tag weight copied over
  copyTagTop: 4,            // top-N master tags copied per session
  bondCooldownSecs: 30,     // sim-seconds between teaching sessions for a pair
  surpassMargin: 2,         // total-level lead at which an apprentice is chronicled as
                            //   having SURPASSED their master (or outstripped their rival)
                            //   — the payoff that closes the rival-apprentices arc
  reconcileChance: 0.25,    // per-pass chance two long-standing rivals RECONCILE (clear the
                            //   rivalry, become friends) — the peaceful end of the arc; higher
                            //   once one has already surpassed the other (the strife is settled)
};

// --- MIGRATION: the emigration valve against population skew ------------------
// In a multi-town world the birth loop compounds wherever couples get a head start
// (dense towns breed more — rich-get-richer; measured by test/townprobe.mjs: at
// 1200s one boom town can hold ~2/3 of the world while another bears NO children).
// The valve is diegetic and EMERGENT, not a quota: a truth-side census pass
// (js/sim/migration.js — observer layer, like the Director) notices a CROWDED town
// and lets word reach a few of its people that land is cheap in the SPARSEST one —
// an Inform (the recruiter-offer / alms-plea mailbox pattern, `_prospects`). The
// agent then DECIDES off its OWN state alone (features/migrate.js): only the poor,
// unhoused, unwed and restless/ambitious are tempted; they provision rations first
// (the no-campaign-without-rations precedent), march as the `migrate` candidate
// (WEIGHT.migrate + fillMigrate, the arbitrage-style own-state journey), and only
// ON ARRIVAL does execution flip their citizenship (resolver.relocate). The rooted
// — housed, wedded, timid — stay. Rare by design.
export const MIGRATE = {
  enabled: true,
  tickEvery: 10,            // sim-seconds between census passes (self-throttled)
  // --- the census (truth-side aggregate; never drives a decision directly) ---
  crowdRatio: 1.2,          // a town at/above mean×this is CROWDED (rumour source)
  sparseRatio: 0.85,        // a town at/below mean×this is land-cheap (rumour destination)
  minGap: 6,                // and the two must differ by at least this many heads (anti-flutter)
  rumoursPerPass: 3,        // at most this many prospects stamped per pass (bounded)
  rumourChance: 0.4,        // per-candidate-ear chance the word reaches THEM this pass
  // --- the prospect mailbox (own-state Inform, pruned in cognition) ---
  prospectTtl: 90,          // sim-seconds an unacted prospect lingers before lapsing
  prospectCap: 2,           // mailbox bound (oldest dropped)
  // --- who is tempted (own state + personality; the rooted never qualify) ---
  poorGold: 14,             // only an agent poorer than this has nothing keeping it (circumstance)
  wanderlustMin: 0.55,      // curiosity at/above which the RESTLESS are tempted…
  ambitionMin: 0.7,         // …or ambition at/above (the strivers chase the open plot)
  acceptChance: 0.6,        // one weighing per prospect: even a tempted soul may decide to stay
  provisionFood: 2,         // no journey without rations — the road is a map-length from a meal
  // a mover ENDURES the road: while a journey intent is live the routine comfort pull is
  // damped by this factor (the journey-tracker probe watched the old town's tavern yank a
  // migrant home over and over — the limit cycle ate the clock). A genuine comfort
  // EMERGENCY (COMFORT.urgentBoost) still punches through — survival first.
  roadHardship: 0.55,
  // --- the journey + settlement ---
  // (the march itself is the `migrate` decide candidate, WEIGHT.migrate + fillMigrate —
  // an own-state intent like arbitrage/bounty, NOT a stack goal: a stack journey got
  // buried under newer goals and lapsed 250m short. Flee/eat still preempt per tick.)
  journeySecs: 600,         // give up the road after this long (stay a citizen of the old town);
                            //   ~35s pure RUN for the longest inter-town leg + generous slack for
                            //   the eat/flee/comfort interruptions that legitimately preempt the
                            //   march (a war-torn home town's churn can eat whole minutes)
  settleRadius: 25,         // within this of the new town centre = arrived → relocate (execution)
};

// --- THE PATRICIAN: a diegetic peace-keeper (Discworld's Vetinari) ------------
// The Director CAUSES drama (feuds, sparks, raids); the Patrician is the in-world
// counterforce that keeps it from boiling over — each cycle it finds the town's
// most dangerous FEUD and brokers a (partial) truce, and quells intra-town hostility
// before it turns to bloodshed. The two together make tension MANAGED, not absent:
// crime simmers, feuds smoulder, but the city holds. Belief-only (it adjusts
// standings, never ground truth); touches no gold; guarded. See js/sim/patrician.js.
export const PATRICIAN = {
  enabled: true,
  tickEvery: 2,            // sim-seconds between interventions — scan often, since a feud's
                           //   latched hostility is "forgiven" (un-latched) within ~2s by
                           //   reputation drift, so a slow Patrician never catches one
  feudThreshold: -0.3,     // step in on a mutual feud at least this sour (summed standing)
  brokerAmount: 0.45,      // how far back toward neutral a brokered truce pulls each side
  quellHostile: true,      // also un-latch intra-town HOSTILE beliefs (prevent a killing)
  reconcileChance: 0.4,    // chance a brokering becomes a LASTING reconciliation (enemies →
                           //   friends) rather than a mere truce — the positive register
  reconcileStanding: 0.4,  // the warm mutual standing a reconciliation leaves behind
};

// --- THE NIGHT WATCH: a civic guard institution (Discworld's City Watch) -------
// Brave townsfolk take up arms to defend the town CORE when it's threatened, led by
// a rising CAPTAIN (the senior watchman — a Vimes). The watch swells with the threat
// and stands down in peace (members return to their trades). Watchmen are combatants
// LEASHED to the core (they hold the line, never chase a raider to the frontier),
// complementing the passive watchtowers with an active, mortal, *led* defence — and
// an institution the chronicle can follow (founded, new captain, a watchman falls).
// See js/sim/watch.js.
export const WATCH = {
  enabled: true,
  tickEvery: 4,            // sim-seconds between muster passes
  base: 2,                 // standing watch in peacetime
  perThreat: 0.7,          // + watchmen per town-hostile body near the core (rallying)
  threatRange: 64,         // a hostile within this of the core counts as a threat
  max: 8,                  // hard cap on watch size
  recruitRisk: 0.45,       // min risk_tolerance to volunteer (the brave answer the call)
  standDownAfter: 30,      // sim-seconds of CALM before surge watchmen are released, one at
                           //   a time — hysteresis so the watch doesn't thrash in/out of duty
                           //   on every flicker of threat (and a captaincy stays put)
  leashR: 44,              // hold the line within this of the core (don't pursue outward)
  patrolR: 14,             // patrol radius around the core when no enemy is near
};

// --- HOUSES: lineage surnames + dynastic narrative ----------------------------
// Each founding townsperson heads a HOUSE (a surname); children carry it down the
// bloodline. So names read like a chronicle ("Aldric Vael the Bold"), kin avenge
// their HOUSE, and the saga gains its most poignant dynastic beat — a bloodline that
// grew across generations finally dying out ("the line of House Vael has ended").
export const HOUSES = {
  enabled: true,
  surnames: ['Vael', 'Thorne', 'Bryce', 'Holt', 'Marsh', 'Crane', 'Dunmore', 'Ashford',
    'Greer', 'Vance', 'Locke', 'Stagg', 'Mercer', 'Voss', 'Harrow', 'Kell', 'Bramble',
    'Fenwick', 'Oakes', 'Rede', 'Sallow', 'Tarn', 'Wode', 'Yarrow', 'Brand', 'Coll',
    'Drey', 'Frost', 'Garn', 'Hale', 'Ives', 'Joss', 'Karr', 'Lund', 'Mott', 'Nye',
    'Orr', 'Pike', 'Quist', 'Reeve', 'Snell', 'Vary'],
};

// --- EPITHETS: emergent heroes & villains (a light Nemesis system) -------------
// Faceless "Raider 12" cutting down a townsperson carries no weight. So combatants
// who distinguish themselves earn a NAME that then rides every future chronicle beat:
// a foe who slays enough townsfolk becomes a dread NEMESIS ("the Bloody-Handed"),
// and a townsperson who fells enough foes is hailed a HERO ("Garrik the Bold"). Gives
// the kin-vendetta arcs a recurring, named target and makes combat read like saga.
export const EPITHETS = {
  enabled: true,
  villainKills: 2,         // townsfolk a foe must slay to earn a dread name (low — the town
                           //   is well-defended, so a raider that lands even two is notable)
  heroKills: 5,            // foes a townsperson must fell to be hailed a hero
  villainNames: ['the Bloody-Handed', 'the Butcher', 'the Reaver', 'the Cruel',
    'Skulltaker', 'the Black Wolf', 'Dreadbringer', 'the Flayer'],
  // a named NEMESIS doesn't withdraw with its raid wave — it PERSISTS as a recurring
  // antagonist, tougher than a common raider, until a hero finally brings it down.
  bossHpMul: 2.2,          // the nemesis's health vs a normal raider (a real boss)
  bossThreatMul: 1.4,      // and it hits harder
  bossSpeedMul: 1.3,       // and runs DOWN fleeing prey (a lone equal-speed raider can never
                           //   catch anyone — this is what makes a nemesis genuinely deadly)
  heroEpithets: ['the Bold', 'the Valiant', 'Ironheart', 'Foe-bane',
    'the Stalwart', 'the Shield of the Town', 'the Brave', 'Bulwark'],
  // a RINCEWIND — not a hero but a COWARD who keeps cheating death by fleeing while
  // braver folk fall; a legend of improbable survival, not valour. Emergent from the
  // near-death survivals the lethal world already produces.
  survivorEpithets: ['the Lucky', 'the Unkillable', 'the Ever-Fleeing', "Death's Despair",
    'the Fortunate', 'the Spared', 'who-runs-away', 'the Improbable'],
  escapesForLegend: 5,     // narrow escapes a COWARD must survive to earn a survival-legend.
                           //   HIGH on purpose: a Rincewind is THE one who cheats death again
                           //   and again, not a category — many cowards survive a scare or two,
                           //   few survive five. (The per-escape flight beats narrate the rest.)
  cowardRisk: 0.42,        // risk_tolerance below which a survivor reads as a coward (a Rincewind)
  escapeCooldown: 18,      // sim-seconds between counted narrow escapes (one scare per window)
};

// --- FAITH: belief-powered gods (Discworld's Small Gods) ----------------------
// The sim already runs on BELIEF — so a god whose power IS its number of believers
// fits the engine natively. Faith spreads by proximity (the faithful proselytise),
// the believers receive MIRACLES (heal + courage) scaled by the size of the flock —
// a feedback loop: belief → power → miracles → the faithful thrive → more belief.
// A god stripped of believers dwindles to a "small god" (its last believer never
// lapses, so it can be REVIVED by a prophet — the director can anoint one). Faith
// touches no gold and is fully guarded. See js/sim/faith.js.
export const FAITH = {
  enabled: true,
  gods: ['Om', 'Blind Io', 'The Lady'],   // the pantheon (compete for believers)
  bootFlock: 5,            // initial believers anointed to EACH god at first tick — each god
                           //   starts VIABLE (at 2, the runners-up never built spread momentum
                           //   and the pantheon collapsed to one god + a faithless mass)
  tickEvery: 3,            // sim-seconds between spread/doubt passes
  convertRange: 6,         // how near a believer must be to win a convert
  convertChance: 0.05,     // base per-pass chance to convert a nearby faithless soul
  powerConvertBonus: 0.04, // + this per √believer (bandwagon, SUB-linear: each believer already
                           //   rolls independently, so a linear bonus made one god sweep the town)
  doubtChance: 0.012,      // per-pass chance a believer lapses (apostasy)
  crowdDoubtAt: 70,        // flock size at which crowding DOUBLES the lapse rate (a god grown
                           //   great holds many in name only — the bandwagon's self-limiting term;
                           //   25 was too fierce: it tipped HALF the town into faithlessness
                           //   because conversion is range-limited while doubt is global)
  miracleEvery: 6,         // sim-seconds between miracles
  miracleHeal: 3,          // hp restored to a HURT believer (× flock-scale) — a BOON, not full
                           //   regen (the old value made the whole town near-unkillable)
  miracleCourage: 0.35,    // fear the miracle quells in the faithful
  smallGodAt: 1,           // ≤ this many believers ⇒ a "small god" (last believer is loyal)
  greatGodAt: 8,           // ≥ this many ⇒ a "great god" (a chronicle milestone)
  // THE SHRINE (a congregation's civic build — SURVEYOR.shrine*): a god's miracles work
  // HARDER on faithful near its standing shrine — holy ground, the reason a flock raises one.
  shrineRange: 14,         // metres from the shrine within which the boost applies
  shrineMiracleBoost: 1.6, // miracle heal/courage multiplier on holy ground
};

// --- EXPEDITIONS: NPC adventuring parties (js/sim/expeditions.js) --------------
// A renowned captain rallies a brave company, marches OUT into the wilds to hunt,
// and returns in triumph or broken — the DF-adventurer / M&B arc for NPCs.
export const EXPEDITION = {
  enabled: true,
  tickEvery: 3,            // sim-seconds between expedition passes
  maxActive: 1,            // at most this many companies afield at once
  formEvery: 240,          // min sim-seconds between companies — RARE background flavour (the
                           //   compact world makes a heroic expedition a quick errand, so don't
                           //   let it dominate; the picaresque Rincewind survivor is the main act)
  formChance: 0.5,         // chance to muster one when eligible + off cooldown
  partySize: 3,            // captain + (partySize-1) followers
  captainMinLevel: 5,      // a leader of some renown
  recruitRisk: 0.5,        // captain/followers must be at least this brave
  huntSecs: 55,            // how long the band hunts the wilds before turning back
  targetRing: 0.78,        // wilds objective distance (× ARENA_RADIUS) — where monsters lurk
  // DELVE — most companies now go UNDERGROUND into the dungeons (the deep adventure the
  // compact overworld can't give). The party descends to an isolated Y pocket (far below
  // the overworld AND the player's own dungeon, so it's isolated by distance — the same
  // spatial trick the DungeonManager uses), fights the HORRORS there, and climbs back
  // bearing relics — or is swallowed by the dark. Off-screen below; told in the chronicle.
  delveChance: 0.7,        // fraction of expeditions that go into the deep vs the wilds
  delveDepth: -900,        // the delve pocket's Y (overworld ~0, player dungeon ~-400)
  delveMonsters: 3,        // horrors lurking in the deep (a 3-strong party usually prevails,
                           //   with the odd costly delve — not a meat-grinder that drains the town)
  monsterHpMul: 1.25,      // a dungeon horror is a bit tougher than a surface raider
  monsterThreatMul: 1.1,   // …and hits a bit harder
  delveSecs: 50,           // how long the delve lasts if not cleared sooner
  relicChance: 0.6,        // chance a delve that CLEARS the deep returns bearing a relic
  minTownPop: 18,          // don't muster a company (risking lives in the deep) from a town
                           //   already below this — it needs everyone at home
  // --- PROPER QUESTS (the expedition-archetype work): march, provision, retreat, explore ---
  provisionFood: 1,        // a member must CARRY this much food to join (the company marches on
                           //   its stomach — provisioning is a real choice, M0-priceable)
  delveRing: 0.55,         // how far out the delve MOUTH lies (× ARENA_RADIUS): the company
                           //   MARCHES there and back — the journey is real, only the descent
                           //   into the pocket is a teleport (climbing into a hole)
  retreatBelow: 0.99,      // the captain CALLS THE RETREAT on FIRST BLOOD (alive fraction below
                           //   this) — "none climbed back" becomes a choice that failed, not a timer
  retreatHp: 0.4,          // …or when the PARTY's mean health fraction drops below this. Keyed to
                           //   the COMPANY, never the captain's own hp — the probe proved a captain-
                           //   keyed bell is silenced by his own sustain (self-healing captains
                           //   pressed on while their parties died: sustain became a death trap)
  exploreDeedDist: 40,     // an EXPLORE deed folds per this many metres marched on expedition —
                           //   one of the two emitters that finally make the explorer identity
                           //   reachable (the other: a sightsee outing fully taken in, act.ts)
  // --- FELLOWSHIP, not mercenary company (the charm trade-off, by design) -------------
  bond: {                  // follower-selection BOND score toward the captain (mutual regard +):
    mate: 0.8,             //   the spouse who won't stay home
    kin: 0.6,              //   blood comes along
    master: 0.5,           //   the master and the apprentice
    groupmate: 0.4,        //   guild-/circle-/hearth-mates
    override: 0.5,         //   a bond at/above this brings even a TIMID soul ("for Frodo" —
                           //   the courage gate is waived; the provision gate never is)
  },
  loyaltyHold: 0.6,        // a captain whose (altruism × mean-bond) loyalty reaches this does
                           //   NOT turn at first blood — he holds until the company truly bleeds
                           //   (the deliberate un-optimality: devotion risks more, and sometimes
                           //   pays in the chronicle's saddest lines)
  comradeWarm: 0.12,       // pairwise standing warmth among survivors who march home together
                           //   (a 'comrade' bond memory too — the group machinery then finds them)
};

// --- NARRATIVE SEEDING: plant initial conditions that GROW into known tropes ---
// We don't script stories — we seed the starting RELATIONSHIPS/STATE and let the
// emergent systems (lineage/apprenticeship, memory-grudges, intrigue, groups, the
// director) play them out, legible in the Chronicle. Data-only + optional. See
// js/sim/seeding.js. Flip `enabled` off for an unseeded (purely-emergent) world.
export const SEEDS = {
  enabled: true,
  // RIVAL APPRENTICES — one master of a trade takes on TWO apprentices who resent
  // each other; the apprenticeship fast-tracks both toward the master's class while
  // the seeded rivalry (mutual ill-will) drives them to outdo one another, until one
  // surpasses. Plays out via lineage._apprenticeships + progression + the chronicle.
  rivalApprentices: {
    enabled: true,
    trios: 1,                 // how many such master+2-apprentice trios to plant
    masterName: 'Master Hadrin',         // evocative fixed names (so the trope reads;
    apprenticeNames: ['Cael', 'Doran'],  //   the general name pool is small + may run dry)
    classKey: 'blacksmith',   // a TEMPLATE class key (see js/rpg/classes.js)
    className: '[Blacksmith]',
    armAbility: 'master_craft', // a pre-validated catalog ability to arm the veteran master with
    masterTags: { SMITHING: 30, CRAFTING: 18, TOOLMAKING: 14 }, // the trade identity to teach
    masterLevel: 8,           // seed the master a seasoned master (>= LINEAGE.masterMinLevel)
    apprenticeTags: { SMITHING: 22, CRAFTING: 10 },             // a strong lean toward the trade
                                                                //   (dominates their early deeds so
                                                                //   the rivalry stays a SMITHING one)
    apprenticeAmbition: 0.85, // driven apprentices work hard (earn XP -> levels)
    rivalry: -0.55,           // the two apprentices' mutual belief-standing (a rivalry)
  },
};

// --- TOWN DEFENCES: watchtowers ringing the core (js/sim/defenses.js) ---------
// The home-ground advantage. Killing power is FIXED (independent of civilian
// population), so it's the robust anti-extinction floor: a gutted town still holds
// its core and rebuilds. Tune so raids still COST the town (some who stray die) but
// the centre endures — defence is an advantage, not invulnerability.
export const DEFENSE = {
  towers: 5,        // watchtowers evenly spaced on a ring around the town core
  ringR: 16,        // ring radius from town centre (origin)
  range: 20,        // a tower fires on town-hostile bodies within this
  damage: 4,        // damage per shot — towers HARASS, they don't instakill. The old high
                    //   value made the core invulnerable (nothing survived near it → raids/
                    //   wars killed nobody → no stakes). Now an attacker lives long enough to
                    //   claim a victim; the anti-extinction floor is the minPop reprieve +
                    //   raider TTL + the territorial leash, not an instant-kill tower wall.
  fireEvery: 1.0,   // sim-seconds between a tower's shots (its rate of fire)
};

// --- DIRECTOR: light, config-driven drama nudge (docs/drama-plan.md §1) ------
// A throttled world-state reader that occasionally rolls a SEED event the
// emergent systems then propagate. Everything here is tuning, not logic — the
// Director's behaviour ("interestingness", pacing, difficulty) lives entirely in
// these knobs. Raiders ALWAYS spawn with zero gold (no minting) and are capped
// in number (no swarm). See js/sim/director.js.
export const DIRECTOR = {
  interval: 6,            // sim-seconds between event rolls (slow throttle)
  minPopForEvents: 4,     // below this living town size, hold ALL events (reprieve)
  eventChance: 0.45,      // base chance an event fires on a given roll
  quietRamp: 60,          // sim-seconds of quiet over which the quiet-bias ramps in
  quietBias: 0.35,        // max added event chance after a long quiet stretch
  tropeKindCooldown: 110, // sim-seconds a trope KIND is benched after firing — forces the
                          // feed to rotate the whole catalog instead of looping greedy beats
  spotlightJitter: 120,   // SPOTLIGHT CASTING noise (secs): candidate protagonists are ordered by
                          //   quietIndex (time since last chronicle-named) + this much uniform jitter,
                          //   so the long-unnamed get first crack at trope roles while the pick stays
                          //   stochastic (0 ⇒ strict longest-quiet-first; large ⇒ uniform shuffle)
  tropeKindCooldownOverride: {
    // major beats with COMMON constellations need a longer leash, else (given tier-1
    // reach) they fire every cooldown and crowd the variety out. A betrayal should be
    // a rare, weighty thing — ~once every 5-6 min, not every other beat.
    betrayal: 330,
    tyrantMarket: 280,
    starCrossed: 300,
    falseWitness: 300,   // now seeds the wrongly-accused arc (tier-1) — long leash, like the other arc seeds
  },

  // POINTS BUDGET (RimWorld-style): instead of a flat per-roll dice, a "drama budget"
  // ACCRUES each roll (scaled by town prosperity), recent DEATHS DRAIN it (mercy /
  // adaptation — the storyteller eases off after losses), and each incident is BOUGHT
  // for a point cost. Banking through calm funds occasional CLIMAXES (a big raid); a
  // bled town's empty purse buys nothing (a natural reprieve). This unifies scaling,
  // pacing, and mercy into one lever — and `eventChance`/`quietBias` are now retired.
  points: {
    enabled: true,
    base: 1.0,             // points accrued per director roll, baseline
    perPop: 0.085,         // + this per living townsperson above raid.minPop (prosperity → drama)
    max: 50,               // banked-points cap (no infinite hoarding; bounds a climax)
    deathDrain: 7,         // points removed per townsperson LOST since last roll (mercy)
    raidPerRaider: 4,      // a raid wave costs this PER raider spawned (budget gates wave size)
    cost: { opportunity: 2, crisis: 5, spark: 3, trope: 8 },   // fixed cost per incident kind
  },

  // relative weights for the event kinds (raids dominate — they ARE the difficulty
  // curve / population valve; the rest are flavour). `trope` is the story-manager
  // roll: it scans LIVE agents for a trope's preconditions and nudges them into it
  // (the measured insight: the substrate — masters, apprentices, families — is
  // already dense at any scale; what's scarce is the SPARK, so the director supplies
  // it rather than us needing a bigger world).
  weights: { raid: 0, opportunity: 2, crisis: 1.5, spark: 1, trope: 3 },   // PEACEFUL SIM: raid weight 0 ⇒ the director never spawns a raider wave

  // TROPE ENGINE — the director as a light story manager. Each instigation finds an
  // existing constellation of agents that ALMOST forms a known trope and supplies
  // the missing spark, then the emergent systems (apprenticeship, grudges, groups,
  // gossip) play it out and the chronicle narrates it. All data-driven + guarded.
  tropes: {
    enabled: true,
    cooldown: 40,            // sim-seconds between trope instigations (a lull)
    rivalApprentices: true,  // a master + two young neighbours -> seed their rivalry
    feud: true,              // two townsfolk who mildly dislike -> deepen to a feud
    vendetta: true,          // amplify a real grievance into a sworn vendetta
    prophet: true,           // a charismatic soul revives a dwindling god (Small Gods)
    nemesis: false,          // PEACEFUL SIM: no raider→boss promotion (off)
    war: false,              // PEACEFUL SIM: no camp-chief→warlord war on the town (off)
    caravanRaid: false,      // PEACEFUL SIM: no road ambushes (off; also inert with one town)
    // --- first wave from docs/trope-catalog.md: break the conflict-monopoly with
    //     warm/social/justice/ambition sparks (all cheap belief+memory, no new verbs)
    reunion: true,           // RECOVERY: long-parted kin of one House recognize each other
    unlikelyFriendship: true,// COMEDY/LOYALTY: two who dislike each other strike up a bond
    falseWitness: true,      // JUSTICE: a whispering campaign poisons an innocent's name
    favoredRise: true,       // AMBITION: an upstart is over-credited, then falls as the lie fades
    warmAmt: 0.25,           // how far the warm tropes lift mutual belief-standing
    slanderDrop: 0.35,       // how far the false-witness rumour sinks the target's standing
    riseBump: 0.4,           // the false reputation spike of a favored rise
    riseFallSecs: 60,        // …after which the inflated esteem sours back down (the fall)
    // --- second wave: LOVE / LOYALTY / REDEMPTION (reliable constellations) ---
    mistakenJealousy: true,  // LOVE: a poisoned whisper makes a spouse believe the other false
    betrayal: true,          // LOYALTY: a trusted friend turns hostile — trust weaponized
    miserReformed: true,     // REDEMPTION: a hoarder is moved to give to a needy neighbour
    jealousyDrop: 0.5,       // how far the false-betrayal whisper cools the marriage
    betrayalDrop: 0.6,       // how hard the betrayer's standing toward the friend crashes
    miserGold: 40,           // a "miser" holds at least this much gold
    miserGift: 15,           // …and gives this much to a needy neighbour (a TRANSFER, no mint)
    // --- third wave: MYSTERY / AMBITION / COMEDY ---
    spyUnmasked: true,       // MYSTERY: a disguised spy is exposed — the town turns on the traitor
    tyrantMarket: true,      // AMBITION: a grasping producer gouges the town; resentment festers
    boastBackfires: true,    // COMEDY: a renown-seeker's planted fame outruns their real deeds
    tyrantSour: 0.35,        // how far a gouged customer's standing toward the tyrant sinks
    tyrantPriceMul: 1.15,    // …and how much their belief of the tyrant's price inflates
    boastFame: 0.3,          // the inflated fame a boaster's audience comes to believe
    // --- fourth wave: the SHIELD verb — a sworn bodyguard (LOYALTY/SACRIFICE) ---
    bodyguard: true,         // a brave soul is sworn to shadow + shield an endangered/notable one
    bodyguardMax: 2,         // at most this many standing bodyguards at once
    bodyguardRisk: 0.55,     // a guard must be at least this brave
    // --- fifth wave: the DUEL goal — two rivals settle a feud in single combat ---
    duel: true,              // CONFLICT: bitter rivals meet for binding single combat (a feud RESOLUTION)
    duelHpYield: 0.35,       // a duelist below this HP fraction YIELDS — honor satisfied, the feud closes
    duelTTL: 55,             // call off an unresolved duel after this (sim-seconds)
    // --- sixth wave: WARM tropes (balance the dark feed with positive bonds) ---
    prodigalReturn: true,    // RECOVERY: a restless wanderer comes home to their kin at last
    debtRepaid: true,        // LOYALTY: one who was helped in need repays the debt in kind
    mentorPride: true,       // LEGACY: a master beams with pride as their apprentice comes into their own
    // --- ARC COMPOSITION: chain single beats into shaped multi-beat stories ---
    reckoningArc: true,      // a betrayal escalates → sworn vengeance → a duel to settle it
    tyrantFallArc: true,     // a gouging tyrant → town resentment → a champion's duel OR a redemption
    spyWebArc: true,         // a disguised spy → suspicion whispers gather → the cover is torn away
    starCrossed: true,       // ROMANCE: two unwed souls from FEUDING houses fall for each other despite it
    starCrossedResolve: 0.52,// combined nerve above which love DEFIES the feud (a union that heals it); below → heartbreak
    houseFeud: true,         // keep a few inter-house FEUDS simmering (activates inherited rivalries + star-crossed romance)
    houseFeudCap: 3,         // max concurrent live house feuds (each healed by a cross-house marriage)
    wronglyAccused: true,    // HEARSAY TRAGEDY: a false slander brands an innocent → it spreads → the truth prevails (exoneration) OR comes too late (tragedy). Inversion of the spy's web.
    masterMinLevel: 6,       // a "master" is a townsperson at/above this total level
    apprenticeMaxLevel: 5,   // an "apprentice" is one at/below this
    proximity: 26,           // how close the constellation must be to count
    rivalryDrop: 0.6,        // how hard a seeded rivalry sours mutual standing
    feudDrop: 0.7,           // how hard a feud sours it
  },

  // CARAVAN — the town DISPATCHES a trader on a long trade-road loop (out to a distant
  // point and back), carrying a staple good. Out there beyond the watchtowers, bandits
  // ambush it: a waylaid caravan's cargo is LOST and that good grows scarce (a real
  // logistics blow); a caravan that returns brings PLENTY (the good gets cheaper). The
  // Watch/heroes can ride out to save it — supply lines become worth defending. See
  // director._tropeCaravan / _advanceCaravans + combatEvents.
  caravan: {
    every: 70,            // sim-seconds between caravan dispatches (a recurring supply run)
    minTownPop: 16,       // …only when the town can spare a trader
    dist: 46,             // how far out the trade road runs (well beyond tower reach ~22)
    ambushAt: 0.7,        // ambush sprung at this fraction OUT along the road (on the route,
                          //   beyond the towers, so it actually intercepts the caravan)
    goods: ['ore', 'wood', 'food', 'herb'],   // what a caravan might be carrying
    ambushers: 6,         // bandits sprung on the road (enough to overwhelm 2 guards sometimes)
    speedMul: 1.4,        // clearly faster than the fleeing caravan, so the chase connects
    ttl: 40,              // the ambushers give up after this (long enough to run a caravan down)
    leashR: 24,           // bandits chase the caravan this far from the ambush — never into town
    runTTL: 120,          // a caravan that can't complete its loop in this just arrives home
    // a caravan is a GROUP: the trader (carries the load) + hired guards (fight the
    // ambush) + porters (flee). Partial losses (a porter/guard cut down) bite the
    // good's price a LITTLE; the trader's death is the full shortage.
    guards: 2,            // armed escorts that stand and fight the bandits
    porters: 2,           // hands that carry/flee — their loss is a partial shortage
    recruitR: 26,         // recruit escorts from idle townsfolk within this of the trader
    windfallMul: 0.86,    // a safe return makes its good cheaper (plenty)
    shortageMul: 1.22,    // a lost caravan (trader killed) makes its good dearer (scarcity)
    partialShortageMul: 1.07,  // a partial loss (an escort cut down) — a milder price bump
  },

  // WAR — a faction-scale arc. A camp leader becomes a named warlord (a persistent,
  // un-leashed boss via the nemesis machinery) and raids INTENSIFY until it falls.
  // Modest multipliers so a war is dangerous but the floor (towers + minPop reprieve)
  // still holds — verified the town survives wars.
  war: {
    warlordNames: ['Gor the Black', 'Skarn Bonebreaker', 'Vald the Despoiler',
      'Mott Ironjaw', 'Hralga the Cruel', 'Drum the Wrathful'],
    hpMul: 4, threatMul: 1.5, speedMul: 1.25,   // the warlord is a heavy boss (tanky enough to
                                                //   lead a siege, not melt at the towers in seconds)
    intensity: 1.4,          // raid waves are this much bigger while at war
    extraWave: 2,            // …and may exceed the normal wave cap by this many
    extraConcurrent: 3,      // …with a raised concurrency cap
    cooldownMul: 0.65,       // …and shorter lulls between waves
  },

  // PACING — dramatic rhythm (the storyteller, not just the spawner). The director
  // tracks TENSION (rises with raids/war, decays in calm); when a high-tension peak
  // RESOLVES (a war won, a raid wave seen off), the town earns a RELIEF window — no
  // new raids, the pall of fear lifts, and in the breathing room bonds form (births +
  // weddings flourish in peace). Gives the world a build-up→climax→relief shape and
  // the EMOTIONAL CONTRAST a flat conflict stream lacks.
  pacing: {
    enabled: true,
    decay: 0.025,            // tension lost per director roll of calm (slow — so an intense
                             //   STRETCH of raids accumulates past the threshold, not single waves)
    raidTension: 0.22,       // tension gained per raid wave (+ a little per raider)
    reliefThreshold: 0.34,   // a peak above this, once the threat clears, earns a relief
    reliefDuration: 45,      // sim-seconds of respite (no new raids) — the town breathes
  },

  // RAID — population-scaled waves with lulls; bounded concurrency. The single
  // most important block: this is the difficulty curve AND the anti-massacre valve.
  raid: {
    minPop: 12,           // raids STOP at/below this and any ongoing raid withdraws — the
                          //   anti-extinction floor (towers now only harass, so this carries
                          //   it). Set so a bled town keeps a viable core that REBUILDS via
                          //   births instead of getting ground down and stuck low — the dip
                          //   bounces back into a boom/bust pulse rather than a death spiral.
    baseSize: 1,          // smallest wave (a lone raider) once raids start
    perTownsfolk: 0.24,   // extra raiders per living townsperson above minPop — a prosperous
                          //   town draws big waves (the amplitude of the pulse). Safe to be
                          //   steep: the towers are the floor, the leash keeps camps/monsters
                          //   off a weakened town, and raiders WITHDRAW on TTL/reprieve.
    maxWave: 6,           // hard cap on a single wave
    maxConcurrent: 12,    // hard cap on simultaneously-alive director raiders
    raiderSpeedMul: 1.1,  // a slight edge over a fleeing townsperson so raids actually claim
                          //   stragglers (at equal speed they caught nobody → zero stakes)
    raiderTTL: 32,        // sim-seconds a raider harries before WITHDRAWING — raids are
                          //   transient WAVES, not a permanent siege. This (with cooldown)
                          //   is what makes the pressure pulse: wave → losses → withdraw →
                          //   lull → the town's couples rebuild → next wave.
    cooldown: 22,         // sim-seconds of LULL enforced between raids
    spawnRingMin: 34,     // raiders appear on a ring this far from town centre...
    spawnRingMax: 50,     // ...out to here, then advance inward (far enough that the
                          //   valve has time to react before a wave reaches the core)
  },

  // OPPORTUNITY — a passing caravan (richer trade beliefs) or a recruitable
  // wanderer (curiosity nudge). No new bodies, no minted gold.
  opportunity: {
    caravanShare: 0.5,        // P(caravan) vs P(wanderer)
    caravanPriceMul: 1.12,    // transient sell-side price-belief brightening
    wanderCuriosity: 0.15,    // curiosity added to the chosen wanderer (clamped)
  },

  // CRISIS — a light transient scarcity shock on one staple (price beliefs only;
  // the market tatonnements it back down). No inventory/gold mutation.
  crisis: {
    staples: ['food', 'wood', 'ore'],
    affectShare: 0.5,     // per-townsperson chance to feel the shock
    maxAffected: 6,       // bounded fan-out
    priceMul: 1.25,       // belief inflation on the scarce good
  },

  // SPARK — seed a feud (mutual negative belief-standing) or a one-sided theft
  // grievance. Writes beliefs only (the standing/deception layer), never truth.
  spark: {
    standingDrop: 0.5,    // how far a grievance pushes belief-standing down
    feudShare: 0.5,       // P(mutual feud) vs P(one-sided theft grievance)
  },
};

// CHRONICLE — the live drama feed (js/sim/chronicle.js). Tunes what gets pulled
// out of the deed firehose and into the story log: only NOTABLE beats, bounded.
export const CHRONICLE = {
  cap: 320,              // ring-buffer size: most-recent N beats kept. Sized for a POPULOUS town —
                         //   at 80 the feed churned so fast that an ordinary townsperson's deeds
                         //   (slaying a raider in the town's defence) scrolled off within seconds and
                         //   never reached the Gazette/UI; legibility for rank-and-file lives needs depth.
  legendCap: 400,        // the SAGA ledger: how many momentous beats the town remembers
                         //   long-term (heroes, nemeses, gods, surpassings) — the history view
  // a windfall (a shrewd deal) — sell/buy events carry a profit/bargain RATIO in
  // magnitude (1 + margin). Only an exceptional margin is story-worthy ("a killing").
  windfallMargin: 0.6,   // margin (magnitude-1) over belief at which a trade is a coup
  // class/level milestones: only crossing one of these levels is story-worthy
  // (so we log a prodigy RISING, not every routine level-up).
  levelMarks: [3, 5, 8, 12, 16, 20, 25, 30],
  // per-(kind,subject) cooldown so a flurry of the same beat is ONE entry, not a torrent
  dedupeSecs: 4,
  // raid/birth tally pollers run on this throttle (sim-seconds); director/lineage
  // expose counters, not bus events, so the chronicle samples their deltas.
  pollSecs: 2,
};

// --- INTRIGUE: the dormant Theory-of-Mind DECEPTION layer (drama §3) ----------
// Switch on the deception the engine was built for. A config FRACTION of an
// enabling camp's followers become SPIES: they wear a town COVER IDENTITY
// (disguiseFaction — perceived as townsfolk, ground-truth faction unchanged),
// infiltrate the town core, and PLANT FALSE RUMOURS (BeliefStore.plant) into
// townsfolk observers — marking an innocent neighbour as hostile to ignite a
// feud — then EXFILTRATE. The whole point is the EPISTEMIC SPLIT: only BELIEFS
// are falsified; combat (simulation.isHostile) still reads true factions, so a
// disguised raider that actually swings is resolved as the enemy it truly is.
// Planted beliefs use RUMOR provenance at low confidence so they FADE (decay)
// unless reinforced. Everything is LIGHT, gated, and guarded (the freeze lesson):
// flip `enabled` off and the subsystem is wholly inert. See js/sim/intrigue.js.
export const INTRIGUE = {
  enabled: true,
  spyFactions: ['bandit'],   // which camp factions field infiltrators
  spyFraction: 0.5,          // fraction of an enabling camp's FOLLOWERS made spies
  disguiseAs: 'townsfolk',   // the cover faction a spy is PERCEIVED as (disguise)
  tickEvery: 4,              // sim-seconds between intrigue passes (self-throttled)
  plantCadence: 14,          // sim-seconds a spy waits between planting rumours
  coreRadius: 36,            // a spy must be within this of the town core to plant
  frameRadius: 24,           // the framed innocent must be within this of the spy
  plantConfidence: 0.4,      // RUMOR-grade confidence the false belief is written at
  plantSuspicion: 0.5,       // suspicion seeded alongside the false hostility
  exfilAfterPlant: true,     // having whispered, the spy slips back to its camp
  coverName: true,           // a spy wears a TOWN cover NAME (a trusted neighbour), so its
                             //   eventual unmasking lands as a betrayal, not "Bandit 3 caught"
  unmaskChance: 0.28,        // chance a PLANT is witnessed and the spy is exposed — its cover
                             //   blown, the town now perceives its true faction and hunts it
};

// --- TRACE: the reasoning-trace diagnostic side-channel (docs/reasoning-traces.md) ---
// A small, bounded, per-agent ring buffer of *why this mind did what it did this tick*,
// WRITTEN BY cognition (own-view only) and NEVER read back by a decision (the one
// non-negotiable rule). Read only by the UI (truth-side) + tests. Entries are CHEAP
// STRUCTURED records; the human string is built lazily on read (traceLabel) — the
// label-cache lesson, so tracing the whole town costs no per-frame string work.
//   enabled — global off switch for a pure-perf soak; off → note() is a guarded
//             early-return (byte-stable, zero allocation), so the soak baseline is
//             unchanged either way. Default ON (always-available diagnostics; tests want it).
//   depth   — entries retained per agent (a ring; appending past the cap overwrites the
//             oldest). 24 balances "enough to see a decision chain" against memory
//             (~agents × depth tiny objects). See js/sim/trace.js.
export const TRACE = {
  enabled: true,
  depth: 24,
  // --- health: the lifetrace tool's ANOMALY HEALTH-CHECKS + COHORT thresholds (test/lifetrace.mjs).
  // PURE OBSERVER-LAYER / display-side: read only by the tool + its regression asserts, NEVER by
  // cognition (the trace's write-only rule extends — a health-check is read-only-on-the-side-channel).
  // Every check is a RATIO (rate-per-X / share-of-total) so it is SCALE-FREE, gated by an absolute-N
  // FLOOR so a tiny / early world can't false-fire (the single most important field). The defaults
  // below are ORDERINGS, not measured constants — calibrate against a healthy soak (doc 13 §1 rule:
  // orderings, not measurements). Tuning lives here, not in the tool's logic (CLAUDE.md convention).
  health: {
    // (a) signalChurn — per-agent event-rate implausibility. Per family rate CEILING (events/life);
    //     FLAG when perAgentRate > ceiling AND total >= floor (so a 3-agent smoke run can't trip it).
    signalRateCeiling: { oaths: 8, deeds: 40, gossip: 200, beats: 12, goals: 60 },
    signalFloor: 200,
    // (b) corpseBloat — dead >> alive. FLAG when dead > alive * ratio AND total (ever-spawned) >= floor.
    bloatRatio: 2.0,
    bloatFloor: 50,
    // (c) salienceCollapse — memory decay-to-zero. FLAG when share of LTM/MTM entries at/below eps
    //     >= collapseFrac (a DISTRIBUTION test, not the mean) OR meanSalience <= eps, AND sampled >= floor.
    salienceEps: 0.02,
    collapseFrac: 0.95,
    salienceFloor: 100,
    // (d) arcMonoculture — one arc-KIND (or one OUTCOME) dominates the closed-arc ring. FLAG when the
    //     top share > monoFrac AND closedTotal >= floor.
    monoFrac: 0.80,
    arcFloor: 25,
    // (e) behaviorCollapse — agents stuck in one goal. Per-agent dominantGoalFrac > stuckFrac; cohort
    //     FLAG when the share of living agents that stuck itself exceeds collapsePopFrac AND living >= floor.
    stuckFrac: 0.90,
    collapsePopFrac: 0.25,
    behaviorFloor: 20,
    // the MEASURED sample must cover at least this fraction of the living roster or the check holds
    // its fire (a thin sample is the trace-ring artifact this measure retired — measured 12/103 then).
    measuredFloorFrac: 0.5,
    // cohort metric 2 (keptOathRatioDist) zero-bucket edge; the quantile set is fixed (p10/p50/p90).
    keptOathZeroEps: 1e-9,
  },
};

