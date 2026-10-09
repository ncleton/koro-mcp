import {
  ROBOT_PATTERN, decodeHtml, formatEuro, hasVeganClaim, isObject, isOrganic, parsePrice, str, stripTags,
  type Adapter, type MutationInput, type SessionSignals,
} from "./adapter.js";
import { ContractChangedError } from "./errors.js";
import type { CartInput, ProductInput, SummaryInput } from "./types.js";

const HOSTS = new Set(["www.koro.fr", "koro.fr"]);

const PRELUDE = String.raw`
const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
const API = "https://bff.koro.com/store-api";
const channel = () => {
  const channels = useNuxtApp().$config.public.localizedFrontendsContext.channels;
  const found = channels.find((entry) => JSON.stringify(entry.domains).indexOf(location.origin) >= 0);
  if (!found || !found.accessKey) throw new Error("Contrat canal de vente KoRo absent");
  return found;
};
let session = null;
const cookieToken = () => { const match = document.cookie.match(/sw-context-token=([^;]+)/); return match ? match[1] : null; };
const remember = (response) => {
  const fresh = response.headers.get("sw-context-token");
  if (fresh && fresh !== session.token) { session.token = fresh; const entry = ["sw-context-token", fresh].join("="); document.cookie = entry + "; path=/; max-age=2592000; SameSite=Lax"; }
};
const open = async () => {
  if (session) return session;
  session = { key: channel().accessKey, token: cookieToken(), language: null };
  const headers = { Accept: "application/json", "sw-access-key": session.key };
  if (session.token) headers["sw-context-token"] = session.token;
  const response = await fetch(API + "/context", { headers: headers });
  if (!response.ok) throw new Error("Contexte HTTP " + response.status);
  remember(response);
  const context = await response.json();
  session.language = context.salesChannel && context.salesChannel.languageId;
  if (!session.language) throw new Error("Contrat langue du canal absent");
  return session;
};
const api = async (path, method, body) => {
  const state = await open();
  const headers = { Accept: "application/json", "Content-Type": "application/json", "sw-access-key": state.key, "sw-context-token": state.token, "sw-language-id": state.language, "sw-include-seo-urls": "true" };
  const response = await fetch(API + path, { method: method || "GET", headers: headers, body: body ? JSON.stringify(body) : undefined });
  remember(response);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("API " + path + " (" + response.status + ") : " + clean(json.errors && json.errors[0] && (json.errors[0].detail || json.errors[0].title)).slice(0, 200));
  return json;
};
const readCart = async () => {
  const cart = await api("/checkout/cart", "GET");
  if (!cart || !Array.isArray(cart.lineItems) || !cart.price) throw new Error("Contrat panier Shopware absent");
  return {
    total: cart.price.positionPrice,
    items: cart.lineItems.filter((line) => line.type === "product").map((line) => ({
      line_id: line.id, product_id: line.referencedId, name: line.label, quantity: line.quantity,
      unit_price: line.price && line.price.unitPrice, line_total: line.price && line.price.totalPrice,
      maximum: line.quantityInformation && line.quantityInformation.maxPurchase != null ? line.quantityInformation.maxPurchase : null,
    })),
  };
};
`;

function searchExpression(query: string, limit: number): string {
  return String.raw`(async () => {
    ${PRELUDE}
    const result = await api("/search", "POST", { search: ${JSON.stringify(query)}, limit: ${limit} });
    if (!result || !Array.isArray(result.elements)) throw new Error("Contrat recherche Shopware absent");
    return result.elements.map((p) => ({
      id: p.id, number: p.productNumber, name: p.translated && p.translated.name || p.name, ean: p.ean || null,
      brand: p.manufacturer && p.manufacturer.translated && p.manufacturer.translated.name || null,
      available: p.available, stock: p.availableStock, min: p.minPurchase, max: p.maxPurchase,
      price: p.calculatedPrice && p.calculatedPrice.unitPrice,
      reference_price: p.calculatedPrice && p.calculatedPrice.referencePrice ? p.calculatedPrice.referencePrice.price + " €/" + p.calculatedPrice.referencePrice.referenceUnit : null,
      seo: Array.isArray(p.seoUrls) && p.seoUrls[0] ? (p.seoUrls[0].seoPathInfo || p.seoUrls[0].pathInfo) : null,
    }));
  })()`;
}

function productExpression(productUrl: string): string {
  return String.raw`(async () => {
    ${PRELUDE}
    const path = new URL(${JSON.stringify(productUrl)}).pathname.replace(/^\/+|\/+$/g, "");
    const seo = await api("/seo-url", "POST", { filter: [{ type: "equals", field: "seoPathInfo", value: path }], limit: 1 });
    const entry = seo.elements && seo.elements[0];
    if (!entry || entry.routeName !== "frontend.detail.page") throw new Error("Aucune fiche produit pour " + path);
    const detail = await api("/product/" + entry.foreignKey, "POST", { associations: { properties: { associations: { group: {} } } } });
    const p = detail.product;
    if (!p) throw new Error("Contrat fiche produit absent");
    const fields = (p.translated && p.translated.customFields) || p.customFields || {};
    const nutrition = {};
    Object.keys(fields).forEach((key) => { if (key.indexOf("koro_nutrition_") === 0 && fields[key] != null && fields[key] !== "") nutrition[key.slice(15)] = fields[key]; });
    return {
      id: p.id, number: p.productNumber, name: p.translated && p.translated.name || p.name, ean: p.ean || null,
      brand: p.manufacturer && p.manufacturer.translated && p.manufacturer.translated.name || null,
      available: p.available, stock: p.availableStock, min: p.minPurchase, max: p.maxPurchase,
      price: p.calculatedPrice && p.calculatedPrice.unitPrice,
      reference_price: p.calculatedPrice && p.calculatedPrice.referencePrice ? p.calculatedPrice.referencePrice.price + " €/" + p.calculatedPrice.referencePrice.referenceUnit : null,
      description: (p.translated && p.translated.description) || "",
      ingredients: fields.koro_ingredients || null, allergens: fields.koro_allergens || null, nutrition: nutrition,
      properties: (p.properties || []).map((x) => x.translated && x.translated.name).filter(Boolean),
      seo: path,
    };
  })()`;
}

function cartExpression(): string {
  return String.raw`(async () => { ${PRELUDE} return readCart(); })()`;
}

function mutationExpression(input: MutationInput): string {
  return String.raw`(async () => {
    ${PRELUDE}
    const productId = ${JSON.stringify(input.productId)};
    const target = ${input.targetQuantity};
    const before = await readCart();
    const line = before.items.find((item) => item.product_id === productId);
    const current = line ? Number(line.quantity) : 0;
    if (current === target) return { before, after: before, applied: false };
    if (target === 0) await api("/checkout/cart/line-item", "DELETE", { ids: [line.line_id] });
    else if (line) await api("/checkout/cart/line-item", "PATCH", { items: [{ id: line.line_id, quantity: target }] });
    else await api("/checkout/cart/line-item", "POST", { items: [{ id: productId, quantity: target, type: "product", referencedId: productId }] });
    return { before, after: await readCart(), applied: true };
  })()`;
}

const NUTRITION_LABELS: Record<string, [string, string]> = {
  energy_kj: ["Énergie", "kJ"], energy_kcal: ["Énergie", "kcal"], kj: ["Énergie", "kJ"], kcal: ["Énergie", "kcal"],
  fat: ["Matières grasses", "g"], fat_saturated: ["dont acides gras saturés", "g"], saturated_fat: ["dont acides gras saturés", "g"], saturates: ["dont acides gras saturés", "g"],
  carbohydrates: ["Glucides", "g"], carbs: ["Glucides", "g"], sugar: ["dont sucres", "g"], sugars: ["dont sucres", "g"],
  fibre: ["Fibres", "g"], fiber: ["Fibres", "g"], protein: ["Protéines", "g"], salt: ["Sel", "g"],
};

function url(base: string, path: string | null): string | null {
  if (!path) return null;
  return `${base}/${path.replace(/^\/+|\/+$/g, "")}`;
}

export const adapter: Adapter = {
  entryUrl: () => "https://www.koro.fr/",
  matchesTab: (u) => u.protocol === "https:" && HOSTS.has(u.hostname),
  inspectSession({ snapshot, tabUrl }): SessionSignals {
    let onSite = false;
    try { onSite = HOSTS.has(new URL(tabUrl).hostname); } catch { onSite = false; }
    const robotVisible = ROBOT_PATTERN.test(snapshot);
    return { ready: onSite && !robotVisible && snapshot.trim().length > 0, robotVisible, accountConnected: /d[ée]connexion|se d[ée]connecter|mon compte.*connect/i.test(snapshot) && !/se connecter/i.test(snapshot) };
  },
  validateProductUrl(u) {
    if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || u.pathname === "/" || u.pathname.split("/").filter(Boolean).length !== 1) throw new Error("Hors des fiches produit KoRo.");
  },
  searchExpression: (_config, query, limit) => searchExpression(query, limit),
  normalizeSearch(raw): SummaryInput[] {
    if (!Array.isArray(raw)) throw new ContractChangedError("La recherche n’a pas retourné une liste de produits.");
    return raw.map((entry): SummaryInput => {
      if (!isObject(entry)) throw new ContractChangedError("Un produit n’est plus un objet exploitable.");
      const id = str(entry, "id");
      const name = str(entry, "name");
      const price = parsePrice(entry.price);
      const link = url("https://www.koro.fr", str(entry, "seo"));
      if (!id || !name || price === null || !link || typeof entry.available !== "boolean") throw new ContractChangedError("Un produit ne contient plus son identifiant, son nom, son prix, son adresse ou sa disponibilité.");
      const stock = typeof entry.stock === "number" && Number.isInteger(entry.stock) && entry.stock >= 0 ? entry.stock : null;
      const max = typeof entry.max === "number" ? entry.max : null;
      return {
        product_id: id, name: decodeHtml(name), brand: str(entry, "brand"), price, unit_price: str(entry, "reference_price"),
        availability: entry.available && (stock === null || stock > 0) ? "available" : "out_of_stock",
        available_quantity: stock === null ? null : max === null ? stock : Math.min(stock, max), organic: isOrganic(name), product_url: link,
      };
    });
  },
  productExpression: (_config, productUrl) => productExpression(productUrl),
  normalizeProduct(raw, _config, requestedUrl): ProductInput {
    if (!isObject(raw)) throw new ContractChangedError("La fiche n’a pas retourné l’objet produit attendu.");
    const id = str(raw, "id");
    const name = str(raw, "name");
    const price = parsePrice(raw.price);
    if (!id || !name || price === null || typeof raw.available !== "boolean") throw new ContractChangedError("La fiche ne contient plus son identifiant, son nom, son prix ou sa disponibilité.");
    const stock = typeof raw.stock === "number" && Number.isInteger(raw.stock) && raw.stock >= 0 ? raw.stock : null;
    const max = typeof raw.max === "number" ? raw.max : null;
    const properties = Array.isArray(raw.properties) ? raw.properties.map(String) : [];
    const nutrition = isObject(raw.nutrition) ? Object.entries(raw.nutrition).flatMap(([key, value]): ProductInput["nutrition"] => {
      const known = NUTRITION_LABELS[key];
      const text = typeof value === "number" || typeof value === "string" ? String(value) : null;
      return text ? [{ label: known ? known[0] : key.replace(/_/g, " "), value: text, unit: known ? known[1] : null }] : [];
    }) : [];
    return {
      product_id: id, name: decodeHtml(name), brand: str(raw, "brand"), price, unit_price: str(raw, "reference_price"),
      availability: raw.available && (stock === null || stock > 0) ? "available" : "out_of_stock",
      available_quantity: stock === null ? null : max === null ? stock : Math.min(stock, max),
      organic: isOrganic(`${name} ${properties.join(" ")}`), product_url: requestedUrl,
      ean: str(raw, "ean"), ingredients: str(raw, "ingredients"), vegan_claim: properties.some((property) => /^vegan$/i.test(property)) || hasVeganClaim(stripTags(str(raw, "description") ?? "")), nutrition,
    };
  },
  cartExpression: () => cartExpression(),
  normalizeCart(raw): CartInput {
    if (!isObject(raw) || !Array.isArray(raw.items)) throw new ContractChangedError("Le panier n’a plus la forme observée.");
    const items = raw.items.map((entry) => {
      if (!isObject(entry)) throw new ContractChangedError("Une ligne de panier n’est plus exploitable.");
      const id = str(entry, "product_id");
      const quantity = Number(entry.quantity);
      if (!id || !Number.isInteger(quantity) || quantity < 0) throw new ContractChangedError("Une ligne de panier ne contient plus son identifiant ou sa quantité.");
      const maximum = typeof entry.maximum === "number" && Number.isInteger(entry.maximum) && entry.maximum >= 0 ? entry.maximum : null;
      return { product_id: id, name: str(entry, "name"), quantity, available_quantity: maximum, unit_price: parsePrice(entry.unit_price), line_total: parsePrice(entry.line_total) };
    });
    const total = parsePrice(raw.total);
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    return { empty: totalQuantity === 0, total_quantity: totalQuantity, total_price: formatEuro(total ?? 0), items };
  },
  mutationExpression: (_config, input) => mutationExpression(input),
};
