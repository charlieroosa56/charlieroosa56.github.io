/* Machine List: field list, which fields apply to which unit, and the due-date math.
   Same rules as the crew equipment app. Field labels and section titles match the master
   sheet's column headers, so an approved change can be copied back into the right cell.
   Names and groupings come from your sheet's Settings tab (see configure below), not from here. */
(function (root) {
  "use strict";

  const CATS = {
    E: "Excavators", P: "Payloaders", S: "Skid Steers", M: "Mini Loaders", D: "Dozers",
    H: "Haul Trucks", R: "Rollers", LF: "Lifts", C: "Small Engine – Compaction",
    T: "Small Engine – Saws & Tools", DT: "Dump Trucks", TC: "Tractor",
    PU: "Pickups / Service Trucks", TB: "Tow-Behinds", TR: "Trailers"
  };
  const CAT_ORDER = ["E", "P", "S", "M", "D", "H", "R", "LF", "C", "T", "DT", "TC", "PU", "TB", "TR"];

  // How the fleet list is grouped. Excavators split three ways, by unit (filled in from the sheet's
  // Settings tab); any excavator not listed is a counterweight excavator. GROUP_ORDER is the order of the
  // tabs at the top and of the list.
  const EX_TYPE = {};
  const EX_NAMES = { mini: "Mini Excavators", zero: "Zero Turn Excavators", conv: "Counterweight Excavators" };
  const GROUP_ORDER = ["ex-mini", "ex-zero", "ex-conv", "DT", "PU", "P", "S", "M", "D", "H", "R", "LF", "TC", "TB", "TR", "C", "T"];
  const NO_TAB = new Set(["C", "T"]);   // small engines get no tab; people's own saws and plates go in their section
  // An excavator added in the app carries its own group (ext) until the sheet's Settings lists say otherwise.
  const groupOf = u => (u.code === "E" ? "ex-" + (EX_TYPE[u.id] || (u.ext === "mini" || u.ext === "zero" ? u.ext : "conv")) : u.code);
  const groupName = k => (String(k).startsWith("ex-") ? EX_NAMES[k.slice(3)] : CATS[k]) || "Other";
  const codeOfGroup = k => (String(k).startsWith("ex-") ? "E" : String(k));

  // New units: the letters their IDs start with (the same as the master sheet), the field group each kind of
  // equipment uses, and the types to pick from where the type changes which fields apply.
  const ID_PREFIX = { E: "EX", P: "PL", S: "SS", M: "ML", D: "DZ", H: "HT", R: "RL", LF: "LF", C: "CP", T: "SE", DT: "DT", TC: "TC", PU: "PU", TB: "TB", TR: "TR" };
  const CODE_G = { E: "HEQ", P: "HEQ", S: "HEQ", M: "HEQ", D: "HEQ", H: "HEQ", R: "HEQ", LF: "HEQ", C: "SML", T: "SML", DT: "TRK", TC: "TRK", PU: "TRK", TB: "TOW", TR: "TRL" };
  const KINDS = {
    TB: [["light", "Light tower"], ["comp", "Air compressor"], ["mixer", "Mixer"], ["", "Something else"]],
    TR: [["", "Equipment trailer"], ["lowboy", "Lowboy"], ["flowboy", "Flow boy"], ["dumptrl", "Dump trailer"]]
  };
  // One of them, the way a sentence would say it: "a tow-behind", "an excavator".
  const ONE_OF = { "ex-mini": "mini excavator", "ex-zero": "zero turn excavator", "ex-conv": "counterweight excavator", P: "payloader", S: "skid steer",
    M: "mini loader", D: "dozer", H: "haul truck", R: "roller", LF: "lift", DT: "dump truck", TC: "tractor", PU: "pickup or service truck", TB: "tow-behind", TR: "trailer",
    C: "compaction machine", T: "saw or tool" };
  const oneOf = k => ONE_OF[k] || "unit";

  const isTwo = u => u.kind === "demo" || u.kind === "chain";
  const hasHammer = u => (u.att || []).some(a => /hammer/i.test(a));
  const inCode = (...cs) => u => cs.includes(u.code);
  const inG = (...gs) => u => gs.includes(u.g);
  const inKind = (...ks) => u => ks.includes(u.kind);
  const or = (...fs) => u => fs.some(f => f(u));
  const and = (...fs) => u => fs.every(f => f(u));
  const not = f => u => !f(u);

  const R = {
    ALL: () => true,
    ENG: u => u.g !== "TRL",
    METER: or(inG("HEQ", "TRK", "TOW"), inCode("C")),
    LOC: or(inG("HEQ"), inCode("C")),   // where it is: machines and compaction gear, not trucks, trailers, tow-behinds or saws
    BIG: inG("HEQ", "TRK", "TOW"),
    TRK: inG("TRK"),
    TRL: inG("TRL"),
    SML: inG("SML"),
    HEQ: inG("HEQ"),
    ROAD: inG("TRK", "TRL", "TOW"),
    BAT: inG("HEQ", "TRK", "TOW", "TRL"),
    HEQ_TRK: inG("HEQ", "TRK"),
    HEQ_SML: inG("HEQ", "SML"),
    TRK_TRL: inG("TRK", "TRL"),
    NOT_TWO: not(isTwo),
    ATT: or(inCode("E", "P", "S", "M", "D", "DT", "PU"), inKind("broom")),
    BKT: inCode("E", "P", "S", "M"),
    EDGE: inCode("E", "P", "S", "M", "D"),
    DOZER: inCode("D"),
    EXC: inCode("E"),
    HAMMER: hasHammer,
    HYD_FLUID: or(inG("HEQ"), inCode("DT", "TC"), inKind("dumptrl", "lowboy", "plate_rev")),
    HYD_SYS: or(inG("HEQ"), inCode("DT", "TC"), inKind("dumptrl", "lowboy")),
    HYD_FILT: or(inG("HEQ"), inCode("DT", "TC")),
    CASE: inCode("E", "S", "M", "D"),
    TRANS: or(inCode("P", "D", "H"), inG("TRK")),
    FD: inCode("E", "S", "M", "D", "R", "LF"),
    AXLE: or(inCode("P", "H", "R"), inG("TRK")),
    ROLLER: inCode("R"),
    PTO: inCode("DT", "TC"),
    SPARK: or(inG("SML", "TOW"), inCode("PU")),
    MIX: or(isTwo, inKind("jj")),
    DBELT: inKind("demo", "broom", "plate", "plate_rev"),
    DEMO: inKind("demo"),
    CHAIN: inKind("chain"),
    COMPACT: inCode("C"),
    LIGHT: inKind("light"),
    COMP: inKind("comp"),
    AXCFG: or(inG("TRK", "TRL", "TOW"), inCode("H")),
    TIRE: or(inCode("P", "S", "M", "H", "R", "LF"), inG("TRK", "TRL", "TOW")),
    TFILL: inCode("P", "S", "M", "H", "LF"),
    TRACK: inCode("E", "D", "S", "M"),
    SHOE: inCode("E", "D"),
    BODY: or(inCode("DT"), inKind("dumptrl")),
    TARP: or(inCode("DT"), inKind("dumptrl", "flowboy")),
    PLOW: inCode("DT", "PU"),
    HUT: inCode("DT", "TC"),
    ENG_NOT_TWO: and(u => u.g !== "TRL", not(isTwo)),
    BELT_SVC: inKind("demo", "chain", "broom", "plate", "plate_rev"),
    ANNUAL: inCode("LF")   // lifts only; trucks, trailers and tow-behinds use the State inspection card instead
  };

  // Filled in from the sheet's Settings tab: the people list, and how master-sheet initials show.
  const PEOPLE = [];
  const FIRST_NAMES = {};
  function personName(o) {
    if (!o) return "";
    const s = String(o).trim();
    if (FIRST_NAMES[s]) return FIRST_NAMES[s];
    return s.includes(" – ") ? s.split(" – ").slice(1).join(" – ") : s;
  }
  const atShop = u => !!u && R.LOC(u) && /\bshop\b/i.test(String((u.v || {}).loc || ""));
  const LISTS = {
    people: PEOPLE,
    status: ["Active", "In Shop", "Down – Needs Repair", "Out of Service", "Sold"],
    setup: ["Quick attach", "Fixed pin", "Fixed pin (swapped often)", "Quick attach plate"],
    yn: ["Yes", "No"],
    track: ["Steel", "Rubber"],
    newused: ["New", "Used"]
  };

  // Settings from the sheet: { people: [...], initials: {"AB": "Alex"}, exTypes: {"EX-01": "mini"} }
  function configure(cfg) {
    cfg = cfg || {};
    PEOPLE.splice(0, PEOPLE.length, ...(Array.isArray(cfg.people) ? cfg.people.map(String) : []));
    Object.keys(FIRST_NAMES).forEach(k => delete FIRST_NAMES[k]);
    Object.assign(FIRST_NAMES, cfg.initials && typeof cfg.initials === "object" ? cfg.initials : {});
    Object.keys(EX_TYPE).forEach(k => delete EX_TYPE[k]);
    const ex = cfg.exTypes && typeof cfg.exTypes === "object" ? cfg.exTypes : {};
    Object.keys(ex).forEach(id => { if (ex[id] === "mini" || ex[id] === "zero") EX_TYPE[id] = ex[id]; });
  }

  // [key, label (= master sheet header), rule, type]
  // types: text | pn (part number) | num | date | expiry | money | list:<name> | sel:<name>
  const SECTIONS = [
    { title: "IDENTITY & STATUS", short: "Identity & status", fields: [
      ["name", "Unit Name", "ALL", "text"],
      ["owner", "Assigned To / Owner", "ALL", "list:people"],
      ["status", "Status", "ALL", "sel:status"],
      ["make", "Make", "ALL", "text"],
      ["model", "Model", "ALL", "text"],
      ["year", "Year", "ALL", "text"],
      ["serial", "Serial # / PIN / VIN", "ALL", "pn"],
      ["plate", "Plate / Reg #", "ROAD", "pn"],
      ["key", "Key # / Key Type", "ENG", "text"],
      ["loc", "Current Job / Location", "LOC", "text"]] },
    { title: "HOURS", short: "Hours", special: true, fields: [
      ["cur", "Current Hours (miles for trucks)", "METER", "num"],
      ["read", "Date Read", "METER", "date"],
      ["enghrs", "Engine Hours (trucks)", "TRK", "num"]] },
    { title: "SPECS & ENGINE", short: "Specs & engine", fields: [
      ["size", "Size / Rating (tons, class)", "ALL", "text"],
      ["weight", "Operating / Empty Weight (lbs)", "ALL", "num"],
      ["engine", "Engine Make / Model", "ENG", "text"],
      ["engserial", "Engine Serial #", "BIG", "pn"]] },
    { title: "BUCKETS & ATTACHMENTS", short: "Bucket setup & wear parts", fields: [
      ["setup", "Bucket / Mount Setup", "BKT", "list:setup"],
      ["attnotes", "Bucket / Attachment Condition & Notes", "ATT", "text"],
      ["nteeth", "# Teeth (main bucket)", "BKT", "num"],
      ["edge", "Cutting Edge P/N", "EDGE", "pn"],
      ["sidecut", "Side Cutter / End Bit P/N", "EDGE", "pn"],
      ["blade", "Dozer Blade Type (PAT / 6-way / straight / U)", "DOZER", "text"],
      ["hammer", "Hammer Make / Model", "HAMMER", "text"],
      ["chisel", "Hammer Chisel / Tool P/N", "HAMMER", "pn"]] },
    { title: "ENGINE OIL", short: "Engine oil", fields: [
      ["oiltype", "Engine Oil Type / Weight", "ENG_NOT_TWO", "text"],
      ["oilcap", "Engine Oil Capacity w/ Filter (qt)", "ENG_NOT_TWO", "text"],
      ["oilfilt", "Oil Filter P/N", "BIG", "pn"]] },
    { title: "FUEL FILTERS", short: "Fuel filters", fields: [
      ["ff1", "Fuel Filter – Primary P/N", "ENG", "pn"],
      ["ff2", "Fuel Filter – Secondary P/N", "BIG", "pn"],
      ["fws", "Fuel / Water Separator P/N", "BIG", "pn"]] },
    { title: "AIR FILTERS", short: "Air filters", fields: [
      ["af1", "Air Filter – Outer / Primary P/N", "ENG", "pn"],
      ["af2", "Air Filter – Inner / Safety P/N", "BIG", "pn"],
      ["afx", "Air Filter Cross-Ref", "ENG", "pn"],
      ["cab", "Cab Air Filter P/N", "HEQ_TRK", "pn"],
      ["precl", "Pre-Cleaner / Pre-Filter P/N", "HEQ_SML", "pn"]] },
    { title: "COOLING · BELTS · DEF", short: "Cooling, belts & DEF", fields: [
      ["cooltype", "Coolant Type", "BIG", "text"],
      ["coolcap", "Coolant Capacity (gal)", "BIG", "text"],
      ["fanbelt", "Fan / Serpentine Belt P/N", "BIG", "pn"],
      ["altbelt", "Alternator / A/C Belt P/N", "BIG", "pn"],
      ["deftype", "DEF Type / Spec", "HEQ_TRK", "text"],
      ["deffilt", "DEF Filter P/N", "HEQ_TRK", "pn"],
      ["ccv", "Crankcase Breather / CCV Filter P/N", "HEQ_TRK", "pn"]] },
    { title: "HYDRAULICS", short: "Hydraulics", fields: [
      ["hydtype", "Hydraulic Fluid Type", "HYD_FLUID", "text"],
      ["hydtank", "Hydraulic Tank Capacity (gal)", "HYD_FLUID", "text"],
      ["hydsys", "Hydraulic System Capacity (gal)", "HYD_SYS", "text"],
      ["hydfilt", "Hydraulic Filter P/N", "HYD_FILT", "pn"],
      ["hydret", "Hydraulic Return Filter P/N", "HEQ", "pn"],
      ["pilot", "Pilot Filter P/N", "EXC", "pn"],
      ["casedrain", "Case Drain Filter P/N", "CASE", "pn"],
      ["breather", "Hydraulic Breather / Tank Cap P/N", "HEQ", "pn"],
      ["hamfilt", "Hammer Circuit Filter P/N", "HAMMER", "pn"],
      ["hydx", "Hydraulic Filter Cross-Ref", "HYD_FILT", "pn"]] },
    { title: "DRIVETRAIN & GEAR OILS", short: "Drivetrain & gear oils", fields: [
      ["transtype", "Transmission Fluid Type", "TRANS", "text"],
      ["transcap", "Transmission Capacity", "TRANS", "text"],
      ["transfilt", "Transmission Filter P/N", "TRANS", "pn"],
      ["fdtype", "Final Drive / Chaincase Oil Type", "FD", "text"],
      ["fdcap", "Final Drive Capacity (each)", "FD", "text"],
      ["swingtype", "Swing Drive Oil Type", "EXC", "text"],
      ["swingcap", "Swing Drive Capacity", "EXC", "text"],
      ["axletype", "Axle / Differential Oil Type", "AXLE", "text"],
      ["axlecap", "Axle / Differential Capacity", "AXLE", "text"],
      ["drumoil", "Drum / Eccentric (Vibe) Oil", "ROLLER", "text"],
      ["hub", "Wheel Hub Oil / Bearing Grease", "ROAD", "text"],
      ["pto", "PTO / Hoist Pump Notes", "PTO", "text"]] },
    { title: "GREASE", short: "Grease", fields: [
      ["greasetype", "Grease Type", "NOT_TWO", "text"],
      ["autolube", "Auto-Lube System? (Y/N)", "HEQ_TRK", "sel:yn"]] },
    { title: "SMALL ENGINE & SAW PARTS", short: "Small engine & saw parts", fields: [
      ["plug", "Spark Plug P/N", "SPARK", "pn"],
      ["gap", "Spark Plug Gap", "SPARK", "text"],
      ["mix", "2-Stroke Mix Ratio", "MIX", "text"],
      ["recoil", "Recoil Starter Rope / Pulley P/N", "SML", "pn"],
      ["carb", "Carburetor / Primer Bulb P/N", "SML", "pn"],
      ["dbelt", "Drive Belt P/N", "DBELT", "pn"],
      ["bladesize", "Blade Size (12\" / 14\" / 16\")", "DEMO", "text"],
      ["bladetype", "Blade Type / Brand", "DEMO", "text"],
      ["arbor", "Arbor Size", "DEMO", "text"],
      ["water", "Water Kit / Hose P/N", "DEMO", "pn"],
      ["bar", "Bar Length", "CHAIN", "text"],
      ["chainpn", "Chain P/N (pitch / gauge / drive links)", "CHAIN", "pn"],
      ["plateshoe", "Plate / Shoe Size", "COMPACT", "text"]] },
    { title: "TOW-BEHIND EXTRAS", short: "Tow-behind extras", fields: [
      ["lamps", "Light Tower – Lamp Type / Qty", "LIGHT", "text"],
      ["mast", "Light Tower – Mast Height", "LIGHT", "text"],
      ["kw", "Generator Output (kW)", "LIGHT", "text"],
      ["compoil", "Compressor Oil Type / Capacity", "COMP", "text"],
      ["sep", "Compressor Separator Element P/N", "COMP", "pn"],
      ["compair", "Compressor Intake Air Filter P/N", "COMP", "pn"]] },
    { title: "TIRES", short: "Tires", fields: [
      ["axcfg", "Axle Configuration", "AXCFG", "text"],
      ["naxles", "# Axles", "AXCFG", "num"],
      ["tsteer", "Steer / Front Tire Size", "TIRE", "pn"],
      ["tdrive", "Drive / Rear Tire Size", "TIRE", "pn"],
      ["ttag", "Tag / Lift / Trailer Axle Tire Size", "TRK_TRL", "pn"],
      ["ntires", "Total # Tires", "TIRE", "num"],
      ["psi", "Tire PSI", "TIRE", "text"],
      ["tbrand", "Tire Brand / Model", "TIRE", "text"],
      ["ply", "Ply / Load Range", "TIRE", "text"],
      ["tfill", "Tire Fill (air / foam / ballast)", "TFILL", "text"],
      ["spare", "Spare Tire? (Y/N)", "ROAD", "sel:yn"],
      ["lasttire", "Last Tire Change", "TIRE", "date"],
      ["lug", "Lug Nut Size / Torque", "TIRE", "text"]] },
    { title: "TRACKS & UNDERCARRIAGE", short: "Tracks & undercarriage", fields: [
      ["tracktype", "Track Type (Steel / Rubber)", "TRACK", "sel:track"],
      ["tracksize", "Track Size (Width × Pitch × Links)", "TRACK", "pn"],
      ["shoe", "Track Shoe Width / Grouser", "SHOE", "text"],
      ["trackpn", "Track / Chain P/N", "TRACK", "pn"],
      ["sprocket", "Sprocket P/N", "TRACK", "pn"],
      ["idler", "Idler P/N", "TRACK", "pn"],
      ["rollers", "Bottom / Top Roller P/N", "TRACK", "pn"],
      ["ucwear", "Undercarriage Wear %", "TRACK", "text"],
      ["lasttrack", "Last Track Replaced", "TRACK", "date"],
      ["drumw", "Drum Width", "ROLLER", "text"],
      ["drumtype", "Drum Type (Smooth / Padfoot / Shell Kit)", "ROLLER", "text"]] },
    { title: "BATTERIES", short: "Batteries", fields: [
      ["nbat", "# Batteries", "BAT", "num"],
      ["volt", "Voltage (12V / 24V)", "BAT", "text"],
      ["bgroup", "Battery Group Size", "BAT", "pn"],
      ["cca", "CCA", "BAT", "num"],
      ["bpn", "Battery Brand / P/N", "BAT", "pn"],
      ["bloc", "Battery Location", "BAT", "text"],
      ["binst", "Battery Install Date", "BAT", "date"],
      ["disc", "Battery Disconnect? (Y/N)", "HEQ_TRK", "sel:yn"]] },
    { title: "HITCH · BODY / DECK", short: "Hitch, body & deck", fields: [
      ["hitch", "Hitch / Coupler (Ball / Pintle / Gooseneck / 5th Wheel)", "ROAD", "text"],
      ["ball", "Ball / Pintle / Kingpin Size", "ROAD", "text"],
      ["plug7", "Light Plug Type (7-pin etc.)", "ROAD", "text"],
      ["chains", "Safety Chains / Tie-Downs", "TRL", "text"],
      ["decklen", "Deck Length", "TRL", "text"],
      ["deckwid", "Deck Width", "TRL", "text"],
      ["deckht", "Deck Height", "TRL", "text"],
      ["ramps", "Ramp Type", "TRL", "text"],
      ["gvwr", "GVWR (lbs)", "ROAD", "num"],
      ["body", "Dump Body Length / Capacity (cu yd)", "BODY", "text"],
      ["tarp", "Tarp System", "TARP", "text"],
      ["plow", "Plow / Sander Setup", "PLOW", "text"]] },
    { title: "PAPERWORK & OWNERSHIP", short: "Paperwork & ownership", fields: [
      ["reg", "Registration Expires", "ROAD", "expiry"],
      ["insp", "Inspection Expires", "ROAD", "expiry"],
      ["hut", "HUT (2290) Expires", "HUT", "expiry"],
      ["irp", "IRP / IFTA / HUT Notes", "HUT", "text"],
      ["warranty", "Warranty Expires", "ALL", "expiry"],
      ["pdate", "Purchase Date", "ALL", "date"],
      ["newused", "Bought New / Used", "ALL", "sel:newused"],
      ["price", "Purchase Price", "ALL", "money"],
      ["dealer", "Purchased From / Dealer", "ALL", "text"],
      ["dphone", "Dealer / Parts Phone", "ALL", "text"],
      ["title", "Title Location", "ROAD", "text"],
      ["ins", "Insurance / Policy Notes", "ALL", "text"],
      ["manual", "Manual / Parts Book Location", "ALL", "text"]] },
    { title: "NOTES", short: "Notes", fields: [
      ["issues", "Known Issues / Open Repairs", "ALL", "text"],
      ["notes", "Notes", "ALL", "text"]] }
  ];

  const FIELDS = {};
  SECTIONS.forEach(s => s.fields.forEach(([key, label, rule, type]) => {
    FIELDS[key] = { key, label, rule, type, section: s.title, sectionShort: s.short };
  }));

  const SERVICES = [
    ["oil", "ENGINE OIL & FILTER", "Engine oil & filter", "ENG_NOT_TWO", "Heavy equipment 250–500 hrs. Heavy trucks 10,000–25,000 mi. Pickups 5,000–10,000 mi. Small 4-stroke engines 25–100 hrs or each season."],
    ["fuel", "FUEL FILTERS", "Fuel filters", "ENG", "Heavy equipment about 500 hrs. Trucks per the engine manual. Small engines once a year."],
    ["air", "AIR FILTER", "Air filter", "ENG", "When the restriction indicator shows, or about 500 hrs. Small engines: clean daily to weekly in dusty work."],
    ["plug", "SPARK PLUG", "Spark plug", "SPARK", "Small engines: about once a year or 100 hrs."],
    ["hydf", "HYDRAULIC FILTERS", "Hydraulic filters", "HYD_FILT", "Often 500–1,000 hrs. Many machines want an early first change when new."],
    ["hydo", "HYDRAULIC OIL", "Hydraulic oil", "HYD_FILT", "Often 2,000–4,000 hrs, or go by oil-sample results."],
    ["grease", "GREASE", "Grease", "NOT_TWO", "Pins and bushings every 10 hrs or daily. Trailers and trucks monthly or every oil change."],
    ["cool", "COOLANT", "Coolant", "BIG", "Extended-life coolant often 3,000–6,000 hrs or 2–3 years. Test it yearly."],
    ["gear", "GEAR OILS (Final Drive · Swing · Axles · Trans)", "Gear oils", "HEQ_TRK", "Often 1,000–2,000 hrs. Check levels much more often."],
    ["belt", "BELT · BLADE · CHAIN", "Belt, blade & chain", "BELT_SVC", "Inspect every use and replace as needed."],
    ["hubs", "WHEEL BEARINGS / HUBS", "Wheel bearings & hubs", "ROAD", "Trailers: inspect or repack about once a year or 12,000 mi."],
    ["brakes", "BRAKES", "Brakes", "TRK_TRL", "Inspect every oil change, or every 3–6 months."],
    ["annual", "ANNUAL INSPECTION (DOT / NYS / Lift)", "Annual inspection", "ANNUAL", "Every 12 months."]
  ].map(([key, title, short, rule, typical]) => ({ key, title: "SERVICE: " + title, short, rule, typical }));
  const SVC = Object.fromEntries(SERVICES.map(s => [s.key, s]));
  const SVC_SUB = {
    ih: { label: "Every (hrs / mi)", hrs: true },
    im: { label: "Every (months)" },
    ld: { label: "Last Done – Date" },
    lh: { label: "Last Done – Hrs / Mi", hrs: true }
  };

  const applies = (u, rule) => (R[rule] ? R[rule](u) : true);
  const usesMeter = u => R.METER(u);
  const unitWord = u => (u.g === "TRK" ? "mi" : "hrs");
  const catName = u => groupName(groupOf(u));

  // ---------- values & dates
  function num(x) {
    if (x === null || x === undefined || x === "") return null;
    if (typeof x === "number") return isFinite(x) ? x : null;
    const n = Number(String(x).replace(/[, ]/g, ""));
    return isFinite(n) ? n : null;
  }
  function parseDate(s) {
    if (!s || typeof s !== "string") return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    return null;
  }
  const pad = n => String(n).padStart(2, "0");
  const isoDate = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const usDate = d => pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + "/" + d.getFullYear();
  function addMonths(d, months) {
    const y = d.getFullYear(), m = d.getMonth() + months, day = d.getDate();
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(day, last));
  }
  function startOfToday(now) {
    const d = now ? new Date(now) : new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const dayDiff = (a, b) => Math.round((a - b) / 86400000);
  const fmtNum = n => (n === null ? "" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 }));

  // Same rules as the master sheet: OVERDUE, DUE SOON (within 10% of the interval or 30 days), OK.
  function serviceStatus(u, key, today) {
    const s = (u.svc || {})[key] || {};
    const meter = usesMeter(u);
    const ih = meter ? num(s.ih) : null, lh = meter ? num(s.lh) : null;
    const im = num(s.im), ld = parseDate(s.ld), cur = meter ? num((u.v || {}).cur) : null;
    const word = unitWord(u);
    const res = { key, st: "set", label: "Set interval", next: "", hrsLeft: null, daysLeft: null };
    if (ih === null && im === null) return res;
    const hrsOK = ih !== null && lh !== null && cur !== null;
    const dteOK = im !== null && ld !== null;
    const nextParts = [];
    if (ih !== null && lh !== null) {
      const due = lh + ih;
      let t = fmtNum(due) + " " + word;
      if (cur !== null) {
        const left = due - cur;
        res.hrsLeft = left;
        t += left < 0 ? " (" + fmtNum(-left) + " over)" : " (" + fmtNum(left) + " left)";
      }
      nextParts.push(t);
    }
    if (dteOK) {
      const dd = addMonths(ld, im);
      res.daysLeft = dayDiff(dd, today);
      res.dueDate = dd;
      nextParts.push(usDate(dd));
    }
    res.next = nextParts.join(" or ");
    if (!hrsOK && !dteOK) {
      res.st = "need";
      res.label = ih !== null && lh !== null ? "Enter current " + word : "Enter last service";
      return res;
    }
    const over = (hrsOK && res.hrsLeft <= 0) || (dteOK && res.daysLeft <= 0);
    const soon = (hrsOK && res.hrsLeft <= ih * 0.1) || (dteOK && res.daysLeft <= 30);
    res.st = over ? "over" : soon ? "soon" : "ok";
    res.label = over ? "Overdue" : soon ? "Due soon" : "OK";
    return res;
  }

  function expiryStatus(value, today) {
    const d = parseDate(value);
    if (!d) return null;
    const days = dayDiff(d, today);
    if (days < 0) return { st: "over", label: "Expired", days };
    if (days <= 30) return { st: "soon", label: "Due soon", days };
    return { st: "ok", label: "OK", days };
  }

  // State inspection (trucks, trailers, tow-behinds): done in a month, good through the end of that
  // month a year later. Yellow for the 3 months before that month, red in that month and after.
  // v.inspdone is the month it was done ("2027-08"); v.insp is the master sheet's Inspection Expires date.
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthYear = d => MONTHS[d.getMonth()] + " " + d.getFullYear();
  function inspExpiry(u) {
    const v = (u && u.v) || {};
    const d = parseDate(v.insp);
    if (d) return d;
    const m = String(v.inspdone || "").match(/^(\d{4})-(\d{2})$/);
    return m ? new Date(+m[1] + 1, +m[2], 0) : null;
  }
  function inspDone(u) {
    const m = String(((u && u.v) || {}).inspdone || "").match(/^(\d{4})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, 1);
    const d = inspExpiry(u);
    return d ? new Date(d.getFullYear() - 1, d.getMonth(), 1) : null;
  }
  function inspStatus(u, today) {
    const due = inspExpiry(u);
    if (!due) return null;
    const months = (due.getFullYear() - today.getFullYear()) * 12 + due.getMonth() - today.getMonth();
    if (months < 0) return { st: "over", label: "Expired", due, months };
    if (months === 0) return { st: "over", now: true, label: "Due this month", due, months };
    if (months <= 3) return { st: "soon", label: "Due soon", due, months };
    return { st: "ok", label: "OK", due, months };
  }

  function servicesFor(u) { return SERVICES.filter(s => applies(u, s.rule)); }

  // Everything that needs attention on one unit: service plus paperwork dates.
  function unitIssues(u, today) {
    const out = [];
    servicesFor(u).forEach(s => {
      const r = serviceStatus(u, s.key, today);
      if (r.st === "over" || r.st === "soon") out.push({ kind: "svc", key: s.key, label: s.short, st: r.st, detail: r.next });
    });
    ["reg", "insp", "hut", "warranty"].forEach(k => {
      const f = FIELDS[k];
      if (!applies(u, f.rule)) return;
      if (k === "insp") {
        const s = inspStatus(u, today);
        if (s && s.st !== "ok") out.push({ kind: "paper", key: k, label: "State inspection", st: s.st,
          pill: s.now ? "This month" : s.st === "over" ? "Expired" : "Soon",
          detail: (s.st === "over" && !s.now ? "Was good through " : "Good through ") + monthYear(s.due) });
        return;
      }
      const e = expiryStatus((u.v || {})[k], today);
      if (e && (e.st === "over" || e.st === "soon")) {
        const d = parseDate(u.v[k]);
        out.push({ kind: "paper", key: k, label: f.label.replace(" Expires", ""), st: e.st,
          detail: (e.st === "over" ? "Expired " : "Expires ") + usDate(d) });
      }
    });
    return out;
  }

  // Worst state first, like the sheet's OVERALL SERVICE STATUS (paperwork dates count too).
  function unitStatus(u, today) {
    const sts = servicesFor(u).map(s => serviceStatus(u, s.key, today).st);
    ["reg", "insp", "hut", "warranty"].forEach(k => {
      if (!applies(u, FIELDS[k].rule)) return;
      if (k === "insp") { const s = inspStatus(u, today); if (s) sts.push(s.now ? "now" : s.st); return; }
      const e = expiryStatus((u.v || {})[k], today);
      if (e) sts.push(e.st);
    });
    if (sts.includes("over")) return { st: "over", label: "Overdue" };
    if (sts.includes("now")) return { st: "over", label: "Due now" };
    if (sts.includes("soon")) return { st: "soon", label: "Due soon" };
    if (sts.includes("ok")) return { st: "ok", label: "OK" };
    if (sts.includes("need")) return { st: "need", label: "Needs info" };
    return { st: "set", label: "Not set up" };
  }

  function displayValue(f, v) {
    if (v === null || v === undefined || v === "") return "";
    if (v === "?") return "Not known yet";
    if (f && (f.type === "date" || f.type === "expiry")) {
      const d = parseDate(v);
      return d ? usDate(d) : String(v);
    }
    if (f && f.type === "money") { const n = num(v); return n === null ? String(v) : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
    if (f && f.type === "num") { const n = num(v); return n === null ? String(v) : fmtNum(n); }
    return String(v);
  }

  const ownerShort = personName;

  root.EQ_CORE = {
    CATS, CAT_ORDER, EX_TYPE, GROUP_ORDER, NO_TAB, groupOf, groupName, codeOfGroup, ID_PREFIX, CODE_G, KINDS, oneOf,
    R, LISTS, PEOPLE, SECTIONS, FIELDS, SERVICES, SVC, SVC_SUB,
    applies, usesMeter, unitWord, catName, num, parseDate, isoDate, usDate, addMonths, startOfToday,
    serviceStatus, expiryStatus, servicesFor, unitIssues, unitStatus, displayValue, fmtNum, ownerShort, personName, atShop,
    MONTHS, monthYear, inspStatus, inspDone, inspExpiry, configure
  };
})(typeof window !== "undefined" ? window : globalThis);
if (typeof module !== "undefined") module.exports = globalThis.EQ_CORE;
