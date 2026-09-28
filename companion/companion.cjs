let node_child_process = require("node:child_process");
let node_http = require("node:http");
let node_fs_promises = require("node:fs/promises");
let node_path = require("node:path");
let node_crypto = require("node:crypto");
let node_util = require("node:util");
//#region scripts/lib/gameLocalisation.mjs
async function findGameRoot(environment = process.env) {
	const steamRoots = ["C:/Program Files (x86)/Steam", "C:/Program Files/Steam"];
	const libraries = /* @__PURE__ */ new Set();
	for (const steam of steamRoots) {
		const vdf = await (0, node_fs_promises.readFile)((0, node_path.join)(steam, "steamapps", "libraryfolders.vdf"), "utf8").catch(() => "");
		libraries.add(steam);
		for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(match[1].replaceAll("\\\\", "/"));
	}
	const candidates = [environment.STELLARIS_GAME_DIR, ...[...libraries].map((library) => (0, node_path.join)(library, "steamapps", "common", "Stellaris"))].filter(Boolean);
	for (const candidate of candidates) try {
		await (0, node_fs_promises.access)((0, node_path.join)(candidate, "launcher-settings.json"));
		return candidate;
	} catch {}
	return null;
}
function parseLocalisation(text, into = /* @__PURE__ */ new Map()) {
	for (const match of text.matchAll(/^\s*([\w.\-]+):\d*\s*"(.*)"/gm)) if (!into.has(match[1])) into.set(match[1], match[2].replace(/"\s*#.*$/, "").replace(/\\"/g, "\""));
	return into;
}
async function loadLocalisation(gameRoot, language = "french") {
	const dir = (0, node_path.join)(gameRoot, "localisation", language);
	const loc = /* @__PURE__ */ new Map();
	for (const file of (await (0, node_fs_promises.readdir)(dir, { recursive: true })).filter((name) => name.endsWith(".yml"))) parseLocalisation(await (0, node_fs_promises.readFile)((0, node_path.join)(dir, file), "utf8"), loc);
	return loc;
}
let cached = null;
function gameLocalisation() {
	cached ??= findGameRoot().then((root) => root ? loadLocalisation(root) : null).catch(() => null);
	return cached;
}
function parseDepositDistricts(text, into = /* @__PURE__ */ new Map()) {
	for (const match of text.matchAll(/^(d_\w+)\s*=\s*\{([\s\S]*?)^\}/gm)) {
		const adds = {};
		for (const add of match[2].matchAll(/\b(district_\w+?)_max_add\s*=\s*(-?\d+)/g)) adds[add[1]] = (adds[add[1]] ?? 0) + Number(add[2]);
		if (Object.keys(adds).length) into.set(match[1], adds);
	}
	return into;
}
let depositsCached = null;
function gameDeposits() {
	depositsCached ??= findGameRoot().then(async (root) => {
		if (!root) return null;
		const dir = (0, node_path.join)(root, "common", "deposits");
		const map = /* @__PURE__ */ new Map();
		for (const file of (await (0, node_fs_promises.readdir)(dir)).filter((name) => name.endsWith(".txt"))) parseDepositDistricts(await (0, node_fs_promises.readFile)((0, node_path.join)(dir, file), "utf8"), map);
		return map;
	}).catch(() => null);
	return depositsCached;
}
function parseBlock(tokens, start = 0) {
	const entries = [];
	let i = start;
	while (i < tokens.length && tokens[i] !== "}") {
		const token = tokens[i];
		if (token === "{") {
			const [child, next] = parseBlock(tokens, i + 1);
			entries.push([null, child]);
			i = next + 1;
			continue;
		}
		if (tokens[i + 1] === "=") {
			if (tokens[i + 2] === "{") {
				const [child, next] = parseBlock(tokens, i + 3);
				entries.push([token, child]);
				i = next + 1;
			} else {
				entries.push([token, tokens[i + 2]?.replace(/^"|"$/g, "")]);
				i += 3;
			}
			continue;
		}
		i += 1;
	}
	return [entries, i];
}
const clean = (text) => text.replace(/§./g, "").replace(/£\w+£/g, "").trim();
function localizeName(nameBlock, loc) {
	if (!nameBlock || !loc) return null;
	const [entries] = parseBlock(nameBlock.match(/"[^"]*"|[{}=]|[^\s{}=]+/g) ?? []);
	const resolve = (block) => {
		const get = (name) => block.find(([key]) => key === name)?.[1];
		const key = get("key");
		if (typeof key !== "string") return null;
		const vars = new Map((get("variables") ?? []).map(([, variable]) => {
			const pair = Array.isArray(variable) ? variable : [];
			const value = pair.find(([k]) => k === "value")?.[1];
			return [pair.find(([k]) => k === "key")?.[1], Array.isArray(value) ? resolve(value) : value];
		}));
		if (get("literal") === "yes") return key;
		let template = loc.get(key);
		if (template === void 0) {
			if (key.startsWith("%") && vars.size) return [...vars.values()].filter(Boolean).join(" ");
			return /^[A-Z0-9_%]+$|_/.test(key) ? null : key;
		}
		template = template.replace(/\$([\w|]+)\$/g, (_, name) => vars.get(name.split("|")[0]) ?? loc.get(name) ?? "");
		return clean(template.replace(/\s+/g, " "));
	};
	const nested = entries.find(([key]) => key === "full_names")?.[1];
	return resolve(Array.isArray(nested) ? nested : entries) || null;
}
function collectLabels(value, loc, labels = {}) {
	if (!loc) return labels;
	const visit = (item) => {
		if (typeof item === "string") {
			const text = /^[a-z][a-z0-9_]+$/.test(item) && loc.has(item) && !(item in labels) ? clean(loc.get(item).replace(/\$\w+\$/g, "")) : "";
			if (text) labels[item] = text;
			if (text && loc.has(`${item}_plural`)) labels[`${item}_plural`] = clean(loc.get(`${item}_plural`));
		} else if (Array.isArray(item)) item.forEach(visit);
		else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
			visit(key);
			visit(child);
		}
	};
	visit(value);
	return labels;
}
//#endregion
//#region scripts/lib/stellarisQuestGraph.mjs
const TOKEN = /"(?:[^"\\]|\\.)*"|#[^\n]*|<=|>=|!=|==|[{}=<>]|[^\s{}=<>#"]+/g;
/** Entries of a Clausewitz block: { k, op, v } where v is a string or a nested entry list; bare values have k = null. */
function parseClausewitz(text) {
	const tokens = [];
	for (const match of text.matchAll(TOKEN)) if (match[0][0] !== "#") tokens.push(match[0]);
	let index = 0;
	const unquote = (token) => token[0] === "\"" ? token.slice(1, -1) : token;
	const block = () => {
		const entries = [];
		while (index < tokens.length && tokens[index] !== "}") {
			const token = tokens[index++];
			if (token === "{") {
				entries.push({
					k: null,
					op: null,
					v: block()
				});
				index += 1;
				continue;
			}
			const op = tokens[index];
			if (op === "=" || op === "<" || op === ">" || op === "<=" || op === ">=" || op === "!=" || op === "==") {
				index += 1;
				if (tokens[index] === "{") {
					index += 1;
					entries.push({
						k: unquote(token),
						op,
						v: block()
					});
					index += 1;
				} else entries.push({
					k: unquote(token),
					op,
					v: unquote(tokens[index++] ?? "")
				});
			} else entries.push({
				k: null,
				op: null,
				v: unquote(token)
			});
		}
		return entries;
	};
	return block();
}
const get$1 = (entries, key) => entries?.find((entry) => entry.k === key)?.v;
const all = (entries, key) => (entries ?? []).filter((entry) => entry.k === key).map((entry) => entry.v);
const num = (value) => typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
/** Offsets of every top-level `key = { ... }` block, found with a cheap brace scan so only needed blocks get parsed. */
function topLevelBlocks(text) {
	const blocks = [];
	let depth = 0;
	let key = null;
	let start = -1;
	let last = null;
	for (const match of text.matchAll(TOKEN)) {
		const token = match[0];
		if (token[0] === "#") continue;
		if (token === "{") {
			if (depth === 0) {
				key = last?.key ?? null;
				start = match.index;
			}
			depth += 1;
		} else if (token === "}") {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				blocks.push({
					key,
					start,
					end: match.index + 1
				});
				start = -1;
			}
			if (depth < 0) depth = 0;
		}
		if (depth === 0 && token !== "=" && token !== "{" && token !== "}") last = { key: token.replace(/^"|"$/g, "") };
	}
	return blocks;
}
const blockEntries = (text, block) => parseClausewitz(text.slice(block.start + 1, block.end - 1));
async function textFiles(dir) {
	return (await (0, node_fs_promises.readdir)(dir, { recursive: true }).catch(() => [])).filter((name) => name.endsWith(".txt")).sort().map((name) => (0, node_path.join)(dir, name));
}
function indexGameTexts({ events = [], projects = [], chains = [] }) {
	const index = {
		events: /* @__PURE__ */ new Map(),
		projects: /* @__PURE__ */ new Map(),
		chains: /* @__PURE__ */ new Set()
	};
	for (const text of events) for (const block of topLevelBlocks(text)) {
		if (!/_event$|^event$/.test(block.key ?? "")) continue;
		const id = text.slice(block.start, Math.min(block.end, block.start + 400)).match(/\bid\s*=\s*"?([\w.]+)"?/)?.[1];
		if (id && !index.events.has(id)) index.events.set(id, {
			type: block.key,
			text,
			block
		});
	}
	for (const text of projects) for (const block of topLevelBlocks(text)) {
		if (block.key !== "special_project") continue;
		const key = text.slice(block.start, block.end).match(/\bkey\s*=\s*"?([\w.]+)"?/)?.[1];
		if (key && !index.projects.has(key)) index.projects.set(key, {
			text,
			block
		});
	}
	for (const text of chains) for (const block of topLevelBlocks(text)) if (block.key && !block.key.startsWith("@")) index.chains.add(block.key);
	return index;
}
let cachedIndex = null;
function gameQuestIndex() {
	cachedIndex ??= findGameRoot().then(async (root) => {
		if (!root) return null;
		const read = async (dir) => Promise.all((await textFiles((0, node_path.join)(root, dir))).map((file) => (0, node_fs_promises.readFile)(file, "utf8").catch(() => "")));
		const [events, projects, chains] = await Promise.all([
			read("events"),
			read("common/special_projects"),
			read("common/event_chains")
		]);
		return indexGameTexts({
			events,
			projects,
			chains
		});
	}).catch(() => null);
	return cachedIndex;
}
function localize(loc, key) {
	if (!key || !loc) return null;
	const raw = loc.get(key);
	if (raw === void 0) return null;
	return raw.replace(/\$([\w.|]+)\$/g, (_, ref) => {
		const nested = loc.get(ref.split("|")[0]);
		return nested && !nested.includes("$") ? nested : "";
	}).replace(/\\n/g, " ").replace(/§[A-Za-z!]/g, "").replace(/£(\w+)£/g, "").replace(/\[[^\]]*\]/g, "…").replace(/\s+/g, " ").trim() || null;
}
const textOf = (value) => typeof value === "string" ? value : Array.isArray(value) ? get$1(value, "text") ?? all(value, null).find((item) => typeof item === "string") : null;
const ETHIC_GROUPS = [
	"xenophile",
	"xenophobe",
	"pacifist",
	"militarist",
	"egalitarian",
	"authoritarian",
	"spiritualist",
	"materialist"
];
const HOMICIDAL = [
	"civic_fanatic_purifiers",
	"civic_hive_devouring_swarm",
	"civic_machine_terminator"
];
function buildContext(build) {
	const ethics = new Set(build?.ethics ?? []);
	const civics = new Set(build?.civics ?? []);
	const authority = build?.authority ?? null;
	const has = (group) => ethics.has(`ethic_${group}`) || ethics.has(`ethic_fanatic_${group}`);
	const hive = authority === "auth_hive_mind";
	const machine = authority === "auth_machine_intelligence";
	return {
		known: Boolean(build),
		ethics,
		civics,
		authority,
		origin: build?.origin ?? null,
		flags: {
			is_gestalt: hive || machine || ethics.has("ethic_gestalt_consciousness"),
			is_hive_empire: hive,
			is_machine_empire: machine,
			is_megacorp: authority === "auth_corporate",
			is_homicidal: HOMICIDAL.some((civic) => civics.has(civic)),
			is_fanatic_purifiers: civics.has("civic_fanatic_purifiers"),
			is_devouring_swarm: civics.has("civic_hive_devouring_swarm"),
			is_machine_terminator: civics.has("civic_machine_terminator"),
			is_ai: false,
			is_human: true,
			...Object.fromEntries(ETHIC_GROUPS.map((group) => [`is_${group}`, has(group)])),
			...Object.fromEntries(ETHIC_GROUPS.map((group) => [`is_fanatic_${group}`, ethics.has(`ethic_fanatic_${group}`)]))
		}
	};
}
const PASS_SCOPES = /* @__PURE__ */ new Set([
	"owner",
	"root",
	"space_owner",
	"controller",
	"owner_main_species"
]);
const truthy = (value) => value === "yes" ? true : value === "no" ? false : null;
/** true / false when the trigger only depends on the player's ethics, authority, civics or origin; null otherwise. */
function evaluateTrigger(entries, context) {
	if (!context?.known) return null;
	const results = (entries ?? []).filter((entry) => entry.k !== null).map((entry) => evaluateEntry(entry, context));
	if (results.includes(false)) return false;
	return results.every((result) => result === true) ? true : null;
}
function evaluateEntry({ k, v }, context) {
	const list = Array.isArray(v) ? v : null;
	switch (k) {
		case "AND": return evaluateTrigger(list, context);
		case "OR":
		case "NAND":
		case "NOR":
		case "NOT": {
			const results = (list ?? []).filter((entry) => entry.k !== null).map((entry) => evaluateEntry(entry, context));
			const any = results.includes(true) ? true : results.every((result) => result === false) ? false : null;
			const every = results.includes(false) ? false : results.every((result) => result === true) ? true : null;
			if (k === "OR") return any;
			if (k === "NAND") return every === null ? null : !every;
			return any === null ? null : !any;
		}
		case "has_ethic": return context.ethics.has(v);
		case "has_authority": return context.authority === v;
		case "has_civic":
		case "has_valid_civic": return context.civics.has(v);
		case "has_origin": return context.origin === v;
	}
	if (list && PASS_SCOPES.has(k)) return evaluateTrigger(list, context);
	if (k in context.flags) {
		const wanted = truthy(v);
		return wanted === null ? null : context.flags[k] === wanted;
	}
	if (k === "is_country_type" && v === "default") return true;
	return null;
}
const FLAG_LABELS = {
	is_gestalt: "Conscience collective",
	is_hive_empire: "Esprit-ruche",
	is_machine_empire: "Intelligence machine",
	is_megacorp: "Mégacorporation",
	is_homicidal: "Empire génocidaire",
	is_xenophile: "Xénophile",
	is_xenophobe: "Xénophobe",
	is_pacifist: "Pacifiste",
	is_militarist: "Militariste",
	is_egalitarian: "Égalitaire",
	is_authoritarian: "Autoritaire",
	is_spiritualist: "Spiritualiste",
	is_materialist: "Matérialiste",
	is_fanatic_purifiers: "Purificateurs fanatiques",
	is_devouring_swarm: "Essaim dévoreur",
	is_machine_terminator: "Exterminateurs"
};
/** Short French reading of a trigger, e.g. "Esprit-ruche ou Xénophile". */
function describeTrigger(entries, loc, depth = 0) {
	if (depth > 3) return "…";
	const parts = (entries ?? []).filter((entry) => entry.k !== null && entry.k !== "text").map(({ k, v }) => {
		const list = Array.isArray(v) ? v : null;
		if (k === "OR") return describeTrigger(list, loc, depth + 1).split(" · ").join(" ou ");
		if (k === "AND") return describeTrigger(list, loc, depth + 1);
		if (k === "NOT" || k === "NOR") return `pas ${describeTrigger(list, loc, depth + 1).split(" · ").join(" ni ")}`;
		if (k === "NAND") return `pas à la fois ${describeTrigger(list, loc, depth + 1)}`;
		if (list && PASS_SCOPES.has(k)) return describeTrigger(list, loc, depth + 1);
		if (k in FLAG_LABELS) return v === "no" ? `non ${FLAG_LABELS[k].toLowerCase()}` : FLAG_LABELS[k];
		if ([
			"has_ethic",
			"has_authority",
			"has_civic",
			"has_valid_civic",
			"has_origin",
			"has_ascension_perk",
			"has_tradition"
		].includes(k)) return localize(loc, v) ?? v;
		if (k === "has_technology") return `technologie ${localize(loc, v) ?? v}`;
		if (/flag$/.test(k)) return "condition de scénario";
		if (list) return null;
		return null;
	}).filter(Boolean);
	return [...new Set(parts)].join(" · ") || "condition de scénario";
}
/** AI weight of an option (factor × modifiers whose triggers hold for this player). */
function aiWeight(entries, context) {
	if (!entries) return null;
	let weight = num(get$1(entries, "factor")) ?? num(get$1(entries, "base")) ?? 1;
	for (const modifier of all(entries, "modifier")) {
		if (!Array.isArray(modifier)) continue;
		if (evaluateTrigger(modifier.filter((entry) => ![
			"factor",
			"add",
			"weight"
		].includes(entry.k)), context) !== true) continue;
		const factor = num(get$1(modifier, "factor"));
		const add = num(get$1(modifier, "add"));
		if (factor !== null) weight *= factor;
		if (add !== null) weight += add;
	}
	return Math.max(0, weight);
}
const IGNORED = /* @__PURE__ */ new Set([
	"limit",
	"log",
	"name",
	"trigger",
	"allow",
	"exclusive_trigger",
	"ai_chance",
	"tooltip",
	"response_text",
	"custom_gui",
	"default_hide_option",
	"is_dialog_only",
	"set_variable",
	"change_variable",
	"export_trigger_value_to_variable",
	"save_event_target_as",
	"save_global_event_target_as",
	"clear_global_event_target",
	"clear_event_target",
	"set_name",
	"set_leader_flag",
	"hidden",
	"icon",
	"picture",
	"sound",
	"show_sound",
	"diplomatic",
	"location",
	"custom_tooltip_fail",
	"trigger_scope",
	"highlight",
	"force_open",
	"remove_modifier",
	"set_timed_country_flag",
	"set_timed_planet_flag",
	"set_timed_ship_flag",
	"show_tooltip_only"
]);
const SCOPE_KEY = /^(owner|root|from|fromfrom|fromfromfrom|prev|prevprev|this|space_owner|controller|capital_scope|solar_system|planet|fleet|leader|ruler|species|owner_species|owner_main_species|star|orbit|last_created_\w+|event_target:[\w.@]+|(every|random|ordered)_\w+)$/;
const EFFECT_LABELS = {
	create_ship: ["ships", "Nouveau vaisseau"],
	create_fleet: ["ships", "Nouvelle flotte"],
	create_starbase: ["ships", "Nouvelle base stellaire"],
	create_leader: ["leader", "Nouveau dirigeant"],
	recruit_leader: ["leader", "Nouveau dirigeant"],
	create_pop: ["pops", "Nouvelle population"],
	create_pop_group: ["pops", "Nouvelle population"],
	create_species: ["pops", "Nouvelle espèce"],
	add_pop: ["pops", "Nouvelle population"],
	kill_pop: ["violence", "Population tuée"],
	remove_pop: ["violence", "Population retirée"],
	kill_leader: ["violence", "Dirigeant perdu"],
	destroy_ship: ["violence", "Vaisseau détruit"],
	destroy_fleet: ["violence", "Flotte détruite"],
	kill_all_pop: ["violence", "Population exterminée"],
	set_planet_entity: ["planet", "Planète modifiée"],
	change_pc: ["planet", "Classe de planète modifiée"],
	add_deposit: ["planet", "Gisement ajouté"],
	add_building: ["planet", "Bâtiment ajouté"],
	establish_communications: ["diplomacy", "Communications établies"],
	establish_communications_no_message: ["diplomacy", "Communications établies"],
	add_opinion_modifier: ["diplomacy", "Opinion modifiée"],
	add_trust: ["diplomacy", "Confiance modifiée"],
	add_intel: ["diplomacy", "Renseignements"],
	add_relic: ["relic", "Relique obtenue"],
	add_research_option: ["research", "Option de recherche débloquée"],
	add_tech_progress: ["research", "Progrès technologique"],
	add_tech_progress_effect: ["research", "Progrès technologique"],
	add_monthly_resource_mult: ["resource", "Ressources"],
	create_archaeological_site: ["quest", "Site archéologique"],
	start_situation: ["quest", "Situation lancée"],
	add_anomaly: ["quest", "Anomalie"],
	add_trait: ["leader", "Trait de dirigeant"],
	add_trait_no_notify: ["leader", "Trait de dirigeant"],
	add_experience: ["leader", "Expérience"],
	add_ship_design: ["ships", "Plan de vaisseau"],
	create_army: ["ships", "Armée créée"],
	add_claims: ["diplomacy", "Revendications"],
	set_owner: ["planet", "Contrôle transféré"],
	set_controller: ["planet", "Contrôle transféré"],
	add_ascension_perk_slot: ["relic", "Emplacement d'ascension"]
};
function eventRef(value) {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return null;
	return get$1(value, "id") ?? null;
}
function summarizeEffects(entries, ctx, depth = 0) {
	const out = [];
	let unknown = 0;
	let lastConditional = null;
	if (depth > 6) return out;
	for (const entry of entries ?? []) {
		const { k, v } = entry;
		if (k === null || IGNORED.has(k) || /flag$|_flag$|^set_\w*flag|^remove_\w*flag|^clear_/.test(k)) continue;
		const list = Array.isArray(v) ? v : null;
		if (/_event$/.test(k) && k !== "remove_event") {
			const id = eventRef(v);
			if (id) out.push({
				kind: "event",
				id,
				days: list ? num(get$1(list, "days")) : null
			});
			continue;
		}
		if (k === "enable_special_project" && list) {
			const key = get$1(list, "name");
			if (key) out.push({
				kind: "project",
				key
			});
			continue;
		}
		if (k === "begin_event_chain" && list) {
			const key = get$1(list, "event_chain");
			if (key) out.push({
				kind: "chain",
				key,
				action: "start"
			});
			continue;
		}
		if (k === "end_event_chain" && list) {
			const key = get$1(list, "event_chain");
			if (key) out.push({
				kind: "chain",
				key,
				action: "end"
			});
			continue;
		}
		if (k === "add_resource" && list) {
			const scaled = list.some((item) => item.k === "mult");
			for (const item of list) if (item.k && item.k !== "mult" && typeof item.v === "string") out.push({
				kind: "resource",
				resource: item.k,
				amount: scaled ? null : num(item.v)
			});
			continue;
		}
		if ((k === "add_modifier" || k === "add_timed_modifier") && list) {
			const key = get$1(list, "modifier");
			out.push({
				kind: "modifier",
				key,
				name: localize(ctx.loc, key) ?? key,
				days: num(get$1(list, "days"))
			});
			continue;
		}
		if ((k === "give_technology" || k === "add_research_option") && list) {
			const key = get$1(list, "tech");
			out.push({
				kind: "tech",
				key,
				name: localize(ctx.loc, key) ?? key,
				grant: k === "give_technology"
			});
			continue;
		}
		if (k === "add_relic" && typeof v === "string") {
			out.push({
				kind: "effect",
				tag: "relic",
				text: `Relique : ${localize(ctx.loc, v) ?? v}`
			});
			continue;
		}
		if (k === "custom_tooltip" || k === "custom_tooltip_with_params") {
			const text = localize(ctx.loc, textOf(v));
			if (text) out.push({
				kind: "text",
				text
			});
			continue;
		}
		if (k === "random_list" && list) {
			const branches = list.filter((item) => item.k !== null && Array.isArray(item.v)).map((item) => {
				let weight = num(item.k) ?? 0;
				for (const modifier of all(item.v, "modifier")) {
					if (!Array.isArray(modifier)) continue;
					if (evaluateTrigger(modifier.filter((part) => !["factor", "add"].includes(part.k)), ctx.context) !== true) continue;
					weight = weight * (num(get$1(modifier, "factor")) ?? 1) + (num(get$1(modifier, "add")) ?? 0);
				}
				return {
					weight,
					outcomes: summarizeEffects(item.v.filter((part) => part.k !== "modifier"), ctx, depth + 1)
				};
			});
			const total = branches.reduce((sum, branch) => sum + branch.weight, 0);
			out.push({
				kind: "random",
				branches: branches.map((branch) => ({
					chance: total ? Math.round(branch.weight / total * 100) : null,
					outcomes: branch.outcomes
				}))
			});
			continue;
		}
		if (k === "random" && list) {
			out.push({
				kind: "random",
				branches: [{
					chance: num(get$1(list, "chance")),
					outcomes: summarizeEffects(list.filter((part) => part.k !== "chance"), ctx, depth + 1)
				}]
			});
			continue;
		}
		if ((k === "if" || k === "else_if") && list) {
			const limit = get$1(list, "limit");
			const branch = {
				condition: Array.isArray(limit) ? describeTrigger(limit, ctx.loc) : null,
				met: Array.isArray(limit) ? evaluateTrigger(limit, ctx.context) : null,
				outcomes: summarizeEffects(list, ctx, depth + 1)
			};
			if (k === "if" || !lastConditional) {
				lastConditional = {
					kind: "conditional",
					branches: [branch]
				};
				out.push(lastConditional);
			} else lastConditional.branches.push(branch);
			continue;
		}
		if (k === "else" && list) {
			const branch = {
				condition: "sinon",
				met: null,
				outcomes: summarizeEffects(list, ctx, depth + 1)
			};
			if (lastConditional) lastConditional.branches.push(branch);
			else out.push(...branch.outcomes);
			continue;
		}
		if (k === "hidden_effect" || k === "while" || k === "switch") {
			if (list) out.push(...summarizeEffects(list, ctx, depth + 1));
			continue;
		}
		if (list && SCOPE_KEY.test(k)) {
			out.push(...summarizeEffects(list, ctx, depth + 1));
			continue;
		}
		if (EFFECT_LABELS[k]) {
			out.push({
				kind: "effect",
				tag: EFFECT_LABELS[k][0],
				text: EFFECT_LABELS[k][1]
			});
			continue;
		}
		unknown += 1;
	}
	const merged = [];
	for (const item of out) {
		if (item.kind === "effect" && merged.some((existing) => existing.kind === "effect" && existing.text === item.text)) continue;
		merged.push(item);
	}
	if (unknown) merged.push({
		kind: "unknown",
		count: unknown
	});
	return merged;
}
const DEPARTMENTS = {
	physics_technology: "Physique",
	society_technology: "Société",
	engineering_technology: "Ingénierie"
};
const REQUIREMENTS = {
	shipclass_science_ship: "vaisseau scientifique",
	shipclass_military: "flotte militaire",
	shipclass_constructor: "vaisseau de construction",
	shipclass_colonizer: "vaisseau colonisateur",
	assault_armies: "armées d'assaut",
	leader: null
};
const LEADER_CLASSES = {
	scientist: "scientifique",
	admiral: "amiral",
	general: "général",
	governor: "gouverneur",
	commander: "commandant",
	official: "fonctionnaire"
};
function eventNode(index, id, ctx) {
	const record = index?.events.get(id);
	if (!record) return null;
	const entries = blockEntries(record.text, record.block);
	const hidden = get$1(entries, "hide_window") === "yes";
	const options = all(entries, "option").filter(Array.isArray).map((option, position) => {
		const trigger = [
			...all(option, "trigger"),
			...all(option, "exclusive_trigger"),
			...all(option, "allow")
		].filter(Array.isArray).flat();
		const ai = get$1(option, "ai_chance");
		return {
			index: position,
			name: localize(ctx.loc, textOf(get$1(option, "name"))) ?? `Option ${position + 1}`,
			available: trigger.length ? evaluateTrigger(trigger, ctx.context) : true,
			requirement: trigger.length ? describeTrigger(trigger, ctx.loc) : null,
			aiWeight: Array.isArray(ai) ? aiWeight(ai, ctx.context) : null,
			outcomes: summarizeEffects(option, ctx)
		};
	});
	return {
		id: `event:${id}`,
		kind: "event",
		eventId: id,
		hidden,
		title: localize(ctx.loc, textOf(get$1(entries, "title"))) ?? (hidden ? "Événement caché" : id),
		desc: localize(ctx.loc, textOf(get$1(entries, "desc"))),
		immediate: summarizeEffects(get$1(entries, "immediate"), ctx),
		after: summarizeEffects(get$1(entries, "after"), ctx),
		options
	};
}
function projectNode(index, key, ctx) {
	const record = index?.projects.get(key);
	if (!record) return null;
	const entries = blockEntries(record.text, record.block);
	const requirements = [];
	for (const entry of get$1(entries, "requirements") ?? []) if (entry.k === "leader") requirements.push(`dirigeant : ${LEADER_CLASSES[entry.v] ?? entry.v}`);
	else if (entry.k in REQUIREMENTS && REQUIREMENTS[entry.k]) requirements.push(REQUIREMENTS[entry.k]);
	return {
		id: `project:${key}`,
		kind: "project",
		key,
		title: localize(ctx.loc, key) ?? key,
		desc: localize(ctx.loc, `${key}_DESC`) ?? localize(ctx.loc, `${key}_desc`),
		department: DEPARTMENTS[get$1(entries, "tech_department")] ?? null,
		cost: num(get$1(entries, "cost")),
		timeLimit: num(get$1(entries, "timelimit")),
		requirements,
		onStart: summarizeEffects(get$1(entries, "on_start"), ctx),
		onSuccess: summarizeEffects(get$1(entries, "on_success"), ctx),
		onFail: summarizeEffects(get$1(entries, "on_fail"), ctx),
		options: []
	};
}
/** Node ids an outcome list leads to (next popups and projects), through random and conditional branches. */
function nextNodeIds(outcomes) {
	const ids = [];
	for (const outcome of outcomes ?? []) if (outcome.kind === "event") ids.push(`event:${outcome.id}`);
	else if (outcome.kind === "project") ids.push(`project:${outcome.key}`);
	else if (outcome.kind === "random" || outcome.kind === "conditional") {
		for (const branch of outcome.branches) if (branch.met !== false) ids.push(...nextNodeIds(branch.outcomes));
	}
	return [...new Set(ids)];
}
function nodeById(index, id, ctx) {
	const [kind, ...rest] = id.split(":");
	const key = rest.join(":");
	return kind === "event" ? eventNode(index, key, ctx) : kind === "project" ? projectNode(index, key, ctx) : null;
}
function nodeExits(node) {
	if (node.kind === "project") return nextNodeIds([...node.onStart, ...node.onSuccess]);
	return nextNodeIds([
		...node.immediate,
		...node.options.flatMap((option) => option.outcomes),
		...node.after
	]);
}
/** Nodes reachable from the roots, breadth-first and bounded so a snapshot stays small. */
function expandNodes(index, roots, ctx, { maxDepth = 4, maxNodes = 120 } = {}) {
	const nodes = {};
	let frontier = [...new Set(roots)];
	for (let depth = 0; depth <= maxDepth && frontier.length; depth += 1) {
		const next = [];
		for (const id of frontier) {
			if (id in nodes || Object.keys(nodes).length >= maxNodes) continue;
			const node = nodeById(index, id, ctx);
			nodes[id] = node;
			if (node) next.push(...nodeExits(node));
		}
		frontier = next.filter((id) => !(id in nodes));
	}
	return Object.fromEntries(Object.entries(nodes).filter(([, node]) => node));
}
function blocksNamed(body, key) {
	const found = [];
	const pattern = new RegExp(`(?:^|[\\s{])${key}=\\s*\\{`, "g");
	for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
		let depth = 0;
		const open = match.index + match[0].length - 1;
		for (let at = open; at < body.length; at += 1) if (body[at] === "{") depth += 1;
		else if (body[at] === "}" && --depth === 0) {
			found.push(body.slice(open + 1, at));
			pattern.lastIndex = at;
			break;
		}
	}
	return found;
}
/** Special projects and event chains the player currently has open, as written in the country block of the save. */
function parseActiveQuests(countryBody) {
	const projects = blocksNamed(countryBody ?? "", "special_project").flatMap((body) => {
		const key = body.match(/\bspecial_project="([^"]+)"/)?.[1];
		if (!key) return [];
		const number = (name) => {
			const raw = body.match(new RegExp(`\\b${name}=(-?[\\d.]+)`))?.[1];
			return raw === void 0 ? null : Number(raw);
		};
		return [{
			key,
			status: body.match(/\bstatus=(\w+)/)?.[1] ?? null,
			daysLeft: number("days_left"),
			progress: number("progress")
		}];
	});
	const chains = [...new Set(blocksNamed(countryBody ?? "", "event_chain").map((body) => body.match(/\bevent_chain="([^"]+)"/)?.[1]).filter(Boolean))];
	return {
		projects: [...new Map(projects.map((project) => [project.key, project])).values()],
		chains
	};
}
function assembleQuestGuide(index, loc, { activeQuests, recentEvents, build }) {
	const ctx = {
		loc,
		context: buildContext(build)
	};
	const recent = (recentEvents ?? []).slice(0, 12);
	const projectRoots = (activeQuests?.projects ?? []).map((project) => `project:${project.key}`);
	const eventRoots = recent.slice(0, 5).map((event) => `event:${event.eventId}`);
	const nodes = index ? expandNodes(index, [...projectRoots, ...eventRoots], ctx) : {};
	return {
		available: Boolean(index),
		projects: (activeQuests?.projects ?? []).map((project) => ({
			...project,
			nodeId: `project:${project.key}`,
			title: localize(loc, project.key) ?? project.key
		})),
		chains: (activeQuests?.chains ?? []).map((key) => ({
			key,
			title: localize(loc, `${key}_title`) ?? localize(loc, key) ?? key,
			desc: localize(loc, `${key}_desc`)
		})),
		recent: recent.map((event) => {
			const node = nodes[`event:${event.eventId}`];
			return {
				...event,
				nodeId: `event:${event.eventId}`,
				title: node?.title ?? event.eventId,
				optionName: node?.options[event.selectedOption]?.name ?? null
			};
		}),
		nodes
	};
}
async function buildQuestGuide(input) {
	const [index, loc] = await Promise.all([gameQuestIndex(), gameLocalisation()]);
	return assembleQuestGuide(index, loc, input);
}
async function questNode(id, build) {
	const [index, loc] = await Promise.all([gameQuestIndex(), gameLocalisation()]);
	if (!index) return null;
	return expandNodes(index, [id], {
		loc,
		context: buildContext(build)
	}, {
		maxDepth: 2,
		maxNodes: 40
	});
}
//#endregion
//#region scripts/lib/stellarisSnapshot.mjs
const execFileAsync = (0, node_util.promisify)(node_child_process.execFile);
const tar = process.platform === "win32" ? (0, node_path.join)(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
async function existingDirectory(candidates) {
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			await (0, node_fs_promises.access)(candidate);
			return candidate;
		} catch {}
	}
	return null;
}
async function findStellarisRoot(environment = process.env) {
	const userProfile = environment.USERPROFILE ?? environment.HOME ?? "";
	const oneDrive = environment.OneDrive ?? environment.OneDriveCommercial ?? "";
	return existingDirectory([
		oneDrive && (0, node_path.join)(oneDrive, "Documents"),
		userProfile && (0, node_path.join)(userProfile, "OneDrive", "Documents"),
		userProfile && (0, node_path.join)(userProfile, "Documents")
	].filter(Boolean).map((folder) => (0, node_path.join)(folder, "Paradox Interactive", "Stellaris")));
}
async function collectSaveFiles(folder) {
	const entries = await (0, node_fs_promises.readdir)(folder, { withFileTypes: true });
	return (await Promise.all(entries.map(async (entry) => {
		const fullPath = (0, node_path.join)(folder, entry.name);
		if (entry.isDirectory()) return collectSaveFiles(fullPath);
		return entry.isFile() && entry.name.toLowerCase().endsWith(".sav") ? [fullPath] : [];
	}))).flat();
}
async function findLatestSave(stellarisRoot) {
	const files = await collectSaveFiles((0, node_path.join)(stellarisRoot, "save games"));
	return (await Promise.all(files.map(async (file) => ({
		file,
		info: await (0, node_fs_promises.stat)(file)
	})))).sort((left, right) => right.info.mtimeMs - left.info.mtimeMs)[0] ?? null;
}
function parseMeta(metaText, context) {
	const stringValue = (key) => metaText.match(new RegExp(`(?:^|\\n)${key}="([^"]*)"`, "m"))?.[1] ?? null;
	const integerValue = (key) => {
		const raw = metaText.match(new RegExp(`(?:^|\\n)${key}=(\\d+)`, "m"))?.[1];
		return raw === void 0 ? null : Number.parseInt(raw, 10);
	};
	const requiredDlcs = [...(metaText.match(/required_dlcs=\s*\{([\s\S]*?)\n\}/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	const empireName = stringValue("name");
	const gameDate = stringValue("date");
	const gameVersion = stringValue("version");
	if (!empireName || !gameDate || !gameVersion) throw new Error("La sauvegarde ne contient pas les métadonnées attendues.");
	return {
		campaignId: (0, node_crypto.createHash)("sha256").update((0, node_path.resolve)(context.campaignDirectory)).digest("hex").slice(0, 32),
		saveName: (0, node_path.basename)(context.savePath, ".sav"),
		empireName,
		gameDate,
		gameVersion,
		portraitKey: stringValue("player_portrait"),
		requiredDlcs,
		fleetCount: integerValue("meta_fleets"),
		planetCount: integerValue("meta_planets"),
		saveUpdatedAt: context.saveUpdatedAt.toISOString()
	};
}
function parsePlayerEvents(logText, limit = 12) {
	const events = [];
	for (const match of logText.matchAll(/^\[([^\]]+)\].*?Event\s+([^\s]+)\s+added info about event selection\. selectedOption\s+(-?\d+), human\s+1, playerEventId\s+(\d+)/gm)) events.push({
		loggedAt: match[1],
		eventId: match[2],
		selectedOption: Number(match[3]),
		playerEventId: Number(match[4])
	});
	return events.slice(-limit).reverse();
}
async function readRecentPlayerEvents(stellarisRoot, limit = 12) {
	const logPath = (0, node_path.join)(stellarisRoot, "logs", "game.log");
	return parsePlayerEvents(await (0, node_fs_promises.readFile)(logPath, "utf8").catch(() => ""), limit);
}
function assignedObject(text, assignment, fromIndex = 0) {
	const assignmentIndex = text.indexOf(assignment, fromIndex);
	if (assignmentIndex < 0) return null;
	const embeddedOpen = assignment.lastIndexOf("{");
	const open = embeddedOpen >= 0 ? assignmentIndex + embeddedOpen : text.indexOf("{", assignmentIndex + assignment.length);
	if (open < 0) return null;
	let depth = 0;
	let quoted = false;
	for (let index = open; index < text.length; index += 1) {
		const character = text[index];
		if (character === "\"" && text[index - 1] !== "\\") quoted = !quoted;
		if (quoted) continue;
		if (character === "{") depth += 1;
		if (character === "}") depth -= 1;
		if (depth === 0) return text.slice(open + 1, index);
	}
	return null;
}
function parsePlayerBuild(gamestateText) {
	const playerCountry = gamestateText.match(/player=\s*\{[\s\S]*?country=(\d+)/)?.[1];
	const countrySection = gamestateText.indexOf("\ncountry=\n{");
	if (!playerCountry || countrySection < 0) return null;
	const country = assignedObject(gamestateText, `\n\t${playerCountry}=\n\t{`, countrySection);
	if (!country) return null;
	const founderSpecies = country.match(/founder_species_ref=(\d+)/)?.[1];
	const government = assignedObject(country, "government=") ?? "";
	const ethos = assignedObject(country, "ethos=") ?? "";
	const civics = assignedObject(government, "civics=") ?? "";
	const traits = assignedObject(founderSpecies ? assignedObject(gamestateText, `\n\t${founderSpecies}=\n\t{`) ?? "" : "", "traits=") ?? "";
	const quotedValues = (value) => [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	return {
		governmentType: government.match(/type="([^"]+)"/)?.[1] ?? null,
		authority: government.match(/authority="([^"]+)"/)?.[1] ?? null,
		origin: government.match(/origin="([^"]+)"/)?.[1] ?? null,
		ethics: [...ethos.matchAll(/ethic="([^"]+)"/g)].map((match) => match[1]),
		civics: quotedValues(civics),
		speciesTraits: [...traits.matchAll(/trait="([^"]+)"/g)].map((match) => match[1])
	};
}
function sectionBounds(gamestate, section) {
	const start = gamestate.indexOf(`\n${section}=\n{`);
	if (start < 0) return null;
	const end = gamestate.indexOf("\n}\n", start);
	return {
		start,
		end: end < 0 ? gamestate.length : end
	};
}
let indexedText = null;
const sectionIndexes = /* @__PURE__ */ new Map();
function entryBody(gamestate, section, id) {
	if (gamestate !== indexedText) {
		indexedText = gamestate;
		sectionIndexes.clear();
	}
	let index = sectionIndexes.get(section);
	if (!index) {
		index = /* @__PURE__ */ new Map();
		const bounds = sectionBounds(gamestate, section);
		if (bounds) {
			const text = gamestate.slice(bounds.start, bounds.end);
			const heads = [...text.matchAll(/\n\t(\d+)=\n\t\{/g)];
			heads.forEach((head, position) => index.set(head[1], text.slice(head.index + head[0].length, heads[position + 1]?.index ?? text.length)));
		}
		sectionIndexes.set(section, index);
	}
	return index.get(String(id)) ?? null;
}
function childBlock(body, key, depth) {
	const tabs = "	".repeat(depth);
	const head = `\n${tabs}${key}=\n${tabs}{`;
	const at = body.indexOf(head);
	if (at < 0) return null;
	const close = body.indexOf(`\n${tabs}}`, at + head.length);
	return close < 0 ? null : body.slice(at + head.length, close);
}
function numberAt(body, key, depth) {
	const raw = body.match(new RegExp(`\\n\\t{${depth}}${key}=(-?[\\d.]+)`))?.[1];
	return raw === void 0 ? null : Number(raw);
}
function stringAt(body, key, depth) {
	return body.match(new RegExp(`\\n\\t{${depth}}${key}="([^"]*)"`))?.[1] ?? null;
}
function numberMap(block) {
	if (!block) return null;
	const entries = [...block.matchAll(/^\s*([a-z_]+)=(-?[\d.]+)\s*$/gm)].map((match) => [match[1], Number(match[2])]);
	return entries.length ? Object.fromEntries(entries) : null;
}
function idList(body, key) {
	return body.match(new RegExp(`\\n\\t\\t${key}=\\s*\\{([^}]*)\\}`))?.[1].trim().split(/\s+/).filter(Boolean) ?? [];
}
function readableName(nameBlock) {
	if (!nameBlock) return null;
	const readable = [...nameBlock.matchAll(/key="([^"]+)"/g)].map((match) => match[1]).filter((key) => !key.startsWith("%") && !/^\d+$/.test(key)).map((key) => {
		if (/_CHR_/.test(key)) return key.split("_CHR_").pop();
		if (/^[A-Z0-9_]+$/.test(key)) return null;
		if (/_name_/.test(key)) {
			const last = key.split("_name_").pop();
			return last.charAt(0).toUpperCase() + last.slice(1);
		}
		return /[a-z]/.test(key) && !/_/.test(key) ? key : null;
	}).filter(Boolean);
	return readable.length ? readable.join(" ") : null;
}
function parseEconomy(countryBody) {
	const stockBlock = childBlock(childBlock(childBlock(countryBody, "modules", 2) ?? "", "standard_economy_module", 3) ?? "", "resources", 4);
	const month = childBlock(childBlock(countryBody, "budget", 2) ?? "", "current_month", 3) ?? "";
	const sumBlock = (block) => {
		const totals = {};
		for (const match of (block ?? "").matchAll(/^\t{6}([a-z_]+)=(-?[\d.]+)$/gm)) totals[match[1]] = (totals[match[1]] ?? 0) + Number(match[2]);
		return totals;
	};
	const income = sumBlock(childBlock(month, "income", 4));
	const expenses = sumBlock(childBlock(month, "expenses", 4));
	const stock = numberMap(stockBlock) ?? {};
	const keys = /* @__PURE__ */ new Set([
		...Object.keys(stock),
		...Object.keys(income),
		...Object.keys(expenses)
	]);
	if (!keys.size) return null;
	const round = (value) => Math.round(value * 100) / 100;
	return { resources: Object.fromEntries([...keys].map((key) => [key, {
		stock: stock[key] ?? null,
		monthly: round((income[key] ?? 0) - (expenses[key] ?? 0))
	}])) };
}
function parseEmpireStats(countryBody) {
	return {
		empireSize: numberAt(countryBody, "empire_size", 2),
		economyPower: numberAt(countryBody, "economy_power", 2),
		militaryPower: numberAt(countryBody, "military_power", 2),
		techPower: numberAt(countryBody, "tech_power", 2)
	};
}
function parseLeaders(gamestate, countryBody, nameOf = readableName) {
	const rulerId = countryBody.match(/\n\t\truler=(\d+)/)?.[1] ?? null;
	return idList(countryBody, "owned_leaders").flatMap((id) => {
		const body = entryBody(gamestate, "leaders", id);
		if (!body) return [];
		return [{
			id,
			name: nameOf(childBlock(body, "name", 2)),
			className: stringAt(body, "class", 2),
			level: numberAt(body, "level", 2),
			traits: [...body.matchAll(/\n\t\ttraits="([^"]+)"/g)].map((match) => match[1]),
			portraitKey: stringAt(body, "portrait", 2),
			isRuler: id === rulerId
		}];
	});
}
function parseProgression(gamestate, countryBody) {
	const quoted = (key) => [...(childBlock(countryBody, key, 2) ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	const techStatus = childBlock(countryBody, "tech_status", 2) ?? "";
	const alternatives = childBlock(techStatus, "alternatives", 3) ?? "";
	const research = Object.fromEntries([
		"physics",
		"society",
		"engineering"
	].map((area) => [area, {
		current: (childBlock(techStatus, `${area}_queue`, 3) ?? "").match(/technology="([^"]+)"/)?.[1] ?? null,
		options: [...(childBlock(alternatives, area, 4) ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1])
	}]));
	return {
		technologies: [...techStatus.matchAll(/\n\t\t\ttechnology="([^"]+)"/g)].map((match) => match[1]),
		research,
		traditions: quoted("traditions"),
		ascensionPerks: quoted("ascension_perks"),
		megastructures: idList(countryBody, "owned_megastructures").map((id) => stringAt(entryBody(gamestate, "megastructures", id) ?? "", "type", 2)).filter(Boolean)
	};
}
function parseColonyWork(gamestate, colony) {
	const jobs = {};
	for (const id of idList(colony, "pop_jobs")) {
		const job = entryBody(gamestate, "pop_jobs", id) ?? "";
		const type = stringAt(job, "type", 2);
		const workforce = numberAt(job, "workforce", 2) ?? 0;
		if (type && workforce > 0) jobs[type] = (jobs[type] ?? 0) + workforce;
	}
	return {
		buildings: idList(colony, "buildings_cache").map((id) => stringAt(entryBody(gamestate, "buildings", id) ?? "", "type", 2)).filter(Boolean),
		jobs
	};
}
function parsePlanets(gamestate, countryId, nameOf = readableName, deposits = null) {
	const bounds = sectionBounds(gamestate, "planets");
	if (!bounds) return [];
	const section = gamestate.slice(bounds.start, bounds.end);
	const heads = [...section.matchAll(/\n\t\t(\d+)=\n\t\t\{/g)];
	const planets = [];
	for (let index = 0; index < heads.length; index += 1) {
		const body = section.slice(heads[index].index + heads[index][0].length, heads[index + 1]?.index ?? section.length);
		if (!body.includes(`\n\t\t\towner=${countryId}\n`)) continue;
		const colonyId = body.match(/\n\t\t\tcolony=(\d+)/)?.[1];
		const colony = colonyId ? entryBody(gamestate, "colony", colonyId) ?? "" : "";
		const districts = {};
		for (const districtId of idList(colony, "districts")) {
			const district = entryBody(gamestate, "districts", districtId) ?? "";
			const type = stringAt(district, "type", 2);
			if (type) districts[type] = (districts[type] ?? 0) + (numberAt(district, "level", 2) ?? 1);
		}
		const designation = stringAt(colony, "final_designation", 2);
		planets.push({
			id: heads[index][1],
			name: nameOf(childBlock(body, "name", 3)),
			planetClass: stringAt(body, "planet_class", 3),
			size: numberAt(body, "planet_size", 3),
			pops: numberAt(colony, "num_sapient_pops", 2),
			stability: numberAt(colony, "stability", 2),
			designation,
			isCapital: designation === "col_capital",
			districts,
			...parseColonyWork(gamestate, colony),
			produces: numberMap(childBlock(colony, "produces", 2)),
			upkeep: numberMap(childBlock(colony, "upkeep", 2)),
			...colony && parseColonyScreen(gamestate, body, colony, nameOf, deposits)
		});
	}
	return planets.sort((a, b) => Number(b.isCapital) - Number(a.isCapital) || (b.pops ?? 0) - (a.pops ?? 0));
}
const systemName = (gamestate, systemId, nameOf) => systemId ? nameOf(childBlock(entryBody(gamestate, "galactic_object", systemId) ?? "", "name", 2)) : null;
function parseColonyScreen(gamestate, planetBody, colony, nameOf = readableName, deposits = null) {
	const systemId = planetBody.match(/\n\t\t\tcoordinate=\s*\{[^}]*?origin=(\d+)/)?.[1] ?? null;
	const queueId = planetBody.match(/\n\t\t\tbuild_queue=(\d+)/)?.[1];
	const size = numberAt(planetBody, "planet_size", 3);
	const depositCaps = {};
	for (const id of planetBody.match(/\n\t\t\tdeposits=\s*\{([^}]*)\}/)?.[1].trim().split(/\s+/).filter(Boolean) ?? []) {
		const type = stringAt(entryBody(gamestate, "deposit", id) ?? "", "type", 2);
		for (const [district, add] of Object.entries(deposits?.get(type) ?? {})) depositCaps[district] = (depositCaps[district] ?? 0) + add;
	}
	const capOf = (type) => /^district_(city|hive|nexus)$/.test(type ?? "") ? size : deposits ? depositCaps[type] ?? null : null;
	return {
		systemId,
		systemName: systemName(gamestate, systemId, nameOf),
		colonizeDate: planetBody.match(/\n\t\t\tcolonize_date=\s*"([^"]+)"/)?.[1] ?? null,
		crime: numberAt(colony, "crime", 2),
		freeHousing: numberAt(colony, "free_housing", 2),
		freeAmenities: numberAt(colony, "free_amenities", 2),
		unemployed: numberAt(colony, "unemploy_pop", 2),
		civilians: numberAt(colony, "civilian", 2),
		districtSlots: idList(colony, "districts").flatMap((id) => {
			const district = entryBody(gamestate, "districts", id);
			if (!district) return [];
			const zones = idList(district, "zones").map((zoneId) => {
				const zone = entryBody(gamestate, "zones", zoneId) ?? "";
				return {
					type: stringAt(zone, "type", 2),
					buildings: idList(zone, "buildings").map((buildingId) => stringAt(entryBody(gamestate, "buildings", buildingId) ?? "", "type", 2)).filter(Boolean)
				};
			});
			const type = stringAt(district, "type", 2);
			return [{
				type,
				level: numberAt(district, "level", 2) ?? 1,
				max: capOf(type),
				zones: zones.filter((zone) => zone.type)
			}];
		}),
		buildQueue: queueId === void 0 ? [] : constructionItems(gamestate).get(queueId) ?? []
	};
}
let queuedText = null;
let queuedItems = /* @__PURE__ */ new Map();
function constructionItems(gamestate) {
	if (gamestate === queuedText) return queuedItems;
	queuedText = gamestate;
	queuedItems = /* @__PURE__ */ new Map();
	const bounds = sectionBounds(gamestate, "construction");
	if (!bounds) return queuedItems;
	const text = gamestate.slice(bounds.start, bounds.end);
	for (const match of text.matchAll(/\n\t\t\t\d+=\n\t\t\t\{\n\t\t\t\tqueue=(\d+)([\s\S]*?)\n\t\t\t\}/g)) {
		const body = match[2];
		queuedItems.set(match[1], [...queuedItems.get(match[1]) ?? [], {
			kind: body.match(/\n\t\t\t\tbuildable_(\w+)=/)?.[1] ?? null,
			target: body.match(/\b(?:building|district|zone|starbase_module|starbase_building)="([^"]+)"/)?.[1] ?? null,
			progress: numberAt(body, "progress", 4) ?? 0,
			needed: numberAt(body, "progress_needed", 4) ?? 0
		}]);
	}
	return queuedItems;
}
function parseSectors(gamestate, countryId, nameOf = readableName) {
	const bounds = sectionBounds(gamestate, "sectors");
	if (!bounds) return [];
	return [...gamestate.slice(bounds.start, bounds.end).matchAll(/\n\t(\d+)=\n\t\{([\s\S]*?)\n\t\}/g)].filter((match) => match[2].match(/\n\t\towner=(\d+)/)?.[1] === String(countryId)).map((match) => ({
		id: match[1],
		name: nameOf(childBlock(match[2], "name", 2)),
		systems: idList(match[2], "systems")
	}));
}
const OUTLINER_CLASSES = {
	shipclass_military: "military",
	shipclass_constructor: "civilian",
	shipclass_science_ship: "civilian",
	shipclass_colonizer: "civilian"
};
function parseFleets(gamestate, countryBody, nameOf = readableName) {
	return [...(childBlock(countryBody, "fleets_manager", 2) ?? "").matchAll(/fleet=(\d+)/g)].flatMap(([, id]) => {
		const body = entryBody(gamestate, "fleet", id);
		const shipClass = body?.match(/\n\t\tship_class=(\w+)/)?.[1];
		if (!body || !OUTLINER_CLASSES[shipClass]) return [];
		const systemId = childBlock(body, "movement_manager", 2)?.match(/coordinate=\s*\{[^}]*?origin=(\d+)/)?.[1] ?? null;
		return [{
			id,
			kind: OUTLINER_CLASSES[shipClass],
			shipClass,
			name: nameOf(childBlock(body, "name", 2)),
			ships: idList(body, "ships").length,
			militaryPower: numberAt(body, "military_power", 2),
			systemName: systemName(gamestate, systemId, nameOf)
		}];
	});
}
async function readLatestSnapshot(stellarisRoot, latestSave) {
	const latest = latestSave ?? await findLatestSave(stellarisRoot);
	if (!latest) throw new Error("Aucune sauvegarde Stellaris n’a été trouvée.");
	const [{ stdout: metaText }, { stdout: gamestateText }] = await Promise.all([execFileAsync(tar, [
		"-xOf",
		latest.file,
		"meta"
	], { maxBuffer: 2097152 }), execFileAsync(tar, [
		"-xOf",
		latest.file,
		"gamestate"
	], { maxBuffer: 268435456 })]);
	const campaignDirectory = (0, node_path.dirname)(latest.file);
	const playerCountry = gamestateText.match(/player=\s*\{[\s\S]*?country=(\d+)/)?.[1] ?? null;
	const countryBody = playerCountry ? entryBody(gamestateText, "country", playerCountry) ?? "" : "";
	const loc = await gameLocalisation();
	const homeworld = localizeName(childBlock(countryBody, "homeworld_name", 2), loc) ?? "";
	const nameOf = (block) => (localizeName(block, loc) ?? readableName(block))?.replace(/\[(?:\w+\.)*GetHomeWorldName\]/g, homeworld).replace(/\[[^\]]*\]\s*/g, "").trim() || null;
	const snapshot = {
		...parseMeta(metaText, {
			campaignDirectory,
			savePath: latest.file,
			saveUpdatedAt: latest.info.mtime
		}),
		recentEvents: await readRecentPlayerEvents(stellarisRoot),
		build: parsePlayerBuild(gamestateText),
		economy: countryBody ? parseEconomy(countryBody) : null,
		empireStats: countryBody ? parseEmpireStats(countryBody) : null,
		leaders: countryBody ? parseLeaders(gamestateText, countryBody, nameOf) : [],
		planets: playerCountry ? parsePlanets(gamestateText, playerCountry, nameOf, await gameDeposits()) : [],
		sectors: playerCountry ? parseSectors(gamestateText, playerCountry, nameOf) : [],
		fleets: countryBody ? parseFleets(gamestateText, countryBody, nameOf) : [],
		progression: countryBody ? parseProgression(gamestateText, countryBody) : null,
		activeQuests: parseActiveQuests(countryBody)
	};
	const questGuide = await buildQuestGuide(snapshot);
	return {
		...snapshot,
		labels: collectLabels(snapshot, loc),
		questGuide
	};
}
async function isStellarisRunning() {
	if (process.platform !== "win32") return null;
	try {
		const { stdout } = await execFileAsync("tasklist", [
			"/FI",
			"IMAGENAME eq stellaris.exe",
			"/FO",
			"CSV",
			"/NH"
		]);
		return /"stellaris\.exe"/i.test(stdout);
	} catch {
		return null;
	}
}
//#endregion
//#region scripts/localCompanion.mjs
const companionVersion = "0.5.0";
process.title = `Curator Companion v${companionVersion}`;
const host = "127.0.0.1";
const port = Number.parseInt(process.env.CURATOR_COMPANION_PORT ?? "43123", 10);
const pollIntervalMs = Number.parseInt(process.env.CURATOR_COMPANION_POLL_MS ?? "1000", 10);
const allowedOrigins = /* @__PURE__ */ new Set([
	"http://localhost:4173",
	"http://localhost:5173",
	"https://stellaris-advisor.cheeta.trade",
	"https://cheeta.trade"
]);
function commonHeaders(origin) {
	return {
		"access-control-allow-origin": allowedOrigins.has(origin) ? origin : "null",
		"access-control-allow-methods": "GET, OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-allow-private-network": "true",
		"cache-control": "no-store",
		vary: "Origin"
	};
}
function jsonHeaders(origin) {
	return {
		...commonHeaders(origin),
		"content-type": "application/json; charset=utf-8"
	};
}
function send(response, origin, status, body) {
	response.writeHead(status, jsonHeaders(origin));
	response.end(JSON.stringify(body));
}
function fileVersion(file) {
	return file ? `${file.file}:${file.info.size}:${file.info.mtimeMs}` : "missing";
}
async function logVersion(stellarisRoot) {
	const info = await (0, node_fs_promises.stat)((0, node_path.join)(stellarisRoot, "logs", "game.log")).catch(() => null);
	return info ? `${info.size}:${info.mtimeMs}` : "missing";
}
var SnapshotMonitor = class {
	clients = /* @__PURE__ */ new Set();
	snapshot = null;
	stellarisRoot = null;
	saveVersion = "";
	pendingSaveVersion = "";
	gameLogVersion = "";
	timer = null;
	refreshing = null;
	runningCheck = 0;
	async refresh(force = false) {
		if (this.refreshing) return this.refreshing;
		this.refreshing = this.#refresh(force).finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}
	async #refresh(force) {
		this.stellarisRoot ??= await findStellarisRoot();
		if (!this.stellarisRoot) throw new Error("Dossier Stellaris introuvable.");
		const latest = await findLatestSave(this.stellarisRoot);
		if (!latest) throw new Error("Aucune sauvegarde Stellaris n’a été trouvée.");
		const nextSaveVersion = fileVersion(latest);
		const nextLogVersion = await logVersion(this.stellarisRoot);
		let saveChanged = force || !this.snapshot || nextSaveVersion !== this.saveVersion;
		const logChanged = force || !this.snapshot || nextLogVersion !== this.gameLogVersion;
		const shouldCheckRunning = force || !this.snapshot || Date.now() - this.runningCheck >= 5e3;
		if (saveChanged && this.snapshot && !force) {
			if (this.pendingSaveVersion !== nextSaveVersion) {
				this.pendingSaveVersion = nextSaveVersion;
				saveChanged = false;
			} else this.pendingSaveVersion = "";
		}
		let next = this.snapshot;
		if (saveChanged) {
			next = await readLatestSnapshot(this.stellarisRoot, latest);
			this.saveVersion = nextSaveVersion;
		} else if (logChanged && next) {
			const recentEvents = await readRecentPlayerEvents(this.stellarisRoot);
			next = {
				...next,
				recentEvents,
				questGuide: await buildQuestGuide({
					...next,
					recentEvents
				})
			};
		}
		if (shouldCheckRunning) {
			this.runningCheck = Date.now();
			const gameRunning = await isStellarisRunning();
			if (!next || gameRunning !== next.gameRunning) next = {
				...next,
				gameRunning
			};
		}
		const changed = next !== this.snapshot;
		this.gameLogVersion = nextLogVersion;
		if (next) this.snapshot = changed || force ? {
			...next,
			companionVersion,
			capturedAt: (/* @__PURE__ */ new Date()).toISOString()
		} : next;
		if (changed && this.snapshot) this.broadcast("snapshot", this.snapshot);
		return this.snapshot;
	}
	addClient(response) {
		this.clients.add(response);
		if (!this.timer) {
			this.timer = setInterval(() => {
				this.refresh().catch((error) => this.broadcast("companion-error", { message: error instanceof Error ? error.message : "Lecture locale indisponible." }));
			}, pollIntervalMs);
			this.timer.unref?.();
		}
		response.write("retry: 1500\n\n");
		this.refresh(true).catch((error) => this.write(response, "companion-error", { message: error instanceof Error ? error.message : "Lecture locale indisponible." }));
	}
	removeClient(response) {
		this.clients.delete(response);
		if (this.clients.size === 0 && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
	write(response, event, data) {
		response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}
	broadcast(event, data) {
		for (const client of this.clients) this.write(client, event, data);
	}
};
const monitor = new SnapshotMonitor();
setInterval(() => monitor.broadcast("heartbeat", { at: (/* @__PURE__ */ new Date()).toISOString() }), 15e3).unref?.();
const server = (0, node_http.createServer)(async (request, response) => {
	const origin = request.headers.origin ?? "";
	if (request.method === "OPTIONS") {
		response.writeHead(204, commonHeaders(origin));
		response.end();
		return;
	}
	if (!allowedOrigins.has(origin)) return send(response, origin, 403, { error: "origin_not_allowed" });
	try {
		if (request.method === "GET" && request.url === "/health") return send(response, origin, 200, {
			status: "ok",
			readOnly: true,
			realtime: "sse",
			version: companionVersion
		});
		if (request.method === "GET" && request.url === "/snapshot") return send(response, origin, 200, await monitor.refresh(true));
		const url = new URL(request.url ?? "/", `http://${host}`);
		if (request.method === "GET" && url.pathname === "/quest-node") {
			const id = url.searchParams.get("id") ?? "";
			if (!/^(event|project):[\w.]+$/.test(id)) return send(response, origin, 400, { error: "invalid_node" });
			return send(response, origin, 200, { nodes: await questNode(id, monitor.snapshot?.build ?? null) ?? {} });
		}
		if (request.method === "GET" && request.url === "/events") {
			response.writeHead(200, {
				...commonHeaders(origin),
				"content-type": "text/event-stream; charset=utf-8",
				connection: "keep-alive",
				"x-accel-buffering": "no"
			});
			monitor.addClient(response);
			request.on("close", () => monitor.removeClient(response));
			return;
		}
		return send(response, origin, 404, { error: "not_found" });
	} catch (error) {
		console.error("Curator companion:", error instanceof Error ? error.message : error);
		return send(response, origin, 500, {
			error: "snapshot_unavailable",
			message: error instanceof Error ? error.message : "Erreur inconnue"
		});
	}
});
if (process.platform === "win32" && !/node(\.exe)?$/i.test(process.execPath)) {
	const key = "HKCU\\Software\\Classes\\stellaris-advisor";
	const run = (args) => (0, node_child_process.execFile)("reg", args, () => void 0);
	run([
		"add",
		key,
		"/ve",
		"/d",
		"URL:Curator Companion",
		"/f"
	]);
	run([
		"add",
		key,
		"/v",
		"URL Protocol",
		"/d",
		"",
		"/f"
	]);
	run([
		"add",
		`${key}\\shell\\open\\command`,
		"/ve",
		"/d",
		`"${process.execPath}" "%1"`,
		"/f"
	]);
}
function runningVersion() {
	return new Promise((resolve) => {
		const request = (0, node_http.get)({
			host,
			port,
			path: "/health",
			headers: { origin: "http://localhost:5173" },
			timeout: 2e3
		}, (response) => {
			let body = "";
			response.on("data", (chunk) => {
				body += chunk;
			});
			response.on("end", () => {
				try {
					resolve(JSON.parse(body).version ?? null);
				} catch {
					resolve(null);
				}
			});
		});
		request.on("timeout", () => request.destroy());
		request.on("error", () => resolve(null));
	});
}
server.on("error", async (error) => {
	if (error.code === "EADDRINUSE") {
		const running = await runningVersion();
		if (running === companionVersion) {
			console.log(`Curator Companion v${companionVersion} est déjà lancé.`);
			process.exit(0);
		}
		console.log(`Une autre version de Curator Companion (${running ? `v${running}` : "version inconnue"}) est déjà lancée.`);
		console.log(`Fermez-la (Gestionnaire des tâches > CuratorCompanion), puis relancez ce fichier (v${companionVersion}).`);
		setTimeout(() => process.exit(1), 6e4);
		return;
	}
	throw error;
});
gameQuestIndex();
server.listen(port, host, () => {
	console.log(`Curator Companion v${companionVersion} écoute sur http://${host}:${port}`);
	console.log("Temps réel SSE actif. Lecture seule : aucune donnée Stellaris n’est modifiée.");
});
//#endregion
